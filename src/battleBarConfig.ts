import type { BattleBarConfig } from './types/battle';
import type { TerrainShape } from './types/terrain';
import { persist, persistJson, readPersisted, migrateKey } from './persistence';

export const BATTLE_CONFIG = {
  units: {
    jackal: { shortName: 'JKL', default: false },
    lynx: { shortName: 'LNX', default: true },
    daddy: { shortName: 'DDY', default: false },
    badger: { shortName: 'BDG', default: true },
    mongoose: { shortName: 'MGS', default: true },
    tick: { shortName: 'TCK', default: true },
    mammoth: { shortName: 'MMT', default: false },
    widow: { shortName: 'WDW', default: true },
    formik: { shortName: 'FMK', default: true },
    hippo: { shortName: 'HPO', default: true },
    tarantula: { shortName: 'TRN', default: false },
    loris: { shortName: 'LRS', default: false },
    commander: { shortName: 'CMD', default: true },
  } as Record<string, { shortName: string; default: boolean }>,
  cap: {
    default: Math.pow(2, 12),
    options: [
      Math.pow(2, 2),
      Math.pow(2, 4),
      Math.pow(2, 6),
      Math.pow(2, 8),
      Math.pow(2, 10),
      Math.pow(2, 12),
      Math.pow(2, 14),
    ] as readonly number[],
  },
  projVelInherit: { default: false },
  firingForce: { default: false },
  hitForce: { default: false },
  ffAccelUnits: { default: false },
  ffAccelShots: { default: true },
  // Terrain shape — applied at game-construction time via
  // setTerrainCenterShape / setTerrainDividersShape (Terrain.ts).
  // Default 'lake' for both: the central basin floods to a body of
  // water and the team-separator slices become trenches between
  // teams. The host's choice is read from localStorage when the
  // demo battle starts and again when the host launches the real
  // battle.
  center: {
    default: 'lake',
    options: [
      { value: 'lake', label: 'LAKE' },
      { value: 'mountain', label: 'MOUNTAIN' },
      { value: 'flat', label: 'FLAT' },
    ],
  },
  dividers: {
    default: 'lake',
    options: [
      { value: 'lake', label: 'LAKES' },
      { value: 'mountain', label: 'MOUNTAINS' },
      { value: 'flat', label: 'FLAT' },
    ],
  },
} as const satisfies BattleBarConfig;

// Default caps per mode (must be values from BATTLE_CONFIG.cap.options)
export const DEMO_CAP_DEFAULT = Math.pow(2, 8);   // 256 ≈ 3e+2
export const REAL_CAP_DEFAULT = BATTLE_CONFIG.cap.default;   // 4096 ≈ 4e+3

export const BATTLE_MODE_DEFAULTS = {
  demo: {
    cap: DEMO_CAP_DEFAULT,
    grid: true,
    barsCollapsed: false,
  },
  real: {
    cap: REAL_CAP_DEFAULT,
    grid: false,
    barsCollapsed: false,
  },
} as const;

// ── localStorage keys (module-private) ──
// `demo-battle-*` and `real-battle-*` namespace each setting to the
// bar/mode it belongs to. EVERY setting that's tunable in BOTH
// modes (firing force, hit force, ff accel, projectile velocity
// inheritance, terrain shapes) gets paired demo + real keys so
// the two modes don't bleed:
//
//   demo battle = the visual demo running on initial page load
//                 (the BUDGET ANNIHILATION backdrop) and any time
//                 the user is back at that screen.
//   real battle = the GAME LOBBY preview AND the REAL BATTLE
//                 itself. Lobby mutations write to the real keys;
//                 the lobby preview reads from them so the
//                 preview shows what the upcoming real game will
//                 look like, not whatever the user had set on
//                 their last solo demo.
//
// First-read fallback: when a `real-battle-*` key has no value
// yet, the loader falls back to the matching `demo-battle-*`
// value — so existing customizations carry over to real battle
// the first time a user enters the lobby, and only diverge when
// the user explicitly changes them in the lobby.
//
// Legacy `rts-*` keys are migrated lazily into `demo-battle-*`
// (the original "battle" namespace) by the load helpers below.
const STORAGE_DEMO_UNITS = 'demo-battle-units';
const STORAGE_DEMO_CAP = 'demo-battle-cap';
const STORAGE_REAL_CAP = 'real-battle-cap';
const STORAGE_DEMO_GRID = 'demo-battle-grid';
const STORAGE_REAL_GRID = 'real-battle-grid';
const STORAGE_DEMO_PROJ_VEL_INHERIT = 'demo-battle-proj-vel-inherit';
const STORAGE_REAL_PROJ_VEL_INHERIT = 'real-battle-proj-vel-inherit';
const STORAGE_DEMO_FIRING_FORCE = 'demo-battle-firing-force';
const STORAGE_REAL_FIRING_FORCE = 'real-battle-firing-force';
const STORAGE_DEMO_HIT_FORCE = 'demo-battle-hit-force';
const STORAGE_REAL_HIT_FORCE = 'real-battle-hit-force';
const STORAGE_DEMO_FF_ACCEL_UNITS = 'demo-battle-ff-accel-units';
const STORAGE_REAL_FF_ACCEL_UNITS = 'real-battle-ff-accel-units';
const STORAGE_DEMO_FF_ACCEL_SHOTS = 'demo-battle-ff-accel-shots';
const STORAGE_REAL_FF_ACCEL_SHOTS = 'real-battle-ff-accel-shots';
const STORAGE_DEMO_TERRAIN_CENTER = 'demo-battle-terrain-center';
const STORAGE_REAL_TERRAIN_CENTER = 'real-battle-terrain-center';
const STORAGE_DEMO_TERRAIN_DIVIDERS = 'demo-battle-terrain-dividers';
const STORAGE_REAL_TERRAIN_DIVIDERS = 'real-battle-terrain-dividers';
// Bottom-bars collapsed state. Persisted PER MODE so the user can
// keep the bars expanded in demo (where they tune sim/visual
// settings) and collapsed in real-battle (where map real estate
// matters more) — or any other mix — and have those preferences
// survive a page refresh independently.
const STORAGE_DEMO_BARS_COLLAPSED = 'demo-battle-bottom-bars-collapsed';
const STORAGE_REAL_BARS_COLLAPSED = 'real-battle-bottom-bars-collapsed';

const BATTLE_KEY_MIGRATIONS: ReadonlyArray<readonly [string, string]> = [
  ['rts-demo-units', STORAGE_DEMO_UNITS],
  ['rts-demo-cap', STORAGE_DEMO_CAP],
  ['rts-real-cap', STORAGE_REAL_CAP],
  ['rts-demo-grid', STORAGE_DEMO_GRID],
  ['rts-real-grid', STORAGE_REAL_GRID],
  ['rts-proj-vel-inherit', STORAGE_DEMO_PROJ_VEL_INHERIT],
  ['rts-firing-force', STORAGE_DEMO_FIRING_FORCE],
  ['rts-hit-force', STORAGE_DEMO_HIT_FORCE],
  ['rts-ff-accel-units', STORAGE_DEMO_FF_ACCEL_UNITS],
  ['rts-ff-accel-shots', STORAGE_DEMO_FF_ACCEL_SHOTS],
  ['rts-terrain-center', STORAGE_DEMO_TERRAIN_CENTER],
  ['rts-terrain-dividers', STORAGE_DEMO_TERRAIN_DIVIDERS],
];

let _battleMigrationsRun = false;
/** Run the legacy → prefixed key rename once per process. Each
 *  load helper calls this before reading; idempotent. */
function ensureBattleMigrations(): void {
  if (_battleMigrationsRun) return;
  _battleMigrationsRun = true;
  for (const [oldK, newK] of BATTLE_KEY_MIGRATIONS) migrateKey(oldK, newK);
}

/** "true"/"false" → boolean, null otherwise. Keeps each loader a
 *  one-liner now that the try/catch is pushed into readPersisted.
 *  Triggers the legacy-key migration on every read so the rename
 *  from `rts-*` to `demo-battle-*` / `real-battle-*` is invisible
 *  to existing users (the once-per-process flag inside makes the
 *  call cheap after the first invocation). */
function loadBool(key: string): boolean | null {
  ensureBattleMigrations();
  const s = readPersisted(key);
  if (s === 'true') return true;
  if (s === 'false') return false;
  return null;
}

/** "<positive-number>" → number, null otherwise. */
function loadPosNum(key: string): number | null {
  ensureBattleMigrations();
  const s = readPersisted(key);
  if (!s) return null;
  const n = Number(s);
  return !isNaN(n) && n > 0 ? n : null;
}

export function loadStoredDemoUnits(): string[] | null {
  ensureBattleMigrations();
  const stored = readPersisted(STORAGE_DEMO_UNITS);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* malformed JSON */ }
  return null;
}

export function saveDemoUnits(units: string[]): void {
  persistJson(STORAGE_DEMO_UNITS, units);
}

export function getDefaultDemoUnits(): string[] {
  return Object.entries(BATTLE_CONFIG.units)
    .filter(([, cfg]) => cfg.default)
    .map(([id]) => id);
}

export function loadStoredDemoCap(): number {
  return loadPosNum(STORAGE_DEMO_CAP) ?? BATTLE_MODE_DEFAULTS.demo.cap;
}

export function saveDemoCap(value: number): void {
  persist(STORAGE_DEMO_CAP, String(value));
}

export function loadStoredRealCap(): number {
  return loadPosNum(STORAGE_REAL_CAP) ?? BATTLE_MODE_DEFAULTS.real.cap;
}

export function saveRealCap(value: number): void {
  persist(STORAGE_REAL_CAP, String(value));
}

export function loadStoredDemoGrid(): boolean {
  return loadBool(STORAGE_DEMO_GRID) ?? BATTLE_MODE_DEFAULTS.demo.grid;
}

export function saveDemoGrid(enabled: boolean): void {
  persist(STORAGE_DEMO_GRID, String(enabled));
}

export function loadStoredRealGrid(): boolean {
  return loadBool(STORAGE_REAL_GRID) ?? BATTLE_MODE_DEFAULTS.real.grid;
}

export function saveRealGrid(enabled: boolean): void {
  persist(STORAGE_REAL_GRID, String(enabled));
}

export function loadStoredGrid(mode: BattleMode): boolean {
  return mode === 'real' ? loadStoredRealGrid() : loadStoredDemoGrid();
}

export function saveStoredGrid(mode: BattleMode, enabled: boolean): void {
  if (mode === 'real') saveRealGrid(enabled);
  else saveDemoGrid(enabled);
}

export function loadStoredDemoBarsCollapsed(): boolean {
  return loadBool(STORAGE_DEMO_BARS_COLLAPSED) ?? BATTLE_MODE_DEFAULTS.demo.barsCollapsed;
}

export function saveDemoBarsCollapsed(collapsed: boolean): void {
  persist(STORAGE_DEMO_BARS_COLLAPSED, String(collapsed));
}

export function loadStoredRealBarsCollapsed(): boolean {
  return loadBool(STORAGE_REAL_BARS_COLLAPSED) ?? BATTLE_MODE_DEFAULTS.real.barsCollapsed;
}

export function saveRealBarsCollapsed(collapsed: boolean): void {
  persist(STORAGE_REAL_BARS_COLLAPSED, String(collapsed));
}

/** Identifies which battle context a setting belongs to.
 *  - `demo` = the visual demo running on the BUDGET ANNIHILATION
 *    backdrop (initial page load + any return to that screen).
 *  - `real` = the GAME LOBBY preview AND the REAL BATTLE itself.
 *  Pass this to every battle-setting load / save call so the
 *  two namespaces stay isolated. */
export type BattleMode = 'demo' | 'real';

export function getDefaultCap(mode: BattleMode): number {
  return BATTLE_MODE_DEFAULTS[mode].cap;
}

export function loadStoredCap(mode: BattleMode): number {
  return mode === 'real' ? loadStoredRealCap() : loadStoredDemoCap();
}

export function saveStoredCap(mode: BattleMode, value: number): void {
  if (mode === 'real') saveRealCap(value);
  else saveDemoCap(value);
}

export function getDefaultGrid(mode: BattleMode): boolean {
  return BATTLE_MODE_DEFAULTS[mode].grid;
}

/** Read a per-mode boolean. When `mode === 'real'` and the real
 *  key has never been written, falls back to the demo key (so a
 *  user's existing demo customizations seed real-battle on first
 *  use). Demo mode falls back to the BATTLE_CONFIG default. */
function loadModeBool(
  mode: BattleMode,
  realKey: string,
  demoKey: string,
  defaultValue: boolean,
): boolean {
  ensureBattleMigrations();
  const primary = loadBool(mode === 'real' ? realKey : demoKey);
  if (primary !== null) return primary;
  if (mode === 'real') {
    const demoFallback = loadBool(demoKey);
    if (demoFallback !== null) return demoFallback;
  }
  return defaultValue;
}

export function loadStoredProjVelInherit(mode: BattleMode): boolean {
  return loadModeBool(
    mode, STORAGE_REAL_PROJ_VEL_INHERIT, STORAGE_DEMO_PROJ_VEL_INHERIT,
    BATTLE_CONFIG.projVelInherit.default,
  );
}

export function saveProjVelInherit(enabled: boolean, mode: BattleMode): void {
  persist(
    mode === 'real' ? STORAGE_REAL_PROJ_VEL_INHERIT : STORAGE_DEMO_PROJ_VEL_INHERIT,
    String(enabled),
  );
}

export function loadStoredFiringForce(mode: BattleMode): boolean {
  return loadModeBool(
    mode, STORAGE_REAL_FIRING_FORCE, STORAGE_DEMO_FIRING_FORCE,
    BATTLE_CONFIG.firingForce.default,
  );
}

export function saveFiringForce(enabled: boolean, mode: BattleMode): void {
  persist(
    mode === 'real' ? STORAGE_REAL_FIRING_FORCE : STORAGE_DEMO_FIRING_FORCE,
    String(enabled),
  );
}

export function loadStoredHitForce(mode: BattleMode): boolean {
  return loadModeBool(
    mode, STORAGE_REAL_HIT_FORCE, STORAGE_DEMO_HIT_FORCE,
    BATTLE_CONFIG.hitForce.default,
  );
}

export function saveHitForce(enabled: boolean, mode: BattleMode): void {
  persist(
    mode === 'real' ? STORAGE_REAL_HIT_FORCE : STORAGE_DEMO_HIT_FORCE,
    String(enabled),
  );
}

export function loadStoredFfAccelUnits(mode: BattleMode): boolean {
  return loadModeBool(
    mode, STORAGE_REAL_FF_ACCEL_UNITS, STORAGE_DEMO_FF_ACCEL_UNITS,
    BATTLE_CONFIG.ffAccelUnits.default,
  );
}

export function saveFfAccelUnits(enabled: boolean, mode: BattleMode): void {
  persist(
    mode === 'real' ? STORAGE_REAL_FF_ACCEL_UNITS : STORAGE_DEMO_FF_ACCEL_UNITS,
    String(enabled),
  );
}

export function loadStoredFfAccelShots(mode: BattleMode): boolean {
  return loadModeBool(
    mode, STORAGE_REAL_FF_ACCEL_SHOTS, STORAGE_DEMO_FF_ACCEL_SHOTS,
    BATTLE_CONFIG.ffAccelShots.default,
  );
}

export function saveFfAccelShots(enabled: boolean, mode: BattleMode): void {
  persist(
    mode === 'real' ? STORAGE_REAL_FF_ACCEL_SHOTS : STORAGE_DEMO_FF_ACCEL_SHOTS,
    String(enabled),
  );
}

/** Validate a string against the known TerrainShape values. Anything
 *  else (corrupted localStorage, removed value) returns null so the
 *  caller falls back to the config default. */
function parseTerrainShape(s: string | null): TerrainShape | null {
  if (s === 'lake' || s === 'mountain' || s === 'flat') return s;
  return null;
}

export function loadStoredTerrainCenter(mode: BattleMode): TerrainShape {
  ensureBattleMigrations();
  const primary = parseTerrainShape(readPersisted(
    mode === 'real' ? STORAGE_REAL_TERRAIN_CENTER : STORAGE_DEMO_TERRAIN_CENTER,
  ));
  if (primary !== null) return primary;
  if (mode === 'real') {
    const demoFallback = parseTerrainShape(readPersisted(STORAGE_DEMO_TERRAIN_CENTER));
    if (demoFallback !== null) return demoFallback;
  }
  return BATTLE_CONFIG.center.default;
}

export function saveTerrainCenter(shape: TerrainShape, mode: BattleMode): void {
  persist(
    mode === 'real' ? STORAGE_REAL_TERRAIN_CENTER : STORAGE_DEMO_TERRAIN_CENTER,
    shape,
  );
}

export function loadStoredTerrainDividers(mode: BattleMode): TerrainShape {
  ensureBattleMigrations();
  const primary = parseTerrainShape(readPersisted(
    mode === 'real' ? STORAGE_REAL_TERRAIN_DIVIDERS : STORAGE_DEMO_TERRAIN_DIVIDERS,
  ));
  if (primary !== null) return primary;
  if (mode === 'real') {
    const demoFallback = parseTerrainShape(readPersisted(STORAGE_DEMO_TERRAIN_DIVIDERS));
    if (demoFallback !== null) return demoFallback;
  }
  return BATTLE_CONFIG.dividers.default;
}

export function saveTerrainDividers(shape: TerrainShape, mode: BattleMode): void {
  persist(
    mode === 'real' ? STORAGE_REAL_TERRAIN_DIVIDERS : STORAGE_DEMO_TERRAIN_DIVIDERS,
    shape,
  );
}
