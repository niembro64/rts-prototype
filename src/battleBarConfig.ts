import type { BattleBarConfig } from './types/battle';
import type { ForceFieldReflectionMode } from './types/shotTypes';
import type { TerrainMapShape, TerrainShape } from './types/terrain';
import { persist, persistJson, readPersisted, migrateKey } from './persistence';
import { MAP_DIMENSION_CONFIG, type MapLandCellDimensions } from './mapSizeConfig';
import {
  BUILDABLE_UNIT_IDS,
  isBuildableUnitId,
  isDemoUnitEnabledByDefault,
} from './game/sim/blueprints/unitRoster';
import battleBarConfig from './battleBarConfig.json';

// ── Authored data lives in battleBarConfig.json ──
// The TS shim composes BATTLE_CONFIG by reading the JSON and layering
// in the two fields that need cross-config references:
//   - `units`: built dynamically from BUILDABLE_UNIT_IDS (unitRoster.json)
//   - `mapSize`: pulled from MAP_DIMENSION_CONFIG (mapSizeConfig.json)
// Everything else — caps, toggles, terrain options, mode defaults,
// storage keys, migration table — is pure JSON.

function buildUnitToggleConfig(): Record<string, { default: boolean }> {
  return Object.fromEntries(
    BUILDABLE_UNIT_IDS.map((unitId) => [
      unitId,
      { default: isDemoUnitEnabledByDefault(unitId) },
    ]),
  );
}

function sanitizeDemoUnitIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const unitId of value) {
    if (typeof unitId !== 'string') continue;
    if (!isBuildableUnitId(unitId)) continue;
    if (seen.has(unitId)) continue;
    seen.add(unitId);
    result.push(unitId);
  }
  return result;
}

export const BATTLE_CONFIG = {
  units: buildUnitToggleConfig(),
  cap: {
    default: battleBarConfig.cap.default,
    options: battleBarConfig.cap.options as readonly number[],
  },
  mirrorsEnabled: battleBarConfig.mirrorsEnabled,
  forceFieldsEnabled: battleBarConfig.forceFieldsEnabled,
  forceFieldsObstructSight: battleBarConfig.forceFieldsObstructSight,
  fogOfWarEnabled: battleBarConfig.fogOfWarEnabled,
  forceFieldReflectionMode: {
    default: battleBarConfig.forceFieldReflectionMode.default as ForceFieldReflectionMode,
  },
  // Terrain shape — applied at game-construction time via
  // setTerrainCenterShape / setTerrainDividersShape (Terrain.ts).
  center: {
    default: battleBarConfig.center.default as TerrainShape,
    options: battleBarConfig.center.options as ReadonlyArray<{ value: TerrainShape; label: string }>,
  },
  dividers: {
    default: battleBarConfig.dividers.default as TerrainShape,
    options: battleBarConfig.dividers.options as ReadonlyArray<{ value: TerrainShape; label: string }>,
  },
  mapShape: {
    default: battleBarConfig.mapShape.default as TerrainMapShape,
    options: battleBarConfig.mapShape.options as ReadonlyArray<{ value: TerrainMapShape; label: string }>,
  },
  mapSize: {
    width: MAP_DIMENSION_CONFIG.width,
    length: MAP_DIMENSION_CONFIG.length,
  },
} satisfies BattleBarConfig;

// Default caps per mode (must be values from BATTLE_CONFIG.cap.options)
export const DEMO_CAP_DEFAULT = BATTLE_CONFIG.cap.default;
export const REAL_CAP_DEFAULT = BATTLE_CONFIG.cap.default;

export const BATTLE_MODE_DEFAULTS = battleBarConfig.modeDefaults;

// ── localStorage keys (module-private) ──
// `demo-battle-*` and `real-battle-*` namespace each setting to the
// bar/mode it belongs to. EVERY setting that's tunable in BOTH
// modes (ff accel, system toggles, terrain shapes) gets paired
// demo + real keys so the two modes don't bleed.
//
// First-read fallback: when a `real-battle-*` key has no value yet,
// the loader falls back to the matching `demo-battle-*` value — so
// existing customizations carry over to real battle the first time
// a user enters the lobby, and only diverge when the user explicitly
// changes them in the lobby.
//
// Legacy `rts-*` keys are migrated lazily into `demo-battle-*` (the
// original "battle" namespace) by the load helpers below.
const sk = battleBarConfig.storageKeys;
const STORAGE_DEMO_UNITS = sk.demoUnits;
const STORAGE_DEMO_CAP = sk.demoCap;
const STORAGE_REAL_CAP = sk.realCap;
const STORAGE_DEMO_GRID = sk.demoGrid;
const STORAGE_REAL_GRID = sk.realGrid;
const STORAGE_DEMO_MIRRORS_ENABLED = sk.demoMirrorsEnabled;
const STORAGE_REAL_MIRRORS_ENABLED = sk.realMirrorsEnabled;
const STORAGE_DEMO_FORCE_FIELDS_ENABLED = sk.demoForceFieldsEnabled;
const STORAGE_REAL_FORCE_FIELDS_ENABLED = sk.realForceFieldsEnabled;
const STORAGE_DEMO_FORCE_FIELDS_OBSTRUCT_SIGHT = sk.demoForceFieldsObstructSight;
const STORAGE_REAL_FORCE_FIELDS_OBSTRUCT_SIGHT = sk.realForceFieldsObstructSight;
const STORAGE_DEMO_FOG_OF_WAR_ENABLED = sk.demoFogOfWarEnabled;
const STORAGE_REAL_FOG_OF_WAR_ENABLED = sk.realFogOfWarEnabled;
const STORAGE_DEMO_FORCE_FIELD_REFLECTION_MODE = sk.demoForceFieldReflectionMode;
const STORAGE_REAL_FORCE_FIELD_REFLECTION_MODE = sk.realForceFieldReflectionMode;
const STORAGE_DEMO_TERRAIN_CENTER = sk.demoTerrainCenter;
const STORAGE_REAL_TERRAIN_CENTER = sk.realTerrainCenter;
const STORAGE_DEMO_TERRAIN_DIVIDERS = sk.demoTerrainDividers;
const STORAGE_REAL_TERRAIN_DIVIDERS = sk.realTerrainDividers;
const STORAGE_DEMO_TERRAIN_MAP_SHAPE = sk.demoTerrainMapShape;
const STORAGE_REAL_TERRAIN_MAP_SHAPE = sk.realTerrainMapShape;
const STORAGE_DEMO_MAP_LAND_CELLS = sk.demoMapLandCells;
const STORAGE_REAL_MAP_LAND_CELLS = sk.realMapLandCells;
const STORAGE_DEMO_MAP_WIDTH_LAND_CELLS = sk.demoMapWidthLandCells;
const STORAGE_REAL_MAP_WIDTH_LAND_CELLS = sk.realMapWidthLandCells;
const STORAGE_DEMO_MAP_LENGTH_LAND_CELLS = sk.demoMapLengthLandCells;
const STORAGE_REAL_MAP_LENGTH_LAND_CELLS = sk.realMapLengthLandCells;
const STORAGE_DEMO_BARS_COLLAPSED = sk.demoBarsCollapsed;
const STORAGE_REAL_BARS_COLLAPSED = sk.realBarsCollapsed;

const BATTLE_KEY_MIGRATIONS: ReadonlyArray<readonly [string, string]> =
  battleBarConfig.storageMigrations as unknown as ReadonlyArray<readonly [string, string]>;

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
    return sanitizeDemoUnitIds(parsed);
  } catch {
    /* malformed JSON */
  }
  return null;
}

export function saveDemoUnits(units: string[]): void {
  persistJson(STORAGE_DEMO_UNITS, sanitizeDemoUnitIds(units) ?? []);
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

export function getDefaultFogOfWar(mode: BattleMode): boolean {
  return BATTLE_MODE_DEFAULTS[mode].fogOfWar;
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

export function loadStoredMirrorsEnabled(_mode: BattleMode): boolean {
  return BATTLE_CONFIG.mirrorsEnabled.default;
}

export function saveMirrorsEnabled(_enabled: boolean, mode: BattleMode): void {
  persist(
    mode === 'real'
      ? STORAGE_REAL_MIRRORS_ENABLED
      : STORAGE_DEMO_MIRRORS_ENABLED,
    String(BATTLE_CONFIG.mirrorsEnabled.default),
  );
}

export function loadStoredForceFieldsEnabled(_mode: BattleMode): boolean {
  return BATTLE_CONFIG.forceFieldsEnabled.default;
}

export function saveForceFieldsEnabled(_enabled: boolean, mode: BattleMode): void {
  persist(
    mode === 'real'
      ? STORAGE_REAL_FORCE_FIELDS_ENABLED
      : STORAGE_DEMO_FORCE_FIELDS_ENABLED,
    String(BATTLE_CONFIG.forceFieldsEnabled.default),
  );
}

export function loadStoredForceFieldsObstructSight(mode: BattleMode): boolean {
  return loadModeBool(
    mode,
    STORAGE_REAL_FORCE_FIELDS_OBSTRUCT_SIGHT,
    STORAGE_DEMO_FORCE_FIELDS_OBSTRUCT_SIGHT,
    BATTLE_CONFIG.forceFieldsObstructSight.default,
  );
}

export function saveForceFieldsObstructSight(enabled: boolean, mode: BattleMode): void {
  persist(
    mode === 'real'
      ? STORAGE_REAL_FORCE_FIELDS_OBSTRUCT_SIGHT
      : STORAGE_DEMO_FORCE_FIELDS_OBSTRUCT_SIGHT,
    String(enabled),
  );
}

export function loadStoredFogOfWarEnabled(mode: BattleMode): boolean {
  return loadModeBool(
    mode,
    STORAGE_REAL_FOG_OF_WAR_ENABLED,
    STORAGE_DEMO_FOG_OF_WAR_ENABLED,
    BATTLE_MODE_DEFAULTS[mode].fogOfWar,
  );
}

export function saveFogOfWarEnabled(enabled: boolean, mode: BattleMode): void {
  persist(
    mode === 'real'
      ? STORAGE_REAL_FOG_OF_WAR_ENABLED
      : STORAGE_DEMO_FOG_OF_WAR_ENABLED,
    String(enabled),
  );
}

export function loadStoredForceFieldReflectionMode(_mode: BattleMode): ForceFieldReflectionMode {
  return BATTLE_CONFIG.forceFieldReflectionMode.default;
}

export function saveForceFieldReflectionMode(
  _reflectionMode: ForceFieldReflectionMode,
  mode: BattleMode,
): void {
  persist(
    mode === 'real'
      ? STORAGE_REAL_FORCE_FIELD_REFLECTION_MODE
      : STORAGE_DEMO_FORCE_FIELD_REFLECTION_MODE,
    BATTLE_CONFIG.forceFieldReflectionMode.default,
  );
}

/** Validate a string against the known TerrainShape values. Anything
 *  else (corrupted localStorage, removed value) returns null so the
 *  caller falls back to the config default. */
function parseTerrainShape(s: string | null): TerrainShape | null {
  if (s === 'lake') return 'valley';
  if (s === 'valley' || s === 'mountain' || s === 'flat') return s;
  return null;
}

function parseTerrainMapShape(s: string | null): TerrainMapShape | null {
  if (s === 'square' || s === 'circle') return s;
  return null;
}

function parseMapLandCellAxis(s: string | null, axis: 'width' | 'length'): number | null {
  if (!s) return null;
  const n = Math.floor(Number(s));
  if (!Number.isFinite(n)) return null;
  const options =
    axis === 'width'
      ? BATTLE_CONFIG.mapSize.width.options
      : BATTLE_CONFIG.mapSize.length.options;
  const option = options.find((opt) => opt.valueLandCells === n);
  return option?.valueLandCells ?? null;
}

function normalizeMapLandDimensions(
  dimensions: MapLandCellDimensions,
): MapLandCellDimensions {
  const width =
    parseMapLandCellAxis(String(dimensions.widthLandCells), 'width') ??
    BATTLE_CONFIG.mapSize.width.default;
  const length =
    parseMapLandCellAxis(String(dimensions.lengthLandCells), 'length') ??
    BATTLE_CONFIG.mapSize.length.default;
  return { widthLandCells: width, lengthLandCells: length };
}

function readStoredMapLandDimensions(
  widthKey: string,
  lengthKey: string,
  legacyKey: string,
): MapLandCellDimensions | null {
  const width = parseMapLandCellAxis(readPersisted(widthKey), 'width');
  const length = parseMapLandCellAxis(readPersisted(lengthKey), 'length');
  if (width !== null && length !== null) {
    return { widthLandCells: width, lengthLandCells: length };
  }

  const legacy = parseMapLandCellAxis(readPersisted(legacyKey), 'width');
  if (legacy !== null) {
    return {
      widthLandCells: width ?? legacy,
      lengthLandCells: length ?? legacy,
    };
  }

  if (width !== null) {
    return { widthLandCells: width, lengthLandCells: width };
  }
  if (length !== null) {
    return { widthLandCells: length, lengthLandCells: length };
  }
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

export function getDefaultMapLandDimensions(): MapLandCellDimensions {
  return {
    widthLandCells: BATTLE_CONFIG.mapSize.width.default,
    lengthLandCells: BATTLE_CONFIG.mapSize.length.default,
  };
}

export function loadStoredMapLandDimensions(mode: BattleMode): MapLandCellDimensions {
  ensureBattleMigrations();
  const primary = readStoredMapLandDimensions(
    mode === 'real'
      ? STORAGE_REAL_MAP_WIDTH_LAND_CELLS
      : STORAGE_DEMO_MAP_WIDTH_LAND_CELLS,
    mode === 'real'
      ? STORAGE_REAL_MAP_LENGTH_LAND_CELLS
      : STORAGE_DEMO_MAP_LENGTH_LAND_CELLS,
    mode === 'real'
      ? STORAGE_REAL_MAP_LAND_CELLS
      : STORAGE_DEMO_MAP_LAND_CELLS,
  );
  if (primary !== null) return primary;
  if (mode === 'real') {
    const demoFallback = readStoredMapLandDimensions(
      STORAGE_DEMO_MAP_WIDTH_LAND_CELLS,
      STORAGE_DEMO_MAP_LENGTH_LAND_CELLS,
      STORAGE_DEMO_MAP_LAND_CELLS,
    );
    if (demoFallback !== null) return demoFallback;
  }
  return getDefaultMapLandDimensions();
}

export function saveMapLandDimensions(
  dimensions: MapLandCellDimensions,
  mode: BattleMode,
): void {
  const normalized = normalizeMapLandDimensions(dimensions);
  persist(
    mode === 'real'
      ? STORAGE_REAL_MAP_WIDTH_LAND_CELLS
      : STORAGE_DEMO_MAP_WIDTH_LAND_CELLS,
    String(normalized.widthLandCells),
  );
  persist(
    mode === 'real'
      ? STORAGE_REAL_MAP_LENGTH_LAND_CELLS
      : STORAGE_DEMO_MAP_LENGTH_LAND_CELLS,
    String(normalized.lengthLandCells),
  );
}
