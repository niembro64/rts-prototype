// Command cursors are authored in-repo so the game has one clean source
// of truth for pointer states. Keep them simple: shape conveys action,
// color conveys intent.

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
  | 'build'
  | 'blocked'
  | 'dgun'
  | 'factoryWaypoint';

type CursorSpec = {
  svg: string;
  hotX: number;
  hotY: number;
  fallback: string;
};

const S = {
  outline: '#02040a',
  white: '#f7fbff',
  move: '#35e86f',
  fight: '#ffb340',
  patrol: '#45bcff',
  attack: '#ff4054',
  guard: '#9ef28d',
  repair: '#63e7ff',
  build: '#ffd33f',
  dgun: '#ff8d24',
  game: '#9bd8ff',
} as const;

function svg(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${inner}</svg>`;
}

function cursorUrl(spec: CursorSpec): string {
  const data = encodeURIComponent(spec.svg)
    .replace(/'/g, '%27')
    .replace(/"/g, '%22');
  return `url("data:image/svg+xml,${data}") ${spec.hotX} ${spec.hotY}, ${spec.fallback}`;
}

const GAME = svg(`
  <path d="M5 4l16.5 15-7.3.9-2.6 7.1z" fill="${S.outline}" stroke="${S.outline}" stroke-width="2.4" stroke-linejoin="round"/>
  <path d="M7 6.8l11 10-5.5.7-1.9 5.4z" fill="${S.white}" stroke="${S.game}" stroke-width="1.25" stroke-linejoin="round"/>
`);

const SELECT = svg(`
  <g fill="none" stroke="${S.outline}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8 12V8h4M20 8h4v4M24 20v4h-4M12 24H8v-4"/>
    <circle cx="16" cy="16" r="3.5"/>
  </g>
  <g fill="none" stroke="${S.white}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8 12V8h4M20 8h4v4M24 20v4h-4M12 24H8v-4"/>
    <circle cx="16" cy="16" r="3.5"/>
  </g>
`);

const MOVE = svg(`
  <g fill="none" stroke="${S.outline}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M16 6v17"/>
    <path d="M9 17l7 7 7-7"/>
    <circle cx="16" cy="16" r="5"/>
  </g>
  <g fill="none" stroke="${S.move}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M16 6v17"/>
    <path d="M9 17l7 7 7-7"/>
    <circle cx="16" cy="16" r="5"/>
  </g>
`);

const FIGHT = svg(`
  <g fill="none" stroke="${S.outline}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M16 6v16"/>
    <path d="M10 16l6 6 6-6"/>
    <circle cx="22" cy="10" r="4"/>
    <path d="M22 6v8M18 10h8"/>
  </g>
  <g fill="none" stroke="${S.fight}" stroke-width="2.35" stroke-linecap="round" stroke-linejoin="round">
    <path d="M16 6v16"/>
    <path d="M10 16l6 6 6-6"/>
    <circle cx="22" cy="10" r="4"/>
    <path d="M22 6v8M18 10h8"/>
  </g>
`);

const PATROL = svg(`
  <g fill="none" stroke="${S.outline}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9 13a8 8 0 0 1 13-3"/>
    <path d="M22 10h-5M22 10v-5"/>
    <path d="M23 19a8 8 0 0 1-13 3"/>
    <path d="M10 22h5M10 22v5"/>
  </g>
  <g fill="none" stroke="${S.patrol}" stroke-width="2.35" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9 13a8 8 0 0 1 13-3"/>
    <path d="M22 10h-5M22 10v-5"/>
    <path d="M23 19a8 8 0 0 1-13 3"/>
    <path d="M10 22h5M10 22v5"/>
  </g>
`);

const ATTACK = svg(`
  <g fill="none" stroke="${S.outline}" stroke-width="5" stroke-linecap="round">
    <circle cx="16" cy="16" r="8"/>
    <path d="M16 5v6M16 21v6M5 16h6M21 16h6"/>
  </g>
  <g fill="none" stroke="${S.attack}" stroke-width="2.35" stroke-linecap="round">
    <circle cx="16" cy="16" r="8"/>
    <path d="M16 5v6M16 21v6M5 16h6M21 16h6"/>
  </g>
`);

const GUARD = svg(`
  <g fill="none" stroke="${S.outline}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M16 5l9 4v6c0 6-4 10-9 12-5-2-9-6-9-12V9z"/>
    <path d="M16 11v9M11.5 15.5h9"/>
  </g>
  <g fill="none" stroke="${S.guard}" stroke-width="2.35" stroke-linecap="round" stroke-linejoin="round">
    <path d="M16 5l9 4v6c0 6-4 10-9 12-5-2-9-6-9-12V9z"/>
    <path d="M16 11v9M11.5 15.5h9"/>
  </g>
`);

const REPAIR = svg(`
  <g fill="none" stroke="${S.outline}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="16" cy="16" r="8"/>
    <path d="M16 10v12M10 16h12"/>
  </g>
  <g fill="none" stroke="${S.repair}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="16" cy="16" r="8"/>
    <path d="M16 10v12M10 16h12"/>
  </g>
`);

const BUILD = svg(`
  <g fill="none" stroke="${S.outline}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="8" y="8" width="16" height="16" rx="1.5"/>
    <path d="M16 11v10M11 16h10"/>
  </g>
  <g fill="none" stroke="${S.build}" stroke-width="2.45" stroke-linecap="round" stroke-linejoin="round">
    <rect x="8" y="8" width="16" height="16" rx="1.5"/>
    <path d="M16 11v10M11 16h10"/>
  </g>
`);

const BLOCKED = svg(`
  <g fill="none" stroke="${S.outline}" stroke-width="5" stroke-linecap="round">
    <circle cx="16" cy="16" r="10"/>
    <path d="M9 23L23 9"/>
  </g>
  <g fill="none" stroke="${S.attack}" stroke-width="2.8" stroke-linecap="round">
    <circle cx="16" cy="16" r="10"/>
    <path d="M9 23L23 9"/>
  </g>
`);

const DGUN = svg(`
  <path d="M18 3L7 17h8l-1 12 11-16h-8z" fill="${S.outline}" stroke="${S.outline}" stroke-width="3.2" stroke-linejoin="round"/>
  <path d="M18 3L7 17h8l-1 12 11-16h-8z" fill="${S.dgun}" stroke="${S.white}" stroke-width="1.1" stroke-linejoin="round"/>
`);

const FACTORY_WAYPOINT = svg(`
  <g fill="none" stroke="${S.outline}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10 26V6"/>
    <path d="M10 7h13l-4 4 4 4H10"/>
    <path d="M7 26h9"/>
  </g>
  <g fill="none" stroke="${S.move}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10 26V6"/>
    <path d="M10 7h13l-4 4 4 4H10"/>
    <path d="M7 26h9"/>
  </g>
`);

const CURSOR_SPECS: Record<Exclude<CommandCursorKind, 'default'>, CursorSpec> = {
  game: { svg: GAME, hotX: 6, hotY: 6, fallback: 'default' },
  select: { svg: SELECT, hotX: 16, hotY: 16, fallback: 'crosshair' },
  move: { svg: MOVE, hotX: 16, hotY: 16, fallback: 'crosshair' },
  fight: { svg: FIGHT, hotX: 16, hotY: 16, fallback: 'crosshair' },
  patrol: { svg: PATROL, hotX: 16, hotY: 16, fallback: 'crosshair' },
  attack: { svg: ATTACK, hotX: 16, hotY: 16, fallback: 'crosshair' },
  guard: { svg: GUARD, hotX: 16, hotY: 16, fallback: 'crosshair' },
  repair: { svg: REPAIR, hotX: 11, hotY: 17, fallback: 'crosshair' },
  build: { svg: BUILD, hotX: 8, hotY: 20, fallback: 'crosshair' },
  blocked: { svg: BLOCKED, hotX: 16, hotY: 16, fallback: 'not-allowed' },
  dgun: { svg: DGUN, hotX: 16, hotY: 16, fallback: 'crosshair' },
  factoryWaypoint: { svg: FACTORY_WAYPOINT, hotX: 10, hotY: 27, fallback: 'crosshair' },
};

const CURSOR_STYLES: Record<CommandCursorKind, string> = {
  default: '',
  game: cursorUrl(CURSOR_SPECS.game),
  select: cursorUrl(CURSOR_SPECS.select),
  move: cursorUrl(CURSOR_SPECS.move),
  fight: cursorUrl(CURSOR_SPECS.fight),
  patrol: cursorUrl(CURSOR_SPECS.patrol),
  attack: cursorUrl(CURSOR_SPECS.attack),
  guard: cursorUrl(CURSOR_SPECS.guard),
  repair: cursorUrl(CURSOR_SPECS.repair),
  build: cursorUrl(CURSOR_SPECS.build),
  blocked: cursorUrl(CURSOR_SPECS.blocked),
  dgun: cursorUrl(CURSOR_SPECS.dgun),
  factoryWaypoint: cursorUrl(CURSOR_SPECS.factoryWaypoint),
};

export function getCommandCursorStyle(kind: CommandCursorKind): string {
  return CURSOR_STYLES[kind] ?? '';
}
