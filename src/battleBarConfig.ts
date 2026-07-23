import type { BattleBarConfig } from './types/battle';
import type { ShieldReflectionMode } from './types/shotTypes';
import { isSlopePathMode, type SlopePathMode } from './types/slopePathMode';
import { persist, persistJson, readPersisted, migrateKey } from './persistence';
import { MAP_DIMENSION_CONFIG, type MapLandCellDimensions } from './mapSizeConfig';
import {
  BUILDABLE_UNIT_BLUEPRINT_IDS,
  isBuildableUnitBlueprintId,
  isDemoUnitEnabledByDefault,
} from './game/sim/blueprints/unitRoster';
import {
  BUILDING_BLUEPRINT_IDS,
  isBuildingBlueprintId,
} from './types/blueprintIds';
import battleBarConfig from './battleBarConfig.json';
import { getModeDefaultPreset } from './components/battlePresets';

// ── Authored data lives in battleBarConfig.json ──
// The TS shim composes BATTLE_CONFIG by reading the JSON and layering
// in the two fields that need cross-config references:
//   - `units`: built dynamically from BUILDABLE_UNIT_BLUEPRINT_IDS (unitRoster.json)
//   - `mapSize`: pulled from MAP_DIMENSION_CONFIG (mapSizeConfig.json)
// Everything else — caps, toggles, terrain options, mode defaults,
// storage keys, migration table — is pure JSON.

function buildUnitToggleConfig(): Record<string, { default: boolean }> {
  return Object.fromEntries(
    BUILDABLE_UNIT_BLUEPRINT_IDS.map((unitBlueprintId) => [
      unitBlueprintId,
      { default: isDemoUnitEnabledByDefault(unitBlueprintId) },
    ]),
  );
}

// Buildings mirror the unit toggle config but default ON for every blueprint
// — there is no "default-disabled in demo" roster for static hosts.
function buildBuildingToggleConfig(): Record<string, { default: boolean }> {
  return Object.fromEntries(
    BUILDING_BLUEPRINT_IDS.map((buildingBlueprintId) => [
      buildingBlueprintId,
      { default: true },
    ]),
  );
}

function sanitizeDemoUnitIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const unitBlueprintId of value) {
    if (typeof unitBlueprintId !== 'string') continue;
    if (!isBuildableUnitBlueprintId(unitBlueprintId)) continue;
    if (seen.has(unitBlueprintId)) continue;
    seen.add(unitBlueprintId);
    result.push(unitBlueprintId);
  }
  return result;
}

/** Generic id-list sanitizer shared by the building and tower loaders —
 *  filters an unknown[] to a deduped string[] of ids accepted by the
 *  supplied membership predicate. Mirrors sanitizeDemoUnitIds. */
function sanitizeIdList(
  value: unknown,
  isValidId: (id: string) => boolean,
): string[] | null {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id !== 'string') continue;
    if (!isValidId(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function sanitizeDemoBuildingIds(value: unknown): string[] | null {
  return sanitizeIdList(value, isBuildingBlueprintId);
}

// `BATTLE_CONFIG.*.default` is no longer authored in JSON. Every
// inline default has been moved into the DEMO BATTLE DEFAULT and REAL
// BATTLE DEFAULT presets. The JSON only owns the *options* lists and
// names the two presets that supply the defaults. The TS shim
// resolves the legacy `.default` field through the demo preset so the
// many call sites that read `BATTLE_CONFIG.cap.default` etc. keep
// working without each having to know about the demo/real split.
const _demoPreset = getModeDefaultPreset('demo');
const TERRAIN_RENDER_SMOOTHING_DEFAULT = 3;
const TERRAIN_TEXTURE_SMOOTH_ACROSS_WALL_BOUNDARY_DEFAULT = true;
const TERRAIN_LIGHT_SMOOTH_ACROSS_WALL_BOUNDARY_DEFAULT = false;
const TERRAIN_SPLIT_WALL_BOUNDARY_VERTICES_DEFAULT = true;

export const BATTLE_CONFIG = {
  units: buildUnitToggleConfig(),
  buildings: buildBuildingToggleConfig(),
  cap: {
    default: _demoPreset.cap,
    options: battleBarConfig.cap.options as readonly number[],
  },
  turretShieldPanelsEnabled: { default: _demoPreset.turretShieldPanelsEnabled },
  turretShieldSpheresEnabled: { default: _demoPreset.turretShieldSpheresEnabled },
  forceFieldsVisible: { default: _demoPreset.forceFieldsVisible },
  shieldsObstructSight: { default: _demoPreset.shieldsObstructSight },
  fogOfWarEnabled: { default: _demoPreset.fogOfWarEnabled },
  shieldReflectionMode: {
    default: _demoPreset.shieldReflectionMode,
  },
  slopePathMode: {
    default: _demoPreset.slopePathMode,
  },
  // CENTER / DIVIDERS amplitudes — applied at game-construction time
  // via setTerrainCenterMagnitude / setTerrainDividersMagnitude
  // (Terrain.ts). Signed: negative dishes the feature below ground,
  // positive raises it above, zero suppresses it.
  centerMagnitude: {
    default: _demoPreset.centerMagnitude,
    options: battleBarConfig.centerMagnitude.options as readonly number[],
  },
  dividersMagnitude: {
    default: _demoPreset.dividersMagnitude,
    options: battleBarConfig.dividersMagnitude.options as readonly number[],
  },
  perimeterMagnitude: {
    default: _demoPreset.perimeterMagnitude,
    options: battleBarConfig.perimeterMagnitude.options as readonly number[],
  },
  terrainDTerrain: {
    default: _demoPreset.terrainDTerrain,
    options: battleBarConfig.terrainDTerrain.options as readonly number[],
  },
  plateauWallSlopeDegrees: {
    default: _demoPreset.plateauWallSlopeDegrees,
    options: battleBarConfig.plateauWallSlopeDegrees.options as readonly number[],
  },
  watersEdgeBeachSlopeDegrees: {
    default: _demoPreset.watersEdgeBeachSlopeDegrees,
    options: battleBarConfig.watersEdgeBeachSlopeDegrees.options as readonly number[],
  },
  watersEdgeCliffHeight: {
    default: _demoPreset.watersEdgeCliffHeight,
    options: battleBarConfig.watersEdgeCliffHeight.options as readonly number[],
  },
  metalDepositStep: {
    default: _demoPreset.metalDepositStep,
    options: battleBarConfig.metalDepositStep.options as readonly number[],
  },
  terrainDetail: {
    default: _demoPreset.terrainDetail,
    options: battleBarConfig.terrainDetail.options as readonly number[],
  },
  terrainTextureSmoothing: {
    default: TERRAIN_RENDER_SMOOTHING_DEFAULT,
    options: battleBarConfig.terrainTextureSmoothing.options as readonly number[],
  },
  terrainLightSmoothing: {
    default: TERRAIN_RENDER_SMOOTHING_DEFAULT,
    options: battleBarConfig.terrainLightSmoothing.options as readonly number[],
  },
  terrainTextureSmoothAcrossWallBoundary: {
    default: TERRAIN_TEXTURE_SMOOTH_ACROSS_WALL_BOUNDARY_DEFAULT,
  },
  terrainLightSmoothAcrossWallBoundary: {
    default: TERRAIN_LIGHT_SMOOTH_ACROSS_WALL_BOUNDARY_DEFAULT,
  },
  terrainSplitWallBoundaryVertices: {
    default: TERRAIN_SPLIT_WALL_BOUNDARY_VERTICES_DEFAULT,
  },
  converterTax: {
    default: _demoPreset.converterTax,
    options: battleBarConfig.converterTax.options as readonly number[],
  },
  mapSize: {
    width: MAP_DIMENSION_CONFIG.width,
    length: MAP_DIMENSION_CONFIG.length,
  },
} satisfies BattleBarConfig;

// Compile-time guard: if anyone re-adds `demoDefault`/`realDefault`
// pointers to presets that don't exist, this surfaces immediately.
void (battleBarConfig.demoDefault as string);
void (battleBarConfig.realDefault as string);


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
const CURRENT_DEMO_CONTENT_REVISION = 'unified-buildings-v2';
const STORAGE_DEMO_UNITS = sk.demoUnits;
const STORAGE_DEMO_CONTENT_REVISION = sk.demoContentRevision;
const STORAGE_DEMO_BUILDINGS = sk.demoBuildings;
const STORAGE_DEMO_TOWERS = sk.demoTowers;
const STORAGE_DEMO_CAP = sk.demoCap;
const STORAGE_REAL_CAP = sk.realCap;
const STORAGE_DEMO_FORCE_FIELDS_VISIBLE = sk.demoForceFieldsVisible;
const STORAGE_REAL_FORCE_FIELDS_VISIBLE = sk.realForceFieldsVisible;
const STORAGE_DEMO_SHIELDS_OBSTRUCT_SIGHT = sk.demoShieldsObstructSight;
const STORAGE_REAL_SHIELDS_OBSTRUCT_SIGHT = sk.realShieldsObstructSight;
const STORAGE_DEMO_FOG_OF_WAR_ENABLED = sk.demoFogOfWarEnabled;
const STORAGE_REAL_FOG_OF_WAR_ENABLED = sk.realFogOfWarEnabled;
const STORAGE_DEMO_SLOPE_PATH_MODE = sk.demoSlopePathMode;
const STORAGE_REAL_SLOPE_PATH_MODE = sk.realSlopePathMode;
const STORAGE_DEMO_CENTER_MAGNITUDE = sk.demoCenterMagnitude;
const STORAGE_REAL_CENTER_MAGNITUDE = sk.realCenterMagnitude;
const STORAGE_DEMO_DIVIDERS_MAGNITUDE = sk.demoDividersMagnitude;
const STORAGE_REAL_DIVIDERS_MAGNITUDE = sk.realDividersMagnitude;
const STORAGE_DEMO_PERIMETER_MAGNITUDE = sk.demoPerimeterMagnitude;
const STORAGE_REAL_PERIMETER_MAGNITUDE = sk.realPerimeterMagnitude;
const STORAGE_DEMO_TERRAIN_D_TERRAIN = sk.demoTerrainDTerrain;
const STORAGE_REAL_TERRAIN_D_TERRAIN = sk.realTerrainDTerrain;
const STORAGE_DEMO_PLATEAU_WALL_SLOPE_DEGREES = sk.demoPlateauWallSlopeDegrees;
const STORAGE_REAL_PLATEAU_WALL_SLOPE_DEGREES = sk.realPlateauWallSlopeDegrees;
const STORAGE_DEMO_WATERS_EDGE_BEACH_SLOPE_DEGREES =
  sk.demoWatersEdgeBeachSlopeDegrees;
const STORAGE_REAL_WATERS_EDGE_BEACH_SLOPE_DEGREES =
  sk.realWatersEdgeBeachSlopeDegrees;
const STORAGE_DEMO_WATERS_EDGE_CLIFF_HEIGHT = sk.demoWatersEdgeCliffHeight;
const STORAGE_REAL_WATERS_EDGE_CLIFF_HEIGHT = sk.realWatersEdgeCliffHeight;
const STORAGE_DEMO_METAL_DEPOSIT_STEP = sk.demoMetalDepositStep;
const STORAGE_REAL_METAL_DEPOSIT_STEP = sk.realMetalDepositStep;
const STORAGE_DEMO_TERRAIN_DETAIL = sk.demoTerrainDetail;
const STORAGE_REAL_TERRAIN_DETAIL = sk.realTerrainDetail;
const STORAGE_DEMO_TERRAIN_TEXTURE_SMOOTHING = sk.demoTerrainTextureSmoothing;
const STORAGE_REAL_TERRAIN_TEXTURE_SMOOTHING = sk.realTerrainTextureSmoothing;
const STORAGE_DEMO_TERRAIN_LIGHT_SMOOTHING = sk.demoTerrainLightSmoothing;
const STORAGE_REAL_TERRAIN_LIGHT_SMOOTHING = sk.realTerrainLightSmoothing;
const STORAGE_DEMO_TERRAIN_TEXTURE_SMOOTH_ACROSS_WALL_BOUNDARY =
  sk.demoTerrainTextureSmoothAcrossWallBoundary;
const STORAGE_REAL_TERRAIN_TEXTURE_SMOOTH_ACROSS_WALL_BOUNDARY =
  sk.realTerrainTextureSmoothAcrossWallBoundary;
const STORAGE_DEMO_TERRAIN_LIGHT_SMOOTH_ACROSS_WALL_BOUNDARY =
  sk.demoTerrainLightSmoothAcrossWallBoundary;
const STORAGE_REAL_TERRAIN_LIGHT_SMOOTH_ACROSS_WALL_BOUNDARY =
  sk.realTerrainLightSmoothAcrossWallBoundary;
const STORAGE_DEMO_TERRAIN_SPLIT_WALL_BOUNDARY_VERTICES =
  sk.demoTerrainSplitWallBoundaryVertices;
const STORAGE_REAL_TERRAIN_SPLIT_WALL_BOUNDARY_VERTICES =
  sk.realTerrainSplitWallBoundaryVertices;
const STORAGE_DEMO_CONVERTER_TAX = sk.demoConverterTax;
const STORAGE_REAL_CONVERTER_TAX = sk.realConverterTax;
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
  migrateDemoContent();
}

/** One-time migration for authored demo-content revisions. */
function migrateDemoContent(): void {
  if (readPersisted(STORAGE_DEMO_CONTENT_REVISION) === CURRENT_DEMO_CONTENT_REVISION) return;

  // Towers used to be stored as a separate static-host roster. Preserve both
  // user choices while folding the legacy lists into the one building roster.
  const legacyTowerBlueprintIds = new Set<string>([
    'towerFabricator',
    'towerBeamMega',
    'towerCannon',
    'towerAntiAir',
  ]);
  let storedBuildingIds: string[] | null = null;
  let storedTowerIds: string[] | null = null;
  const storedBuildings = readPersisted(STORAGE_DEMO_BUILDINGS);
  const storedTowers = readPersisted(STORAGE_DEMO_TOWERS);
  try {
    if (storedBuildings !== null) {
      storedBuildingIds = sanitizeDemoBuildingIds(JSON.parse(storedBuildings));
    }
  } catch {
    // Malformed legacy state falls back to the old default building roster.
  }
  try {
    if (storedTowers !== null) {
      storedTowerIds = sanitizeDemoBuildingIds(JSON.parse(storedTowers));
    }
  } catch {
    // Malformed legacy state falls back to the old default tower roster.
  }
  const selected = new Set<string>(
    storedBuildingIds ??
      BUILDING_BLUEPRINT_IDS.filter((id) => !legacyTowerBlueprintIds.has(id)),
  );
  const selectedLegacyTowers =
    storedTowerIds ??
    BUILDING_BLUEPRINT_IDS.filter((id) => legacyTowerBlueprintIds.has(id));
  for (const id of selectedLegacyTowers) selected.add(id);
  persistJson(
    STORAGE_DEMO_BUILDINGS,
    BUILDING_BLUEPRINT_IDS.filter((id) => selected.has(id)),
  );
  // Leave an inert value at the legacy key so older builds do not resurrect
  // stale choices if a developer switches branches.
  persistJson(STORAGE_DEMO_TOWERS, []);

  const storedUnits = readPersisted(STORAGE_DEMO_UNITS);
  if (storedUnits !== null) {
    try {
      const units = sanitizeDemoUnitIds(JSON.parse(storedUnits));
      if (units !== null && !units.includes('unitOrca')) {
        units.push('unitOrca');
        persistJson(STORAGE_DEMO_UNITS, units);
      }
    } catch {
      // Malformed state will fall back to the current demo preset.
    }
  }

  // 0 was the previous DEMO BATTLE default. Move that legacy default to the
  // round-island value so its offshore Fabricators have an actual water ring.
  // After this one-time migration the user's terrain choice is preserved.
  if (readPersisted(STORAGE_DEMO_PERIMETER_MAGNITUDE) === '0') {
    persist(STORAGE_DEMO_PERIMETER_MAGNITUDE, '-800');
  }
  persist(STORAGE_DEMO_CONTENT_REVISION, CURRENT_DEMO_CONTENT_REVISION);
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
    return sanitizeDemoUnitIds(JSON.parse(stored));
  } catch {
    /* malformed JSON */
  }
  return null;
}

export function saveDemoUnits(units: string[]): void {
  persistJson(STORAGE_DEMO_UNITS, sanitizeDemoUnitIds(units) ?? []);
  persist(STORAGE_DEMO_CONTENT_REVISION, CURRENT_DEMO_CONTENT_REVISION);
}

export function getDefaultDemoUnits(): string[] {
  return Object.entries(BATTLE_CONFIG.units)
    .filter(([, cfg]) => cfg.default)
    .map(([id]) => id);
}

// ── Demo building enablement (BUILDINGS bar group) ──
// Persistence mirrors the unit trio. Buildings have NO legacy `rts-*`
// key, so the loaders run ensureBattleMigrations() only to stay
// structurally identical to the unit loaders (it's a cheap no-op after
// the first call).

export function loadStoredDemoBuildings(): string[] | null {
  ensureBattleMigrations();
  const stored = readPersisted(STORAGE_DEMO_BUILDINGS);
  if (!stored) return null;
  try {
    return sanitizeDemoBuildingIds(JSON.parse(stored));
  } catch {
    /* malformed JSON */
  }
  return null;
}

export function saveDemoBuildings(buildings: string[]): void {
  persistJson(STORAGE_DEMO_BUILDINGS, sanitizeDemoBuildingIds(buildings) ?? []);
}

export function getDefaultDemoBuildings(): string[] {
  return Object.entries(BATTLE_CONFIG.buildings)
    .filter(([, cfg]) => cfg.default)
    .map(([id]) => id);
}

export function loadStoredDemoCap(): number {
  return loadPosNum(STORAGE_DEMO_CAP) ?? getModeDefaultPreset('demo').cap;
}

function saveDemoCap(value: number): void {
  persist(STORAGE_DEMO_CAP, String(value));
}

export function loadStoredRealCap(): number {
  return loadPosNum(STORAGE_REAL_CAP) ?? getModeDefaultPreset('real').cap;
}

function saveRealCap(value: number): void {
  persist(STORAGE_REAL_CAP, String(value));
}

export function loadStoredDemoBarsCollapsed(): boolean {
  return (
    loadBool(STORAGE_DEMO_BARS_COLLAPSED) ??
    getModeDefaultPreset('demo').barsCollapsed
  );
}

export function saveDemoBarsCollapsed(collapsed: boolean): void {
  persist(STORAGE_DEMO_BARS_COLLAPSED, String(collapsed));
}

export function loadStoredRealBarsCollapsed(): boolean {
  return (
    loadBool(STORAGE_REAL_BARS_COLLAPSED) ??
    getModeDefaultPreset('real').barsCollapsed
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

export type BattleTerrainRuntimeConfig = {
  centerMagnitude: number;
  dividersMagnitude: number;
  /** Signed PERIMETER ring altitude. 0 = flat square; negative sinks the
   *  outer ring below water (round-island); positive raises a rim. */
  perimeterMagnitude: number;
  /** Plateau lattice step in world units. 0 = NONE (no terracing). */
  terrainDTerrain: number;
  /** D-PLATEAU wall slope angle in degrees from horizontal. */
  plateauWallSlopeDegrees: number;
  /** Water's-edge beach slope angle in degrees from horizontal. */
  watersEdgeBeachSlopeDegrees: number;
  /** Water's-edge cliff height in world units. 0 = no cliff. */
  watersEdgeCliffHeight: number;
  /** Metal-extractor pad altitude step in world units. */
  metalDepositStep: number;
  /** Fine-triangle subdivisions per land cell. 0 = off, which the
   *  terrain baker clamps to one triangle edge subdivision per cell. */
  terrainDetail: number;
};


export function loadStoredCap(mode: BattleMode): number {
  return mode === 'real' ? loadStoredRealCap() : loadStoredDemoCap();
}

export function saveStoredCap(mode: BattleMode, value: number): void {
  if (mode === 'real') saveRealCap(value);
  else saveDemoCap(value);
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

export function loadStoredTurretShieldPanelsEnabled(_mode: BattleMode): boolean {
  return BATTLE_CONFIG.turretShieldPanelsEnabled.default;
}


export function loadStoredTurretShieldSpheresEnabled(_mode: BattleMode): boolean {
  return BATTLE_CONFIG.turretShieldSpheresEnabled.default;
}


export function loadStoredForceFieldsVisible(mode: BattleMode): boolean {
  return loadModeBool(
    mode,
    STORAGE_REAL_FORCE_FIELDS_VISIBLE,
    STORAGE_DEMO_FORCE_FIELDS_VISIBLE,
    BATTLE_CONFIG.forceFieldsVisible.default,
  );
}

export function saveForceFieldsVisible(enabled: boolean, mode: BattleMode): void {
  persist(
    mode === 'real'
      ? STORAGE_REAL_FORCE_FIELDS_VISIBLE
      : STORAGE_DEMO_FORCE_FIELDS_VISIBLE,
    String(enabled),
  );
}

export function loadStoredShieldsObstructSight(mode: BattleMode): boolean {
  return loadModeBool(
    mode,
    STORAGE_REAL_SHIELDS_OBSTRUCT_SIGHT,
    STORAGE_DEMO_SHIELDS_OBSTRUCT_SIGHT,
    BATTLE_CONFIG.shieldsObstructSight.default,
  );
}

export function saveShieldsObstructSight(enabled: boolean, mode: BattleMode): void {
  persist(
    mode === 'real'
      ? STORAGE_REAL_SHIELDS_OBSTRUCT_SIGHT
      : STORAGE_DEMO_SHIELDS_OBSTRUCT_SIGHT,
    String(enabled),
  );
}

export function loadStoredFogOfWarEnabled(mode: BattleMode): boolean {
  return loadModeBool(
    mode,
    STORAGE_REAL_FOG_OF_WAR_ENABLED,
    STORAGE_DEMO_FOG_OF_WAR_ENABLED,
    getModeDefaultPreset(mode).fogOfWarEnabled,
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

export function loadStoredShieldReflectionMode(_mode: BattleMode): ShieldReflectionMode {
  return BATTLE_CONFIG.shieldReflectionMode.default;
}

export function loadStoredSlopePathMode(mode: BattleMode): SlopePathMode {
  const stored = readPersisted(
    mode === 'real' ? STORAGE_REAL_SLOPE_PATH_MODE : STORAGE_DEMO_SLOPE_PATH_MODE,
  );
  return isSlopePathMode(stored) ? stored : getModeDefaultPreset(mode).slopePathMode;
}

export function saveSlopePathMode(value: SlopePathMode, mode: BattleMode): void {
  persist(
    mode === 'real' ? STORAGE_REAL_SLOPE_PATH_MODE : STORAGE_DEMO_SLOPE_PATH_MODE,
    value,
  );
}


function parseNumberOption(
  value: string | null,
  options: readonly number[],
): number | null {
  if (value === null || value === '') return null;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return null;
  return options.includes(n) ? n : null;
}

function normalizeNumberOption(
  value: number,
  config: { readonly default: number; readonly options: readonly number[] },
): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && config.options.includes(n) ? n : config.default;
}

function loadModeNumberOption(
  mode: BattleMode,
  realKey: string,
  demoKey: string,
  config: { readonly default: number; readonly options: readonly number[] },
): number {
  ensureBattleMigrations();
  const primary = parseNumberOption(
    readPersisted(mode === 'real' ? realKey : demoKey),
    config.options,
  );
  if (primary !== null) return primary;
  if (mode === 'real') {
    const demoFallback = parseNumberOption(
      readPersisted(demoKey),
      config.options,
    );
    if (demoFallback !== null) return demoFallback;
  }
  return config.default;
}

export function normalizeCenterMagnitude(value: number): number {
  return normalizeNumberOption(value, BATTLE_CONFIG.centerMagnitude);
}

export function normalizeDividersMagnitude(value: number): number {
  return normalizeNumberOption(value, BATTLE_CONFIG.dividersMagnitude);
}

export function normalizePerimeterMagnitude(value: number): number {
  return normalizeNumberOption(value, BATTLE_CONFIG.perimeterMagnitude);
}

export function normalizeTerrainDTerrain(value: number): number {
  return normalizeNumberOption(value, BATTLE_CONFIG.terrainDTerrain);
}

export function normalizePlateauWallSlopeDegrees(value: number): number {
  return normalizeNumberOption(value, BATTLE_CONFIG.plateauWallSlopeDegrees);
}

export function normalizeWatersEdgeBeachSlopeDegrees(value: number): number {
  return normalizeNumberOption(value, BATTLE_CONFIG.watersEdgeBeachSlopeDegrees);
}

export function normalizeWatersEdgeCliffHeight(value: number): number {
  return normalizeNumberOption(value, BATTLE_CONFIG.watersEdgeCliffHeight);
}

export function normalizeMetalDepositStep(value: number): number {
  return normalizeNumberOption(value, BATTLE_CONFIG.metalDepositStep);
}

export function normalizeTerrainDetail(value: number): number {
  return normalizeNumberOption(value, BATTLE_CONFIG.terrainDetail);
}

export function normalizeTerrainTextureSmoothing(value: number): number {
  return normalizeNumberOption(value, BATTLE_CONFIG.terrainTextureSmoothing);
}

export function normalizeTerrainLightSmoothing(value: number): number {
  return normalizeNumberOption(value, BATTLE_CONFIG.terrainLightSmoothing);
}

/** Match against the configured options with a small epsilon so float
 *  options like [0.0, 0.1, 0.5] survive a String→Number roundtrip
 *  without missing a match. */
function matchFloatOption(
  value: number,
  options: readonly number[],
): number | null {
  if (!Number.isFinite(value)) return null;
  for (const opt of options) {
    if (Math.abs(opt - value) < 1e-6) return opt;
  }
  return null;
}

function parseFloatOption(
  value: string | null,
  options: readonly number[],
): number | null {
  if (value === null || value === '') return null;
  return matchFloatOption(Number(value), options);
}

function loadModeFloatOption(
  mode: BattleMode,
  realKey: string,
  demoKey: string,
  config: { readonly default: number; readonly options: readonly number[] },
): number {
  ensureBattleMigrations();
  const primary = parseFloatOption(
    readPersisted(mode === 'real' ? realKey : demoKey),
    config.options,
  );
  if (primary !== null) return primary;
  if (mode === 'real') {
    const demoFallback = parseFloatOption(
      readPersisted(demoKey),
      config.options,
    );
    if (demoFallback !== null) return demoFallback;
  }
  return config.default;
}

export function normalizeConverterTax(value: number): number {
  return matchFloatOption(value, BATTLE_CONFIG.converterTax.options)
    ?? BATTLE_CONFIG.converterTax.default;
}

export function loadStoredConverterTax(mode: BattleMode): number {
  return loadModeFloatOption(
    mode,
    STORAGE_REAL_CONVERTER_TAX,
    STORAGE_DEMO_CONVERTER_TAX,
    BATTLE_CONFIG.converterTax,
  );
}

export function saveConverterTax(value: number, mode: BattleMode): void {
  persist(
    mode === 'real' ? STORAGE_REAL_CONVERTER_TAX : STORAGE_DEMO_CONVERTER_TAX,
    String(normalizeConverterTax(value)),
  );
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

export function loadStoredCenterMagnitude(mode: BattleMode): number {
  return loadModeNumberOption(
    mode,
    STORAGE_REAL_CENTER_MAGNITUDE,
    STORAGE_DEMO_CENTER_MAGNITUDE,
    BATTLE_CONFIG.centerMagnitude,
  );
}

export function saveCenterMagnitude(value: number, mode: BattleMode): void {
  persist(
    mode === 'real' ? STORAGE_REAL_CENTER_MAGNITUDE : STORAGE_DEMO_CENTER_MAGNITUDE,
    String(normalizeCenterMagnitude(value)),
  );
}

export function loadStoredDividersMagnitude(mode: BattleMode): number {
  return loadModeNumberOption(
    mode,
    STORAGE_REAL_DIVIDERS_MAGNITUDE,
    STORAGE_DEMO_DIVIDERS_MAGNITUDE,
    BATTLE_CONFIG.dividersMagnitude,
  );
}

export function saveDividersMagnitude(value: number, mode: BattleMode): void {
  persist(
    mode === 'real'
      ? STORAGE_REAL_DIVIDERS_MAGNITUDE
      : STORAGE_DEMO_DIVIDERS_MAGNITUDE,
    String(normalizeDividersMagnitude(value)),
  );
}

export function loadStoredPerimeterMagnitude(mode: BattleMode): number {
  return loadModeNumberOption(
    mode,
    STORAGE_REAL_PERIMETER_MAGNITUDE,
    STORAGE_DEMO_PERIMETER_MAGNITUDE,
    BATTLE_CONFIG.perimeterMagnitude,
  );
}

export function savePerimeterMagnitude(value: number, mode: BattleMode): void {
  persist(
    mode === 'real'
      ? STORAGE_REAL_PERIMETER_MAGNITUDE
      : STORAGE_DEMO_PERIMETER_MAGNITUDE,
    String(normalizePerimeterMagnitude(value)),
  );
}

export function loadStoredTerrainDTerrain(mode: BattleMode): number {
  return loadModeNumberOption(
    mode,
    STORAGE_REAL_TERRAIN_D_TERRAIN,
    STORAGE_DEMO_TERRAIN_D_TERRAIN,
    BATTLE_CONFIG.terrainDTerrain,
  );
}

export function saveTerrainDTerrain(value: number, mode: BattleMode): void {
  persist(
    mode === 'real'
      ? STORAGE_REAL_TERRAIN_D_TERRAIN
      : STORAGE_DEMO_TERRAIN_D_TERRAIN,
    String(normalizeTerrainDTerrain(value)),
  );
}

export function loadStoredPlateauWallSlopeDegrees(mode: BattleMode): number {
  return loadModeNumberOption(
    mode,
    STORAGE_REAL_PLATEAU_WALL_SLOPE_DEGREES,
    STORAGE_DEMO_PLATEAU_WALL_SLOPE_DEGREES,
    BATTLE_CONFIG.plateauWallSlopeDegrees,
  );
}

export function savePlateauWallSlopeDegrees(
  value: number,
  mode: BattleMode,
): void {
  persist(
    mode === 'real'
      ? STORAGE_REAL_PLATEAU_WALL_SLOPE_DEGREES
      : STORAGE_DEMO_PLATEAU_WALL_SLOPE_DEGREES,
    String(normalizePlateauWallSlopeDegrees(value)),
  );
}

export function loadStoredWatersEdgeBeachSlopeDegrees(mode: BattleMode): number {
  return loadModeNumberOption(
    mode,
    STORAGE_REAL_WATERS_EDGE_BEACH_SLOPE_DEGREES,
    STORAGE_DEMO_WATERS_EDGE_BEACH_SLOPE_DEGREES,
    BATTLE_CONFIG.watersEdgeBeachSlopeDegrees,
  );
}

export function saveWatersEdgeBeachSlopeDegrees(
  value: number,
  mode: BattleMode,
): void {
  persist(
    mode === 'real'
      ? STORAGE_REAL_WATERS_EDGE_BEACH_SLOPE_DEGREES
      : STORAGE_DEMO_WATERS_EDGE_BEACH_SLOPE_DEGREES,
    String(normalizeWatersEdgeBeachSlopeDegrees(value)),
  );
}

export function loadStoredWatersEdgeCliffHeight(mode: BattleMode): number {
  return loadModeNumberOption(
    mode,
    STORAGE_REAL_WATERS_EDGE_CLIFF_HEIGHT,
    STORAGE_DEMO_WATERS_EDGE_CLIFF_HEIGHT,
    BATTLE_CONFIG.watersEdgeCliffHeight,
  );
}

export function saveWatersEdgeCliffHeight(
  value: number,
  mode: BattleMode,
): void {
  persist(
    mode === 'real'
      ? STORAGE_REAL_WATERS_EDGE_CLIFF_HEIGHT
      : STORAGE_DEMO_WATERS_EDGE_CLIFF_HEIGHT,
    String(normalizeWatersEdgeCliffHeight(value)),
  );
}

export function loadStoredMetalDepositStep(mode: BattleMode): number {
  return loadModeNumberOption(
    mode,
    STORAGE_REAL_METAL_DEPOSIT_STEP,
    STORAGE_DEMO_METAL_DEPOSIT_STEP,
    BATTLE_CONFIG.metalDepositStep,
  );
}

export function saveMetalDepositStep(value: number, mode: BattleMode): void {
  persist(
    mode === 'real'
      ? STORAGE_REAL_METAL_DEPOSIT_STEP
      : STORAGE_DEMO_METAL_DEPOSIT_STEP,
    String(normalizeMetalDepositStep(value)),
  );
}

export function loadStoredTerrainDetail(mode: BattleMode): number {
  return loadModeNumberOption(
    mode,
    STORAGE_REAL_TERRAIN_DETAIL,
    STORAGE_DEMO_TERRAIN_DETAIL,
    BATTLE_CONFIG.terrainDetail,
  );
}

export function saveTerrainDetail(value: number, mode: BattleMode): void {
  persist(
    mode === 'real' ? STORAGE_REAL_TERRAIN_DETAIL : STORAGE_DEMO_TERRAIN_DETAIL,
    String(normalizeTerrainDetail(value)),
  );
}

export function loadStoredTerrainTextureSmoothing(mode: BattleMode): number {
  return loadModeNumberOption(
    mode,
    STORAGE_REAL_TERRAIN_TEXTURE_SMOOTHING,
    STORAGE_DEMO_TERRAIN_TEXTURE_SMOOTHING,
    BATTLE_CONFIG.terrainTextureSmoothing,
  );
}

export function saveTerrainTextureSmoothing(value: number, mode: BattleMode): void {
  persist(
    mode === 'real'
      ? STORAGE_REAL_TERRAIN_TEXTURE_SMOOTHING
      : STORAGE_DEMO_TERRAIN_TEXTURE_SMOOTHING,
    String(normalizeTerrainTextureSmoothing(value)),
  );
}

export function loadStoredTerrainLightSmoothing(mode: BattleMode): number {
  return loadModeNumberOption(
    mode,
    STORAGE_REAL_TERRAIN_LIGHT_SMOOTHING,
    STORAGE_DEMO_TERRAIN_LIGHT_SMOOTHING,
    BATTLE_CONFIG.terrainLightSmoothing,
  );
}

export function saveTerrainLightSmoothing(value: number, mode: BattleMode): void {
  persist(
    mode === 'real'
      ? STORAGE_REAL_TERRAIN_LIGHT_SMOOTHING
      : STORAGE_DEMO_TERRAIN_LIGHT_SMOOTHING,
    String(normalizeTerrainLightSmoothing(value)),
  );
}

export function loadStoredTerrainTextureSmoothAcrossWallBoundary(
  mode: BattleMode,
): boolean {
  return loadModeBool(
    mode,
    STORAGE_REAL_TERRAIN_TEXTURE_SMOOTH_ACROSS_WALL_BOUNDARY,
    STORAGE_DEMO_TERRAIN_TEXTURE_SMOOTH_ACROSS_WALL_BOUNDARY,
    BATTLE_CONFIG.terrainTextureSmoothAcrossWallBoundary.default,
  );
}

export function saveTerrainTextureSmoothAcrossWallBoundary(
  enabled: boolean,
  mode: BattleMode,
): void {
  persist(
    mode === 'real'
      ? STORAGE_REAL_TERRAIN_TEXTURE_SMOOTH_ACROSS_WALL_BOUNDARY
      : STORAGE_DEMO_TERRAIN_TEXTURE_SMOOTH_ACROSS_WALL_BOUNDARY,
    String(enabled),
  );
}

export function loadStoredTerrainLightSmoothAcrossWallBoundary(
  mode: BattleMode,
): boolean {
  return loadModeBool(
    mode,
    STORAGE_REAL_TERRAIN_LIGHT_SMOOTH_ACROSS_WALL_BOUNDARY,
    STORAGE_DEMO_TERRAIN_LIGHT_SMOOTH_ACROSS_WALL_BOUNDARY,
    BATTLE_CONFIG.terrainLightSmoothAcrossWallBoundary.default,
  );
}

export function saveTerrainLightSmoothAcrossWallBoundary(
  enabled: boolean,
  mode: BattleMode,
): void {
  persist(
    mode === 'real'
      ? STORAGE_REAL_TERRAIN_LIGHT_SMOOTH_ACROSS_WALL_BOUNDARY
      : STORAGE_DEMO_TERRAIN_LIGHT_SMOOTH_ACROSS_WALL_BOUNDARY,
    String(enabled),
  );
}

export function loadStoredTerrainSplitWallBoundaryVertices(
  mode: BattleMode,
): boolean {
  return loadModeBool(
    mode,
    STORAGE_REAL_TERRAIN_SPLIT_WALL_BOUNDARY_VERTICES,
    STORAGE_DEMO_TERRAIN_SPLIT_WALL_BOUNDARY_VERTICES,
    BATTLE_CONFIG.terrainSplitWallBoundaryVertices.default,
  );
}

export function saveTerrainSplitWallBoundaryVertices(
  enabled: boolean,
  mode: BattleMode,
): void {
  persist(
    mode === 'real'
      ? STORAGE_REAL_TERRAIN_SPLIT_WALL_BOUNDARY_VERTICES
      : STORAGE_DEMO_TERRAIN_SPLIT_WALL_BOUNDARY_VERTICES,
    String(enabled),
  );
}

let currentTerrainTextureSmoothing: number =
  BATTLE_CONFIG.terrainTextureSmoothing.default;
let currentTerrainLightSmoothing: number =
  BATTLE_CONFIG.terrainLightSmoothing.default;
let currentTerrainTextureSmoothAcrossWallBoundary: boolean =
  BATTLE_CONFIG.terrainTextureSmoothAcrossWallBoundary.default;
let currentTerrainLightSmoothAcrossWallBoundary: boolean =
  BATTLE_CONFIG.terrainLightSmoothAcrossWallBoundary.default;
let currentTerrainSplitWallBoundaryVertices: boolean =
  BATTLE_CONFIG.terrainSplitWallBoundaryVertices.default;

export function syncTerrainRenderSmoothingSettings(mode: BattleMode): void {
  currentTerrainTextureSmoothing = loadStoredTerrainTextureSmoothing(mode);
  currentTerrainLightSmoothing = loadStoredTerrainLightSmoothing(mode);
  currentTerrainTextureSmoothAcrossWallBoundary =
    loadStoredTerrainTextureSmoothAcrossWallBoundary(mode);
  currentTerrainLightSmoothAcrossWallBoundary =
    loadStoredTerrainLightSmoothAcrossWallBoundary(mode);
  currentTerrainSplitWallBoundaryVertices =
    loadStoredTerrainSplitWallBoundaryVertices(mode);
}

export function getTerrainTextureSmoothing(): number {
  return currentTerrainTextureSmoothing;
}

export function getTerrainLightSmoothing(): number {
  return currentTerrainLightSmoothing;
}

export function getTerrainTextureSmoothAcrossWallBoundary(): boolean {
  return currentTerrainTextureSmoothAcrossWallBoundary;
}

export function getTerrainLightSmoothAcrossWallBoundary(): boolean {
  return currentTerrainLightSmoothAcrossWallBoundary;
}

export function getTerrainSplitWallBoundaryVertices(): boolean {
  return currentTerrainSplitWallBoundaryVertices;
}

export function setTerrainTextureSmoothing(
  value: number,
  mode: BattleMode,
): void {
  currentTerrainTextureSmoothing = normalizeTerrainTextureSmoothing(value);
  saveTerrainTextureSmoothing(currentTerrainTextureSmoothing, mode);
}

export function setTerrainLightSmoothing(
  value: number,
  mode: BattleMode,
): void {
  currentTerrainLightSmoothing = normalizeTerrainLightSmoothing(value);
  saveTerrainLightSmoothing(currentTerrainLightSmoothing, mode);
}

export function setTerrainTextureSmoothAcrossWallBoundary(
  enabled: boolean,
  mode: BattleMode,
): void {
  currentTerrainTextureSmoothAcrossWallBoundary = enabled;
  saveTerrainTextureSmoothAcrossWallBoundary(enabled, mode);
}

export function setTerrainLightSmoothAcrossWallBoundary(
  enabled: boolean,
  mode: BattleMode,
): void {
  currentTerrainLightSmoothAcrossWallBoundary = enabled;
  saveTerrainLightSmoothAcrossWallBoundary(enabled, mode);
}

export function setTerrainSplitWallBoundaryVertices(
  enabled: boolean,
  mode: BattleMode,
): void {
  currentTerrainSplitWallBoundaryVertices = enabled;
  saveTerrainSplitWallBoundaryVertices(enabled, mode);
}

syncTerrainRenderSmoothingSettings('demo');

export function loadStoredTerrainRuntimeConfig(
  mode: BattleMode,
): BattleTerrainRuntimeConfig {
  return {
    centerMagnitude: loadStoredCenterMagnitude(mode),
    dividersMagnitude: loadStoredDividersMagnitude(mode),
    perimeterMagnitude: loadStoredPerimeterMagnitude(mode),
    terrainDTerrain: loadStoredTerrainDTerrain(mode),
    plateauWallSlopeDegrees: loadStoredPlateauWallSlopeDegrees(mode),
    watersEdgeBeachSlopeDegrees: loadStoredWatersEdgeBeachSlopeDegrees(mode),
    watersEdgeCliffHeight: loadStoredWatersEdgeCliffHeight(mode),
    metalDepositStep: loadStoredMetalDepositStep(mode),
    terrainDetail: loadStoredTerrainDetail(mode),
  };
}

export function getDefaultMapLandDimensions(): MapLandCellDimensions {
  return {
    widthLandCells: BATTLE_CONFIG.mapSize.width.default,
    lengthLandCells: BATTLE_CONFIG.mapSize.length.default,
  };
}

function getModeDefaultMapLandDimensions(mode: BattleMode): MapLandCellDimensions {
  const preset = getModeDefaultPreset(mode);
  return {
    widthLandCells: preset.mapWidthLandCells,
    lengthLandCells: preset.mapLengthLandCells,
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
  return getModeDefaultMapLandDimensions(mode);
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
