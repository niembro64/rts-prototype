#!/usr/bin/env python3
"""Generate the per-preset sky backdrop panoramas.

Outputs one equirectangular (360 x 180 degree) JPEG per stock battle
preset (src/components/battlePresets.ts) into public/assets/backdrops/.
The renderer applies them as THREE scene.background with
EquirectangularReflectionMapping (see src/game/render3d/presetBackdrops.ts),
the same role BAR's skybox DDS library plays via Spring.SetSkyBoxTexture.

Every image is horizontally seamless (all azimuthal detail is built from
integer-frequency harmonics or x-wrapped value noise) so any 180-degree
camera sweep works. Colors are derived from src/colorsConfig.json so the
backdrops stay in the game's existing palette; when battle settings do not
match a stock preset the renderer keeps the plain gradient built from the
same palette.

Usage: python3 scripts/generate_backdrops.py
Requires: numpy, Pillow.
"""

from __future__ import annotations

import json
import os

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "public", "assets", "backdrops")
W, H = 4096, 2048
# Final soft-focus blur (box-blur radius, 3 passes ~ Gaussian). Keeps the
# backdrops dreamy and hides silhouette stair-steps at horizon
# magnification; individual presets can override in PRESETS.
DEFAULT_BLUR_RADIUS = 6

with open(os.path.join(ROOT, "src", "colorsConfig.json")) as f:
    COLORS = json.load(f)["world"]


def hx(s: str) -> np.ndarray:
    s = s.lstrip("#")
    return np.array([int(s[i : i + 2], 16) for i in (0, 2, 4)], dtype=np.float64) / 255.0


def mix(a: np.ndarray, b: np.ndarray, t: float) -> np.ndarray:
    return a * (1.0 - t) + b * t


SKY_TOP = hx(COLORS["sky"]["topColor"])          # #6d9dcc
SKY_MID = hx(COLORS["sky"]["midColor"])          # #b7cddd
SKY_HORIZON = hx(COLORS["sky"]["horizonColor"])  # #e1d5bd
WATER = hx(COLORS["water"]["colorHex"])          # #22303B
LAVA = hx(COLORS["water"]["lava"]["colorHex"])   # #b2523a
OUT_OF_BOUNDS = hx(COLORS["map"]["outOfBounds"]["colorHex"])  # #121820
CAMERA_CLEAR = hx(COLORS["map"]["cameraClear"]["colorHex"])   # #8fb1c9
IN_BOUNDS = hx(COLORS["map"]["inBounds"]["colorHex"])         # #445138
SUN_CORE = hx(COLORS["sun"]["visibleSkyDisk"]["coreColor"])   # #fff8dc
SUN_HALO = hx(COLORS["sun"]["visibleSkyDisk"]["haloColor"])   # #f0b860
SUN_COLOR = hx(COLORS["sun"]["colorHex"])                     # #fff0cf
GROUND = hx(COLORS["terrain"]["ground"]["baseColorHex"])      # #222b1a
ROCKS = [hx(c) for c in COLORS["terrain"]["rock"]["shadePaletteRgb"]]
BURN_HOT = hx(COLORS["burnMark"]["hotColorHex"])              # #880200
BURN_RESIDUE = hx(COLORS["burnMark"]["coolResidueColorHex"])  # #221100
GROUND_PRINT = hx(COLORS["groundPrint"]["colorHex"])          # #1a1308

# Angular coordinate grids. theta: azimuth [0, 2pi) per column; elev:
# elevation in degrees per row (+90 top row, -90 bottom row).
THETA = np.linspace(0.0, 2.0 * np.pi, W, endpoint=False)
ELEV = np.linspace(90.0, -90.0, H)
ELEV_COL = ELEV[:, None]


def smoothstep(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def harmonic_ridge(rng: np.random.Generator, harmonics: range, decay: float) -> np.ndarray:
    """Periodic 1D ridge profile in [-1, 1], seamless across theta = 0."""
    out = np.zeros(W)
    for k in harmonics:
        amp = k ** -decay
        phase = rng.uniform(0.0, 2.0 * np.pi)
        out += amp * np.sin(k * THETA + phase)
    m = np.max(np.abs(out))
    return out / m if m > 0 else out


def tileable_noise(rng: np.random.Generator, cells_x: int, cells_y: int, octaves: int = 4) -> np.ndarray:
    """2D value noise, W x H, wrapped in x (seamless), [0, 1]."""
    total = np.zeros((H, W))
    amp_sum = 0.0
    for o in range(octaves):
        cx, cy = cells_x * (2 ** o), cells_y * (2 ** o)
        grid = rng.random((cy + 1, cx))
        xs = np.linspace(0.0, cx, W, endpoint=False)
        ys = np.linspace(0.0, cy, H)
        xi = np.floor(xs).astype(int) % cx
        yi = np.clip(np.floor(ys).astype(int), 0, cy - 1)
        xf = xs - np.floor(xs)
        yf = ys - np.floor(ys)
        xf = xf * xf * (3.0 - 2.0 * xf)
        yf = yf * yf * (3.0 - 2.0 * yf)
        g00 = grid[np.ix_(yi, xi)]
        g10 = grid[np.ix_(yi, (xi + 1) % cx)]
        g01 = grid[np.ix_(yi + 1, xi)]
        g11 = grid[np.ix_(yi + 1, (xi + 1) % cx)]
        top = g00 * (1 - xf[None, :]) + g10 * xf[None, :]
        bot = g01 * (1 - xf[None, :]) + g11 * xf[None, :]
        octave = top * (1 - yf[:, None]) + bot * yf[:, None]
        amp = 0.5 ** o
        total += octave * amp
        amp_sum += amp
    return total / amp_sum


def sky_gradient(stops: list[tuple[float, np.ndarray]]) -> np.ndarray:
    """Vertical gradient from (elevation_degrees, color) stops, top-down."""
    img = np.zeros((H, W, 3))
    elevs = np.array([s[0] for s in stops])
    for c in range(3):
        vals = np.array([s[1][c] for s in stops])
        img[:, :, c] = np.interp(ELEV, elevs[::-1], vals[::-1])[:, None]
    return img


def paint_silhouette(
    img: np.ndarray,
    ridge_deg: np.ndarray,
    base_deg: float,
    color: np.ndarray,
    haze_color: np.ndarray,
    haze: float,
    rim_color: np.ndarray | None = None,
    rim_strength: float = 0.0,
    rim_width_deg: float = 0.5,
) -> None:
    """Fill everything below ridge_deg (and above base_deg) with a hazed color.

    Inside the fill, haze increases slightly toward the horizon so distant
    bases melt into the sky. An optional rim light brightens the top edge.
    """
    ridge = ridge_deg[None, :]
    inside = (ELEV_COL <= ridge) & (ELEV_COL >= base_deg)
    depth = np.where(ridge > 1e-6, np.clip(1.0 - ELEV_COL / np.maximum(ridge, 1e-6), 0.0, 1.0), 1.0)
    haze_map = np.clip(haze + depth * 0.12, 0.0, 0.96)
    fill = color[None, None, :] * (1.0 - haze_map[..., None]) + haze_color[None, None, :] * haze_map[..., None]
    img[inside] = fill[inside]
    if rim_color is not None and rim_strength > 0.0:
        rim = inside & (ridge - ELEV_COL < rim_width_deg)
        rim_falloff = np.clip(1.0 - (ridge - ELEV_COL) / rim_width_deg, 0.0, 1.0)
        add = rim_color[None, None, :] * (rim_falloff * rim_strength)[..., None]
        img[rim] = np.clip(img[rim] + add[rim], 0.0, 1.0)


def paint_cloud_layer(
    img: np.ndarray,
    rng: np.random.Generator,
    lo_deg: float,
    hi_deg: float,
    color: np.ndarray,
    shade_color: np.ndarray,
    coverage: float,
    cells_x: int = 10,
    cells_y: int = 5,
    softness: float = 0.16,
    max_alpha: float = 0.85,
) -> None:
    """Soft noise-thresholded cloud band between two elevations.

    The noise field is sampled in band-local coordinates (the band's
    elevation range maps across the whole noise field) so clouds keep full
    detail even in thin low-elevation bands, which occupy most of what an
    RTS camera actually sees of the sky.
    """
    noise_full = tileable_noise(rng, cells_x, cells_y)
    v = np.clip((ELEV_COL[:, 0] - lo_deg) / (hi_deg - lo_deg), 0.0, 1.0)
    noise = noise_full[np.clip(((1.0 - v) * (H - 1)).astype(int), 0, H - 1), :]
    band = smoothstep(lo_deg, lo_deg + (hi_deg - lo_deg) * 0.35, ELEV_COL) * (
        1.0 - smoothstep(hi_deg - (hi_deg - lo_deg) * 0.35, hi_deg, ELEV_COL)
    )
    threshold = 1.0 - coverage
    alpha = smoothstep(threshold, threshold + softness, noise) * band * max_alpha
    # Flat-bottomed shading: lower half of the band shades toward shade_color.
    vertical = smoothstep(lo_deg, hi_deg, ELEV_COL)
    cloud_color = shade_color[None, None, :] * (1.0 - vertical[..., None] * 0.9) + color[None, None, :] * (
        vertical[..., None] * 0.9
    )
    img[:] = img * (1.0 - alpha[..., None]) + cloud_color * alpha[..., None]


def paint_horizon_glow(img: np.ndarray, color: np.ndarray, strength: float, height_deg: float) -> None:
    glow = np.exp(-np.abs(ELEV_COL) / height_deg) * strength
    img[:] = np.clip(img + color[None, None, :] * glow[..., None], 0.0, 1.0)


def paint_azimuth_glow(
    img: np.ndarray,
    center_theta: float,
    color: np.ndarray,
    strength: float,
    angular_width: float,
    height_deg: float,
    below_horizon: bool = False,
) -> None:
    """Warm directional glow (soft, no hard disk — the scene draws its own sun)."""
    d = np.abs(((THETA - center_theta + np.pi) % (2.0 * np.pi)) - np.pi)
    az = np.exp(-((d / angular_width) ** 2))[None, :]
    if below_horizon:
        vert = np.exp(-np.abs(ELEV_COL) / height_deg)
    else:
        vert = np.exp(-np.clip(ELEV_COL, 0.0, None) / height_deg) * (ELEV_COL >= -2.0)
    glow = az * vert * strength
    img[:] = np.clip(img + color[None, None, :] * glow[..., None], 0.0, 1.0)


def _gauss_kernel(sigma: float) -> np.ndarray:
    """Small 2D Gaussian splat kernel, peak-normalized to 1."""
    r = max(1, int(np.ceil(sigma * 3.0)))
    ax = np.arange(-r, r + 1)
    k = np.exp(-(ax[:, None] ** 2 + ax[None, :] ** 2) / (2.0 * sigma * sigma))
    return k / k.max()


def _splat(img: np.ndarray, y: int, x: int, kernel: np.ndarray, color: np.ndarray, strength: float) -> None:
    """Additively stamp a soft dot; wraps in x, clips in y."""
    r = kernel.shape[0] // 2
    ys = np.arange(y - r, y + r + 1)
    xs = np.arange(x - r, x + r + 1) % W
    valid = (ys >= 0) & (ys < H)
    if not np.any(valid):
        return
    img[np.ix_(ys[valid], xs)] += kernel[valid][:, :, None] * color[None, None, :] * strength


def paint_stars(
    img: np.ndarray,
    rng: np.random.Generator,
    count: int,
    min_elev_deg: float,
    max_strength: float = 0.9,
) -> None:
    # Soft multi-pixel dots (not single pixels) so the final soft-focus
    # blur dims them gracefully instead of erasing them.
    dot = _gauss_kernel(1.7)
    bright = _gauss_kernel(2.6)
    white = np.ones(3)
    for _ in range(count):
        x = int(rng.integers(0, W))
        # Bias star rows toward the zenith less strongly than area-uniform
        # sampling would: backdrop viewers mostly see the low sky.
        y = int(rng.uniform(0.0, (90.0 - min_elev_deg) / 180.0) * H)
        strength = rng.uniform(0.25, max_strength)
        if rng.random() < 0.18:
            _splat(img, y, x, bright, white, strength * 1.3)
        else:
            _splat(img, y, x, dot, white, strength)
    np.clip(img, 0.0, 1.0, out=img)


def paint_embers(img: np.ndarray, rng: np.random.Generator, count: int, max_elev_deg: float) -> None:
    dot = _gauss_kernel(1.4)
    for _ in range(count):
        x = int(rng.integers(0, W))
        elev = rng.uniform(0.5, max_elev_deg)
        y = int((90.0 - elev) / 180.0 * H)
        strength = rng.uniform(0.2, 0.7) * (1.0 - elev / max_elev_deg)
        _splat(img, y, x, dot, SUN_HALO, strength)
    np.clip(img, 0.0, 1.0, out=img)


def below_horizon_sea(img: np.ndarray, surface: np.ndarray, deep: np.ndarray) -> None:
    """Paint everything below the horizon: surface color melting into deep."""
    below = ELEV_COL < 0.0
    t = np.clip(-ELEV_COL / 30.0, 0.0, 1.0)
    fill = surface[None, None, :] * (1.0 - t[..., None]) + deep[None, None, :] * t[..., None]
    mask = np.broadcast_to(below[..., None], img.shape)
    img[:] = np.where(mask, np.broadcast_to(fill, img.shape), img)


def rounded(profile01: np.ndarray, exponent: float = 0.8) -> np.ndarray:
    """Widen and round the crests of a [0,1] ridge (organic, never boxy)."""
    return np.clip(profile01, 0.0, 1.0) ** exponent


def _box_blur_x(img: np.ndarray, r: int) -> np.ndarray:
    """Horizontal box blur with wrap-around, preserving the panorama seam."""
    pad = np.concatenate([img[:, -r:], img, img[:, :r]], axis=1)
    c = np.cumsum(pad, axis=1)
    c = np.concatenate([np.zeros_like(c[:, :1]), c], axis=1)
    return (c[:, 2 * r + 1 :] - c[:, : -(2 * r + 1)]) / (2 * r + 1)


def _box_blur_y(img: np.ndarray, r: int) -> np.ndarray:
    """Vertical box blur with edge-clamp padding."""
    pad = np.concatenate([img[:1].repeat(r, axis=0), img, img[-1:].repeat(r, axis=0)], axis=0)
    c = np.cumsum(pad, axis=0)
    c = np.concatenate([np.zeros_like(c[:1]), c], axis=0)
    return (c[2 * r + 1 :] - c[: -(2 * r + 1)]) / (2 * r + 1)


def soft_focus(img: np.ndarray, radius: int) -> np.ndarray:
    """Three box-blur passes ~ Gaussian. Done in numpy (not PIL) so the
    x wrap keeps the 360-degree seam invisible after blurring."""
    out = img
    for _ in range(3):
        out = _box_blur_y(_box_blur_x(out, radius), radius)
    return out


def save(img: np.ndarray, slug: str, blur_radius: int = DEFAULT_BLUR_RADIUS) -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    if blur_radius > 0:
        img = soft_focus(img, blur_radius)
    # Fine dither before quantization: breaks the visible banding steps
    # that smooth sky gradients otherwise develop at 8 bits. A tiled
    # pattern (not white noise) so PNG's LZ compression still bites —
    # white noise here quadruples the file size.
    tile = np.random.default_rng(999).uniform(-0.5, 0.5, (64, 64))
    dither = np.tile(tile, (H // 64, W // 64))[..., None]
    out = np.clip(img * 255.0 + dither, 0.0, 255.0).astype(np.uint8)
    # PNG (lossless): no JPEG block/ringing artifacts around silhouettes,
    # stars, or the horizon line.
    path = os.path.join(OUT_DIR, f"{slug}.png")
    Image.fromarray(out).save(path, optimize=True)
    print(f"wrote {os.path.relpath(path, ROOT)} ({os.path.getsize(path) // 1024} KB)")


# ---------------------------------------------------------------------------
# Preset panoramas. One function per stock preset; names must stay in sync
# with battlePresets.ts via presetBackdrops.ts.
# ---------------------------------------------------------------------------


def large_circle() -> np.ndarray:
    """Open-ocean ring island: calm default sky, stratus banks, far islets."""
    rng = np.random.default_rng(101)
    img = sky_gradient([(90.0, SKY_TOP), (20.0, SKY_MID), (0.0, SKY_HORIZON)])
    paint_cloud_layer(img, rng, 4.0, 14.0, mix(SKY_MID, SUN_CORE, 0.55), mix(SKY_MID, SKY_TOP, 0.3), 0.5, cells_x=12, cells_y=4, max_alpha=0.85)
    paint_cloud_layer(img, rng, 16.0, 30.0, mix(SKY_MID, SUN_COLOR, 0.4), SKY_MID, 0.36, cells_x=7, cells_y=4, max_alpha=0.6)
    far = (harmonic_ridge(rng, range(3, 40), 1.15) * 0.5 + 0.5) * 3.5
    far *= smoothstep(0.3, 0.6, tileable_noise(rng, 6, 1)[H // 2])  # sparse islet clusters
    paint_silhouette(img, far, 0.0, mix(IN_BOUNDS, WATER, 0.4), SKY_HORIZON, 0.78)
    near = (harmonic_ridge(rng, range(2, 28), 1.2) * 0.5 + 0.5) * 6.5
    near *= smoothstep(0.38, 0.68, tileable_noise(rng, 5, 1)[H // 3])
    paint_silhouette(img, near, 0.0, mix(IN_BOUNDS, WATER, 0.25), SKY_HORIZON, 0.58, rim_color=SUN_CORE, rim_strength=0.2, rim_width_deg=0.5)
    paint_horizon_glow(img, mix(SKY_HORIZON, SUN_COLOR, 0.4), 0.16, 2.5)
    below_horizon_sea(img, mix(WATER, SKY_HORIZON, 0.35), OUT_OF_BOUNDS)
    return img


def angels_flat() -> np.ndarray:
    """The default preset: today's gradient, alive — cumulus over soft downs."""
    rng = np.random.default_rng(202)
    img = sky_gradient([(90.0, SKY_TOP), (20.0, SKY_MID), (0.0, SKY_HORIZON)])
    paint_cloud_layer(img, rng, 8.0, 26.0, mix(SUN_CORE, SKY_MID, 0.25), mix(SKY_MID, SKY_TOP, 0.45), 0.42, cells_x=8, cells_y=5, max_alpha=0.85)
    paint_cloud_layer(img, rng, 30.0, 50.0, mix(SKY_MID, SUN_COLOR, 0.2), SKY_MID, 0.3, cells_x=6, cells_y=3, max_alpha=0.45)
    # Gentle rolling downs: broad low-frequency swells, rounded crests.
    far = rounded(harmonic_ridge(rng, range(2, 8), 1.3) * 0.5 + 0.5, 0.85) * 3.8
    paint_silhouette(img, far, 0.0, IN_BOUNDS, SKY_HORIZON, 0.82)
    near = rounded(harmonic_ridge(rng, range(2, 6), 1.25) * 0.5 + 0.5, 0.85) * 6.5
    paint_silhouette(img, near, 0.0, mix(IN_BOUNDS, GROUND, 0.5), SKY_HORIZON, 0.66, rim_color=SUN_CORE, rim_strength=0.22, rim_width_deg=0.5)
    paint_horizon_glow(img, SKY_HORIZON, 0.12, 3.0)
    below_horizon_sea(img, mix(WATER, SKY_HORIZON, 0.3), OUT_OF_BOUNDS)
    return img


def boulder_mountain() -> np.ndarray:
    """Alpine: colder zenith, two ranges of jagged rock, snowlit crests."""
    rng = np.random.default_rng(303)
    img = sky_gradient(
        [(90.0, mix(SKY_TOP, OUT_OF_BOUNDS, 0.18)), (25.0, SKY_MID), (0.0, mix(SKY_HORIZON, SKY_MID, 0.35))]
    )
    paint_cloud_layer(img, rng, 20.0, 42.0, mix(SUN_CORE, SKY_MID, 0.35), mix(SKY_MID, SKY_TOP, 0.5), 0.3, cells_x=7, cells_y=4, max_alpha=0.6)
    haze = mix(SKY_HORIZON, SKY_MID, 0.4)
    far = np.abs(harmonic_ridge(rng, range(3, 48), 1.05)) * 9.5
    paint_silhouette(img, far, 0.0, ROCKS[2], haze, 0.62, rim_color=ROCKS[6], rim_strength=0.3, rim_width_deg=0.9)
    near = np.abs(harmonic_ridge(rng, range(2, 36), 1.0)) * 16.0
    paint_silhouette(img, near, 0.0, ROCKS[1], haze, 0.32, rim_color=mix(ROCKS[6], SUN_CORE, 0.5), rim_strength=0.45, rim_width_deg=1.4)
    # Valley mist pooling on the horizon line.
    mist = np.exp(-np.abs(ELEV_COL - 0.8) / 2.0) * 0.28
    img[:] = img * (1.0 - mist[..., None]) + SKY_MID[None, None, :] * mist[..., None]
    below_horizon_sea(img, mix(WATER, SKY_MID, 0.3), OUT_OF_BOUNDS)
    return img


def spikey_lake() -> np.ndarray:
    """Moody teal lake bowl ringed by needle spires and mist."""
    rng = np.random.default_rng(404)
    img = sky_gradient(
        [
            (90.0, mix(SKY_TOP, WATER, 0.3)),
            (18.0, mix(SKY_MID, WATER, 0.18)),
            (0.0, mix(SKY_HORIZON, SKY_MID, 0.5)),
        ]
    )
    paint_cloud_layer(img, rng, 14.0, 30.0, mix(SKY_MID, CAMERA_CLEAR, 0.5), mix(SKY_MID, WATER, 0.35), 0.36, cells_x=10, cells_y=5, max_alpha=0.55)
    haze = mix(SKY_MID, WATER, 0.2)

    def spikes(profile: np.ndarray, power: float) -> np.ndarray:
        sharp = np.abs(profile) ** power
        m = np.max(sharp)
        return sharp / m if m > 0 else sharp

    far = spikes(harmonic_ridge(rng, range(6, 90), 0.85), 1.9) * 7.0
    far *= 0.4 + 0.6 * smoothstep(0.35, 0.7, tileable_noise(rng, 5, 1)[H // 2])
    paint_silhouette(img, far, 0.0, mix(ROCKS[0], WATER, 0.3), haze, 0.68)
    near = spikes(harmonic_ridge(rng, range(5, 70), 0.8), 2.2) * 14.0
    near *= 0.35 + 0.65 * smoothstep(0.4, 0.75, tileable_noise(rng, 4, 1)[H // 2])
    paint_silhouette(img, near, 0.0, ROCKS[0], haze, 0.42, rim_color=CAMERA_CLEAR, rim_strength=0.35, rim_width_deg=0.7)
    mist = np.exp(-np.abs(ELEV_COL - 0.5) / 1.6) * 0.5
    img[:] = img * (1.0 - mist[..., None]) + mix(SKY_MID, SKY_HORIZON, 0.4)[None, None, :] * mist[..., None]
    below_horizon_sea(img, mix(WATER, SKY_MID, 0.45), WATER)
    return img


def niemo_islands() -> np.ndarray:
    """Warm maritime archipelago: trade-wind rows, island chain, sun-side glow."""
    rng = np.random.default_rng(505)
    img = sky_gradient([(90.0, SKY_TOP), (25.0, SKY_MID), (0.0, SKY_HORIZON)])
    sun_theta = 0.75 * np.pi
    paint_azimuth_glow(img, sun_theta, SUN_HALO, 0.34, 1.1, 14.0)
    paint_cloud_layer(img, rng, 6.0, 16.0, mix(SUN_CORE, SKY_HORIZON, 0.3), mix(SKY_MID, SUN_HALO, 0.25), 0.48, cells_x=11, cells_y=4, max_alpha=0.8)
    paint_cloud_layer(img, rng, 18.0, 32.0, mix(SUN_CORE, SKY_MID, 0.3), SKY_MID, 0.34, cells_x=7, cells_y=4, max_alpha=0.55)
    chain = (harmonic_ridge(rng, range(3, 30), 1.1) * 0.5 + 0.5) * 6.0
    chain *= smoothstep(0.3, 0.6, tileable_noise(rng, 7, 1)[H // 2])
    paint_silhouette(img, chain, 0.0, mix(IN_BOUNDS, GROUND, 0.35), mix(SKY_HORIZON, SUN_HALO, 0.2), 0.58, rim_color=SUN_HALO, rim_strength=0.3, rim_width_deg=0.6)
    close = (harmonic_ridge(rng, range(2, 22), 1.15) * 0.5 + 0.5) * 3.2
    close *= smoothstep(0.45, 0.75, tileable_noise(rng, 9, 1)[H // 2])
    paint_silhouette(img, close, 0.0, IN_BOUNDS, SKY_HORIZON, 0.4, rim_color=SUN_CORE, rim_strength=0.25, rim_width_deg=0.5)
    below_horizon_sea(img, mix(WATER, SKY_HORIZON, 0.4), OUT_OF_BOUNDS)
    # Sun-glint path on the water under the glow azimuth.
    paint_azimuth_glow(img, sun_theta, mix(SUN_HALO, SUN_CORE, 0.5), 0.22, 0.5, 6.0, below_horizon=True)
    return img


def angels_playhouse() -> np.ndarray:
    """Surreal golden hour over colossal terraced towers (BAR gold-sunrise nod)."""
    rng = np.random.default_rng(606)
    img = sky_gradient(
        [
            (90.0, SKY_TOP),
            (45.0, mix(SKY_MID, SUN_COLOR, 0.4)),
            (12.0, SUN_HALO),
            (0.0, SUN_COLOR),
        ]
    )
    glow_theta = 1.35 * np.pi
    paint_azimuth_glow(img, glow_theta, mix(SUN_HALO, SUN_CORE, 0.4), 0.3, 1.4, 20.0)
    paint_cloud_layer(img, rng, 35.0, 60.0, mix(SUN_CORE, SKY_MID, 0.4), mix(SKY_MID, SUN_HALO, 0.4), 0.3, cells_x=6, cells_y=3, max_alpha=0.45)
    paint_cloud_layer(img, rng, 10.0, 24.0, mix(SUN_CORE, SUN_HALO, 0.35), mix(SUN_HALO, GROUND_PRINT, 0.35), 0.32, cells_x=9, cells_y=4, max_alpha=0.6)
    haze = mix(SUN_HALO, SUN_COLOR, 0.5)
    # Sweeping organic highlands in three depths — flowing rounded
    # ridgelines with golden rim light, no hard geometry.
    farthest = rounded(harmonic_ridge(rng, range(2, 10), 1.2) * 0.5 + 0.5, 0.9) * 5.5
    paint_silhouette(img, farthest, 0.0, mix(ROCKS[7], SUN_HALO, 0.3), haze, 0.74, rim_color=SUN_CORE, rim_strength=0.25, rim_width_deg=0.7)
    behind = rounded(harmonic_ridge(rng, range(2, 12), 1.15) * 0.5 + 0.5, 0.82) * 9.0
    paint_silhouette(img, behind, 0.0, mix(ROCKS[7], GROUND_PRINT, 0.4), haze, 0.58, rim_color=SUN_CORE, rim_strength=0.4, rim_width_deg=0.8)
    sweep = rounded(harmonic_ridge(rng, range(2, 7), 1.05) * 0.5 + 0.5, 0.75) * 15.0
    paint_silhouette(img, sweep, 0.0, mix(GROUND_PRINT, ROCKS[7], 0.35), haze, 0.36, rim_color=SUN_CORE, rim_strength=0.6, rim_width_deg=1.1)
    below_horizon_sea(img, mix(WATER, SUN_HALO, 0.35), OUT_OF_BOUNDS)
    return img


def metal_hell() -> np.ndarray:
    """Ember world: smoke sky, lava-lit horizon, backlit slag ridges."""
    rng = np.random.default_rng(707)
    img = sky_gradient(
        [
            (90.0, OUT_OF_BOUNDS),
            (35.0, mix(OUT_OF_BOUNDS, BURN_HOT, 0.35)),
            (8.0, LAVA),
            (0.0, mix(LAVA, SUN_HALO, 0.35)),
        ]
    )
    paint_cloud_layer(img, rng, 15.0, 45.0, mix(BURN_RESIDUE, LAVA, 0.35), mix(OUT_OF_BOUNDS, BURN_RESIDUE, 0.5), 0.44, cells_x=8, cells_y=5, max_alpha=0.8)
    paint_cloud_layer(img, rng, 4.0, 12.0, mix(LAVA, SUN_HALO, 0.25), BURN_RESIDUE, 0.4, cells_x=13, cells_y=3, max_alpha=0.6)
    glow = mix(LAVA, SUN_HALO, 0.45)
    far = np.abs(harmonic_ridge(rng, range(3, 44), 1.0)) * 4.5
    paint_silhouette(img, far, 0.0, mix(GROUND_PRINT, BURN_RESIDUE, 0.5), mix(LAVA, BURN_RESIDUE, 0.35), 0.5, rim_color=glow, rim_strength=0.5, rim_width_deg=0.8)
    near = np.abs(harmonic_ridge(rng, range(2, 32), 0.95)) * 7.5
    paint_silhouette(img, near, 0.0, GROUND_PRINT, BURN_RESIDUE, 0.22, rim_color=glow, rim_strength=0.75, rim_width_deg=1.0)
    paint_horizon_glow(img, glow, 0.3, 2.0)
    paint_embers(img, rng, 900, 10.0)
    below_horizon_sea(img, LAVA, BURN_RESIDUE)
    return img


def metal_plate() -> np.ndarray:
    """Sterile plate under deep space: starfield, nebula wisps, cold rim (BAR space-skybox nod)."""
    rng = np.random.default_rng(808)
    img = sky_gradient(
        [
            (90.0, mix(OUT_OF_BOUNDS, np.zeros(3), 0.45)),
            (30.0, OUT_OF_BOUNDS),
            (6.0, mix(OUT_OF_BOUNDS, SKY_TOP, 0.45)),
            (0.0, CAMERA_CLEAR),
        ]
    )
    # Nebula wisps, faint and cool.
    neb = tileable_noise(rng, 5, 3, octaves=5)
    neb_alpha = smoothstep(0.62, 0.95, neb) * smoothstep(5.0, 30.0, ELEV_COL) * 0.35
    img[:] = img * (1.0 - neb_alpha[..., None]) + mix(SKY_TOP, CAMERA_CLEAR, 0.5)[None, None, :] * neb_alpha[..., None]
    star_layer = np.zeros((H, W, 3))
    paint_stars(star_layer, rng, 2600, 2.0)
    star_visibility = smoothstep(2.0, 12.0, ELEV_COL)
    img[:] = np.clip(img + star_layer * star_visibility[..., None], 0.0, 1.0)
    # Razor-thin cold horizon line: the edge of the plate world.
    line = np.exp(-((ELEV_COL - 0.35) ** 2) / 0.18) * 0.55
    img[:] = np.clip(img + SKY_MID[None, None, :] * line[..., None], 0.0, 1.0)
    below_horizon_sea(img, mix(WATER, CAMERA_CLEAR, 0.25), mix(OUT_OF_BOUNDS, np.zeros(3), 0.5))
    return img


# slug -> (painter, soft-focus blur radius). The metal worlds keep a
# tighter blur so the starfield and razor horizon line stay defined.
PRESETS = {
    "large-circle": (large_circle, DEFAULT_BLUR_RADIUS),
    "angels-flat": (angels_flat, DEFAULT_BLUR_RADIUS),
    "boulder-mountain": (boulder_mountain, DEFAULT_BLUR_RADIUS),
    "spikey-lake": (spikey_lake, DEFAULT_BLUR_RADIUS),
    "niemo-islands": (niemo_islands, DEFAULT_BLUR_RADIUS),
    "angels-playhouse": (angels_playhouse, DEFAULT_BLUR_RADIUS),
    "metal-hell": (metal_hell, 4),
    "metal-plate": (metal_plate, 3),
}


def main() -> None:
    for slug, (fn, blur_radius) in PRESETS.items():
        save(fn(), slug, blur_radius)


if __name__ == "__main__":
    main()
