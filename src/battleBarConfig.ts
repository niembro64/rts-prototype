import type { BattleBarConfig } from './types/battle';
import type { TerrainMapShape, TerrainShape } from './types/terrain';
import { persist, persistJson, readPersisted, migrateKey } from './persistence';

const clean = (x: number) => {
  return Math.floor(Math.pow(3, x));
};

export const BATTLE_CONFIG = {
  units: {
    jackal: { default: true },
    lynx: { default: true },
    daddy: { default: false },
    badger: { default: true },
    mongoose: { default: true },
    tick: { default: true },
    mammoth: { default: true },
    widow: { default: true },
    formik: { default: true },
    hippo: { default: true },
    tarantula: { default: true },
    loris: { default: true },
    commander: { default: true },
  } as Record<string, { default: boolean }>,
  cap: {
    default: clean(5),
    options: [
      // clean(1),
      clean(2),
      // clean(3),
      clean(4),
      clean(5),
      clean(6),
      clean(6.5),
      clean(7),
    ] as readonly number[],
  },
  ffAccelUnits: { default: false },
  ffAccelShots: { default: true },
  mirrorsEnabled: { default: true },
  forceFieldsEnabled: { default: true },
  // Terrain shape — applied at game-construction time via
  // setTerrainCenterShape / setTerrainDividersShape (Terrain.ts).
  // User-facing "VALLEY" options still map to the internal "lake"
  // terrain shape so persisted settings and generation code remain
  // stable while the UI uses the broader terrain language.
  center: {
    default: 'flat',
    options: [
      { value: 'lake', label: 'VALLEY' },
      { value: 'mountain', label: 'MOUNTAIN' },
      { value: 'flat', label: 'FLAT' },
    ],
  },
  dividers: {
    default: 'lake',
    options: [
      { value: 'lake', label: 'VALLEYS' },
      { value: 'mountain', label: 'MOUNTAINS' },
      { value: 'flat', label: 'FLAT' },
    ],
  },
  mapShape: {
    default: 'circle',
    options: [
      { value: 'square', label: 'SQUARE' },
      { value: 'circle', label: 'CIRCLE' },
    ],
  },
} as const satisfies BattleBarConfig;

// Default caps per mode (must be values from BATTLE_CONFIG.cap.options)
export const DEMO_CAP_DEFAULT = BATTLE_CONFIG.cap.default;
export const REAL_CAP_DEFAULT = BATTLE_CONFIG.cap.default;

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
// modes (ff accel, system toggles, terrain shapes) gets paired
// demo + real keys so
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
const STORAGE_DEMO_FF_ACCEL_UNITS = 'demo-battle-ff-accel-units';
const STORAGE_REAL_FF_ACCEL_UNITS = 'real-battle-ff-accel-units';
const STORAGE_DEMO_FF_ACCEL_SHOTS = 'demo-battle-ff-accel-shots';
const STORAGE_REAL_FF_ACCEL_SHOTS = 'real-battle-ff-accel-shots';
const STORAGE_DEMO_MIRRORS_ENABLED = 'demo-battle-mirrors-enabled';
const STORAGE_REAL_MIRRORS_ENABLED = 'real-battle-mirrors-enabled';
const STORAGE_DEMO_FORCE_FIELDS_ENABLED = 'demo-battle-force-fields-enabled';
const STORAGE_REAL_FORCE_FIELDS_ENABLED = 'real-battle-force-fields-enabled';
const STORAGE_DEMO_TERRAIN_CENTER = 'demo-battle-terrain-center';
const STORAGE_REAL_TERRAIN_CENTER = 'real-battle-terrain-center';
const STORAGE_DEMO_TERRAIN_DIVIDERS = 'demo-battle-terrain-dividers';
const STORAGE_REAL_TERRAIN_DIVIDERS = 'real-battle-terrain-dividers';
const STORAGE_DEMO_TERRAIN_MAP_SHAPE = 'demo-battle-terrain-map-shape';
const STORAGE_REAL_TERRAIN_MAP_SHAPE = 'real-battle-terrain-map-shape';
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
  ['rts-ff-accel-units', STORAGE_DEMO_FF_ACCEL_UNITS],
  ['rts-ff-accel-shots', STORAGE_DEMO_FF_ACCEL_SHOTS],
  ['rts-mirrors-enabled', STORAGE_DEMO_MIRRORS_ENABLED],
  ['rts-force-fields-enabled', STORAGE_DEMO_FORCE_FIELDS_ENABLED],
  ['rts-terrain-center', STORAGE_DEMO_TERRAIN_CENTER],
  ['rts-terrain-dividers', STORAGE_DEMO_TERRAIN_DIVIDERS],
  ['rts-terrain-map-shape', STORAGE_DEMO_TERRAIN_MAP_SHAPE],
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
  } catch {
    /* malformed JSON */
  }
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
  return (
    loadBool(STORAGE_DEMO_BARS_COLLAPSED) ??
    BATTLE_MODE_DEFAULTS.demo.barsCollapsed
  );
}

export function saveDemoBarsCollapsed(collapsed: boolean): void {
  persist(STORAGE_DEMO_BARS_COLLAPSED, String(collapsed));
}

export function loadStoredRealBarsCollapsed(): boolean {
  return (
    loadBool(STORAGE_REAL_BARS_COLLAPSED) ??
    BATTLE_MODE_DEFAULTS.real.barsCollapsed
  );
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

export function loadStoredFfAccelUnits(mode: BattleMode): boolean {
  return loadModeBool(
    mode,
    STORAGE_REAL_FF_ACCEL_UNITS,
    STORAGE_DEMO_FF_ACCEL_UNITS,
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
    mode,
    STORAGE_REAL_FF_ACCEL_SHOTS,
    STORAGE_DEMO_FF_ACCEL_SHOTS,
    BATTLE_CONFIG.ffAccelShots.default,
  );
}

export function saveFfAccelShots(enabled: boolean, mode: BattleMode): void {
  persist(
    mode === 'real' ? STORAGE_REAL_FF_ACCEL_SHOTS : STORAGE_DEMO_FF_ACCEL_SHOTS,
    String(enabled),
  );
}

export function loadStoredMirrorsEnabled(mode: BattleMode): boolean {
  return loadModeBool(
    mode,
    STORAGE_REAL_MIRRORS_ENABLED,
    STORAGE_DEMO_MIRRORS_ENABLED,
    BATTLE_CONFIG.mirrorsEnabled.default,
  );
}

export function saveMirrorsEnabled(enabled: boolean, mode: BattleMode): void {
  persist(
    mode === 'real'
      ? STORAGE_REAL_MIRRORS_ENABLED
      : STORAGE_DEMO_MIRRORS_ENABLED,
    String(enabled),
  );
}

export function loadStoredForceFieldsEnabled(mode: BattleMode): boolean {
  return loadModeBool(
    mode,
    STORAGE_REAL_FORCE_FIELDS_ENABLED,
    STORAGE_DEMO_FORCE_FIELDS_ENABLED,
    BATTLE_CONFIG.forceFieldsEnabled.default,
  );
}

export function saveForceFieldsEnabled(enabled: boolean, mode: BattleMode): void {
  persist(
    mode === 'real'
      ? STORAGE_REAL_FORCE_FIELDS_ENABLED
      : STORAGE_DEMO_FORCE_FIELDS_ENABLED,
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

function parseTerrainMapShape(s: string | null): TerrainMapShape | null {
  if (s === 'square' || s === 'circle') return s;
  return null;
}

export function loadStoredTerrainCenter(mode: BattleMode): TerrainShape {
  ensureBattleMigrations();
  const primary = parseTerrainShape(
    readPersisted(
      mode === 'real'
        ? STORAGE_REAL_TERRAIN_CENTER
        : STORAGE_DEMO_TERRAIN_CENTER,
    ),
  );
  if (primary !== null) return primary;
  if (mode === 'real') {
    const demoFallback = parseTerrainShape(
      readPersisted(STORAGE_DEMO_TERRAIN_CENTER),
    );
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
  const primary = parseTerrainShape(
    readPersisted(
      mode === 'real'
        ? STORAGE_REAL_TERRAIN_DIVIDERS
        : STORAGE_DEMO_TERRAIN_DIVIDERS,
    ),
  );
  if (primary !== null) return primary;
  if (mode === 'real') {
    const demoFallback = parseTerrainShape(
      readPersisted(STORAGE_DEMO_TERRAIN_DIVIDERS),
    );
    if (demoFallback !== null) return demoFallback;
  }
  return BATTLE_CONFIG.dividers.default;
}

export function saveTerrainDividers(
  shape: TerrainShape,
  mode: BattleMode,
): void {
  persist(
    mode === 'real'
      ? STORAGE_REAL_TERRAIN_DIVIDERS
      : STORAGE_DEMO_TERRAIN_DIVIDERS,
    shape,
  );
}

export function loadStoredTerrainMapShape(mode: BattleMode): TerrainMapShape {
  ensureBattleMigrations();
  const primary = parseTerrainMapShape(
    readPersisted(
      mode === 'real'
        ? STORAGE_REAL_TERRAIN_MAP_SHAPE
        : STORAGE_DEMO_TERRAIN_MAP_SHAPE,
    ),
  );
  if (primary !== null) return primary;
  if (mode === 'real') {
    const demoFallback = parseTerrainMapShape(
      readPersisted(STORAGE_DEMO_TERRAIN_MAP_SHAPE),
    );
    if (demoFallback !== null) return demoFallback;
  }
  return BATTLE_CONFIG.mapShape.default;
}

export function saveTerrainMapShape(
  shape: TerrainMapShape,
  mode: BattleMode,
): void {
  persist(
    mode === 'real'
      ? STORAGE_REAL_TERRAIN_MAP_SHAPE
      : STORAGE_DEMO_TERRAIN_MAP_SHAPE,
    shape,
  );
}
