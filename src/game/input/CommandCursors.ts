// Original, vector-first command cursors for the battlefield canvas.
//
// Visual language: high-DPI "cousins" of the Beyond All Reason command cursors
// (bold arrows colour-coded by action; centred reticles / rings for target
// actions), authored from first principles here — no external cursor art or
// animation frames are used.
//
// Crispness strategy (this is the important part):
//   A plain `cursor: url("data:image/svg+xml,...") x y` is rasterised by the
//   engine at the cursor's *logical* CSS size. On a Retina panel — and worse,
//   when macOS is set to a large pointer — the OS then upscales that low-res
//   bitmap, so the cursor looks fuzzy no matter how clean the vector art is.
//   The fix is to hand the engine a genuinely high-resolution bitmap via
//   `image-set()`, providing 2x and 3x density variants of the same SVG. We
//   emit each variant at a larger intrinsic pixel size so the rasteriser has
//   real pixels to work with, and the OS has a dense bitmap to enlarge.
//
//   `image-set()` in `cursor` is spelled differently across engines (Chrome:
//   unprefixed; older WebKit: `-webkit-image-set`), and an unsupported cursor
//   value must never poison the whole declaration. So `getCommandCursorStyle`
//   returns an ordered *cascade* of candidate values (least → most preferred);
//   the caller assigns each to `style.cursor` in turn and the last one the
//   engine actually understands wins (an unsupported assignment is a no-op).

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
  | 'ping'
  | 'factoryWaypoint';

const S = COLORS.ui.commandCursor;

// The artwork is authored in a 64-unit square (VIEWBOX). DISPLAY is the cursor's
// on-screen (CSS px) footprint at 1x density — tune this to make every cursor
// bigger or smaller. Hotspots, authored in VIEWBOX coordinates, are scaled to
// DISPLAY space in buildCascade. High-DPI variants are the same art emitted at
// 2x / 3x the display size (see DENSITIES), so shrinking DISPLAY keeps them
// crisp rather than just downsampling one bitmap.
const VIEWBOX = 64;
const DISPLAY = 22;
const DENSITIES = [2, 3] as const;

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

// A chunky, slightly bevelled pointer with its tip at the top-left. The whole
// arrow is filled with the action colour (BAR/`icexuick` convention) so the
// command reads from colour alone; an optional badge marks sub-variants.
const ARROW_PATH = 'M9 7 L9 45 L19.5 35.5 L26 49 L31.5 46.5 L25 33 L38 33 Z';

function arrow(color: string, badge = ''): string {
  return `
    <path d="${ARROW_PATH}" fill="none" stroke="${S.outline}" stroke-width="7.5" stroke-linejoin="round" stroke-linecap="round"/>
    <path d="${ARROW_PATH}" fill="${color}" stroke="${S.outline}" stroke-width="1.4" stroke-linejoin="round"/>
    <path d="M11.4 11 L11.4 39" stroke="${S.white}" stroke-width="2.2" stroke-linecap="round" opacity="0.85"/>
    <path d="M12.6 13 L23 30" stroke="${S.white}" stroke-width="1.3" stroke-linecap="round" opacity="0.5"/>
    ${badge}
  `;
}

// A filled disc (dark-rimmed) at the arrow's lower-right that carries a glyph.
function badge(cx: number, cy: number, r: number, fill: string, glyph: string): string {
  return `
    <circle cx="${cx}" cy="${cy}" r="${r + 2.4}" fill="${S.outline}"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>
    ${glyph}
  `;
}

// Two-pass stroked path: a wide dark outline under a thinner coloured stroke,
// giving the high-contrast readable-on-any-terrain look.
function stroked(d: string, color: string, inner = 3.6, outline = 8): string {
  return `
    <path d="${d}" fill="none" stroke="${S.outline}" stroke-width="${outline}" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="${inner}" stroke-linecap="round" stroke-linejoin="round"/>
  `;
}

// Evenly spaced radial spikes around a centre (used by the d-gun burst ring).
function spikes(cx: number, cy: number, r1: number, r2: number, color: string, inner: number, outline: number): string {
  const d = [0, 45, 90, 135, 180, 225, 270, 315]
    .map((deg) => {
      const a = (deg * Math.PI) / 180;
      const x1 = (cx + Math.cos(a) * r1).toFixed(1);
      const y1 = (cy + Math.sin(a) * r1).toFixed(1);
      const x2 = (cx + Math.cos(a) * r2).toFixed(1);
      const y2 = (cy + Math.sin(a) * r2).toFixed(1);
      return `M${x1} ${y1} L${x2} ${y2}`;
    })
    .join(' ');
  return `
    <path d="${d}" fill="none" stroke="${S.outline}" stroke-width="${outline}" stroke-linecap="round"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="${inner}" stroke-linecap="round"/>
  `;
}

// One recycle-arrow segment, rotated three times for the reclaim glyph.
const RECYCLE_SEGMENT = 'M24 16 L40 16 L37 12 L44 12 L48 19 L44 26 L41 22 L28 22 Z';
function recycle(color: string): string {
  const rot = [0, 120, 240];
  const outline = rot
    .map((a) => `<path d="${RECYCLE_SEGMENT}" transform="rotate(${a} 32 32)" fill="none" stroke="${S.outline}" stroke-width="7" stroke-linejoin="round"/>`)
    .join('');
  const fill = rot
    .map((a) => `<path d="${RECYCLE_SEGMENT}" transform="rotate(${a} 32 32)" fill="${color}" stroke="${S.outline}" stroke-width="1.2" stroke-linejoin="round"/>`)
    .join('');
  return outline + fill;
}

// ---------------------------------------------------------------------------
// Cursor artwork (inner SVG, authored in the 64-unit viewBox)
// ---------------------------------------------------------------------------

const CORNER_RETICLE = 'M18 24 V18 H24 M40 18 H46 V24 M46 40 V46 H40 M24 46 H18 V40';
const BUILD_FRAME = 'M14 22 V14 H22 M42 14 H50 V22 M50 42 V50 H42 M22 50 H14 V42';

const ART: Record<Exclude<CommandCursorKind, 'default'>, string> = {
  // Neutral pointer.
  game: arrow(S.game),

  // Move: colour alone carries the command.
  move: arrow(S.move),

  // Fight (move-and-engage): arrow + crossed-blades mark (pommels sell it as
  // swords rather than an X/"cancel").
  fight: arrow(S.fight, `
    <g stroke-linecap="round" stroke-linejoin="round">
      <g stroke="${S.outline}" stroke-width="7"><path d="M37 52 L51 38"/><path d="M51 52 L37 38"/></g>
      <g stroke="${S.fight}" stroke-width="4.2"><path d="M37 52 L51 38"/><path d="M51 52 L37 38"/></g>
      <g stroke="${S.white}" stroke-width="1.7"><path d="M37 52 L51 38"/><path d="M51 52 L37 38"/></g>
      <g stroke="${S.outline}" stroke-width="2.2" fill="${S.white}"><circle cx="37" cy="52" r="2"/><circle cx="51" cy="52" r="2"/></g>
    </g>
  `),

  // Patrol: arrow + looping-arrow badge.
  patrol: arrow(S.patrol, badge(45, 46, 12, S.patrol, `
    <path d="M39.5 47.5 a6 6 0 1 1 3 4.2" fill="none" stroke="${S.outline}" stroke-width="4.6" stroke-linecap="round"/>
    <path d="M39.5 47.5 a6 6 0 1 1 3 4.2" fill="none" stroke="${S.white}" stroke-width="2.1" stroke-linecap="round"/>
    <path d="M37.5 42 l1.6 5.6 l5.4 -2.2" fill="none" stroke="${S.outline}" stroke-width="4.6" stroke-linejoin="round" stroke-linecap="round"/>
    <path d="M37.5 42 l1.6 5.6 l5.4 -2.2" fill="none" stroke="${S.white}" stroke-width="2.1" stroke-linejoin="round" stroke-linecap="round"/>
  `)),

  // Repair: arrow + wrench badge.
  repair: arrow(S.repair, badge(45.5, 46, 12.5, S.repair, `
    <g stroke="${S.outline}" stroke-width="7" stroke-linecap="round"><path d="M40.5 51.5 L49 43"/></g>
    <path d="M52.5 39.2 a5 5 0 0 0 -6.6 6.6 l-6 6 a2.4 2.4 0 0 0 3.4 3.4 l6 -6 a5 5 0 0 0 6.6 -6.6 l-3.4 3.4 -3 -3 Z"
          fill="${S.white}" stroke="${S.outline}" stroke-width="2.2" stroke-linejoin="round"/>
  `)),

  // Attack: red corner-bracket reticle + centre dot.
  attack: `
    ${stroked(CORNER_RETICLE, S.attack)}
    <circle cx="32" cy="32" r="4.6" fill="${S.outline}"/>
    <circle cx="32" cy="32" r="2.4" fill="${S.attack}"/>
  `,

  // Blocked: red no-entry.
  blocked: `
    <circle cx="32" cy="32" r="19" fill="none" stroke="${S.outline}" stroke-width="8.5"/>
    <circle cx="32" cy="32" r="19" fill="none" stroke="${S.attack}" stroke-width="4"/>
    ${stroked('M19 45 L45 19', S.attack, 4, 8.5)}
  `,

  // Guard/assist: cyan shield + plus.
  guard: `
    <path d="M32 10 L48 16 V30 c0 12 -7 20 -16 25 -9 -5 -16 -13 -16 -25 V16 Z"
          fill="none" stroke="${S.outline}" stroke-width="8" stroke-linejoin="round"/>
    <path d="M32 10 L48 16 V30 c0 12 -7 20 -16 25 -9 -5 -16 -13 -16 -25 V16 Z"
          fill="${S.guard}" stroke="${S.outline}" stroke-width="1.4" stroke-linejoin="round"/>
    <g stroke="${S.outline}" stroke-width="6" stroke-linecap="round"><path d="M32 22 V38 M24 30 H40"/></g>
    <g stroke="${S.white}" stroke-width="3" stroke-linecap="round"><path d="M32 22 V38 M24 30 H40"/></g>
  `,

  // Reclaim: three chasing recycle arrows.
  reclaim: recycle(S.reclaim),

  // Build: gold placement frame + grid plus.
  build: `
    ${stroked(BUILD_FRAME, S.build)}
    <g stroke="${S.outline}" stroke-width="6.5" stroke-linecap="round"><path d="M32 24 V40 M24 32 H40"/></g>
    <g stroke="${S.build}" stroke-width="3" stroke-linecap="round"><path d="M32 24 V40 M24 32 H40"/></g>
  `,

  // D-gun: burst ring with radial spikes + a bolt.
  dgun: `
    <circle cx="32" cy="32" r="15.5" fill="none" stroke="${S.outline}" stroke-width="8"/>
    <circle cx="32" cy="32" r="15.5" fill="none" stroke="${S.dgun}" stroke-width="3.6"/>
    ${spikes(32, 32, 15.5, 22, S.dgun, 3.2, 7)}
    <path d="M35 20 L25 34 h6 l-2 10 l10 -14 h-6 Z" fill="${S.white}" stroke="${S.outline}" stroke-width="2.2" stroke-linejoin="round"/>
  `,

  // Selection marquee: ice crosshair reticle.
  select: `
    ${stroked('M32 12 V24 M32 40 V52 M12 32 H24 M40 32 H52', S.ping, 3.2, 7.5)}
    <circle cx="32" cy="32" r="4.4" fill="none" stroke="${S.outline}" stroke-width="5"/>
    <circle cx="32" cy="32" r="4.4" fill="none" stroke="${S.ping}" stroke-width="2.4"/>
  `,

  // Map ping: marker pin (hotspot at the pin tip).
  ping: `
    <path d="M32 12 c-8 0 -14 6 -14 14 c0 10 14 24 14 24 s14 -14 14 -24 c0 -8 -6 -14 -14 -14 Z"
          fill="none" stroke="${S.outline}" stroke-width="8" stroke-linejoin="round"/>
    <path d="M32 12 c-8 0 -14 6 -14 14 c0 10 14 24 14 24 s14 -14 14 -24 c0 -8 -6 -14 -14 -14 Z"
          fill="${S.ping}" stroke="${S.outline}" stroke-width="1.4" stroke-linejoin="round"/>
    <circle cx="32" cy="26" r="5.2" fill="${S.outline}"/>
    <circle cx="32" cy="26" r="2.8" fill="${S.white}"/>
  `,

  // Factory rally point: flag + arrow (hotspot at the pole base).
  factoryWaypoint: `
    <g fill="none" stroke="${S.outline}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M16 54 V12"/>
      <path d="M16 14 H44 L37 22 L44 30 H16"/>
      <path d="M28 44 H46 M40 38 L48 44 L40 50"/>
    </g>
    <path d="M16 14 H44 L37 22 L44 30 H16 Z" fill="${S.move}"/>
    <g fill="none" stroke="${S.move}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M16 54 V12"/>
      <path d="M28 44 H46 M40 38 L48 44 L40 50"/>
    </g>
  `,
};

// ---------------------------------------------------------------------------
// CSS value generation
// ---------------------------------------------------------------------------

type CursorSpec = { hotX: number; hotY: number; fallback: string };

const SPECS: Record<Exclude<CommandCursorKind, 'default'>, CursorSpec> = {
  game: { hotX: 9, hotY: 7, fallback: 'default' },
  move: { hotX: 9, hotY: 7, fallback: 'crosshair' },
  fight: { hotX: 9, hotY: 7, fallback: 'crosshair' },
  patrol: { hotX: 9, hotY: 7, fallback: 'crosshair' },
  repair: { hotX: 9, hotY: 7, fallback: 'crosshair' },
  attack: { hotX: 32, hotY: 32, fallback: 'crosshair' },
  guard: { hotX: 32, hotY: 32, fallback: 'crosshair' },
  reclaim: { hotX: 32, hotY: 32, fallback: 'crosshair' },
  build: { hotX: 32, hotY: 32, fallback: 'crosshair' },
  blocked: { hotX: 32, hotY: 32, fallback: 'not-allowed' },
  dgun: { hotX: 32, hotY: 32, fallback: 'crosshair' },
  select: { hotX: 32, hotY: 32, fallback: 'crosshair' },
  ping: { hotX: 32, hotY: 50, fallback: 'crosshair' },
  factoryWaypoint: { hotX: 16, hotY: 54, fallback: 'crosshair' },
};

function svgDataUrl(inner: string, sizePx: number): string {
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}" viewBox="0 0 ${VIEWBOX} ${VIEWBOX}">${inner}</svg>`;
  const encoded = encodeURIComponent(markup).replace(/'/g, '%27').replace(/"/g, '%22');
  return `data:image/svg+xml,${encoded}`;
}

// Build the ordered cascade of `cursor` values (least → most preferred). The
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
 * The ordered list of `cursor` CSS values for a command, least → most
 * preferred. Assign each to `element.style.cursor` in order so the most
 * capable value the engine supports (high-DPI `image-set`) wins while older
 * engines fall back cleanly.
 */
export function getCommandCursorStyle(kind: CommandCursorKind): string[] {
  return CASCADES[kind] ?? CASCADES.default;
}
