import type { BattleMode } from '../battleBarConfig';
import type { ShieldReflectionMode } from '../types/shotTypes';
import type { SlopePathMode } from '../types/slopePathMode';
import type { TerrainPrecedence } from '../types/terrainPrecedence';
import {
  METAL_COVERAGE_LABEL,
  type LiquidSurfaceMode,
  type MetalCoverage,
} from '../types/worldSurfaceMode';
import { LAND_CELL_SIZE } from '../mapSizeConfig';
import { AUTHOR_BYLINE } from '../authorBylineConfig';
import type { MapPresetLabelCaption } from '../game/render3d/presetMapLabel';
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
  /** Signed CENTER dome/dish altitude at the exact map centre. */
  readonly centerMagnitude: number;
  /** Signed RING annulus crest altitude (0 = no ring). */
  readonly ringMagnitude: number;
  readonly dividersMagnitude: number;
  /** Signed PERIMETER ring altitude: negative sinks the outer ring below
   *  water (round-island), positive raises a rim, 0 flattens it to ground
   *  level. */
  readonly perimeterMagnitude: number;
  /** Which of DIVIDERS/PERIMETER applies last in terrain generation
   *  (PRECEDENCE bar) — last wins where they overlap. */
  readonly terrainPrecedence: TerrainPrecedence;
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
      name: 'LAND PLATE',
      backdropSlug: 'large-circle',
      ...SUBSYSTEM_DEFAULTS,
      fogOfWarEnabled: true,
      converterTax: 0.5,
      centerMagnitude: 0,
      ringMagnitude: 0,
      dividersMagnitude: 0,
      perimeterMagnitude: 0,
      terrainPrecedence: 'perimeter-precedence',
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
      ringMagnitude: 0,
      dividersMagnitude: 800,
      perimeterMagnitude: -400,
      terrainPrecedence: 'perimeter-precedence',
      terrainDTerrain: 400,
      plateauWallSlopeDegrees: 70,
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
      ringMagnitude: 0,
      dividersMagnitude: 800,
      perimeterMagnitude: -200,
      terrainPrecedence: 'dividers-precedence',
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
      ringMagnitude: 0,
      dividersMagnitude: 1600,
      perimeterMagnitude: 200,
      terrainPrecedence: 'perimeter-precedence',
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
      ringMagnitude: 0,
      dividersMagnitude: -3200,
      perimeterMagnitude: -400,
      terrainPrecedence: 'dividers-precedence',
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
      centerMagnitude: 1600,
      ringMagnitude: 0,
      dividersMagnitude: 6400,
      perimeterMagnitude: -400,
      terrainPrecedence: 'perimeter-precedence',
      terrainDTerrain: 800,
      plateauWallSlopeDegrees: 89,
      metalDepositStep: -800,
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
      ringMagnitude: 200,
      dividersMagnitude: -400,
      perimeterMagnitude: -400,
      terrainPrecedence: 'perimeter-precedence',
      terrainDTerrain: 0,
      plateauWallSlopeDegrees: 89,
      metalDepositStep: 200,
      terrainDetail: 4,
      mapWidthLandCells: 119,
      mapLengthLandCells: 119,
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
      ringMagnitude: 0,
      dividersMagnitude: 0,
      // The plate is flat at 0 everywhere, so a ground-level ring is the
      // same surface the old "no ring" pick produced.
      perimeterMagnitude: 0,
      terrainPrecedence: 'perimeter-precedence',
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
    p.ringMagnitude === c.ringMagnitude &&
    p.dividersMagnitude === c.dividersMagnitude &&
    p.perimeterMagnitude === c.perimeterMagnitude &&
    p.terrainPrecedence === c.terrainPrecedence &&
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
  readonly labelCaption: NonNullable<MapPresetLabelCaption>;
};

function formatTerrainMagnitude(value: number): string {
  return value === 0 ? 'NONE' : String(value);
}

/** PERIMETER prints 0 as 0 rather than NONE because a ground-level ring is
 *  a real (and visibly different) map shape. */
function formatPerimeterMagnitude(value: number): string {
  return String(value);
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
  // ONE FIELD PER ENTRY, not one row. How many share a row is a typographic
  // decision about the headland the sign has to fill, and the painter makes
  // it: fixing the rows here fixes the block's shape, and a block whose shape
  // does not match the table cannot be inset by the same gap on all four
  // sides at any size — see resolveMapPresetLabelPlacement.
  const labelCaption = {
    title: presetName?.toUpperCase() ?? 'CUSTOM',
    info: [
      `${current.mapWidthLandCells} × ${current.mapLengthLandCells} LAND CELLS`,
      `${worldWidth} × ${worldLength} WORLD`,
      `${current.cap} ENTITY CAP`,
      terrain,
      liquid,
      `CENTER ${formatTerrainMagnitude(current.centerMagnitude)}`,
      `RING ${formatTerrainMagnitude(current.ringMagnitude)}`,
      `DIVIDERS ${formatTerrainMagnitude(current.dividersMagnitude)}`,
      `PERIMETER ${formatPerimeterMagnitude(current.perimeterMagnitude)}`,
      `PRECEDENCE ${current.terrainPrecedence === 'dividers-precedence' ? 'DIVIDERS' : 'PERIMETER'}`,
      `D-TERRAIN ${formatTerrainMagnitude(current.terrainDTerrain)}`,
      `METAL STEP ${formatTerrainMagnitude(current.metalDepositStep)}`,
      `DETAIL ${current.terrainDetail}`,
    ],
    byline: [AUTHOR_BYLINE.siteUrl, AUTHOR_BYLINE.email],
  };
  return {
    presetName,
    backdropPresetName: presetName,
    labelCaption,
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
