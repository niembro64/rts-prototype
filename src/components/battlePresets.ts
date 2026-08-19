import type { BattleMode } from '../battleBarConfig';
import type { ShieldReflectionMode } from '../types/shotTypes';
import type { SlopePathMode } from '../types/slopePathMode';
import {
  METAL_COVERAGE_LABEL,
  type LiquidSurfaceMode,
  type MetalCoverage,
} from '../types/worldSurfaceMode';
import { LAND_CELL_SIZE } from '../mapSizeConfig';
import battleBarConfig from '../battleBarConfig.json';

export type BattlePreset = {
  readonly name: string;
  /** Generated four-layer panorama set for this authored map. Keeping it on
   *  the preset removes the second name-to-background registry. */
  readonly backdropSlug: string;
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
  readonly metalCoverage: MetalCoverage;
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
> & {
  /** DISPLAY ONLY. The entity count cap is a standalone global setting, not
   *  a map property: presets never carry one, applying a preset never
   *  changes it, and it takes no part in preset matching. The map caption
   *  prints it as live battle info. */
  readonly cap: number;
};

const MODE_DEFAULT_PRESET_NAMES: Record<BattleMode, string> = {
  demo: battleBarConfig.demoDefault,
  real: battleBarConfig.realDefault,
};

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
  metalCoverage: 'more' as MetalCoverage,
  liquidSurfaceMode: 'water' as LiquidSurfaceMode,
};

function buildPresets(): readonly BattlePreset[] {
  return [
    {
      name: 'Large Circle',
      backdropSlug: 'large-circle',
      ...SUBSYSTEM_DEFAULTS,
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
      ...SUBSYSTEM_DEFAULTS,
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
      ...SUBSYSTEM_DEFAULTS,
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
      ...SUBSYSTEM_DEFAULTS,
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
      ...SUBSYSTEM_DEFAULTS,
      fogOfWarEnabled: true,
      converterTax: 0.5,
      centerMagnitude: 200,
      dividersMagnitude: -3200,
      perimeterMagnitude: -800,
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
      ...SUBSYSTEM_DEFAULTS,
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
      ...SUBSYSTEM_DEFAULTS,
      metalCoverage: 'all',
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
      ...SUBSYSTEM_DEFAULTS,
      metalCoverage: 'all',
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

/** The authored map a battle mode starts on. Demo and real intentionally
 *  share it; they differ only in the entity count cap, which is a standalone
 *  setting (getModeDefaultEntityCountCap) rather than a preset field. */
export function getModeDefaultPreset(mode: BattleMode): BattlePreset {
  const name = MODE_DEFAULT_PRESET_NAMES[mode];
  const found = BATTLE_PRESETS.find((p) => p.name === name);
  if (!found) {
    throw new Error(`Missing battle mode default preset: ${name}`);
  }
  return found;
}

function presetMatchesCurrent(
  p: BattlePreset,
  c: BattlePresetSnapshot,
): boolean {
  // Fog of war is intentionally excluded: the lobby forces it off and the
  // real battle forces it on. The shield panel/reflection defaults that have
  // no live preset control are excluded too. The entity count cap is excluded
  // because it is not a map property — changing it must not flip the caption
  // to CUSTOM. Every other user-controllable map/gameplay field is compared.
  return (
    p.metalCoverage === c.metalCoverage &&
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

type BattleMapPresentation = {
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
  const terrain = `${METAL_COVERAGE_LABEL[current.metalCoverage]} METAL`;
  const liquid = current.liquidSurfaceMode === 'lava' ? 'LAVA' : 'WATER';
  const worldWidth = current.mapWidthLandCells * LAND_CELL_SIZE;
  const worldLength = current.mapLengthLandCells * LAND_CELL_SIZE;
  const labelLines = [
    presetName?.toUpperCase() ?? 'CUSTOM',
    `${current.mapWidthLandCells} × ${current.mapLengthLandCells} LAND CELLS`
      + `  ·  ${worldWidth} × ${worldLength} WORLD`,
    `${current.cap} ENTITY CAP  ·  ${terrain}  ·  ${liquid}`,
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

function findMatchingPresetName(c: BattlePresetSnapshot): string | null {
  for (const mode of ['demo', 'real'] as const) {
    const preset = getModeDefaultPreset(mode);
    if (presetMatchesCurrent(preset, c)) return preset.name;
  }
  for (const p of BATTLE_PRESETS) {
    if (presetMatchesCurrent(p, c)) return p.name;
  }
  return null;
}
