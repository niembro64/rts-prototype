// Original, vector-first command cursors for the battlefield canvas.
//
// SVG is deliberate here: each cursor has a 64px intrinsic canvas (the usual
// browser-safe upper bound is 128px) and remains crisp when the OS or browser
// increases pointer scale.  The artwork is authored from first principles;
// its high-contrast outline and action colours follow the familiar RTS visual
// language without using any external cursor art or animation frames.

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

type CursorSpec = {
  svg: string;
  hotX: number;
  hotY: number;
  fallback: string;
};

const S = COLORS.ui.commandCursor;

// The drawing grid is intentionally smaller than the intrinsic SVG size.
// This keeps a large, high-resolution backing image while retaining a clear
// command-cursor footprint and enough transparent edge room for wide strokes.
const VIEWBOX_SIZE = 48;
const CURSOR_SIZE = 64;
const CURSOR_SCALE = CURSOR_SIZE / VIEWBOX_SIZE;

function svg(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CURSOR_SIZE}" height="${CURSOR_SIZE}" viewBox="0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}">${inner}</svg>`;
}

function hotspot(value: number): number {
  return Math.round(value * CURSOR_SCALE);
}

function cursorUrl(spec: CursorSpec): string {
  const data = encodeURIComponent(spec.svg)
    .replace(/'/g, '%27')
    .replace(/"/g, '%22');
  return `url("data:image/svg+xml,${data}") ${spec.hotX} ${spec.hotY}, ${spec.fallback}`;
}

function outlined(
  inner: string,
  color: string,
  innerWidth = 2.6,
  outlineWidth = 6.5,
): string {
  return `
    <g fill="none" stroke="${S.outline}" stroke-width="${outlineWidth}" stroke-linecap="round" stroke-linejoin="round">${inner}</g>
    <g fill="none" stroke="${color}" stroke-width="${innerWidth}" stroke-linecap="round" stroke-linejoin="round">${inner}</g>
  `;
}

function pointer(
  color: string,
  accents = '',
): string {
  return `
    <path d="M7 5.5 33.5 18.1 22.1 21.8 16.7 35.1Z" fill="${S.outline}" stroke="${S.outline}" stroke-width="3.5" stroke-linejoin="round"/>
    <path d="M8.8 7.9 29.6 18 20.2 21 16.2 30.8Z" fill="${color}" stroke="${S.white}" stroke-width="1.15" stroke-linejoin="round"/>
    <path d="M13.2 11.2 23.7 17.3 18.3 19" fill="none" stroke="${S.white}" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>
    ${accents}
  `;
}

// Normal and move deliberately share an arrow silhouette: move is the
// familiar command-arrow, while the normal cursor remains neutral and white.
const GAME = svg(pointer(S.game, `
  <path d="M19.5 33.6 24.9 39" fill="none" stroke="${S.outline}" stroke-width="5.1" stroke-linecap="round"/>
  <path d="M19.5 33.6 24.9 39" fill="none" stroke="${S.game}" stroke-width="2.15" stroke-linecap="round"/>
`));

const SELECT = svg(outlined(`
  <path d="M16 6v6M16 36v6M6 16h6M36 16h6"/>
  <path d="M10 10h5M33 10h5M10 38h5M33 38h5"/>
  <path d="m16 20 4 4-4 4-4-4Z"/>
`, S.ping, 2.4, 6.2));

const MOVE = svg(pointer(S.move, `
  <path d="M25.6 29.4 34.2 38M29.7 29.2l4.7 4.7M25.4 33.6l4.7 4.7" fill="none" stroke="${S.outline}" stroke-width="5.3" stroke-linecap="round"/>
  <path d="M25.6 29.4 34.2 38M29.7 29.2l4.7 4.7M25.4 33.6l4.7 4.7" fill="none" stroke="${S.move}" stroke-width="2.1" stroke-linecap="round"/>
`));

const FIGHT = svg(pointer(S.fight, `
  <circle cx="35.4" cy="10.9" r="5.2" fill="${S.outline}"/>
  <circle cx="35.4" cy="10.9" r="3.1" fill="none" stroke="${S.fight}" stroke-width="1.8"/>
  <path d="M35.4 3.9v2.5M35.4 15.4v2.5M28.4 10.9h2.5M39.9 10.9h2.5" fill="none" stroke="${S.white}" stroke-width="1.55" stroke-linecap="round"/>
`));

const PATROL = svg(pointer(S.patrol, `
  <path d="M29.2 30.8a8.8 8.8 0 0 0 9.6-1.7M38.8 29.1l-1.1 5.2M38.8 29.1l-5.3.7" fill="none" stroke="${S.outline}" stroke-width="5.4" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M29.2 30.8a8.8 8.8 0 0 0 9.6-1.7M38.8 29.1l-1.1 5.2M38.8 29.1l-5.3.7" fill="none" stroke="${S.patrol}" stroke-width="2.15" stroke-linecap="round" stroke-linejoin="round"/>
`));

const ATTACK = svg(outlined(`
  <circle cx="24" cy="24" r="9.3"/>
  <path d="M24 5.5v7M24 35.5v7M5.5 24h7M35.5 24h7"/>
  <path d="m20.6 24 3.4-3.4 3.4 3.4-3.4 3.4Z"/>
`, S.attack, 2.7, 6.8));

const GUARD = svg(`
  <path d="M24 5.5 38 11v9.2c0 9.4-5.4 16.2-14 21.1-8.6-4.9-14-11.7-14-21.1V11Z" fill="${S.outline}" stroke="${S.outline}" stroke-width="3.1" stroke-linejoin="round"/>
  <path d="M24 8.8 35 13v7.1c0 7.4-4.1 12.9-11 17.1-6.9-4.2-11-9.7-11-17.1V13Z" fill="${S.guard}" stroke="${S.white}" stroke-width="1.2" stroke-linejoin="round"/>
  <path d="M24 15.4v13.5M17.3 22.1h13.4" fill="none" stroke="${S.white}" stroke-width="2.25" stroke-linecap="round"/>
`);

const REPAIR = svg(pointer(S.repair, `
  <path d="m29.1 28.5 8.8 8.8M34.7 25.7a5.7 5.7 0 0 1-7.8-7.8l3.2 3.2 3.1-3.1-3.2-3.2a5.7 5.7 0 0 1 7.8 7.8Z" fill="${S.outline}" stroke="${S.outline}" stroke-width="2.7" stroke-linejoin="round"/>
  <path d="m29.1 28.5 8.8 8.8M34.7 25.7a5.7 5.7 0 0 1-7.8-7.8l3.2 3.2 3.1-3.1-3.2-3.2a5.7 5.7 0 0 1 7.8 7.8Z" fill="none" stroke="${S.repair}" stroke-width="1.8" stroke-linejoin="round"/>
  <circle cx="38.7" cy="38.2" r="2.4" fill="${S.repair}" stroke="${S.white}" stroke-width="1"/>
`));

const RECLAIM = svg(outlined(`
  <path d="M24 6.5 32.8 12l-2.8 1.6 4.2 6.6 3-1.7v10.3H26.9l3-1.8-4.2-6.6-2.6 1.6Z"/>
  <path d="m12.5 18.6 8.8-5.4v3.2h7.8v-3.5l8.9 5.4-5.2 8.9-1.8-3.1h-7.6v3.4l-8.9-5.3Z" transform="rotate(120 24 24)"/>
  <path d="m12.5 18.6 8.8-5.4v3.2h7.8v-3.5l8.9 5.4-5.2 8.9-1.8-3.1h-7.6v3.4l-8.9-5.3Z" transform="rotate(240 24 24)"/>
`, S.reclaim, 1.9, 5.8));

const BUILD = svg(outlined(`
  <path d="M8 17V9h8M32 9h8v8M40 31v8h-8M16 39H8v-8"/>
  <path d="M17 17h14v14H17Z"/>
  <path d="M24 20v8M20 24h8"/>
`, S.build, 2.55, 6.4));

const BLOCKED = svg(outlined(`
  <circle cx="24" cy="24" r="15.2"/>
  <path d="m13.2 34.8 21.6-21.6"/>
`, S.attack, 2.9, 7));

const DGUN = svg(`
  <circle cx="24" cy="24" r="15.5" fill="${S.outline}" stroke="${S.outline}" stroke-width="3.2"/>
  <circle cx="24" cy="24" r="12.4" fill="none" stroke="${S.dgun}" stroke-width="2.4"/>
  <path d="m27.4 9.9-10 14h6.8l-3.1 14.2 10.6-15h-6.8Z" fill="${S.dgun}" stroke="${S.white}" stroke-width="1.25" stroke-linejoin="round"/>
  <path d="M24 4.5v3M24 40.5v3M4.5 24h3M40.5 24h3" fill="none" stroke="${S.white}" stroke-width="1.55" stroke-linecap="round"/>
`);

const PING = svg(outlined(`
  <path d="M24 8.2c-6.1 0-11.1 4.8-11.1 10.8 0 7.7 7.2 13.9 11.1 20.7 3.9-6.8 11.1-13 11.1-20.7 0-6-5-10.8-11.1-10.8Z"/>
  <circle cx="24" cy="19" r="3"/>
  <path d="M24 3.8v1.6M7.3 19H9M39 19h1.7"/>
`, S.ping, 2.35, 6.1));

const FACTORY_WAYPOINT = svg(outlined(`
  <path d="M13 41V8"/>
  <path d="M13 9h23l-5.4 7 5.4 7H13"/>
  <path d="M8.4 41h9.2"/>
  <path d="M22 34h16M33.5 29.5 38 34l-4.5 4.5"/>
`, S.move, 2.45, 6.3));

const CURSOR_SPECS: Record<Exclude<CommandCursorKind, 'default'>, CursorSpec> = {
  game: { svg: GAME, hotX: hotspot(7), hotY: hotspot(5.5), fallback: 'default' },
  select: { svg: SELECT, hotX: hotspot(24), hotY: hotspot(24), fallback: 'crosshair' },
  move: { svg: MOVE, hotX: hotspot(7), hotY: hotspot(5.5), fallback: 'crosshair' },
  fight: { svg: FIGHT, hotX: hotspot(7), hotY: hotspot(5.5), fallback: 'crosshair' },
  patrol: { svg: PATROL, hotX: hotspot(7), hotY: hotspot(5.5), fallback: 'crosshair' },
  attack: { svg: ATTACK, hotX: hotspot(24), hotY: hotspot(24), fallback: 'crosshair' },
  guard: { svg: GUARD, hotX: hotspot(24), hotY: hotspot(24), fallback: 'crosshair' },
  repair: { svg: REPAIR, hotX: hotspot(7), hotY: hotspot(5.5), fallback: 'crosshair' },
  reclaim: { svg: RECLAIM, hotX: hotspot(24), hotY: hotspot(24), fallback: 'crosshair' },
  build: { svg: BUILD, hotX: hotspot(24), hotY: hotspot(24), fallback: 'crosshair' },
  blocked: { svg: BLOCKED, hotX: hotspot(24), hotY: hotspot(24), fallback: 'not-allowed' },
  dgun: { svg: DGUN, hotX: hotspot(24), hotY: hotspot(24), fallback: 'crosshair' },
  ping: { svg: PING, hotX: hotspot(24), hotY: hotspot(19), fallback: 'crosshair' },
  factoryWaypoint: { svg: FACTORY_WAYPOINT, hotX: hotspot(13), hotY: hotspot(41), fallback: 'crosshair' },
};

const CURSOR_STYLES: Record<CommandCursorKind, string> = {
  default: cursorUrl(CURSOR_SPECS.game),
  game: cursorUrl(CURSOR_SPECS.game),
  select: cursorUrl(CURSOR_SPECS.select),
  move: cursorUrl(CURSOR_SPECS.move),
  fight: cursorUrl(CURSOR_SPECS.fight),
  patrol: cursorUrl(CURSOR_SPECS.patrol),
  attack: cursorUrl(CURSOR_SPECS.attack),
  guard: cursorUrl(CURSOR_SPECS.guard),
  repair: cursorUrl(CURSOR_SPECS.repair),
  reclaim: cursorUrl(CURSOR_SPECS.reclaim),
  build: cursorUrl(CURSOR_SPECS.build),
  blocked: cursorUrl(CURSOR_SPECS.blocked),
  dgun: cursorUrl(CURSOR_SPECS.dgun),
  ping: cursorUrl(CURSOR_SPECS.ping),
  factoryWaypoint: cursorUrl(CURSOR_SPECS.factoryWaypoint),
};

export function getCommandCursorStyle(kind: CommandCursorKind): string {
  return CURSOR_STYLES[kind] ?? CURSOR_STYLES.default;
}
