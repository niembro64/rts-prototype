import { BATTLE_CONFIG } from '../../../battleBarConfig';
import { LAND_CELL_SIZE } from '../../../mapSizeConfig';
import terrainConfig from './terrainConfig.json';

/** Floor of the world's vertical extent: the bottom face of every 3D tile. */
export const TILE_FLOOR_Y = terrainConfig.tileFloorY;

/** Water surface position between TILE_FLOOR_Y and ground level 0. */
export const WATER_LEVEL_FRACTION = terrainConfig.waterLevelFraction;
export const WATER_LEVEL = TILE_FLOOR_Y * (1 - WATER_LEVEL_FRACTION);

// Host sim, client prediction, and terrain rendering share this exact mesh.
// This is the finest equilateral-triangle edge resolution relative to
// LAND_CELL_SIZE. The baker groups fine triangles upward into larger
// authoritative triangles where error allows.
export const TERRAIN_FINE_TRIANGLE_SUBDIV = terrainConfig.terrainFineTriangleSubdiv;

/** Maximum perpendicular deviation, in world units, allowed when a terrain
 *  triangle is collapsed to a lower subdivision. Measuring error against the
 *  candidate plane, rather than only in world-Z height, lets steep-but-planar
 *  terrain simplify without top-down projection bias. */
export const TERRAIN_TRIANGLE_MAX_SURFACE_ERROR =
  terrainConfig.terrainTriangleMaxSurfaceError;

/** @deprecated Use TERRAIN_TRIANGLE_MAX_SURFACE_ERROR. The collapse check now
 *  measures perpendicular surface error instead of world-Z height error. */
export const TERRAIN_TRIANGLE_MAX_HEIGHT_ERROR = TERRAIN_TRIANGLE_MAX_SURFACE_ERROR;

/** Maximum source-surface normal divergence allowed inside a collapsed
 *  triangle. This catches curved terrain whose sampled points happen to stay
 *  within the positional error tolerance. */
export const TERRAIN_TRIANGLE_MAX_NORMAL_ANGLE_DEGREES =
  terrainConfig.terrainTriangleMaxNormalAngleDegrees;
export const TERRAIN_TRIANGLE_MIN_NORMAL_DOT = Math.cos(
  Math.max(0, Math.min(180, TERRAIN_TRIANGLE_MAX_NORMAL_ANGLE_DEGREES)) *
    Math.PI / 180,
);

/** Maximum hierarchy-level delta allowed across touching triangle edges.
 *  `1` gives a 2:1 balanced transition band around high-detail terrain. */
export const TERRAIN_TRIANGLE_MAX_NEIGHBOR_LEVEL_DELTA =
  terrainConfig.terrainTriangleMaxNeighborLevelDelta;

/** Hard cap for final mesh edge repair. Keeps terrain startup bounded even
 *  when a pathological map generates many transition edges. */
export const TERRAIN_TRIANGLE_FINAL_REPAIR_MAX_PASSES =
  terrainConfig.terrainTriangleFinalRepairMaxPasses;

/** Extra error sample at a triangle centroid catches peaks or valleys that do
 *  not land on the fine lattice points for that candidate triangle. */
export const TERRAIN_TRIANGLE_SAMPLE_CENTROID =
  terrainConfig.terrainTriangleSampleCentroid;

/** Never collapse a candidate triangle if the simplified plane moves the
 *  waterline classification of any checked point. */
export const TERRAIN_TRIANGLE_PRESERVE_WATERLINE =
  terrainConfig.terrainTrianglePreserveWaterline;

/** World-space vertex de-duplication precision for clipped triangle borders. */
export const TERRAIN_TRIANGLE_VERTEX_KEY_SCALE =
  terrainConfig.terrainTriangleVertexKeyScale;

/** Render-only "solid ocean" mode. When true:
 *    (a) `WaterRenderer3D` draws the ocean surface fully opaque
 *        (transparency disabled, depth writes on), and
 *    (b) `TerrainTileRenderer3D` culls triangles whose three vertices
 *        all sit at or below `WATER_LEVEL` — they would be invisible
 *        through the opaque water anyway, so neither their indices nor
 *        their vertices are uploaded to the GPU. Shoreline triangles
 *        (any vertex above water) are still drawn.
 *  The authoritative mesh — used by the sim for height queries, unit
 *  grounding, and pathing — is untouched. */
export const WATER_FULLY_OPAQUE = terrainConfig.waterFullyOpaque;

export type TerrainRuntimeConfig = {
  /** Plateau intensity 0..5 — 0 disables terracing entirely (perfectly
   *  smooth surface); higher values progressively admit steeper slopes
   *  into the terraced set, with 5 forcing every slope (including
   *  cliffs) into discrete TERRAIN_D_TERRAIN levels. */
  plateauAmount: number;
  /** Signed altitude of the central ripple (CENTER bar). */
  centerMagnitude: number;
  /** Signed altitude of the team-separator ridges (DIVIDERS bar). */
  dividersMagnitude: number;
  terrainDTerrain: number;
};

/** Currently-installed signed CENTER amplitude (matches the active
 *  battle's CENTER bar pick). The actual terrain heightmap reads this
 *  directly — sign decides ripple polarity, magnitude decides height. */
export let TERRAIN_CENTER_MAGNITUDE = BATTLE_CONFIG.centerMagnitude.default;
/** Currently-installed signed DIVIDERS amplitude. */
export let TERRAIN_DIVIDERS_MAGNITUDE = BATTLE_CONFIG.dividersMagnitude.default;

/** Conservative upper bound on terrain heights — both ripples can
 *  stack at their intersection, so use the sum of absolute amplitudes
 *  doubled to match the prior "magnitude × 2" headroom convention. */
function computeTerrainMaxRenderY(
  centerMag: number,
  dividersMag: number,
): number {
  return Math.abs(centerMag) + Math.abs(dividersMag);
}
export let TERRAIN_MAX_RENDER_Y = computeTerrainMaxRenderY(
  TERRAIN_CENTER_MAGNITUDE,
  TERRAIN_DIVIDERS_MAGNITUDE,
);

/** Vertical spacing between authored terrain plateau levels. */
export let TERRAIN_D_TERRAIN = BATTLE_CONFIG.terrainDTerrain.default;

export const TERRAIN_CIRCLE_PERIMETER_EDGE_FRACTION =
  terrainConfig.terrainCirclePerimeterEdgeFraction;
export const TERRAIN_CIRCLE_PERIMETER_TRANSITION_WIDTH_FRACTION =
  terrainConfig.terrainCirclePerimeterTransitionWidthFraction;
export let TERRAIN_CIRCLE_UNDERWATER_HEIGHT = WATER_LEVEL - TERRAIN_D_TERRAIN;

/** Fade authored terrain features to flat before the outer map buffer. */
export const TERRAIN_GENERATION_EDGE_TRANSITION_WIDTH_FRACTION =
  terrainConfig.terrainGenerationEdgeTransitionWidthFraction;

/** Slope window for a given plateau amount. Amount 0 disables
 *  terracing entirely; the caller short-circuits on `amount <= 0`.
 *  Higher amounts open the slope window wider so steeper terrain
 *  starts to terrace; amount 5 forces every slope into a plateau by
 *  pushing the gate beyond any realistic slope value (cliffs). */
function plateauSlopeWindowForAmount(amount: number): {
  fullTerraceMaxSlope: number;
  noTerraceMinSlope: number;
} {
  if (amount >= 5) {
    return {
      fullTerraceMaxSlope: Number.POSITIVE_INFINITY,
      noTerraceMinSlope: Number.POSITIVE_INFINITY,
    };
  }
  // Per-level full-terrace ceilings — chosen so amount 1 only
  // terraces nearly-flat ground and amount 4 catches most slopes
  // short of cliffs. Amount 3 matches the prior PLATEAU: ON default
  // (0.45 / 0.9) for visual continuity with old maps.
  const fullByAmount = [0, 0.1, 0.25, 0.45, 0.8];
  const fadeByAmount = [0, 0.1, 0.2, 0.45, 0.6];
  const idx = Math.max(0, Math.min(fullByAmount.length - 1, Math.floor(amount)));
  const full = fullByAmount[idx];
  const fade = fadeByAmount[idx];
  return {
    fullTerraceMaxSlope: full,
    noTerraceMinSlope: full + Math.max(1e-6, fade),
  };
}

const DEFAULT_PLATEAU_SLOPE_WINDOW = plateauSlopeWindowForAmount(
  BATTLE_CONFIG.plateau.amount.default,
);

export const TERRAIN_PLATEAU_CONFIG: {
  /** Plateau intensity 0..5; 0 disables terracing entirely. */
  amount: number;
  readonly shelfFractionOfStep: number;
  readonly rampEdgeSharpness: number;
  readonly buildableShelfHeightTolerance: number;
  readonly slopeSampleDistance: number;
  /** Derived from `amount` — see plateauSlopeWindowForAmount. */
  fullTerraceMaxSlope: number;
  /** Derived from `amount`. */
  noTerraceMinSlope: number;
} = {
  amount: BATTLE_CONFIG.plateau.amount.default,
  shelfFractionOfStep: terrainConfig.plateau.shelfFractionOfStep,
  rampEdgeSharpness: terrainConfig.plateau.rampEdgeSharpness,
  buildableShelfHeightTolerance: terrainConfig.plateau.buildableShelfHeightTolerance,
  slopeSampleDistance:
    LAND_CELL_SIZE * terrainConfig.plateau.slopeSampleDistanceLandCellMultiplier,
  fullTerraceMaxSlope: DEFAULT_PLATEAU_SLOPE_WINDOW.fullTerraceMaxSlope,
  noTerraceMinSlope: DEFAULT_PLATEAU_SLOPE_WINDOW.noTerraceMinSlope,
};

export function applyTerrainRuntimeConfig(config: TerrainRuntimeConfig): boolean {
  let changed = false;
  if (TERRAIN_CENTER_MAGNITUDE !== config.centerMagnitude) {
    TERRAIN_CENTER_MAGNITUDE = config.centerMagnitude;
    changed = true;
  }
  if (TERRAIN_DIVIDERS_MAGNITUDE !== config.dividersMagnitude) {
    TERRAIN_DIVIDERS_MAGNITUDE = config.dividersMagnitude;
    changed = true;
  }
  if (changed) {
    TERRAIN_MAX_RENDER_Y = computeTerrainMaxRenderY(
      TERRAIN_CENTER_MAGNITUDE,
      TERRAIN_DIVIDERS_MAGNITUDE,
    );
  }

  const nextDTerrain = Math.max(0, config.terrainDTerrain);
  if (TERRAIN_D_TERRAIN !== nextDTerrain) {
    TERRAIN_D_TERRAIN = nextDTerrain;
    TERRAIN_CIRCLE_UNDERWATER_HEIGHT = WATER_LEVEL - TERRAIN_D_TERRAIN;
    changed = true;
  }

  const nextAmount = Math.max(0, Math.floor(config.plateauAmount));
  if (TERRAIN_PLATEAU_CONFIG.amount !== nextAmount) {
    TERRAIN_PLATEAU_CONFIG.amount = nextAmount;
    const window = plateauSlopeWindowForAmount(nextAmount);
    TERRAIN_PLATEAU_CONFIG.fullTerraceMaxSlope = window.fullTerraceMaxSlope;
    TERRAIN_PLATEAU_CONFIG.noTerraceMinSlope = window.noTerraceMinSlope;
    changed = true;
  }

  return changed;
}

/** Three summed wave components form the central mountain ripple.
 *  Each carries its own wavelength and magnitude (the per-component
 *  weight in the sum, normalized to [0,1] before being scaled by the
 *  global mountain ripple amplitude). The component formulas differ
 *  in shape — see `getGeneratedNaturalTerrainHeight` — so wavelength
 *  means slightly different things per component, but magnitude is
 *  uniformly the relative weight. */
export const TERRAIN_RIPPLE_CONFIG = {
  radiusFraction: terrainConfig.ripple.radiusFraction,
  phase: terrainConfig.ripple.phase,
  components: terrainConfig.ripple.components,
} as const;

export const TERRAIN_RIDGE_CONFIG = {
  innerRadiusFraction: terrainConfig.ridge.innerRadiusFraction,
  outerRadiusFraction: terrainConfig.ridge.outerRadiusFraction,
  halfWidthFraction: terrainConfig.ridge.halfWidthFraction,
} as const;
