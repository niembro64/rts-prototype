import type { BattleBarConfig } from './types/battle';
import type { ShieldReflectionMode } from './types/shotTypes';
import { isSlopePathMode, type SlopePathMode } from './types/slopePathMode';
import {
  isTerrainPrecedence,
  type TerrainPrecedence,
} from './types/terrainPrecedence';
import {
  isLiquidSurfaceMode,
  isMetalCoverage,
  type LiquidSurfaceMode,
  type MetalCoverage,
} from './types/worldSurfaceMode';
import { persistJson, readPersisted } from './persistence';
import { readModeSetting, writeModeSetting } from './realBattleSessionSettings';
import { MAP_DIMENSION_CONFIG, type MapLandCellDimensions } from './mapSizeConfig';
import {
  BUILDABLE_UNIT_BLUEPRINT_IDS,
  isBuildableUnitBlueprintId,
} from './game/sim/blueprints/unitRoster';
import {
  BUILDING_BLUEPRINT_IDS,
  isBuildingBlueprintId,
} from './types/blueprintIds';
import battleBarConfig from './battleBarConfig.json';
import { getModeDefaultPreset } from './components/battlePresets';
import {
  normalizePathfindingCellConsolidationMultiplier as normalizePathfindingMultiplierValue,
  PATHFINDING_CELL_CONSOLIDATION_OPTIONS,
  type PathfindingCellConsolidationMultiplier,
} from './types/pathfinding';
import {
  normalizeSimulationTickRateHz as normalizeSimulationTickRateValue,
  SIMULATION_TICK_RATE_OPTIONS,
  type SimulationTickRateHz,
} from './types/simulationTickRate';

// ── Authored data lives in battleBarConfig.json ──
// The TS shim composes BATTLE_CONFIG by reading the JSON and layering
// in the two fields that need cross-config references:
//   - `units`: built dynamically from BUILDABLE_UNIT_BLUEPRINT_IDS (unitRoster.json)
//   - `mapSize`: pulled from MAP_DIMENSION_CONFIG (mapSizeConfig.json)
// Everything else — caps, toggles, terrain options, mode defaults,
// and storage keys — is pure JSON.

function buildUnitToggleConfig(): Record<string, { default: boolean }> {
  return Object.fromEntries(
    BUILDABLE_UNIT_BLUEPRINT_IDS.map((unitBlueprintId) => [
      unitBlueprintId,
      { default: true },
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

// Most `BATTLE_CONFIG.*.default` values flow through the mode's base preset.
// Unit-cap defaults are mode policy authored beside the cap options: Demo is
// a small persistent sandbox, while Lobby/Real starts fresh at battle scale.
const _demoPreset = getModeDefaultPreset('demo');

/** The ENTITY COUNT CAP is a standalone global setting, deliberately NOT a
 *  preset field: switching maps must never resize the battle. Only an
 *  explicit CAP change moves it, and each mode has one authored default —
 *  demo is a persistent sandbox, the lobby always starts fresh. */
const MODE_DEFAULT_ENTITY_COUNT_CAPS: Record<BattleMode, number> = {
  demo: battleBarConfig.cap.demoDefault,
  real: battleBarConfig.cap.realDefault,
};

const MODE_DEFAULT_PATHFINDING_CELL_CONSOLIDATION: Record<
  BattleMode,
  PathfindingCellConsolidationMultiplier
> = {
  demo: normalizePathfindingMultiplierValue(
    battleBarConfig.pathfindingCellConsolidation.demoDefault,
  ),
  real: normalizePathfindingMultiplierValue(
    battleBarConfig.pathfindingCellConsolidation.realDefault,
  ),
};

const MODE_DEFAULT_SIMULATION_TICK_RATE: Record<
  BattleMode,
  SimulationTickRateHz
> = {
  demo: normalizeSimulationTickRateValue(
    battleBarConfig.simulationTickRate.demoDefault,
  ),
  real: normalizeSimulationTickRateValue(
    battleBarConfig.simulationTickRate.realDefault,
  ),
};

const authoredSimulationTickRateOptions =
  battleBarConfig.simulationTickRate.options;
if (
  authoredSimulationTickRateOptions.length !==
    SIMULATION_TICK_RATE_OPTIONS.length ||
  authoredSimulationTickRateOptions.some(
    (value, index) => value !== SIMULATION_TICK_RATE_OPTIONS[index],
  )
) {
  throw new Error(
    'battleBarConfig.simulationTickRate.options must be 1, 5, 10, 15, 20, 30, 45, 60',
  );
}

export function getModeDefaultEntityCountCap(mode: BattleMode): number {
  return MODE_DEFAULT_ENTITY_COUNT_CAPS[mode];
}
const TERRAIN_RENDER_SMOOTHING_DEFAULT = 3;
const TERRAIN_TEXTURE_SMOOTH_ACROSS_WALL_BOUNDARY_DEFAULT = true;
const TERRAIN_LIGHT_SMOOTH_ACROSS_WALL_BOUNDARY_DEFAULT = false;
const TERRAIN_SPLIT_WALL_BOUNDARY_VERTICES_DEFAULT = true;

export const BATTLE_CONFIG = {
  units: buildUnitToggleConfig(),
  buildings: buildBuildingToggleConfig(),
  cap: {
    default: MODE_DEFAULT_ENTITY_COUNT_CAPS.demo,
    options: battleBarConfig.cap.options as readonly number[],
  },
  /** Sides a REAL lobby offers. Demo has no entry: its shape is authored as
   *  seats-per-side in demoConfig.json, which is the only form that can seat
   *  a side unevenly. */
  allyTeamCount: {
    default: battleBarConfig.allyTeamCount.realDefault as number,
    options: battleBarConfig.allyTeamCount.options as readonly number[],
  },
  pathfindingCellConsolidation: {
    default: MODE_DEFAULT_PATHFINDING_CELL_CONSOLIDATION.demo,
    options: battleBarConfig.pathfindingCellConsolidation.options as readonly PathfindingCellConsolidationMultiplier[],
  },
  simulationTickRate: {
    default: MODE_DEFAULT_SIMULATION_TICK_RATE.demo,
    options: battleBarConfig.simulationTickRate.options as readonly SimulationTickRateHz[],
  },
  turretShieldPanelsEnabled: { default: _demoPreset.turretShieldPanelsEnabled },
  turretShieldSpheresEnabled: { default: _demoPreset.turretShieldSpheresEnabled },
  forceFieldsVisible: { default: _demoPreset.forceFieldsVisible },
  fogOfWarEnabled: { default: _demoPreset.fogOfWarEnabled },
  slowDownAtFinalWaypoint: { default: _demoPreset.slowDownAtFinalWaypoint },
  shieldReflectionMode: {
    default: _demoPreset.shieldReflectionMode,
  },
  slopePathMode: {
    default: _demoPreset.slopePathMode,
  },
  // WORLD group: ground material and what fills the map below water level.
  metalCoverage: {
    default: _demoPreset.metalCoverage,
  },
  liquidSurfaceMode: {
    default: _demoPreset.liquidSurfaceMode,
  },
  // CENTER / DIVIDERS amplitudes — applied at game-construction time
  // via setTerrainCenterMagnitude / setTerrainDividersMagnitude
  // (Terrain.ts). Signed: negative dishes the feature below ground,
  // positive raises it above, zero suppresses it.
  centerMagnitude: {
    default: _demoPreset.centerMagnitude,
    options: battleBarConfig.centerMagnitude.options as readonly number[],
  },
  // RING annulus crest amplitude — baseline at the map centre, full signed
  // magnitude at the authored crest radius, baseline again at the outer
  // radius.
  ringMagnitude: {
    default: _demoPreset.ringMagnitude,
    options: battleBarConfig.ringMagnitude.options as readonly number[],
  },
  dividersMagnitude: {
    default: _demoPreset.dividersMagnitude,
    options: battleBarConfig.dividersMagnitude.options as readonly number[],
  },
  perimeterMagnitude: {
    default: _demoPreset.perimeterMagnitude,
    options: battleBarConfig.perimeterMagnitude.options as readonly number[],
  },
  // PRECEDENCE: which of DIVIDERS/PERIMETER applies last in terrain
  // generation — last wins where they overlap.
  terrainPrecedence: {
    default: _demoPreset.terrainPrecedence,
    options: battleBarConfig.terrainPrecedence.options as readonly TerrainPrecedence[],
  },
  terrainDTerrain: {
    default: _demoPreset.terrainDTerrain,
    options: battleBarConfig.terrainDTerrain.options as readonly number[],
  },
  plateauWallSlopeDegrees: {
    default: _demoPreset.plateauWallSlopeDegrees,
    options: battleBarConfig.plateauWallSlopeDegrees.options as readonly number[],
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
// Unit cap is the intentional exception: Demo persists its cap, while Real
// belongs to one lobby/match session and starts fresh for the next one.
//
// First-read fallback: when a `real-battle-*` key has no value yet,
// the loader falls back to the matching `demo-battle-*` value — so
// existing customizations carry over to real battle the first time
// a user enters the lobby, and only diverge when the user explicitly
// changes them in the lobby.
//
const sk = battleBarConfig.storageKeys;
// There is deliberately no shared "content revision" any more.
//
// A single version string is a one-shot latch: it answers "has this migration
// run?", and every profile that already matches it short-circuits past
// everything the block later grows. That is the wrong question for authored
// content, where the real question is "has this profile ever SEEN this
// blueprint?" — a standing rule that must be re-evaluated every time the
// roster grows. Using the latch for it hid the two shield labs, and then the
// precision lab, from every developer profile while fresh ones were fine.
//
// Content adoption reads a LEDGER of the ids each roster was last written
// against, so a blueprint added later is provably new and defaults ON without
// accepting or rewriting any obsolete storage shape.
const STORAGE_DEMO_UNITS = sk.demoUnits;
const STORAGE_REAL_UNITS = sk.realUnits;
const STORAGE_DEMO_UNITS_KNOWN_IDS = sk.demoUnitsKnownIds;
const STORAGE_DEMO_UNITS_ALL_ENABLED_REVISION = sk.demoUnitsAllEnabledRevision;
const STORAGE_DEMO_BUILDINGS = sk.demoBuildings;
const STORAGE_REAL_BUILDINGS = sk.realBuildings;
const STORAGE_DEMO_BUILDINGS_KNOWN_IDS = sk.demoBuildingsKnownIds;
const STORAGE_DEMO_CAP = sk.demoCap;
// Every `real*` key below names a slot in `realSessionSettings`, NOT a
// localStorage entry — real-battle settings are never written to the
// browser. The names mirror the demo keys so the two stay symmetric.
const STORAGE_REAL_CAP = sk.realCap;
const STORAGE_DEMO_PATHFINDING_CELL_CONSOLIDATION =
  sk.demoPathfindingCellConsolidation;
const STORAGE_REAL_PATHFINDING_CELL_CONSOLIDATION =
  sk.realPathfindingCellConsolidation;
const STORAGE_DEMO_SIMULATION_TICK_RATE = sk.demoSimulationTickRate;
const STORAGE_REAL_SIMULATION_TICK_RATE = sk.realSimulationTickRate;
const STORAGE_DEMO_FORCE_FIELDS_VISIBLE = sk.demoForceFieldsVisible;
const STORAGE_REAL_FORCE_FIELDS_VISIBLE = sk.realForceFieldsVisible;
const STORAGE_DEMO_FOG_OF_WAR_ENABLED = sk.demoFogOfWarEnabled;
const STORAGE_REAL_FOG_OF_WAR_ENABLED = sk.realFogOfWarEnabled;
const STORAGE_DEMO_SLOW_DOWN_AT_FINAL_WAYPOINT = sk.demoSlowDownAtFinalWaypoint;
const STORAGE_REAL_SLOW_DOWN_AT_FINAL_WAYPOINT = sk.realSlowDownAtFinalWaypoint;
const STORAGE_DEMO_SLOPE_PATH_MODE = sk.demoSlopePathMode;
const STORAGE_REAL_SLOPE_PATH_MODE = sk.realSlopePathMode;
const STORAGE_DEMO_METAL_COVERAGE = sk.demoMetalCoverage;
const STORAGE_REAL_METAL_COVERAGE = sk.realMetalCoverage;
const STORAGE_DEMO_LIQUID_SURFACE_MODE = sk.demoLiquidSurfaceMode;
const STORAGE_REAL_LIQUID_SURFACE_MODE = sk.realLiquidSurfaceMode;
const STORAGE_DEMO_CENTER_MAGNITUDE = sk.demoCenterMagnitude;
const STORAGE_REAL_CENTER_MAGNITUDE = sk.realCenterMagnitude;
const STORAGE_DEMO_RING_MAGNITUDE = sk.demoRingMagnitude;
const STORAGE_REAL_RING_MAGNITUDE = sk.realRingMagnitude;
const STORAGE_DEMO_DIVIDERS_MAGNITUDE = sk.demoDividersMagnitude;
const STORAGE_REAL_DIVIDERS_MAGNITUDE = sk.realDividersMagnitude;
const STORAGE_DEMO_PERIMETER_MAGNITUDE = sk.demoPerimeterMagnitude;
const STORAGE_REAL_PERIMETER_MAGNITUDE = sk.realPerimeterMagnitude;
const STORAGE_DEMO_TERRAIN_PRECEDENCE = sk.demoTerrainPrecedence;
const STORAGE_REAL_TERRAIN_PRECEDENCE = sk.realTerrainPrecedence;
const STORAGE_DEMO_TERRAIN_D_TERRAIN = sk.demoTerrainDTerrain;
const STORAGE_REAL_TERRAIN_D_TERRAIN = sk.realTerrainDTerrain;
const STORAGE_DEMO_PLATEAU_WALL_SLOPE_DEGREES = sk.demoPlateauWallSlopeDegrees;
const STORAGE_REAL_PLATEAU_WALL_SLOPE_DEGREES = sk.realPlateauWallSlopeDegrees;
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
const STORAGE_DEMO_MAP_WIDTH_LAND_CELLS = sk.demoMapWidthLandCells;
const STORAGE_REAL_MAP_WIDTH_LAND_CELLS = sk.realMapWidthLandCells;
const STORAGE_DEMO_MAP_LENGTH_LAND_CELLS = sk.demoMapLengthLandCells;
const STORAGE_REAL_MAP_LENGTH_LAND_CELLS = sk.realMapLengthLandCells;

let _demoRosterRefreshRun = false;
/** Refresh current roster ledgers once per process. */
function refreshDemoRosterLedgers(): void {
  if (_demoRosterRefreshRun) return;
  _demoRosterRefreshRun = true;
  migrateDemoUnitsToAllEnabledDefault();
  adoptNewDemoBlueprints();
}

/** One-time policy migration for profiles saved while Queen Bee and Queen
 * Tick were authored as default-disabled. Their absence in those rosters was
 * not a user opt-out, so the new universal all-enabled default must add them
 * once. Every other saved choice is preserved. */
export function migrateDemoUnitsToAllEnabledDefault(): void {
  if (readPersisted(STORAGE_DEMO_UNITS_ALL_ENABLED_REVISION) !== null) return;
  persistJson(STORAGE_DEMO_UNITS_ALL_ENABLED_REVISION, true);
  const storedRoster = readPersisted(STORAGE_DEMO_UNITS);
  if (storedRoster === null) return;
  let roster: string[] | null = null;
  try {
    roster = sanitizeDemoUnitIds(JSON.parse(storedRoster));
  } catch {
    return;
  }
  if (roster === null) return;
  const selected = new Set(roster);
  selected.add('unitQueenBee');
  selected.add('unitQueenTick');
  persistJson(
    STORAGE_DEMO_UNITS,
    BUILDABLE_UNIT_BLUEPRINT_IDS.filter((id) => selected.has(id)),
  );
}

/** Adopt every blueprint that this profile's stored roster has never seen.
 *
 *  A roster is a list of opt-OUTS: it records which blueprints the player
 *  switched off. A blueprint added to the game after the roster was saved was
 *  never on screen to switch off, so it defaults ON.
 *
 *  The LEDGER is what makes that decidable. It records the ids the roster was
 *  last written against, so anything in the current id list missing from it is
 *  provably new — no version string, no hand-written id list, and nothing to
 *  remember when the next blueprint lands. The previous mechanism was a
 *  hardcoded id list inside a revision-gated migration, which silently does
 *  nothing for a profile already at the current revision; that is how the two
 *  shield labs, and then the precision lab, went missing from the demo on
 *  every developer profile while fresh installs were fine.
 *
 *  A missing ledger is initialized to the current contract without trying to
 *  infer the age or meaning of an unversioned roster. */
export function adoptNewDemoBlueprints(): void {
  adoptNewRosterBlueprints(
    STORAGE_DEMO_BUILDINGS,
    STORAGE_DEMO_BUILDINGS_KNOWN_IDS,
    BUILDING_BLUEPRINT_IDS,
    sanitizeDemoBuildingIds,
  );
  adoptNewRosterBlueprints(
    STORAGE_DEMO_UNITS,
    STORAGE_DEMO_UNITS_KNOWN_IDS,
    BUILDABLE_UNIT_BLUEPRINT_IDS,
    sanitizeDemoUnitIds,
  );
}

function adoptNewRosterBlueprints(
  rosterKey: string,
  ledgerKey: string,
  currentIds: readonly string[],
  sanitize: (value: unknown) => string[] | null,
): void {
  const persistLedger = (): void => {
    persistJson(ledgerKey, [...currentIds]);
  };
  const storedLedger = readPersisted(ledgerKey);
  if (storedLedger === null) {
    persistLedger();
    return;
  }
  let knownIds: string[] | null = null;
  try {
    knownIds = sanitize(JSON.parse(storedLedger));
  } catch {
    // Malformed current state is replaced, never interpreted as an older shape.
  }
  if (knownIds === null) {
    persistLedger();
    return;
  }
  const known = new Set<string>(knownIds);
  const introduced = currentIds.filter((id) => !known.has(id));
  persistLedger();
  if (introduced.length === 0) return;

  // No stored roster means the defaults apply, and those already cover every
  // current blueprint.
  const storedRoster = readPersisted(rosterKey);
  if (storedRoster === null) return;
  let roster: string[] | null = null;
  try {
    roster = sanitize(JSON.parse(storedRoster));
  } catch {
    return;
  }
  if (roster === null) return;
  const selected = new Set<string>(roster);
  for (const id of introduced) selected.add(id);
  persistJson(rosterKey, currentIds.filter((id) => selected.has(id)));
}

/** "<positive-number>" → number, null otherwise. */
function loadPosNum(key: string): number | null {
  refreshDemoRosterLedgers();
  const s = readPersisted(key);
  if (!s) return null;
  const n = Number(s);
  return !isNaN(n) && n > 0 ? n : null;
}

function loadStoredDemoUnits(): string[] | null {
  refreshDemoRosterLedgers();
  const stored = readPersisted(STORAGE_DEMO_UNITS);
  if (!stored) return null;
  try {
    return sanitizeDemoUnitIds(JSON.parse(stored));
  } catch {
    /* malformed JSON */
  }
  return null;
}

function saveDemoUnits(units: string[]): void {
  // Refresh first: a save must not write a roster before adoption has had a
  // chance to fold in blueprints this profile has never seen, or the save
  // persists the gap and the ledger then records it as deliberate.
  refreshDemoRosterLedgers();
  persistJson(STORAGE_DEMO_UNITS, sanitizeDemoUnitIds(units) ?? []);
}

export function getDefaultDemoUnits(): string[] {
  return Object.entries(BATTLE_CONFIG.units)
    .filter(([, cfg]) => cfg.default)
    .map(([id]) => id);
}

/** Complete unit selection for one battle context.
 *
 * Demo is a persistent sandbox and reads its browser roster. Lobby/Real uses
 * the shared in-memory session store, which is cleared on every lobby entry;
 * it therefore starts from the complete current registry without ever
 * reading or writing browser storage. An explicitly empty roster is valid. */
export function loadBattleUnitRoster(mode: BattleMode): string[] {
  if (mode === 'demo') {
    return loadStoredDemoUnits() ?? getDefaultDemoUnits();
  }
  const stored = readModeSetting('real', STORAGE_REAL_UNITS, STORAGE_DEMO_UNITS);
  if (stored !== null) {
    try {
      const sanitized = sanitizeDemoUnitIds(JSON.parse(stored));
      if (sanitized !== null) return sanitized;
    } catch {
      // Invalid session state falls back to the authored all-enabled policy.
    }
  }
  return [...BUILDABLE_UNIT_BLUEPRINT_IDS];
}

export function saveBattleUnitRoster(
  units: readonly string[],
  mode: BattleMode,
): void {
  const sanitized = sanitizeDemoUnitIds(units) ?? [];
  if (mode === 'demo') {
    saveDemoUnits(sanitized);
    return;
  }
  writeModeSetting(
    'real',
    STORAGE_REAL_UNITS,
    STORAGE_DEMO_UNITS,
    JSON.stringify(sanitized),
  );
}

// ── Demo building enablement (BUILDINGS bar group) ──
// Persistence mirrors the unit trio.

function loadStoredDemoBuildings(): string[] | null {
  refreshDemoRosterLedgers();
  const stored = readPersisted(STORAGE_DEMO_BUILDINGS);
  if (!stored) return null;
  try {
    return sanitizeDemoBuildingIds(JSON.parse(stored));
  } catch {
    /* malformed JSON */
  }
  return null;
}

function saveDemoBuildings(buildings: string[]): void {
  refreshDemoRosterLedgers();
  persistJson(STORAGE_DEMO_BUILDINGS, sanitizeDemoBuildingIds(buildings) ?? []);
}

export function getDefaultDemoBuildings(): string[] {
  return Object.entries(BATTLE_CONFIG.buildings)
    .filter(([, cfg]) => cfg.default)
    .map(([id]) => id);
}

/** Building counterpart of loadBattleUnitRoster; Real is session-only. */
export function loadBattleBuildingRoster(mode: BattleMode): string[] {
  if (mode === 'demo') {
    return loadStoredDemoBuildings() ?? getDefaultDemoBuildings();
  }
  const stored = readModeSetting(
    'real',
    STORAGE_REAL_BUILDINGS,
    STORAGE_DEMO_BUILDINGS,
  );
  if (stored !== null) {
    try {
      const sanitized = sanitizeDemoBuildingIds(JSON.parse(stored));
      if (sanitized !== null) return sanitized;
    } catch {
      // Invalid session state falls back to the authored all-enabled policy.
    }
  }
  return [...BUILDING_BLUEPRINT_IDS];
}

export function saveBattleBuildingRoster(
  buildings: readonly string[],
  mode: BattleMode,
): void {
  const sanitized = sanitizeDemoBuildingIds(buildings) ?? [];
  if (mode === 'demo') {
    saveDemoBuildings(sanitized);
    return;
  }
  writeModeSetting(
    'real',
    STORAGE_REAL_BUILDINGS,
    STORAGE_DEMO_BUILDINGS,
    JSON.stringify(sanitized),
  );
}

/** A cap is only meaningful when it sits on the authored ladder: the BATTLE
 *  bar renders exactly those buttons, so an off-ladder value (a default from
 *  an older build, a hand-edited store) lights no CAP at all and the bar
 *  reads as capless. Off the ladder falls back to the mode default. */
function sanitizeEntityCountCap(value: number, mode: BattleMode): number {
  return (battleBarConfig.cap.options as readonly number[]).includes(value)
    ? value
    : MODE_DEFAULT_ENTITY_COUNT_CAPS[mode];
}

function loadStoredDemoCap(): number {
  const stored = loadPosNum(STORAGE_DEMO_CAP);
  return stored === null
    ? getModeDefaultEntityCountCap('demo')
    : sanitizeEntityCountCap(stored, 'demo');
}

// Real-battle settings are session-only; see realBattleSessionSettings.ts
// for the rule and the store. Re-exported so callers keep one import.
export { resetRealBattleSettings } from './realBattleSessionSettings';

/** Identifies which battle context a setting belongs to.
 *  - `demo` = the visual demo running on the BUDGET ANNIHILATION
 *    backdrop (initial page load + any return to that screen).
 *  - `real` = the GAME LOBBY preview AND the REAL BATTLE itself.
 *  Pass this to every battle-setting load / save call so the
 *  two namespaces stay isolated. */
export type BattleMode = 'demo' | 'real';

export type BattleTerrainRuntimeConfig = {
  centerMagnitude: number;
  /** Signed RING annulus crest altitude (RING bar). */
  ringMagnitude: number;
  dividersMagnitude: number;
  /** Signed PERIMETER ring altitude: negative sinks the outer ring below
   *  water (round-island), positive raises a rim, 0 flattens it to ground
   *  level. */
  perimeterMagnitude: number;
  /** Which of DIVIDERS/PERIMETER applies last in terrain generation
   *  (PRECEDENCE bar) — last wins where they overlap. */
  terrainPrecedence: TerrainPrecedence;
  /** Plateau lattice step in world units. 0 = NONE (no terracing). */
  terrainDTerrain: number;
  /** D-PLATEAU wall slope angle in degrees from horizontal. */
  plateauWallSlopeDegrees: number;
  /** Metal-extractor pad altitude step in world units. */
  metalDepositStep: number;
  /** Fine-triangle subdivisions per land cell. 0 = off, which the
   *  terrain baker clamps to one triangle edge subdivision per cell. */
  terrainDetail: number;
};


/** Current ENTITY COUNT CAP for a battle mode. Demo reads the browser
 *  preference; real reads this session's memory, so a fresh lobby always
 *  opens on the authored default. Rides the same store as every other
 *  real setting — there is one reset, not one per field. */
export function getUnitCap(mode: BattleMode): number {
  if (mode === 'demo') return loadStoredDemoCap();
  const stored = Number(readModeSetting('real', STORAGE_REAL_CAP, STORAGE_DEMO_CAP));
  return Number.isFinite(stored) && stored > 0
    ? sanitizeEntityCountCap(stored, 'real')
    : getModeDefaultEntityCountCap('real');
}

/** Change the current mode's cap. Only Demo reaches localStorage. */
export function setUnitCap(mode: BattleMode, value: number): void {
  if (!Number.isFinite(value) || value <= 0) return;
  writeModeSetting(mode, STORAGE_REAL_CAP, STORAGE_DEMO_CAP, String(value));
}

export function normalizePathfindingCellConsolidation(
  value: number,
): PathfindingCellConsolidationMultiplier {
  return normalizePathfindingMultiplierValue(value);
}

export function loadStoredPathfindingCellConsolidation(
  mode: BattleMode,
): PathfindingCellConsolidationMultiplier {
  const fallback = MODE_DEFAULT_PATHFINDING_CELL_CONSOLIDATION[mode];
  const stored = readModeSetting(
    mode,
    STORAGE_REAL_PATHFINDING_CELL_CONSOLIDATION,
    STORAGE_DEMO_PATHFINDING_CELL_CONSOLIDATION,
  );
  const value = Number(stored);
  return PATHFINDING_CELL_CONSOLIDATION_OPTIONS.includes(
    value as PathfindingCellConsolidationMultiplier,
  )
    ? value as PathfindingCellConsolidationMultiplier
    : fallback;
}

export function savePathfindingCellConsolidation(
  value: number,
  mode: BattleMode,
): void {
  writeModeSetting(
    mode,
    STORAGE_REAL_PATHFINDING_CELL_CONSOLIDATION,
    STORAGE_DEMO_PATHFINDING_CELL_CONSOLIDATION,
    String(normalizePathfindingCellConsolidation(value)),
  );
}

export function loadStoredSimulationTickRate(
  mode: BattleMode,
): SimulationTickRateHz {
  const stored = Number(readModeSetting(
    mode,
    STORAGE_REAL_SIMULATION_TICK_RATE,
    STORAGE_DEMO_SIMULATION_TICK_RATE,
  ));
  return normalizeSimulationTickRateValue(
    stored,
    MODE_DEFAULT_SIMULATION_TICK_RATE[mode],
  );
}

export function saveSimulationTickRate(
  value: number,
  mode: BattleMode,
): void {
  const fallback = MODE_DEFAULT_SIMULATION_TICK_RATE[mode];
  writeModeSetting(
    mode,
    STORAGE_REAL_SIMULATION_TICK_RATE,
    STORAGE_DEMO_SIMULATION_TICK_RATE,
    String(normalizeSimulationTickRateValue(value, fallback)),
  );
}

export function normalizeSimulationTickRate(
  value: number,
  mode: BattleMode = 'demo',
): SimulationTickRateHz {
  return normalizeSimulationTickRateValue(
    value,
    MODE_DEFAULT_SIMULATION_TICK_RATE[mode],
  );
}


/** Read a per-mode boolean. Demo reads its browser preference; real reads
 *  this session's memory and otherwise takes the authored default. Real
 *  never falls back to the demo key — a lobby must not inherit whatever
 *  the sandbox was left on. */
function loadModeBool(
  mode: BattleMode,
  realKey: string,
  demoKey: string,
  defaultValue: boolean,
): boolean {
  refreshDemoRosterLedgers();
  const stored = readModeSetting(mode, realKey, demoKey);
  if (stored === 'true') return true;
  if (stored === 'false') return false;
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
  writeModeSetting(mode, STORAGE_REAL_FORCE_FIELDS_VISIBLE, STORAGE_DEMO_FORCE_FIELDS_VISIBLE, String(enabled));
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
  writeModeSetting(mode, STORAGE_REAL_FOG_OF_WAR_ENABLED, STORAGE_DEMO_FOG_OF_WAR_ENABLED, String(enabled));
}

export function loadStoredSlowDownAtFinalWaypoint(mode: BattleMode): boolean {
  return loadModeBool(
    mode,
    STORAGE_REAL_SLOW_DOWN_AT_FINAL_WAYPOINT,
    STORAGE_DEMO_SLOW_DOWN_AT_FINAL_WAYPOINT,
    getModeDefaultPreset(mode).slowDownAtFinalWaypoint,
  );
}

export function saveSlowDownAtFinalWaypoint(enabled: boolean, mode: BattleMode): void {
  writeModeSetting(mode, STORAGE_REAL_SLOW_DOWN_AT_FINAL_WAYPOINT, STORAGE_DEMO_SLOW_DOWN_AT_FINAL_WAYPOINT, String(enabled));
}

export function loadStoredShieldReflectionMode(_mode: BattleMode): ShieldReflectionMode {
  return BATTLE_CONFIG.shieldReflectionMode.default;
}

export function loadStoredSlopePathMode(mode: BattleMode): SlopePathMode {
  const stored = readModeSetting(mode, STORAGE_REAL_SLOPE_PATH_MODE, STORAGE_DEMO_SLOPE_PATH_MODE);
  return isSlopePathMode(stored) ? stored : getModeDefaultPreset(mode).slopePathMode;
}

export function saveSlopePathMode(value: SlopePathMode, mode: BattleMode): void {
  writeModeSetting(mode, STORAGE_REAL_SLOPE_PATH_MODE, STORAGE_DEMO_SLOPE_PATH_MODE, value);
}

export function loadStoredMetalCoverage(mode: BattleMode): MetalCoverage {
  const stored = readModeSetting(mode, STORAGE_REAL_METAL_COVERAGE, STORAGE_DEMO_METAL_COVERAGE);
  return isMetalCoverage(stored) ? stored : getModeDefaultPreset(mode).metalCoverage;
}

export function saveMetalCoverage(value: MetalCoverage, mode: BattleMode): void {
  writeModeSetting(mode, STORAGE_REAL_METAL_COVERAGE, STORAGE_DEMO_METAL_COVERAGE, value);
}

export function loadStoredLiquidSurfaceMode(mode: BattleMode): LiquidSurfaceMode {
  const stored = readModeSetting(mode, STORAGE_REAL_LIQUID_SURFACE_MODE, STORAGE_DEMO_LIQUID_SURFACE_MODE);
  return isLiquidSurfaceMode(stored) ? stored : getModeDefaultPreset(mode).liquidSurfaceMode;
}

export function saveLiquidSurfaceMode(value: LiquidSurfaceMode, mode: BattleMode): void {
  writeModeSetting(mode, STORAGE_REAL_LIQUID_SURFACE_MODE, STORAGE_DEMO_LIQUID_SURFACE_MODE, value);
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
  refreshDemoRosterLedgers();
  const stored = parseNumberOption(
    readModeSetting(mode, realKey, demoKey),
    config.options,
  );
  return stored !== null ? stored : config.default;
}

export function normalizeCenterMagnitude(value: number): number {
  return normalizeNumberOption(value, BATTLE_CONFIG.centerMagnitude);
}

export function normalizeRingMagnitude(value: number): number {
  return normalizeNumberOption(value, BATTLE_CONFIG.ringMagnitude);
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

export function normalizeMetalDepositStep(value: number): number {
  return normalizeNumberOption(value, BATTLE_CONFIG.metalDepositStep);
}

export function normalizeTerrainDetail(value: number): number {
  return normalizeNumberOption(value, BATTLE_CONFIG.terrainDetail);
}

function normalizeTerrainTextureSmoothing(value: number): number {
  return normalizeNumberOption(value, BATTLE_CONFIG.terrainTextureSmoothing);
}

function normalizeTerrainLightSmoothing(value: number): number {
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
  refreshDemoRosterLedgers();
  const stored = parseFloatOption(
    readModeSetting(mode, realKey, demoKey),
    config.options,
  );
  return stored !== null ? stored : config.default;
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
  writeModeSetting(mode, STORAGE_REAL_CONVERTER_TAX, STORAGE_DEMO_CONVERTER_TAX, String(normalizeConverterTax(value)));
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

export function loadStoredCenterMagnitude(mode: BattleMode): number {
  return loadModeNumberOption(
    mode,
    STORAGE_REAL_CENTER_MAGNITUDE,
    STORAGE_DEMO_CENTER_MAGNITUDE,
    BATTLE_CONFIG.centerMagnitude,
  );
}

export function saveCenterMagnitude(value: number, mode: BattleMode): void {
  writeModeSetting(mode, STORAGE_REAL_CENTER_MAGNITUDE, STORAGE_DEMO_CENTER_MAGNITUDE, String(normalizeCenterMagnitude(value)));
}

export function loadStoredRingMagnitude(mode: BattleMode): number {
  return loadModeNumberOption(
    mode,
    STORAGE_REAL_RING_MAGNITUDE,
    STORAGE_DEMO_RING_MAGNITUDE,
    BATTLE_CONFIG.ringMagnitude,
  );
}

export function saveRingMagnitude(value: number, mode: BattleMode): void {
  writeModeSetting(mode, STORAGE_REAL_RING_MAGNITUDE, STORAGE_DEMO_RING_MAGNITUDE, String(normalizeRingMagnitude(value)));
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
  writeModeSetting(mode, STORAGE_REAL_DIVIDERS_MAGNITUDE, STORAGE_DEMO_DIVIDERS_MAGNITUDE, String(normalizeDividersMagnitude(value)));
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
  writeModeSetting(mode, STORAGE_REAL_PERIMETER_MAGNITUDE, STORAGE_DEMO_PERIMETER_MAGNITUDE, String(normalizePerimeterMagnitude(value)));
}

export function normalizeTerrainPrecedence(value: unknown): TerrainPrecedence {
  return isTerrainPrecedence(value)
    ? value
    : BATTLE_CONFIG.terrainPrecedence.default;
}

export function loadStoredTerrainPrecedence(mode: BattleMode): TerrainPrecedence {
  refreshDemoRosterLedgers();
  const stored = readModeSetting(
    mode,
    STORAGE_REAL_TERRAIN_PRECEDENCE,
    STORAGE_DEMO_TERRAIN_PRECEDENCE,
  );
  return isTerrainPrecedence(stored)
    ? stored
    : getModeDefaultPreset(mode).terrainPrecedence;
}

export function saveTerrainPrecedence(
  value: TerrainPrecedence,
  mode: BattleMode,
): void {
  writeModeSetting(
    mode,
    STORAGE_REAL_TERRAIN_PRECEDENCE,
    STORAGE_DEMO_TERRAIN_PRECEDENCE,
    normalizeTerrainPrecedence(value),
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
  writeModeSetting(mode, STORAGE_REAL_TERRAIN_D_TERRAIN, STORAGE_DEMO_TERRAIN_D_TERRAIN, String(normalizeTerrainDTerrain(value)));
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
  writeModeSetting(mode, STORAGE_REAL_PLATEAU_WALL_SLOPE_DEGREES, STORAGE_DEMO_PLATEAU_WALL_SLOPE_DEGREES, String(normalizePlateauWallSlopeDegrees(value)));
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
  writeModeSetting(mode, STORAGE_REAL_METAL_DEPOSIT_STEP, STORAGE_DEMO_METAL_DEPOSIT_STEP, String(normalizeMetalDepositStep(value)));
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
  writeModeSetting(mode, STORAGE_REAL_TERRAIN_DETAIL, STORAGE_DEMO_TERRAIN_DETAIL, String(normalizeTerrainDetail(value)));
}

function loadStoredTerrainTextureSmoothing(mode: BattleMode): number {
  return loadModeNumberOption(
    mode,
    STORAGE_REAL_TERRAIN_TEXTURE_SMOOTHING,
    STORAGE_DEMO_TERRAIN_TEXTURE_SMOOTHING,
    BATTLE_CONFIG.terrainTextureSmoothing,
  );
}

function saveTerrainTextureSmoothing(value: number, mode: BattleMode): void {
  writeModeSetting(mode, STORAGE_REAL_TERRAIN_TEXTURE_SMOOTHING, STORAGE_DEMO_TERRAIN_TEXTURE_SMOOTHING, String(normalizeTerrainTextureSmoothing(value)));
}

function loadStoredTerrainLightSmoothing(mode: BattleMode): number {
  return loadModeNumberOption(
    mode,
    STORAGE_REAL_TERRAIN_LIGHT_SMOOTHING,
    STORAGE_DEMO_TERRAIN_LIGHT_SMOOTHING,
    BATTLE_CONFIG.terrainLightSmoothing,
  );
}

function saveTerrainLightSmoothing(value: number, mode: BattleMode): void {
  writeModeSetting(mode, STORAGE_REAL_TERRAIN_LIGHT_SMOOTHING, STORAGE_DEMO_TERRAIN_LIGHT_SMOOTHING, String(normalizeTerrainLightSmoothing(value)));
}

function loadStoredTerrainTextureSmoothAcrossWallBoundary(
  mode: BattleMode,
): boolean {
  return loadModeBool(
    mode,
    STORAGE_REAL_TERRAIN_TEXTURE_SMOOTH_ACROSS_WALL_BOUNDARY,
    STORAGE_DEMO_TERRAIN_TEXTURE_SMOOTH_ACROSS_WALL_BOUNDARY,
    BATTLE_CONFIG.terrainTextureSmoothAcrossWallBoundary.default,
  );
}

function saveTerrainTextureSmoothAcrossWallBoundary(
  enabled: boolean,
  mode: BattleMode,
): void {
  writeModeSetting(mode, STORAGE_REAL_TERRAIN_TEXTURE_SMOOTH_ACROSS_WALL_BOUNDARY, STORAGE_DEMO_TERRAIN_TEXTURE_SMOOTH_ACROSS_WALL_BOUNDARY, String(enabled));
}

function loadStoredTerrainLightSmoothAcrossWallBoundary(
  mode: BattleMode,
): boolean {
  return loadModeBool(
    mode,
    STORAGE_REAL_TERRAIN_LIGHT_SMOOTH_ACROSS_WALL_BOUNDARY,
    STORAGE_DEMO_TERRAIN_LIGHT_SMOOTH_ACROSS_WALL_BOUNDARY,
    BATTLE_CONFIG.terrainLightSmoothAcrossWallBoundary.default,
  );
}

function saveTerrainLightSmoothAcrossWallBoundary(
  enabled: boolean,
  mode: BattleMode,
): void {
  writeModeSetting(mode, STORAGE_REAL_TERRAIN_LIGHT_SMOOTH_ACROSS_WALL_BOUNDARY, STORAGE_DEMO_TERRAIN_LIGHT_SMOOTH_ACROSS_WALL_BOUNDARY, String(enabled));
}

function loadStoredTerrainSplitWallBoundaryVertices(
  mode: BattleMode,
): boolean {
  return loadModeBool(
    mode,
    STORAGE_REAL_TERRAIN_SPLIT_WALL_BOUNDARY_VERTICES,
    STORAGE_DEMO_TERRAIN_SPLIT_WALL_BOUNDARY_VERTICES,
    BATTLE_CONFIG.terrainSplitWallBoundaryVertices.default,
  );
}

function saveTerrainSplitWallBoundaryVertices(
  enabled: boolean,
  mode: BattleMode,
): void {
  writeModeSetting(mode, STORAGE_REAL_TERRAIN_SPLIT_WALL_BOUNDARY_VERTICES, STORAGE_DEMO_TERRAIN_SPLIT_WALL_BOUNDARY_VERTICES, String(enabled));
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
    ringMagnitude: loadStoredRingMagnitude(mode),
    dividersMagnitude: loadStoredDividersMagnitude(mode),
    perimeterMagnitude: loadStoredPerimeterMagnitude(mode),
    terrainPrecedence: loadStoredTerrainPrecedence(mode),
    terrainDTerrain: loadStoredTerrainDTerrain(mode),
    plateauWallSlopeDegrees: loadStoredPlateauWallSlopeDegrees(mode),
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
  refreshDemoRosterLedgers();
  const width = parseMapLandCellAxis(
    readModeSetting(mode, STORAGE_REAL_MAP_WIDTH_LAND_CELLS, STORAGE_DEMO_MAP_WIDTH_LAND_CELLS),
    'width',
  );
  const length = parseMapLandCellAxis(
    readModeSetting(mode, STORAGE_REAL_MAP_LENGTH_LAND_CELLS, STORAGE_DEMO_MAP_LENGTH_LAND_CELLS),
    'length',
  );
  // Both axes or neither — a half-stored pair is not a map size.
  if (width !== null && length !== null) return { widthLandCells: width, lengthLandCells: length };
  return getModeDefaultMapLandDimensions(mode);
}

export function saveMapLandDimensions(
  dimensions: MapLandCellDimensions,
  mode: BattleMode,
): void {
  const normalized = normalizeMapLandDimensions(dimensions);
  writeModeSetting(
    mode,
    STORAGE_REAL_MAP_WIDTH_LAND_CELLS,
    STORAGE_DEMO_MAP_WIDTH_LAND_CELLS,
    String(normalized.widthLandCells),
  );
  writeModeSetting(
    mode,
    STORAGE_REAL_MAP_LENGTH_LAND_CELLS,
    STORAGE_DEMO_MAP_LENGTH_LAND_CELLS,
    String(normalized.lengthLandCells),
  );
}
