// Original, vector-first command cursors for the battlefield canvas.
//
// Visual language: original high-DPI cursors styled after the Beyond All Reason
// "icexuick" command cursors — glossy, beveled, glowing shapes with white-hot
// cores, colour-coded by action. The artwork is authored from first principles
// here (no external cursor art is used); it deliberately echoes BAR's look:
// arrows for the positional commands (move/fight/patrol/repair), a red
// corner-hook attack reticle, a segmented "defend" ring for guard, a burst ring
// for d-gun, and a glowing recycle mark for reclaim.
//
// Crispness strategy: a plain `cursor: url("data:image/svg+xml,...") x y` is
// rasterised at the cursor's logical size, so on Retina — or when macOS is set
// to a large pointer — the OS upscales a low-res bitmap and it looks fuzzy. We
// instead hand the engine high-resolution bitmaps via `image-set()` (2x/3x),
// emitted at a larger intrinsic pixel size. `image-set()` in `cursor` is spelled
// differently across engines, and an unsupported value must not poison the whole
// declaration, so `getCommandCursorStyle` returns an ordered *cascade* of
// candidate values (least -> most preferred) that the caller assigns in turn.

import { COLORS } from '@/colorsConfig';

export type CommandCursorKind =
  | 'default'
  | 'game'
  | 'select'
  | 'move'
  | 'fight'
  | 'patrol'
  | 'attack'
  | 'guard'
  | 'repair'
  | 'reclaim'
  | 'build'
  | 'blocked'
  | 'dgun'
  | 'ping';

const S = COLORS.ui.commandCursor;
const WHITE = S.white;
const SHADOW = S.outline; // near-black; used for grounding shadows, not hard outlines

// ---------------------------------------------------------------------------
// Colour blend helpers (bevel gradients derive light/dark facets from one hue)
// ---------------------------------------------------------------------------

function hexToRgb(h: string): [number, number, number] {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
function rgbToHex(rgb: number[]): string {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
function mix(h: string, target: string, amt: number): string {
  const a = hexToRgb(h);
  const b = hexToRgb(target);
  return rgbToHex(a.map((v, i) => v + (b[i] - v) * amt));
}
const lite = (h: string, amt = 0.5): string => mix(h, '#ffffff', amt);
const dark = (h: string, amt = 0.4): string => mix(h, SHADOW, amt);

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

// A glowing "tube" stroke with a white-hot core (rings, reticles, spokes). The
// grounding shadow keeps it legible over bright terrain without a hard outline.
function glow(d: string, color: string, w = 5.5, core = 2.0, cap: 'round' | 'butt' = 'round'): string {
  return `
    <path d="${d}" fill="none" stroke="${SHADOW}" stroke-width="${w + 7}" opacity="0.22" stroke-linecap="${cap}" stroke-linejoin="round"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="${w + 6}" opacity="0.18" stroke-linecap="${cap}" stroke-linejoin="round"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="${w + 2.5}" opacity="0.40" stroke-linecap="${cap}" stroke-linejoin="round"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="${cap}" stroke-linejoin="round"/>
    <path d="${d}" fill="none" stroke="${lite(color, 0.7)}" stroke-width="${core}" opacity="0.92" stroke-linecap="${cap}" stroke-linejoin="round"/>
  `;
}

// A glossy beveled arrow, tip at the top-left (hotspot). gid must be unique
// within the cursor's own SVG document (cursors are separate documents, so the
// same id may repeat across them).
const ARROW = 'M8 6 L8 44 L18.5 34.5 L25 48.5 L31 45.8 L24.6 32 L39 32 Z';
function arrow(color: string, gid: string, extra = ''): string {
  const defs = `<defs>
    <linearGradient id="${gid}" x1="0.05" y1="0.05" x2="0.95" y2="1">
      <stop offset="0" stop-color="${lite(color, 0.92)}"/>
      <stop offset="0.38" stop-color="${lite(color, 0.18)}"/>
      <stop offset="0.72" stop-color="${dark(color, 0.28)}"/>
      <stop offset="1" stop-color="${dark(color, 0.55)}"/>
    </linearGradient>
    <radialGradient id="${gid}h" cx="0.34" cy="0.26" r="0.55">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.95"/>
      <stop offset="0.45" stop-color="#ffffff" stop-opacity="0.28"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>`;
  return `${defs}
    <path d="${ARROW}" fill="${SHADOW}" opacity="0.32" transform="translate(1.4,2.1)"/>
    <path d="${ARROW}" fill="none" stroke="${color}" stroke-width="6" opacity="0.24" stroke-linejoin="round" stroke-linecap="round"/>
    <path d="${ARROW}" fill="url(#${gid})" stroke="${dark(color, 0.62)}" stroke-width="1.4" stroke-linejoin="round"/>
    <path d="${ARROW}" fill="url(#${gid}h)"/>
    <path d="M10.4 9.6 L10.4 37" stroke="${WHITE}" stroke-width="2.2" opacity="0.85" stroke-linecap="round"/>
    ${extra}`;
}

// Segmented ring (BAR "defend"): `segs` arcs of radius r with angular gaps.
function segRing(cx: number, cy: number, r: number, segs: number, gapDeg: number): string {
  let d = '';
  const step = 360 / segs;
  for (let i = 0; i < segs; i++) {
    const a0 = ((i * step + gapDeg / 2) * Math.PI) / 180;
    const a1 = (((i + 1) * step - gapDeg / 2) * Math.PI) / 180;
    const x0 = (cx + Math.cos(a0) * r).toFixed(2);
    const y0 = (cy + Math.sin(a0) * r).toFixed(2);
    const x1 = (cx + Math.cos(a1) * r).toFixed(2);
    const y1 = (cy + Math.sin(a1) * r).toFixed(2);
    d += `M${x0} ${y0} A${r} ${r} 0 0 1 ${x1} ${y1} `;
  }
  return d.trim();
}

// Eight radial spokes between two radii (d-gun burst).
function spokes(cx: number, cy: number, r1: number, r2: number): string {
  return [0, 45, 90, 135, 180, 225, 270, 315]
    .map((deg) => {
      const a = (deg * Math.PI) / 180;
      return `M${(cx + Math.cos(a) * r1).toFixed(1)} ${(cy + Math.sin(a) * r1).toFixed(1)} L${(cx + Math.cos(a) * r2).toFixed(1)} ${(cy + Math.sin(a) * r2).toFixed(1)}`;
    })
    .join(' ');
}

const RECYCLE_SEGMENT = 'M24 16 L40 16 L37 12 L44 12 L48 19 L44 26 L41 22 L28 22 Z';
const CORNER_HOOKS = 'M20 15 h-7 v7 M44 15 h7 v7 M44 49 h7 v-7 M20 49 h-7 v-7';
const BUILD_FRAME = 'M14 22 V14 H22 M42 14 H50 V22 M50 42 V50 H42 M22 50 H14 V42';
const PIN = 'M32 12 c-8 0 -14 6 -14 14 c0 10 14 24 14 24 s14 -14 14 -24 c0 -8 -6 -14 -14 -14 Z';
const rot = [0, 120, 240];

// ---------------------------------------------------------------------------
// Cursor artwork (inner SVG, authored in the 64-unit viewBox)
// ---------------------------------------------------------------------------

const ART: Record<Exclude<CommandCursorKind, 'default'>, string> = {
  // Positional commands: glossy beveled arrows, colour-coded.
  game: arrow(S.game, 'g'),
  move: arrow(S.move, 'g'),
  fight: arrow(S.fight, 'g'),
  patrol: arrow(S.patrol, 'g'),

  // Repair: yellow arrow + glowing wrench at the lower-right.
  repair: arrow(S.repair, 'g', `
    <g transform="rotate(38 44 46)">${glow('M44 34 v22', S.repair, 5.5, 2)}</g>
    <path d="M52.5 37.5 a5.4 5.4 0 0 0 -7 7 l-6.4 6.4 a2.6 2.6 0 0 0 3.7 3.7 l6.4 -6.4 a5.4 5.4 0 0 0 7 -7 l-3.7 3.7 -3.4 -3.4 Z"
          fill="${lite(S.repair, 0.15)}" stroke="${dark(S.repair, 0.55)}" stroke-width="1.3" stroke-linejoin="round"/>
  `),

  // Attack: four glowing red corner-hooks + centre dot (BAR reticle).
  attack: `
    <circle cx="32" cy="32" r="13" fill="none" stroke="${S.attack}" stroke-width="2" opacity="0.3"/>
    ${glow(CORNER_HOOKS, S.attack, 7, 2.8)}
    <circle cx="32" cy="32" r="2.6" fill="${WHITE}" opacity="0.85"/>
  `,

  // Blocked: glowing red no-entry.
  blocked: glow('M32 32 m-18 0 a18 18 0 1 0 36 0 a18 18 0 1 0 -36 0', S.attack, 5) + glow('M20 44 L44 20', S.attack, 5),

  // Guard: cyan segmented "defend" ring.
  guard: glow(segRing(32, 32, 15, 5, 24), S.guard, 8.5, 3.6, 'butt'),

  // Reclaim: white-cored recycle triangle with a green glow.
  reclaim: `
    ${rot.map((a) => `<path d="${RECYCLE_SEGMENT}" transform="rotate(${a} 32 32)" fill="none" stroke="${SHADOW}" stroke-width="7" opacity="0.18" stroke-linejoin="round"/>`).join('')}
    ${rot.map((a) => `<path d="${RECYCLE_SEGMENT}" transform="rotate(${a} 32 32)" fill="none" stroke="${S.reclaim}" stroke-width="5.5" opacity="0.5" stroke-linejoin="round"/>`).join('')}
    ${rot.map((a) => `<path d="${RECYCLE_SEGMENT}" transform="rotate(${a} 32 32)" fill="${WHITE}" stroke="${mix(S.reclaim, '#ffffff', 0.5)}" stroke-width="0.8" stroke-linejoin="round"/>`).join('')}
  `,

  // Build: glowing gold placement frame + grid plus.
  build: glow(BUILD_FRAME, S.build, 5, 2.2) + glow('M32 25 V39 M25 32 H39', S.build, 4.5, 2),

  // D-gun: red burst ring with radial spokes + a bolt.
  dgun: `
    ${glow('M32 32 m-15 0 a15 15 0 1 0 30 0 a15 15 0 1 0 -30 0', S.dgun, 4)}
    ${glow(spokes(32, 32, 15, 21.5), S.dgun, 5, 2.2)}
    ${glow('M35 21 L26 33 h5.5 l-2 9 l9 -12.5 h-5.5 Z', lite(S.repair, 0.1), 3, 1.4)}
  `,

  // Selection marquee: glowing ice crosshair.
  select: glow('M32 13 V25 M32 39 V51 M13 32 H25 M39 32 H51', S.ping, 4.5, 2) +
    glow('M32 32 m-4.5 0 a4.5 4.5 0 1 0 9 0 a4.5 4.5 0 1 0 -9 0', S.ping, 3.5, 1.6),

  // Map ping: glossy marker pin (hotspot at the tip).
  ping: `<defs><linearGradient id="pg" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0" stop-color="${lite(S.ping, 0.8)}"/>
      <stop offset="0.5" stop-color="${S.ping}"/>
      <stop offset="1" stop-color="${dark(S.ping, 0.4)}"/>
    </linearGradient></defs>
    <path d="${PIN}" fill="${SHADOW}" opacity="0.28" transform="translate(1.4,1.9)"/>
    <path d="${PIN}" fill="none" stroke="${S.ping}" stroke-width="6" opacity="0.22" stroke-linejoin="round"/>
    <path d="${PIN}" fill="url(#pg)" stroke="${dark(S.ping, 0.5)}" stroke-width="1.3" stroke-linejoin="round"/>
    <circle cx="32" cy="26" r="4.6" fill="${SHADOW}" opacity="0.85"/>
    <circle cx="32" cy="26" r="2.6" fill="${WHITE}"/>
  `,
};

// ---------------------------------------------------------------------------
// CSS value generation
// ---------------------------------------------------------------------------

type CursorSpec = { hotX: number; hotY: number; fallback: string };

const SPECS: Record<Exclude<CommandCursorKind, 'default'>, CursorSpec> = {
  game: { hotX: 8, hotY: 6, fallback: 'default' },
  move: { hotX: 8, hotY: 6, fallback: 'crosshair' },
  fight: { hotX: 8, hotY: 6, fallback: 'crosshair' },
  patrol: { hotX: 8, hotY: 6, fallback: 'crosshair' },
  repair: { hotX: 8, hotY: 6, fallback: 'crosshair' },
  attack: { hotX: 32, hotY: 32, fallback: 'crosshair' },
  guard: { hotX: 32, hotY: 32, fallback: 'crosshair' },
  reclaim: { hotX: 32, hotY: 32, fallback: 'crosshair' },
  build: { hotX: 32, hotY: 32, fallback: 'crosshair' },
  blocked: { hotX: 32, hotY: 32, fallback: 'not-allowed' },
  dgun: { hotX: 32, hotY: 32, fallback: 'crosshair' },
  select: { hotX: 32, hotY: 32, fallback: 'crosshair' },
  ping: { hotX: 32, hotY: 50, fallback: 'crosshair' },
};

// The artwork is authored in a 64-unit square (VIEWBOX). DISPLAY is the cursor's
// on-screen (CSS px) footprint at 1x density — tune this to make every cursor
// bigger or smaller. Hotspots, authored in VIEWBOX coordinates, are scaled to
// DISPLAY space in buildCascade. High-DPI variants are the same art emitted at
// 2x / 3x the display size (see DENSITIES), so shrinking DISPLAY keeps them
// crisp rather than just downsampling one bitmap.
const VIEWBOX = 64;
const DISPLAY = 22;
const DENSITIES = [2, 3] as const;

function svgDataUrl(inner: string, sizePx: number): string {
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}" viewBox="0 0 ${VIEWBOX} ${VIEWBOX}">${inner}</svg>`;
  const encoded = encodeURIComponent(markup).replace(/'/g, '%27').replace(/"/g, '%22');
  return `data:image/svg+xml,${encoded}`;
}

// Build the ordered cascade of `cursor` values (least -> most preferred). The
// caller assigns each in turn; the last value the engine understands wins.
function buildCascade(inner: string, spec: CursorSpec): string[] {
  const { fallback } = spec;
  const scale = DISPLAY / VIEWBOX;
  const hotX = Math.round(spec.hotX * scale);
  const hotY = Math.round(spec.hotY * scale);
  const base = svgDataUrl(inner, DISPLAY);
  const set = [
    `url("${base}") 1x`,
    ...DENSITIES.map((d) => `url("${svgDataUrl(inner, DISPLAY * d)}") ${d}x`),
  ].join(', ');
  return [
    // 1. Bare keyword — always valid, so the cursor is never left unset.
    fallback,
    // 2. Plain single-resolution SVG — works everywhere `url()` cursors do.
    `url("${base}") ${hotX} ${hotY}, ${fallback}`,
    // 3. High-DPI via legacy WebKit spelling.
    `-webkit-image-set(${set}) ${hotX} ${hotY}, ${fallback}`,
    // 4. High-DPI via the standard spelling (preferred).
    `image-set(${set}) ${hotX} ${hotY}, ${fallback}`,
  ];
}

const CASCADES: Record<CommandCursorKind, string[]> = (() => {
  const built = {} as Record<CommandCursorKind, string[]>;
  for (const kind of Object.keys(SPECS) as Array<Exclude<CommandCursorKind, 'default'>>) {
    built[kind] = buildCascade(ART[kind], SPECS[kind]);
  }
  built.default = built.game;
  return built;
})();

/**
 * The ordered list of `cursor` CSS values for a command, least -> most
 * preferred. Assign each to `element.style.cursor` in order so the most
 * capable value the engine supports (high-DPI `image-set`) wins while older
 * engines fall back cleanly.
 */
export function getCommandCursorStyle(kind: CommandCursorKind): string[] {
  return CASCADES[kind] ?? CASCADES.default;
}
