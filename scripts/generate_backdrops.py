#!/usr/bin/env python3
"""Generate four-layer UASTC KTX2 panoramas for every stock battle preset.

Each preset emits coordinated equirectangular textures named
``<slug>-near/middle/far/terminal.ktx2``. The first three are RGBA scenery and
cloud layers with transparent skies, soft skyline alpha, and progressively
stronger atmospheric blur. The terminal layer is fully opaque and owns the
complete sky; stars are deliberately painted only there.

The lossless image assembled by Python is written only to a temporary directory
and encoded as UASTC with Zstandard supercompression. No runtime PNG is kept.
An input fingerprint makes ordinary dev/build runs reuse current KTX2 assets;
pass ``--force`` to rebuild them unconditionally.

The renderer intersects world-space camera rays with four map-centered
spheres at the distances authored in ``src/worldRenderConfig.json``. Keeping
generation IDs, blur radii, and texture widths in that shared config prevents
the assets and renderer from silently drifting apart.

Every image is horizontally seamless: azimuthal detail uses integer-frequency
harmonics or x-wrapped value noise, and the blur wraps in x. Colors are derived
from ``src/colorsConfig.json``.

Usage: python3 scripts/generate_backdrops.py [--force]
Requires: numpy, Pillow, and the pinned ``basisu`` npm dev dependency.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "public", "assets", "backdrops")
MANIFEST_PATH = os.path.join(OUT_DIR, "manifest.json")
COLORS_CONFIG_PATH = os.path.join(ROOT, "src", "colorsConfig.json")
WORLD_RENDER_CONFIG_PATH = os.path.join(ROOT, "src", "worldRenderConfig.json")
BASISU_PACKAGE_PATH = os.path.join(ROOT, "node_modules", "basisu", "package.json")
BASISU_LAUNCHER_PATH = os.path.join(ROOT, "node_modules", "basisu", "bin", "basisu.js")
THREE_BASIS_SOURCE_DIR = os.path.join(
    ROOT, "node_modules", "three", "examples", "jsm", "libs", "basis"
)
PUBLIC_BASIS_DIR = os.path.join(ROOT, "public", "assets", "basis")

# Bump this whenever painter, blur, compositing, resizing, or encoder behavior
# changes the resulting pixels/blocks. Build plumbing and audit-only edits do
# not invalidate several minutes of deterministic texture generation.
BACKDROP_VISUAL_REVISION = 1

ENCODING_SETTINGS = {
    "container": "KTX2",
    "supercompressionFormat": "UASTC",
    "supercompressionScheme": "Zstandard",
    "uastcLevel": 2,
    "uastcRdoLambda": 0.75,
    "zstandardLevel": 9,
    "mipmapLevels": 1,
    "yFlippedForThreeJsUv": True,
}

with open(COLORS_CONFIG_PATH) as f:
    COLORS = json.load(f)["world"]
with open(WORLD_RENDER_CONFIG_PATH) as f:
    BACKDROP_CONFIG = json.load(f)["presetBackdrop"]

BACKDROP_PALETTE_CONFIG = {
    "skyTop": COLORS["sky"]["topColor"],
    "skyMid": COLORS["sky"]["midColor"],
    "skyHorizon": COLORS["sky"]["horizonColor"],
    "water": COLORS["water"]["colorHex"],
    "lava": COLORS["water"]["lava"]["colorHex"],
    "outOfBounds": COLORS["map"]["outOfBounds"]["colorHex"],
    "cameraClear": COLORS["map"]["cameraClear"]["colorHex"],
    "inBounds": COLORS["map"]["inBounds"]["colorHex"],
    "sunCore": COLORS["sun"]["visibleSkyDisk"]["coreColor"],
    "sunHalo": COLORS["sun"]["visibleSkyDisk"]["haloColor"],
    "sun": COLORS["sun"]["colorHex"],
    "ground": COLORS["terrain"]["ground"]["baseColorHex"],
    "rocks": COLORS["terrain"]["rock"]["shadePaletteRgb"],
    "burnHot": COLORS["burnMark"]["hotColorHex"],
    "burnResidue": COLORS["burnMark"]["coolResidueColorHex"],
    "groundPrint": COLORS["groundPrint"]["colorHex"],
}

LAYER_CONFIGS = BACKDROP_CONFIG["layers"]
LAYER_IDS = ("near", "middle", "far", "terminal")
if tuple(layer["id"] for layer in LAYER_CONFIGS) != LAYER_IDS:
    raise ValueError(f"presetBackdrop.layers must be ordered {LAYER_IDS}")
if len(LAYER_CONFIGS) != 4:
    raise ValueError("presetBackdrop.layers must contain exactly four layers")
blur_radii = [layer["blurRadiusPixels"] for layer in LAYER_CONFIGS]
if any(a >= b for a, b in zip(blur_radii, blur_radii[1:])):
    raise ValueError("preset backdrop blur radii must increase with distance")
minimum_distances = [layer["minimumDistanceWorldUnits"] for layer in LAYER_CONFIGS]
distance_factors = [layer["distanceMapFactor"] for layer in LAYER_CONFIGS]
if any(a >= b for a, b in zip(minimum_distances, minimum_distances[1:])):
    raise ValueError("preset backdrop minimum distances must increase")
if any(a >= b for a, b in zip(distance_factors, distance_factors[1:])):
    raise ValueError("preset backdrop map-distance factors must increase")

W = max(int(layer["textureWidth"]) for layer in LAYER_CONFIGS)
if W <= 0 or W % 2 != 0:
    raise ValueError("preset backdrop texture widths must be positive even integers")
H = W // 2


def hx(s: str) -> np.ndarray:
    s = s.lstrip("#")
    return np.array([int(s[i : i + 2], 16) for i in (0, 2, 4)], dtype=np.float32) / 255.0


def mix(a: np.ndarray, b: np.ndarray, t: float) -> np.ndarray:
    return (a * (1.0 - t) + b * t).astype(np.float32)


SKY_TOP = hx(BACKDROP_PALETTE_CONFIG["skyTop"])
SKY_MID = hx(BACKDROP_PALETTE_CONFIG["skyMid"])
SKY_HORIZON = hx(BACKDROP_PALETTE_CONFIG["skyHorizon"])
WATER = hx(BACKDROP_PALETTE_CONFIG["water"])
LAVA = hx(BACKDROP_PALETTE_CONFIG["lava"])
OUT_OF_BOUNDS = hx(BACKDROP_PALETTE_CONFIG["outOfBounds"])
CAMERA_CLEAR = hx(BACKDROP_PALETTE_CONFIG["cameraClear"])
IN_BOUNDS = hx(BACKDROP_PALETTE_CONFIG["inBounds"])
SUN_CORE = hx(BACKDROP_PALETTE_CONFIG["sunCore"])
SUN_HALO = hx(BACKDROP_PALETTE_CONFIG["sunHalo"])
SUN_COLOR = hx(BACKDROP_PALETTE_CONFIG["sun"])
GROUND = hx(BACKDROP_PALETTE_CONFIG["ground"])
ROCKS = [hx(c) for c in BACKDROP_PALETTE_CONFIG["rocks"]]
BURN_HOT = hx(BACKDROP_PALETTE_CONFIG["burnHot"])
BURN_RESIDUE = hx(BACKDROP_PALETTE_CONFIG["burnResidue"])
GROUND_PRINT = hx(BACKDROP_PALETTE_CONFIG["groundPrint"])

# Angular grids. theta is azimuth [0, 2pi); ELEV is +90 top to -90 bottom.
THETA = np.linspace(0.0, 2.0 * np.pi, W, endpoint=False, dtype=np.float32)
ELEV = np.linspace(90.0, -90.0, H, dtype=np.float32)
ELEV_COL = ELEV[:, None]


def smoothstep(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return (t * t * (3.0 - 2.0 * t)).astype(np.float32)


def harmonic_ridge(rng: np.random.Generator, harmonics: range, decay: float) -> np.ndarray:
    """Periodic 1D ridge profile in [-1, 1], seamless across theta = 0."""
    out = np.zeros(W, dtype=np.float32)
    for k in harmonics:
        amp = k ** -decay
        phase = rng.uniform(0.0, 2.0 * np.pi)
        out += (amp * np.sin(k * THETA + phase)).astype(np.float32)
    m = float(np.max(np.abs(out)))
    return out / m if m > 0 else out


def tileable_noise(
    rng: np.random.Generator,
    cells_x: int,
    cells_y: int,
    octaves: int = 4,
) -> np.ndarray:
    """2D value noise, W x H, wrapped in x (seamless), in [0, 1]."""
    total = np.zeros((H, W), dtype=np.float32)
    amp_sum = 0.0
    for octave_index in range(octaves):
        cx = cells_x * (2 ** octave_index)
        cy = cells_y * (2 ** octave_index)
        grid = rng.random((cy + 1, cx), dtype=np.float32)
        xs = np.linspace(0.0, cx, W, endpoint=False, dtype=np.float32)
        ys = np.linspace(0.0, cy, H, dtype=np.float32)
        xi = np.floor(xs).astype(np.int32) % cx
        yi = np.clip(np.floor(ys).astype(np.int32), 0, cy - 1)
        xf = xs - np.floor(xs)
        yf = ys - np.floor(ys)
        xf = xf * xf * (3.0 - 2.0 * xf)
        yf = yf * yf * (3.0 - 2.0 * yf)
        g00 = grid[np.ix_(yi, xi)]
        g10 = grid[np.ix_(yi, (xi + 1) % cx)]
        g01 = grid[np.ix_(yi + 1, xi)]
        g11 = grid[np.ix_(yi + 1, (xi + 1) % cx)]
        top = g00 * (1.0 - xf[None, :]) + g10 * xf[None, :]
        bottom = g01 * (1.0 - xf[None, :]) + g11 * xf[None, :]
        amplitude = 0.5 ** octave_index
        total += (top * (1.0 - yf[:, None]) + bottom * yf[:, None]) * amplitude
        amp_sum += amplitude
    return total / amp_sum


def sky_gradient(stops: list[tuple[float, np.ndarray]]) -> np.ndarray:
    """Opaque RGB vertical gradient from elevation/color stops."""
    img = np.zeros((H, W, 3), dtype=np.float32)
    elevations = np.array([stop[0] for stop in stops], dtype=np.float32)
    for channel in range(3):
        values = np.array([stop[1][channel] for stop in stops], dtype=np.float32)
        column = np.interp(ELEV, elevations[::-1], values[::-1]).astype(np.float32)
        img[:, :, channel] = column[:, None]
    return img


def make_layers(terminal: np.ndarray) -> list[np.ndarray]:
    return [
        np.zeros((H, W, 4), dtype=np.float32),
        np.zeros((H, W, 4), dtype=np.float32),
        np.zeros((H, W, 4), dtype=np.float32),
        terminal,
    ]


def composite_rgba(
    destination: np.ndarray,
    source_rgb: np.ndarray,
    source_alpha: np.ndarray,
) -> None:
    """Straight-alpha source-over composition into one transparent layer."""
    alpha = np.clip(source_alpha, 0.0, 1.0).astype(np.float32, copy=False)
    dst_alpha = destination[:, :, 3]
    inverse = 1.0 - alpha
    out_alpha = alpha + dst_alpha * inverse
    numerator = (
        source_rgb * alpha[:, :, None]
        + destination[:, :, :3] * (dst_alpha * inverse)[:, :, None]
    )
    np.divide(
        numerator,
        out_alpha[:, :, None],
        out=destination[:, :, :3],
        where=out_alpha[:, :, None] > 1.0e-7,
    )
    destination[:, :, 3] = out_alpha


def paint_silhouette_layer(
    layer: np.ndarray,
    ridge_deg: np.ndarray,
    base_deg: float,
    color: np.ndarray,
    haze_color: np.ndarray,
    haze: float,
    *,
    top_feather_deg: float,
    atmosphere_alpha: float,
    rim_color: np.ndarray | None = None,
    rim_strength: float = 0.0,
    rim_width_deg: float = 0.5,
) -> None:
    """Paint a solid lower body with a translucent atmospheric skyline.

    The color is increasingly haze-mixed toward its base, the top few degrees
    feather from transparent to opaque, and a low-alpha veil straddles the
    skyline to soften layers behind it like distance smoke.
    """
    ridge = ridge_deg[None, :].astype(np.float32, copy=False)
    inside = (ELEV_COL <= ridge) & (ELEV_COL >= base_deg)
    ridge_height = np.maximum(ridge - base_deg, 1.0e-5)
    toward_base = np.clip((ridge - ELEV_COL) / ridge_height, 0.0, 1.0)
    haze_map = np.clip(haze + toward_base * 0.12, 0.0, 0.96)
    fill = (
        color[None, None, :] * (1.0 - haze_map[:, :, None])
        + haze_color[None, None, :] * haze_map[:, :, None]
    ).astype(np.float32)

    veil_width = max(0.35, top_feather_deg * 1.7)
    veil_alpha = (
        np.exp(-np.abs(ELEV_COL - ridge) / veil_width)
        * atmosphere_alpha
        * (ELEV_COL >= base_deg - veil_width)
    ).astype(np.float32)
    composite_rgba(layer, haze_color[None, None, :], veil_alpha)

    depth_below_top = np.maximum(ridge - ELEV_COL, 0.0)
    body_alpha = smoothstep(0.0, top_feather_deg, depth_below_top) * inside
    composite_rgba(layer, fill, body_alpha)

    if rim_color is not None and rim_strength > 0.0:
        rim_alpha = (
            np.clip(1.0 - depth_below_top / rim_width_deg, 0.0, 1.0)
            * rim_strength
            * inside
        ).astype(np.float32)
        composite_rgba(layer, rim_color[None, None, :], rim_alpha)


def cloud_field(
    rng: np.random.Generator,
    lo_deg: float,
    hi_deg: float,
    coverage: float,
    cells_x: int,
    cells_y: int,
    softness: float,
) -> tuple[np.ndarray, np.ndarray]:
    noise_full = tileable_noise(rng, cells_x, cells_y)
    local_v = np.clip((ELEV - lo_deg) / (hi_deg - lo_deg), 0.0, 1.0)
    rows = np.clip(((1.0 - local_v) * (H - 1)).astype(np.int32), 0, H - 1)
    noise = noise_full[rows, :]
    band = smoothstep(lo_deg, lo_deg + (hi_deg - lo_deg) * 0.35, ELEV_COL) * (
        1.0 - smoothstep(hi_deg - (hi_deg - lo_deg) * 0.35, hi_deg, ELEV_COL)
    )
    alpha = smoothstep(1.0 - coverage, 1.0 - coverage + softness, noise) * band
    return alpha.astype(np.float32), smoothstep(lo_deg, hi_deg, ELEV_COL)


def paint_cloud_layer(
    layer: np.ndarray,
    rng: np.random.Generator,
    lo_deg: float,
    hi_deg: float,
    color: np.ndarray,
    shade_color: np.ndarray,
    coverage: float,
    *,
    cells_x: int = 10,
    cells_y: int = 5,
    softness: float = 0.16,
    max_alpha: float = 0.85,
) -> None:
    """Paint one soft, transparent cloud band into any parallax layer."""
    alpha, vertical = cloud_field(
        rng, lo_deg, hi_deg, coverage, cells_x, cells_y, softness
    )
    cloud_color = (
        shade_color[None, None, :] * (1.0 - vertical[:, :, None] * 0.9)
        + color[None, None, :] * (vertical[:, :, None] * 0.9)
    ).astype(np.float32)
    composite_rgba(layer, cloud_color, alpha * max_alpha)


def paint_haze_band(
    layer: np.ndarray,
    color: np.ndarray,
    center_deg: float,
    height_deg: float,
    max_alpha: float,
) -> None:
    alpha = np.exp(-np.abs(ELEV_COL - center_deg) / height_deg) * max_alpha
    composite_rgba(layer, color[None, None, :], alpha.astype(np.float32))


def paint_horizon_glow(
    img: np.ndarray,
    color: np.ndarray,
    strength: float,
    height_deg: float,
) -> None:
    glow = np.exp(-np.abs(ELEV_COL) / height_deg) * strength
    img[:] = np.clip(img + color[None, None, :] * glow[:, :, None], 0.0, 1.0)


def paint_azimuth_glow(
    img: np.ndarray,
    center_theta: float,
    color: np.ndarray,
    strength: float,
    angular_width: float,
    height_deg: float,
    below_horizon: bool = False,
) -> None:
    """Warm directional glow; the scene still draws the hard sun disk."""
    distance = np.abs(((THETA - center_theta + np.pi) % (2.0 * np.pi)) - np.pi)
    azimuth = np.exp(-((distance / angular_width) ** 2))[None, :]
    if below_horizon:
        vertical = np.exp(-np.abs(ELEV_COL) / height_deg)
    else:
        vertical = (
            np.exp(-np.clip(ELEV_COL, 0.0, None) / height_deg)
            * (ELEV_COL >= -2.0)
        )
    glow = azimuth * vertical * strength
    img[:] = np.clip(img + color[None, None, :] * glow[:, :, None], 0.0, 1.0)


def _gauss_kernel(sigma: float) -> np.ndarray:
    radius = max(1, int(np.ceil(sigma * 3.0)))
    axis = np.arange(-radius, radius + 1, dtype=np.float32)
    kernel = np.exp(
        -(axis[:, None] ** 2 + axis[None, :] ** 2) / (2.0 * sigma * sigma)
    )
    return (kernel / kernel.max()).astype(np.float32)


def _splat_rgb(
    img: np.ndarray,
    y: int,
    x: int,
    kernel: np.ndarray,
    color: np.ndarray,
    strength: float,
) -> None:
    radius = kernel.shape[0] // 2
    ys = np.arange(y - radius, y + radius + 1)
    xs = np.arange(x - radius, x + radius + 1) % W
    valid = (ys >= 0) & (ys < H)
    if np.any(valid):
        img[np.ix_(ys[valid], xs)] += (
            kernel[valid][:, :, None] * color[None, None, :] * strength
        )


def _splat_rgba(
    layer: np.ndarray,
    y: int,
    x: int,
    kernel: np.ndarray,
    color: np.ndarray,
    strength: float,
) -> None:
    radius = kernel.shape[0] // 2
    ys = np.arange(y - radius, y + radius + 1)
    xs = np.arange(x - radius, x + radius + 1) % W
    valid = (ys >= 0) & (ys < H)
    if not np.any(valid):
        return
    yv = ys[valid]
    patch = layer[np.ix_(yv, xs)].copy()
    alpha = np.clip(kernel[valid] * strength, 0.0, 1.0)
    local_color = np.broadcast_to(color, patch[:, :, :3].shape)
    local_dst_alpha = patch[:, :, 3]
    inverse = 1.0 - alpha
    out_alpha = alpha + local_dst_alpha * inverse
    numerator = (
        local_color * alpha[:, :, None]
        + patch[:, :, :3] * (local_dst_alpha * inverse)[:, :, None]
    )
    np.divide(
        numerator,
        out_alpha[:, :, None],
        out=patch[:, :, :3],
        where=out_alpha[:, :, None] > 1.0e-7,
    )
    patch[:, :, 3] = out_alpha
    layer[np.ix_(yv, xs)] = patch


def paint_stars(
    terminal: np.ndarray,
    rng: np.random.Generator,
    count: int,
    min_elev_deg: float,
    max_strength: float = 0.9,
) -> None:
    """Paint stars into the terminal layer only."""
    dot = _gauss_kernel(2.2)
    bright = _gauss_kernel(3.2)
    white = np.ones(3, dtype=np.float32)
    for _ in range(count):
        x = int(rng.integers(0, W))
        y = int(rng.uniform(0.0, (90.0 - min_elev_deg) / 180.0) * H)
        strength = rng.uniform(0.25, max_strength)
        kernel = bright if rng.random() < 0.18 else dot
        _splat_rgb(terminal, y, x, kernel, white, strength * (1.3 if kernel is bright else 1.0))
    np.clip(terminal, 0.0, 1.0, out=terminal)


def paint_embers(
    layer: np.ndarray,
    rng: np.random.Generator,
    count: int,
    max_elev_deg: float,
) -> None:
    """Embers are local particles, so unlike stars they may parallax."""
    dot = _gauss_kernel(1.7)
    for _ in range(count):
        x = int(rng.integers(0, W))
        elevation = rng.uniform(0.5, max_elev_deg)
        y = int((90.0 - elevation) / 180.0 * H)
        strength = rng.uniform(0.15, 0.55) * (1.0 - elevation / max_elev_deg)
        _splat_rgba(layer, y, x, dot, SUN_HALO, strength)


def below_horizon_sea(img: np.ndarray, surface: np.ndarray, deep: np.ndarray) -> None:
    """Fully cover the terminal layer below the authored horizon."""
    below = ELEV_COL < 0.0
    depth = np.clip(-ELEV_COL / 30.0, 0.0, 1.0)
    fill = (
        surface[None, None, :] * (1.0 - depth[:, :, None])
        + deep[None, None, :] * depth[:, :, None]
    )
    img[:] = np.where(below[:, :, None], fill, img)


def rounded(profile01: np.ndarray, exponent: float = 0.8) -> np.ndarray:
    return np.clip(profile01, 0.0, 1.0) ** exponent


def tree_topped_ridge(
    rng: np.random.Generator,
    base_profile: np.ndarray,
    tree_height_deg: float,
) -> np.ndarray:
    """Add a seamless fine conifer-like crown to a broad ridge."""
    crown = np.abs(harmonic_ridge(rng, range(24, 150), 0.72)) ** 4.5
    return base_profile + crown * tree_height_deg


def _box_blur_x(img: np.ndarray, radius: int) -> np.ndarray:
    pad = np.concatenate([img[:, -radius:], img, img[:, :radius]], axis=1)
    cumulative = np.cumsum(pad, axis=1, dtype=np.float32)
    cumulative = np.concatenate([np.zeros_like(cumulative[:, :1]), cumulative], axis=1)
    return (
        cumulative[:, 2 * radius + 1 :] - cumulative[:, : -(2 * radius + 1)]
    ) / (2 * radius + 1)


def _box_blur_y(img: np.ndarray, radius: int) -> np.ndarray:
    pad = np.concatenate(
        [img[:1].repeat(radius, axis=0), img, img[-1:].repeat(radius, axis=0)],
        axis=0,
    )
    cumulative = np.cumsum(pad, axis=0, dtype=np.float32)
    cumulative = np.concatenate([np.zeros_like(cumulative[:1]), cumulative], axis=0)
    return (
        cumulative[2 * radius + 1 :] - cumulative[: -(2 * radius + 1)]
    ) / (2 * radius + 1)


def soft_focus(img: np.ndarray, radius: int) -> np.ndarray:
    if radius <= 0:
        return img
    out = img
    for _ in range(3):
        out = _box_blur_y(_box_blur_x(out, radius), radius)
    return out


def soft_focus_layer(img: np.ndarray, radius: int) -> np.ndarray:
    if img.shape[2] == 3:
        return soft_focus(img, radius)
    # Blur premultiplied RGB and alpha together, then return straight alpha.
    premultiplied = np.empty_like(img)
    premultiplied[:, :, :3] = img[:, :, :3] * img[:, :, 3:4]
    premultiplied[:, :, 3] = img[:, :, 3]
    blurred = soft_focus(premultiplied, radius)
    alpha = blurred[:, :, 3:4]
    # Float32 cumulative blur can leave sub-byte cancellation residue where
    # both alpha and premultiplied color should be zero. Constrain RGB to the
    # legal premultiplied range and do not unpremultiply alpha that will
    # quantize to zero; otherwise those tiny values become colored fringes.
    blurred[:, :, :3] = np.clip(blurred[:, :, :3], 0.0, alpha)
    out = np.zeros_like(blurred)
    np.divide(
        blurred[:, :, :3],
        alpha,
        out=out[:, :, :3],
        where=alpha > (0.5 / 255.0),
    )
    out[:, :, 3] = alpha[:, :, 0]
    return out


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical_json_bytes(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def file_sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def generation_contract() -> dict[str, object]:
    if not os.path.isfile(BASISU_PACKAGE_PATH) or not os.path.isfile(BASISU_LAUNCHER_PATH):
        raise RuntimeError(
            "Missing the pinned basisu encoder. Run npm install before generating backdrops."
        )
    with open(BASISU_PACKAGE_PATH) as source:
        basisu_version = json.load(source)["version"]
    input_hashes = {
        "backdropPaletteSha256": sha256_bytes(
            canonical_json_bytes(BACKDROP_PALETTE_CONFIG)
        ),
        "presetBackdropConfigSha256": sha256_bytes(
            canonical_json_bytes(BACKDROP_CONFIG)
        ),
    }
    contract = {
        "schemaVersion": 1,
        "inputHashes": input_hashes,
        "generator": {"visualRevision": BACKDROP_VISUAL_REVISION},
        "encoder": {"package": "basisu", "version": basisu_version},
        "encoding": ENCODING_SETTINGS,
    }
    return {
        **contract,
        "fingerprint": sha256_bytes(canonical_json_bytes(contract)),
    }


def expected_asset_names() -> list[str]:
    return [
        f"{slug}-{layer_id}.ktx2"
        for slug in PRESETS
        for layer_id in LAYER_IDS
    ]


def current_manifest(contract: dict[str, object]) -> dict[str, object] | None:
    try:
        with open(MANIFEST_PATH) as source:
            manifest = json.load(source)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    if manifest.get("fingerprint") != contract["fingerprint"]:
        return None
    assets = manifest.get("assets")
    if not isinstance(assets, list):
        return None
    expected_names = expected_asset_names()
    if [asset.get("file") for asset in assets] != expected_names:
        return None
    for asset in assets:
        path = os.path.join(OUT_DIR, asset["file"])
        if not os.path.isfile(path) or file_sha256(path) != asset.get("sha256"):
            return None
    if any(name.endswith(".png") for name in os.listdir(OUT_DIR)):
        return None
    return manifest


def basisu_command(source_path: str, output_path: str, has_alpha: bool) -> list[str]:
    node = shutil.which("node")
    if node is None:
        raise RuntimeError("Node.js is required to run the pinned basisu encoder")
    alpha_flag = "-force_alpha" if has_alpha else "-no_alpha"
    return [
        node,
        BASISU_LAUNCHER_PATH,
        "-ktx2",
        "-uastc",
        "-uastc_level",
        str(ENCODING_SETTINGS["uastcLevel"]),
        "-uastc_rdo_l",
        str(ENCODING_SETTINGS["uastcRdoLambda"]),
        "-uastc_rdo_m",
        "-ktx2_zstandard_level",
        str(ENCODING_SETTINGS["zstandardLevel"]),
        "-y_flip",
        alpha_flag,
        "-file",
        source_path,
        "-output_file",
        output_path,
    ]


def encode_layer(
    img: np.ndarray,
    slug: str,
    index: int,
    temporary_directory: str,
) -> dict[str, object]:
    config = LAYER_CONFIGS[index]
    layer_id = config["id"]
    terminal = layer_id == "terminal"
    if terminal:
        if img.shape != (H, W, 3):
            raise ValueError(f"{slug} terminal layer must be opaque RGB")
    else:
        if img.shape != (H, W, 4):
            raise ValueError(f"{slug} {layer_id} layer must be RGBA")
        alpha = img[:, :, 3]
        if float(alpha.max()) <= 0.0 or float(alpha.min()) >= 1.0:
            raise ValueError(f"{slug} {layer_id} must contain scenery and transparency")
        if float(np.mean(alpha[: H // 8])) > 0.25:
            raise ValueError(f"{slug} {layer_id} upper sky is not sufficiently transparent")

    focused = soft_focus_layer(img, int(config["blurRadiusPixels"]))
    tile = np.random.default_rng(999 + index).uniform(-0.5, 0.5, (64, 64)).astype(np.float32)
    dither = np.tile(tile, (H // 64, W // 64))[:, :, None]
    rgb = np.clip(focused[:, :, :3] * 255.0 + dither, 0.0, 255.0).astype(np.uint8)
    if terminal:
        out = rgb
    else:
        alpha8 = np.clip(focused[:, :, 3:4] * 255.0 + 0.5, 0.0, 255.0).astype(np.uint8)
        out = np.concatenate([rgb, alpha8], axis=2)

    image = Image.fromarray(out)
    target_width = int(config["textureWidth"])
    if target_width != W:
        image = image.resize((target_width, target_width // 2), Image.Resampling.LANCZOS)
    os.makedirs(OUT_DIR, exist_ok=True)
    asset_name = f"{slug}-{layer_id}.ktx2"
    source_path = os.path.join(temporary_directory, f"{slug}-{layer_id}.png")
    encoded_path = os.path.join(temporary_directory, asset_name)
    final_path = os.path.join(OUT_DIR, asset_name)
    # This PNG is an encoder interchange file only. Low DEFLATE effort keeps
    # generation quick; it never enters public/ or the application bundle.
    image.save(source_path, compress_level=1)
    completed = subprocess.run(
        basisu_command(source_path, encoded_path, not terminal),
        cwd=ROOT,
        text=True,
        capture_output=True,
    )
    if completed.returncode != 0 or not os.path.isfile(encoded_path):
        detail = (completed.stderr or completed.stdout).strip()
        raise RuntimeError(f"basisu failed for {asset_name}: {detail}")
    os.replace(encoded_path, final_path)
    size = os.path.getsize(final_path)
    print(f"wrote {os.path.relpath(final_path, ROOT)} ({size // 1024} KB)")
    return {
        "file": asset_name,
        "slug": slug,
        "layer": layer_id,
        "width": target_width,
        "height": target_width // 2,
        "hasAlpha": not terminal,
        "bytes": size,
        "sha256": file_sha256(final_path),
    }


# ---------------------------------------------------------------------------
# Preset painters. Return [near RGBA, middle RGBA, far RGBA, terminal RGB].
# Stars are only ever introduced by metal_plate(), directly into terminal.
# ---------------------------------------------------------------------------


def large_circle() -> list[np.ndarray]:
    rng = np.random.default_rng(101)
    layers = make_layers(sky_gradient([(90.0, SKY_TOP), (20.0, SKY_MID), (0.0, SKY_HORIZON)]))
    terminal = layers[3]
    paint_horizon_glow(terminal, mix(SKY_HORIZON, SUN_COLOR, 0.4), 0.16, 2.5)
    below_horizon_sea(terminal, mix(WATER, SKY_HORIZON, 0.35), OUT_OF_BOUNDS)

    far = (harmonic_ridge(rng, range(4, 48), 1.12) * 0.5 + 0.5) * 3.0
    far *= smoothstep(0.28, 0.62, tileable_noise(rng, 7, 1)[H // 2])
    paint_silhouette_layer(layers[2], far, 0.0, mix(IN_BOUNDS, WATER, 0.52), SKY_HORIZON, 0.82, top_feather_deg=1.5, atmosphere_alpha=0.16)
    paint_cloud_layer(layers[2], rng, 19.0, 34.0, mix(SKY_MID, SUN_COLOR, 0.4), SKY_MID, 0.35, cells_x=7, cells_y=4, max_alpha=0.5)

    middle = (harmonic_ridge(rng, range(3, 36), 1.16) * 0.5 + 0.5) * 4.8
    middle *= smoothstep(0.34, 0.66, tileable_noise(rng, 6, 1)[H // 3])
    paint_silhouette_layer(layers[1], middle, 0.0, mix(IN_BOUNDS, WATER, 0.38), SKY_HORIZON, 0.68, top_feather_deg=1.1, atmosphere_alpha=0.12)
    paint_cloud_layer(layers[1], rng, 7.0, 17.0, mix(SKY_MID, SUN_CORE, 0.55), mix(SKY_MID, SKY_TOP, 0.3), 0.48, cells_x=12, cells_y=4, max_alpha=0.72)

    near = (harmonic_ridge(rng, range(2, 28), 1.2) * 0.5 + 0.5) * 7.0
    near *= smoothstep(0.4, 0.7, tileable_noise(rng, 5, 1)[H // 3])
    paint_silhouette_layer(layers[0], near, 0.0, mix(IN_BOUNDS, WATER, 0.22), SKY_HORIZON, 0.5, top_feather_deg=0.7, atmosphere_alpha=0.08, rim_color=SUN_CORE, rim_strength=0.18, rim_width_deg=0.55)
    return layers


def angels_flat() -> list[np.ndarray]:
    rng = np.random.default_rng(202)
    layers = make_layers(sky_gradient([(90.0, SKY_TOP), (20.0, SKY_MID), (0.0, SKY_HORIZON)]))
    terminal = layers[3]
    paint_horizon_glow(terminal, SKY_HORIZON, 0.12, 3.0)
    below_horizon_sea(terminal, mix(WATER, SKY_HORIZON, 0.3), OUT_OF_BOUNDS)

    far = rounded(harmonic_ridge(rng, range(2, 9), 1.35) * 0.5 + 0.5, 0.9) * 3.5
    paint_silhouette_layer(layers[2], far, -2.5, IN_BOUNDS, SKY_HORIZON, 0.84, top_feather_deg=1.7, atmosphere_alpha=0.18)
    paint_cloud_layer(layers[2], rng, 31.0, 51.0, mix(SKY_MID, SUN_COLOR, 0.2), SKY_MID, 0.3, cells_x=6, cells_y=3, max_alpha=0.4)

    middle = rounded(harmonic_ridge(rng, range(2, 7), 1.3) * 0.5 + 0.5, 0.86) * 6.2
    paint_silhouette_layer(layers[1], middle, -4.0, mix(IN_BOUNDS, GROUND, 0.3), SKY_HORIZON, 0.68, top_feather_deg=1.2, atmosphere_alpha=0.12)
    paint_cloud_layer(layers[1], rng, 17.0, 31.0, mix(SUN_CORE, SKY_MID, 0.3), mix(SKY_MID, SKY_TOP, 0.35), 0.34, cells_x=7, cells_y=4, max_alpha=0.58)

    broad = rounded(harmonic_ridge(rng, range(2, 6), 1.22) * 0.5 + 0.5, 0.82) * 7.8
    near = tree_topped_ridge(rng, broad, 2.2)
    paint_silhouette_layer(layers[0], near, -6.0, mix(IN_BOUNDS, GROUND, 0.55), SKY_HORIZON, 0.48, top_feather_deg=0.7, atmosphere_alpha=0.08, rim_color=SUN_CORE, rim_strength=0.18, rim_width_deg=0.55)
    paint_cloud_layer(layers[0], rng, 8.0, 25.0, mix(SUN_CORE, SKY_MID, 0.25), mix(SKY_MID, SKY_TOP, 0.45), 0.4, cells_x=9, cells_y=5, max_alpha=0.75)
    return layers


def boulder_mountain() -> list[np.ndarray]:
    rng = np.random.default_rng(303)
    terminal = sky_gradient([(90.0, mix(SKY_TOP, OUT_OF_BOUNDS, 0.18)), (25.0, SKY_MID), (0.0, mix(SKY_HORIZON, SKY_MID, 0.35))])
    layers = make_layers(terminal)
    below_horizon_sea(terminal, mix(WATER, SKY_MID, 0.3), OUT_OF_BOUNDS)
    haze = mix(SKY_HORIZON, SKY_MID, 0.4)

    far = np.abs(harmonic_ridge(rng, range(4, 55), 1.08)) * 6.5
    paint_silhouette_layer(layers[2], far, -2.0, ROCKS[3], haze, 0.76, top_feather_deg=2.2, atmosphere_alpha=0.2, rim_color=ROCKS[6], rim_strength=0.18, rim_width_deg=1.0)
    paint_cloud_layer(layers[2], rng, 23.0, 44.0, mix(SUN_CORE, SKY_MID, 0.35), mix(SKY_MID, SKY_TOP, 0.5), 0.28, cells_x=7, cells_y=4, max_alpha=0.5)

    middle = np.abs(harmonic_ridge(rng, range(3, 48), 1.04)) * 10.5
    paint_silhouette_layer(layers[1], middle, -4.0, ROCKS[2], haze, 0.58, top_feather_deg=1.5, atmosphere_alpha=0.15, rim_color=ROCKS[6], rim_strength=0.28, rim_width_deg=1.1)
    paint_haze_band(layers[1], SKY_MID, 0.8, 2.2, 0.16)

    near = np.abs(harmonic_ridge(rng, range(2, 36), 1.0)) * 16.0
    paint_silhouette_layer(layers[0], near, -7.0, ROCKS[1], haze, 0.3, top_feather_deg=0.9, atmosphere_alpha=0.09, rim_color=mix(ROCKS[6], SUN_CORE, 0.5), rim_strength=0.42, rim_width_deg=1.4)
    return layers


def spikey_lake() -> list[np.ndarray]:
    rng = np.random.default_rng(404)
    terminal = sky_gradient([(90.0, mix(SKY_TOP, WATER, 0.3)), (18.0, mix(SKY_MID, WATER, 0.18)), (0.0, mix(SKY_HORIZON, SKY_MID, 0.5))])
    layers = make_layers(terminal)
    below_horizon_sea(terminal, mix(WATER, SKY_MID, 0.45), WATER)
    haze = mix(SKY_MID, WATER, 0.2)

    def spikes(profile: np.ndarray, power: float) -> np.ndarray:
        sharp = np.abs(profile) ** power
        maximum = float(np.max(sharp))
        return sharp / maximum if maximum > 0 else sharp

    far = spikes(harmonic_ridge(rng, range(8, 105), 0.88), 1.8) * 5.0
    far *= 0.45 + 0.55 * smoothstep(0.32, 0.68, tileable_noise(rng, 6, 1)[H // 2])
    paint_silhouette_layer(layers[2], far, -1.5, mix(ROCKS[0], WATER, 0.42), haze, 0.78, top_feather_deg=1.8, atmosphere_alpha=0.22)
    paint_cloud_layer(layers[2], rng, 19.0, 34.0, mix(SKY_MID, CAMERA_CLEAR, 0.5), mix(SKY_MID, WATER, 0.35), 0.32, cells_x=9, cells_y=4, max_alpha=0.45)

    middle = spikes(harmonic_ridge(rng, range(6, 90), 0.85), 2.0) * 9.0
    middle *= 0.4 + 0.6 * smoothstep(0.35, 0.7, tileable_noise(rng, 5, 1)[H // 2])
    paint_silhouette_layer(layers[1], middle, -3.5, mix(ROCKS[0], WATER, 0.22), haze, 0.58, top_feather_deg=1.25, atmosphere_alpha=0.16)
    paint_haze_band(layers[1], mix(SKY_MID, SKY_HORIZON, 0.4), 0.5, 1.8, 0.32)

    near = spikes(harmonic_ridge(rng, range(5, 70), 0.8), 2.2) * 14.0
    near *= 0.35 + 0.65 * smoothstep(0.4, 0.75, tileable_noise(rng, 4, 1)[H // 2])
    paint_silhouette_layer(layers[0], near, -6.0, ROCKS[0], haze, 0.38, top_feather_deg=0.7, atmosphere_alpha=0.1, rim_color=CAMERA_CLEAR, rim_strength=0.32, rim_width_deg=0.7)
    paint_cloud_layer(layers[0], rng, 13.0, 27.0, mix(SKY_MID, CAMERA_CLEAR, 0.5), mix(SKY_MID, WATER, 0.35), 0.2, cells_x=12, cells_y=5, max_alpha=0.35)
    return layers


def niemo_islands() -> list[np.ndarray]:
    rng = np.random.default_rng(505)
    terminal = sky_gradient([(90.0, SKY_TOP), (25.0, SKY_MID), (0.0, SKY_HORIZON)])
    layers = make_layers(terminal)
    sun_theta = 0.75 * np.pi
    paint_azimuth_glow(terminal, sun_theta, SUN_HALO, 0.34, 1.1, 14.0)
    below_horizon_sea(terminal, mix(WATER, SKY_HORIZON, 0.4), OUT_OF_BOUNDS)
    paint_azimuth_glow(terminal, sun_theta, mix(SUN_HALO, SUN_CORE, 0.5), 0.22, 0.5, 6.0, below_horizon=True)

    far = (harmonic_ridge(rng, range(4, 40), 1.08) * 0.5 + 0.5) * 3.2
    far *= smoothstep(0.28, 0.62, tileable_noise(rng, 8, 1)[H // 2])
    paint_silhouette_layer(layers[2], far, 0.0, mix(IN_BOUNDS, WATER, 0.28), mix(SKY_HORIZON, SUN_HALO, 0.2), 0.76, top_feather_deg=1.5, atmosphere_alpha=0.17, rim_color=SUN_HALO, rim_strength=0.16, rim_width_deg=0.7)
    paint_cloud_layer(layers[2], rng, 20.0, 35.0, mix(SUN_CORE, SKY_MID, 0.3), SKY_MID, 0.32, cells_x=7, cells_y=4, max_alpha=0.45)

    chain = (harmonic_ridge(rng, range(3, 30), 1.1) * 0.5 + 0.5) * 6.0
    chain *= smoothstep(0.3, 0.6, tileable_noise(rng, 7, 1)[H // 2])
    paint_silhouette_layer(layers[1], chain, 0.0, mix(IN_BOUNDS, GROUND, 0.35), mix(SKY_HORIZON, SUN_HALO, 0.2), 0.56, top_feather_deg=1.0, atmosphere_alpha=0.12, rim_color=SUN_HALO, rim_strength=0.26, rim_width_deg=0.6)
    paint_cloud_layer(layers[1], rng, 7.0, 17.0, mix(SUN_CORE, SKY_HORIZON, 0.3), mix(SKY_MID, SUN_HALO, 0.25), 0.46, cells_x=11, cells_y=4, max_alpha=0.72)

    close = (harmonic_ridge(rng, range(2, 22), 1.15) * 0.5 + 0.5) * 4.2
    close *= smoothstep(0.42, 0.73, tileable_noise(rng, 9, 1)[H // 2])
    paint_silhouette_layer(layers[0], close, 0.0, IN_BOUNDS, SKY_HORIZON, 0.36, top_feather_deg=0.6, atmosphere_alpha=0.07, rim_color=SUN_CORE, rim_strength=0.22, rim_width_deg=0.5)
    return layers


def angels_playhouse() -> list[np.ndarray]:
    rng = np.random.default_rng(606)
    terminal = sky_gradient([(90.0, SKY_TOP), (45.0, mix(SKY_MID, SUN_COLOR, 0.4)), (12.0, SUN_HALO), (0.0, SUN_COLOR)])
    layers = make_layers(terminal)
    glow_theta = 1.35 * np.pi
    paint_azimuth_glow(terminal, glow_theta, mix(SUN_HALO, SUN_CORE, 0.4), 0.3, 1.4, 20.0)
    below_horizon_sea(terminal, mix(WATER, SUN_HALO, 0.35), OUT_OF_BOUNDS)
    haze = mix(SUN_HALO, SUN_COLOR, 0.5)

    farthest = rounded(harmonic_ridge(rng, range(2, 10), 1.2) * 0.5 + 0.5, 0.9) * 5.5
    paint_silhouette_layer(layers[2], farthest, -2.0, mix(ROCKS[7], SUN_HALO, 0.3), haze, 0.76, top_feather_deg=2.0, atmosphere_alpha=0.2, rim_color=SUN_CORE, rim_strength=0.2, rim_width_deg=0.8)
    paint_cloud_layer(layers[2], rng, 36.0, 61.0, mix(SUN_CORE, SKY_MID, 0.4), mix(SKY_MID, SUN_HALO, 0.4), 0.28, cells_x=6, cells_y=3, max_alpha=0.38)

    behind = rounded(harmonic_ridge(rng, range(2, 12), 1.15) * 0.5 + 0.5, 0.82) * 9.0
    paint_silhouette_layer(layers[1], behind, -4.0, mix(ROCKS[7], GROUND_PRINT, 0.4), haze, 0.56, top_feather_deg=1.35, atmosphere_alpha=0.14, rim_color=SUN_CORE, rim_strength=0.34, rim_width_deg=0.9)
    paint_cloud_layer(layers[1], rng, 11.0, 25.0, mix(SUN_CORE, SUN_HALO, 0.35), mix(SUN_HALO, GROUND_PRINT, 0.35), 0.3, cells_x=9, cells_y=4, max_alpha=0.52)

    sweep = rounded(harmonic_ridge(rng, range(2, 7), 1.05) * 0.5 + 0.5, 0.75) * 15.0
    paint_silhouette_layer(layers[0], sweep, -7.0, mix(GROUND_PRINT, ROCKS[7], 0.35), haze, 0.34, top_feather_deg=0.8, atmosphere_alpha=0.08, rim_color=SUN_CORE, rim_strength=0.52, rim_width_deg=1.1)
    return layers


def metal_hell() -> list[np.ndarray]:
    rng = np.random.default_rng(707)
    terminal = sky_gradient([(90.0, OUT_OF_BOUNDS), (35.0, mix(OUT_OF_BOUNDS, BURN_HOT, 0.35)), (8.0, LAVA), (0.0, mix(LAVA, SUN_HALO, 0.35))])
    layers = make_layers(terminal)
    glow = mix(LAVA, SUN_HALO, 0.45)
    paint_horizon_glow(terminal, glow, 0.3, 2.0)
    below_horizon_sea(terminal, LAVA, BURN_RESIDUE)

    far = np.abs(harmonic_ridge(rng, range(4, 52), 1.03)) * 3.8
    paint_silhouette_layer(layers[2], far, -2.0, mix(GROUND_PRINT, BURN_RESIDUE, 0.55), mix(LAVA, BURN_RESIDUE, 0.35), 0.68, top_feather_deg=1.8, atmosphere_alpha=0.22, rim_color=glow, rim_strength=0.28, rim_width_deg=0.9)
    paint_cloud_layer(layers[2], rng, 17.0, 47.0, mix(BURN_RESIDUE, LAVA, 0.35), mix(OUT_OF_BOUNDS, BURN_RESIDUE, 0.5), 0.42, cells_x=8, cells_y=5, max_alpha=0.68)

    middle = np.abs(harmonic_ridge(rng, range(3, 44), 1.0)) * 6.0
    paint_silhouette_layer(layers[1], middle, -4.0, mix(GROUND_PRINT, BURN_RESIDUE, 0.3), BURN_RESIDUE, 0.44, top_feather_deg=1.2, atmosphere_alpha=0.16, rim_color=glow, rim_strength=0.46, rim_width_deg=0.9)
    paint_cloud_layer(layers[1], rng, 5.0, 13.0, mix(LAVA, SUN_HALO, 0.25), BURN_RESIDUE, 0.38, cells_x=13, cells_y=3, max_alpha=0.52)
    paint_embers(layers[1], rng, 450, 9.0)

    near = np.abs(harmonic_ridge(rng, range(2, 32), 0.95)) * 9.0
    paint_silhouette_layer(layers[0], near, -7.0, GROUND_PRINT, BURN_RESIDUE, 0.2, top_feather_deg=0.65, atmosphere_alpha=0.09, rim_color=glow, rim_strength=0.68, rim_width_deg=1.0)
    paint_embers(layers[0], rng, 500, 7.0)
    return layers


def metal_plate() -> list[np.ndarray]:
    rng = np.random.default_rng(808)
    terminal = sky_gradient([(90.0, mix(OUT_OF_BOUNDS, np.zeros(3, dtype=np.float32), 0.45)), (30.0, OUT_OF_BOUNDS), (6.0, mix(OUT_OF_BOUNDS, SKY_TOP, 0.45)), (0.0, CAMERA_CLEAR)])
    layers = make_layers(terminal)

    # Cosmic content is terminal-only: no star or nebula parallax.
    nebula = tileable_noise(rng, 5, 3, octaves=5)
    nebula_alpha = smoothstep(0.62, 0.95, nebula) * smoothstep(5.0, 30.0, ELEV_COL) * 0.35
    terminal[:] = terminal * (1.0 - nebula_alpha[:, :, None]) + mix(SKY_TOP, CAMERA_CLEAR, 0.5)[None, None, :] * nebula_alpha[:, :, None]
    paint_stars(terminal, rng, 2600, 2.0)
    line = np.exp(-((ELEV_COL - 0.35) ** 2) / 0.18) * 0.55
    terminal[:] = np.clip(terminal + SKY_MID[None, None, :] * line[:, :, None], 0.0, 1.0)
    below_horizon_sea(terminal, mix(WATER, CAMERA_CLEAR, 0.25), mix(OUT_OF_BOUNDS, np.zeros(3, dtype=np.float32), 0.5))

    far = rounded(harmonic_ridge(rng, range(5, 24), 1.18) * 0.5 + 0.5, 0.9) * 1.8
    paint_silhouette_layer(layers[2], far, -1.0, mix(OUT_OF_BOUNDS, CAMERA_CLEAR, 0.18), CAMERA_CLEAR, 0.82, top_feather_deg=1.4, atmosphere_alpha=0.16)
    paint_haze_band(layers[2], CAMERA_CLEAR, 0.2, 1.1, 0.16)

    middle = rounded(harmonic_ridge(rng, range(3, 18), 1.12) * 0.5 + 0.5, 0.86) * 3.2
    paint_silhouette_layer(layers[1], middle, -2.5, mix(OUT_OF_BOUNDS, ROCKS[0], 0.3), CAMERA_CLEAR, 0.62, top_feather_deg=1.0, atmosphere_alpha=0.11)

    near = rounded(harmonic_ridge(rng, range(2, 14), 1.05) * 0.5 + 0.5, 0.8) * 5.0
    paint_silhouette_layer(layers[0], near, -5.0, mix(OUT_OF_BOUNDS, np.zeros(3, dtype=np.float32), 0.2), CAMERA_CLEAR, 0.36, top_feather_deg=0.6, atmosphere_alpha=0.06, rim_color=SKY_MID, rim_strength=0.18, rim_width_deg=0.45)
    return layers


PRESETS = {
    "large-circle": large_circle,
    "angels-flat": angels_flat,
    "boulder-mountain": boulder_mountain,
    "spikey-lake": spikey_lake,
    "niemo-islands": niemo_islands,
    "angels-playhouse": angels_playhouse,
    "metal-hell": metal_hell,
    "metal-plate": metal_plate,
}


def write_manifest(contract: dict[str, object], assets: list[dict[str, object]]) -> None:
    manifest = {**contract, "assets": assets}
    temporary_path = f"{MANIFEST_PATH}.tmp"
    with open(temporary_path, "w") as destination:
        json.dump(manifest, destination, indent=2, sort_keys=True)
        destination.write("\n")
    os.replace(temporary_path, MANIFEST_PATH)


def remove_obsolete_backdrop_assets() -> None:
    expected = set(expected_asset_names())
    for name in os.listdir(OUT_DIR):
        path = os.path.join(OUT_DIR, name)
        if name.endswith(".png") or (name.endswith(".ktx2") and name not in expected):
            os.remove(path)


def sync_basis_transcoder() -> None:
    os.makedirs(PUBLIC_BASIS_DIR, exist_ok=True)
    for name in ("basis_transcoder.js", "basis_transcoder.wasm", "README.md"):
        source = os.path.join(THREE_BASIS_SOURCE_DIR, name)
        destination = os.path.join(PUBLIC_BASIS_DIR, name)
        if not os.path.isfile(source):
            raise RuntimeError(f"Three.js Basis transcoder asset is missing: {source}")
        if not os.path.isfile(destination) or file_sha256(source) != file_sha256(destination):
            shutil.copyfile(source, destination)
            print(f"synced {os.path.relpath(destination, ROOT)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--force",
        action="store_true",
        help="regenerate every KTX2 even when the input fingerprint is current",
    )
    args = parser.parse_args()
    os.makedirs(OUT_DIR, exist_ok=True)
    sync_basis_transcoder()
    contract = generation_contract()
    if not args.force and current_manifest(contract) is not None:
        print(f"backdrop KTX2 assets are current ({str(contract['fingerprint'])[:12]})")
        return

    assets: list[dict[str, object]] = []
    with tempfile.TemporaryDirectory(prefix="rts-backdrops-") as temporary_directory:
        for slug, painter in PRESETS.items():
            layers = painter()
            if len(layers) != 4:
                raise ValueError(f"{slug} did not produce four backdrop layers")
            for index, layer in enumerate(layers):
                assets.append(
                    encode_layer(layer, slug, index, temporary_directory)
                )
    remove_obsolete_backdrop_assets()
    write_manifest(contract, assets)
    print(f"wrote {os.path.relpath(MANIFEST_PATH, ROOT)}")


if __name__ == "__main__":
    main()
