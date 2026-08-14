import { BUILDABLE_UNIT_BLUEPRINT_IDS } from '../game/sim/blueprints/unitRoster';
import { BUILDING_BLUEPRINT_IDS } from '../types/blueprintIds';
import type { BattleMode } from '../battleBarConfig';
import { persist } from '../persistence';
import type { ShieldReflectionMode } from '../types/shotTypes';
import type { SlopePathMode } from '../types/slopePathMode';
import type {
  LiquidSurfaceMode,
  TerrainSurfaceMode,
} from '../types/worldSurfaceMode';
import { LAND_CELL_SIZE } from '../mapSizeConfig';

export type BattlePreset = {
  readonly name: string;
  /** Generated four-layer panorama set for this authored map. Keeping it on
   *  the preset removes the second name-to-background registry. */
  readonly backdropSlug: string;
  readonly units: readonly string[];
  /** Enabled building blueprints (BUILDINGS bar group). Every preset
   *  ships with all buildings on; the field exists so DEFAULTS / preset
   *  selection resets structure toggles and the active-preset highlight
   *  accounts for them, mirroring `units`. */
  readonly buildings: readonly string[];
  readonly cap: number;
  readonly turretShieldPanelsEnabled: boolean;
  readonly turretShieldSpheresEnabled: boolean;
  readonly forceFieldsVisible: boolean;
  readonly shieldReflectionMode: ShieldReflectionMode;
  readonly fogOfWarEnabled: boolean;
  /** Apply velocity-aware braking near the last point of the last action. */
  readonly slowDownAtFinalWaypoint: boolean;
  /** Ground pathfinding slope policy (SLOPE LIMIT bar toggle). */
  readonly slopePathMode: SlopePathMode;
  /** Ground material policy (WORLD bar group). `metal` makes the whole map
   *  one ore body — see types/worldSurfaceMode. */
  readonly terrainSurfaceMode: TerrainSurfaceMode;
  /** What fills the map below the water level (WORLD bar group). */
  readonly liquidSurfaceMode: LiquidSurfaceMode;
  readonly converterTax: number;
  readonly centerMagnitude: number;
  readonly dividersMagnitude: number;
  /** Signed PERIMETER ring altitude. 0 = flat square; negative sinks the
   *  outer ring below water (round-island); positive raises a rim. */
  readonly perimeterMagnitude: number;
  readonly terrainDTerrain: number;
  readonly plateauWallSlopeDegrees: number;
  readonly metalDepositStep: number;
  /** Fine-triangle subdivisions per land cell. 0 = off, which the
   *  terrain baker clamps to one triangle edge subdivision per cell.
   *  Drives `TERRAIN_FINE_TRIANGLE_SUBDIV`. */
  readonly terrainDetail: number;
  readonly mapWidthLandCells: number;
  readonly mapLengthLandCells: number;
};

export type BattlePresetSnapshot = Omit<
  BattlePreset,
  | 'name'
  | 'backdropSlug'
  | 'turretShieldPanelsEnabled'
  | 'turretShieldSpheresEnabled'
  | 'forceFieldsVisible'
  | 'shieldReflectionMode'
  | 'fogOfWarEnabled'
>;

const MODE_DEFAULT_PRESET_NAMES: Record<BattleMode, string> = {
  demo: 'Angels Flat',
  real: 'Angels Flat',
};

function allUnits(): readonly string[] {
  return BUILDABLE_UNIT_BLUEPRINT_IDS;
}
function allBuildings(): readonly string[] {
  return BUILDING_BLUEPRINT_IDS;
}

// Shared subsystem toggles that historically lived as inline
// BATTLE_CONFIG defaults. Folding them into the presets means every
// battle bar fallback flows through a preset — the JSON has zero
// inline defaults.
const SUBSYSTEM_DEFAULTS = {
  turretShieldPanelsEnabled: true,
  turretShieldSpheresEnabled: true,
  forceFieldsVisible: true,
  shieldReflectionMode: 'both' as ShieldReflectionMode,
  // BAR-style full-speed arrival is the default; the BATTLE toggle opts into
  // the smoother velocity-aware final approach.
  slowDownAtFinalWaypoint: false,
  slopePathMode: 'directional' as SlopePathMode,
  // Every stock preset ships the authored world; only METAL HELL flips these.
  terrainSurfaceMode: 'normal' as TerrainSurfaceMode,
  liquidSurfaceMode: 'water' as LiquidSurfaceMode,
};

// Every preset enables all buildings — there is no preset that ships with
// static hosts disabled. Spread into each literal so the structure field
// stays in one place (mirrors SUBSYSTEM_DEFAULTS).
const STRUCTURE_DEFAULTS = {
  buildings: allBuildings(),
};

function buildPresets(): readonly BattlePreset[] {
  return [
    {
      name: 'Large Circle',
      backdropSlug: 'large-circle',
      units: allUnits(),
      cap: 81,
      ...SUBSYSTEM_DEFAULTS,
      ...STRUCTURE_DEFAULTS,
      fogOfWarEnabled: true,
      converterTax: 0.5,
      centerMagnitude: 0,
      dividersMagnitude: 0,
      perimeterMagnitude: -400,
      terrainDTerrain: 0,
      plateauWallSlopeDegrees: 89,
      metalDepositStep: 0,
      terrainDetail: 4,
      mapWidthLandCells: 119,
      mapLengthLandCells: 119,
    },
    {
      name: 'Angels Flat',
      backdropSlug: 'angels-flat',
      units: allUnits(),
      cap: 81,
      ...SUBSYSTEM_DEFAULTS,
      ...STRUCTURE_DEFAULTS,
      fogOfWarEnabled: true,
      converterTax: 0.5,
      centerMagnitude: 0,
      dividersMagnitude: 800,
      perimeterMagnitude: -400,
      terrainDTerrain: 400,
      plateauWallSlopeDegrees: 89,
      metalDepositStep: 0,
      terrainDetail: 4,
      mapWidthLandCells: 79,
      mapLengthLandCells: 79,
    },
    {
      name: 'Boulder Mountain',
      backdropSlug: 'boulder-mountain',
      units: allUnits(),
      cap: 81,
      ...SUBSYSTEM_DEFAULTS,
      ...STRUCTURE_DEFAULTS,
      fogOfWarEnabled: true,
      converterTax: 0.5,
      centerMagnitude: 1600,
      dividersMagnitude: 800,
      perimeterMagnitude: -200,
      terrainDTerrain: 0,
      plateauWallSlopeDegrees: 89,
      metalDepositStep: 400,
      terrainDetail: 4,
      mapWidthLandCells: 119,
      mapLengthLandCells: 119,
    },
    {
      name: 'Spikey Lake',
      backdropSlug: 'spikey-lake',
      units: allUnits(),
      cap: 81,
      ...SUBSYSTEM_DEFAULTS,
      ...STRUCTURE_DEFAULTS,
      fogOfWarEnabled: true,
      converterTax: 0.5,
      centerMagnitude: -400,
      dividersMagnitude: 1600,
      perimeterMagnitude: -200,
      terrainDTerrain: 0,
      plateauWallSlopeDegrees: 89,
      metalDepositStep: 200,
      terrainDetail: 4,
      mapWidthLandCells: 53,
      mapLengthLandCells: 53,
    },
    {
      name: 'Nemo Island',
      backdropSlug: 'niemo-islands',
      units: allUnits(),
      cap: 81,
      ...SUBSYSTEM_DEFAULTS,
      ...STRUCTURE_DEFAULTS,
      fogOfWarEnabled: true,
      converterTax: 0.5,
      centerMagnitude: 200,
      dividersMagnitude: -3200,
      perimeterMagnitude: -400,
      terrainDTerrain: 0,
      plateauWallSlopeDegrees: 89,
      metalDepositStep: 200,
      terrainDetail: 4,
      mapWidthLandCells: 79,
      mapLengthLandCells: 79,
    },
    {
      name: 'Angels Playhouse',
      backdropSlug: 'angels-playhouse',
      units: allUnits(),
      cap: 81,
      ...SUBSYSTEM_DEFAULTS,
      ...STRUCTURE_DEFAULTS,
      fogOfWarEnabled: true,
      converterTax: 0.5,
      centerMagnitude: 6400,
      dividersMagnitude: 6400,
      perimeterMagnitude: -400,
      terrainDTerrain: 800,
      plateauWallSlopeDegrees: 89,
      metalDepositStep: 3200,
      terrainDetail: 4,
      mapWidthLandCells: 79,
      mapLengthLandCells: 79,
    },
    {
      name: 'METAL HELL',
      backdropSlug: 'metal-hell',
      units: allUnits(),
      cap: 81,
      ...SUBSYSTEM_DEFAULTS,
      ...STRUCTURE_DEFAULTS,
      terrainSurfaceMode: 'metal',
      liquidSurfaceMode: 'lava',
      fogOfWarEnabled: true,
      converterTax: 0.5,
      centerMagnitude: 0,
      dividersMagnitude: -400,
      perimeterMagnitude: -400,
      terrainDTerrain: 0,
      plateauWallSlopeDegrees: 89,
      metalDepositStep: 200,
      terrainDetail: 4,
      mapWidthLandCells: 79,
      mapLengthLandCells: 79,
    },
    {
      name: 'METAL PLATE',
      backdropSlug: 'metal-plate',
      units: allUnits(),
      cap: 81,
      ...SUBSYSTEM_DEFAULTS,
      ...STRUCTURE_DEFAULTS,
      terrainSurfaceMode: 'metal',
      liquidSurfaceMode: 'water',
      fogOfWarEnabled: true,
      converterTax: 0.5,
      centerMagnitude: 0,
      dividersMagnitude: 0,
      perimeterMagnitude: 0,
      terrainDTerrain: 0,
      plateauWallSlopeDegrees: 89,
      metalDepositStep: 0,
      terrainDetail: 1,
      mapWidthLandCells: 79,
      mapLengthLandCells: 79,
    },
  ];
}

export const BATTLE_PRESETS: readonly BattlePreset[] = buildPresets();

const STORAGE_SELECTED_PRESET = 'battle-selected-preset';

/** Resolve the preset that supplies the default values for a given
 *  battle mode. Every DEMO BATTLE / REAL BATTLE bar default — cap,
 *  fog of war, terrain, bar collapse — flows through
 *  the preset returned here. The bars own no inline defaults. */
export function getModeDefaultPreset(mode: BattleMode): BattlePreset {
  const name = MODE_DEFAULT_PRESET_NAMES[mode];
  const found = BATTLE_PRESETS.find((p) => p.name === name);
  if (!found) {
    throw new Error(`Missing battle mode default preset: ${name}`);
  }
  return found;
}

export function saveSelectedPresetName(name: string): void {
  persist(STORAGE_SELECTED_PRESET, name);
}

function sameUnits(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  for (const x of b) if (!setA.has(x)) return false;
  return true;
}

function presetMatchesCurrent(
  p: BattlePreset,
  c: BattlePresetSnapshot,
): boolean {
  // Fog of war is intentionally excluded: the lobby forces it off and the
  // real battle forces it on. The shield panel/reflection defaults that have
  // no live preset control are excluded too. Every user-controllable
  // map/gameplay field is compared.
  return (
    sameUnits(p.units, c.units) &&
    sameUnits(p.buildings, c.buildings) &&
    p.cap === c.cap &&
    p.terrainSurfaceMode === c.terrainSurfaceMode &&
    p.liquidSurfaceMode === c.liquidSurfaceMode &&
    p.slowDownAtFinalWaypoint === c.slowDownAtFinalWaypoint &&
    p.slopePathMode === c.slopePathMode &&
    Math.abs(p.converterTax - c.converterTax) < 1e-6 &&
    p.centerMagnitude === c.centerMagnitude &&
    p.dividersMagnitude === c.dividersMagnitude &&
    p.perimeterMagnitude === c.perimeterMagnitude &&
    p.terrainDTerrain === c.terrainDTerrain &&
    p.plateauWallSlopeDegrees === c.plateauWallSlopeDegrees &&
    p.metalDepositStep === c.metalDepositStep &&
    p.terrainDetail === c.terrainDetail &&
    p.mapWidthLandCells === c.mapWidthLandCells &&
    p.mapLengthLandCells === c.mapLengthLandCells
  );
}

export type BattleMapPresentation = {
  /** Exact stock match, or null when any map/gameplay setting is custom. */
  readonly presetName: string | null;
  /** Only exact stock matches receive the preset's special panorama. */
  readonly backdropPresetName: string | null;
  /** The ground sign is always present and always describes current values. */
  readonly labelLines: readonly string[];
};

function formatTerrainMagnitude(value: number): string {
  return value === 0 ? 'NONE' : String(value);
}

/** Resolve the complete map presentation once from the current settings.
 *  Custom maps retain the useful sign but use the neutral default backdrop. */
export function resolveBattleMapPresentation(
  current: BattlePresetSnapshot,
): BattleMapPresentation {
  const presetName = findMatchingPresetName(current);
  const terrain = current.terrainSurfaceMode === 'metal'
    ? 'METAL TERRAIN'
    : 'NORMAL TERRAIN';
  const liquid = current.liquidSurfaceMode === 'lava' ? 'LAVA' : 'WATER';
  const worldWidth = current.mapWidthLandCells * LAND_CELL_SIZE;
  const worldLength = current.mapLengthLandCells * LAND_CELL_SIZE;
  const labelLines = [
    presetName?.toUpperCase() ?? 'CUSTOM',
    `${current.mapWidthLandCells} × ${current.mapLengthLandCells} LAND CELLS`
      + `  ·  ${worldWidth} × ${worldLength} WORLD`,
    `${current.cap} UNIT CAP  ·  ${terrain}  ·  ${liquid}`,
    `CENTER ${formatTerrainMagnitude(current.centerMagnitude)}`
      + `  ·  DIVIDERS ${formatTerrainMagnitude(current.dividersMagnitude)}`
      + `  ·  PERIMETER ${formatTerrainMagnitude(current.perimeterMagnitude)}`,
    `D-TERRAIN ${formatTerrainMagnitude(current.terrainDTerrain)}`
      + `  ·  METAL STEP ${formatTerrainMagnitude(current.metalDepositStep)}`
      + `  ·  DETAIL ${current.terrainDetail}`,
  ];
  return {
    presetName,
    backdropPresetName: presetName,
    labelLines,
  };
}

export function findMatchingPresetName(c: BattlePresetSnapshot): string | null {
  for (const p of BATTLE_PRESETS) {
    if (presetMatchesCurrent(p, c)) return p.name;
  }
  return null;
}
