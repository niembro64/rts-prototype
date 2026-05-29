import { BATTLE_CONFIG } from '../../../battleBarConfig';
import terrainConfig from './terrainConfig.json';

/** Floor of the world's vertical extent: the bottom face of every 3D tile. */
export const TILE_FLOOR_Y = terrainConfig.world.floorY;

/** Water surface position between TILE_FLOOR_Y and ground level 0. */
export const WATER_LEVEL_FRACTION = terrainConfig.water.levelFraction;
export const WATER_LEVEL = TILE_FLOOR_Y * (1 - WATER_LEVEL_FRACTION);

// Host sim, client prediction, and terrain rendering share this exact mesh.
// This is the finest equilateral-triangle edge resolution relative to
// LAND_CELL_SIZE. The baker groups fine triangles upward into larger
// authoritative triangles where error allows. Lives as a `let` so the
// TERRAIN DETAIL battle bar can swap in a new value at battle start.
// Clamped to a minimum of 1 right here at the source — terrainTileMap
// divides land-cell size by this value and indexes from `subdiv - 1`,
// so a zero leaks into NaN coordinates and negative loop bounds. The
// picker's `0` option becomes 1 internally ("off" = one triangle per
// cell).
export let TERRAIN_FINE_TRIANGLE_SUBDIV = Math.max(
  1,
  Math.floor(BATTLE_CONFIG.terrainDetail.default),
);

/** Maximum perpendicular deviation, in world units, allowed when a terrain
 *  triangle is collapsed to a lower subdivision. Measuring error against the
 *  candidate plane, rather than only in world-Z height, lets steep-but-planar
 *  terrain simplify without top-down projection bias. */
export const TERRAIN_TRIANGLE_MAX_SURFACE_ERROR =
  terrainConfig.mesh.collapse.maxSurfaceError;

/** @deprecated Use TERRAIN_TRIANGLE_MAX_SURFACE_ERROR. The collapse check now
 *  measures perpendicular surface error instead of world-Z height error. */
export const TERRAIN_TRIANGLE_MAX_HEIGHT_ERROR = TERRAIN_TRIANGLE_MAX_SURFACE_ERROR;

/** Maximum source-surface normal divergence allowed inside a collapsed
 *  triangle. This catches curved terrain whose sampled points happen to stay
 *  within the positional error tolerance. */
export const TERRAIN_TRIANGLE_MAX_NORMAL_ANGLE_DEGREES =
  terrainConfig.mesh.collapse.maxNormalAngleDegrees;
export const TERRAIN_TRIANGLE_MIN_NORMAL_DOT = Math.cos(
  Math.max(0, Math.min(180, TERRAIN_TRIANGLE_MAX_NORMAL_ANGLE_DEGREES)) *
    Math.PI / 180,
);

/** Maximum hierarchy-level delta allowed across touching triangle edges.
 *  `1` gives a 2:1 balanced transition band around high-detail terrain. */
export const TERRAIN_TRIANGLE_MAX_NEIGHBOR_LEVEL_DELTA =
  terrainConfig.mesh.balance.maxNeighborLevelDelta;

/** Hard cap for final mesh edge repair. Keeps terrain startup bounded even
 *  when a pathological map generates many transition edges. */
export const TERRAIN_TRIANGLE_FINAL_REPAIR_MAX_PASSES =
  terrainConfig.mesh.balance.repairMaxPasses;

/** Extra error sample at a triangle centroid catches peaks or valleys that do
 *  not land on the fine lattice points for that candidate triangle. */
export const TERRAIN_TRIANGLE_SAMPLE_CENTROID =
  terrainConfig.mesh.collapse.sampleCentroid;

/** Never collapse a candidate triangle if the simplified plane moves the
 *  waterline classification of any checked point. */
export const TERRAIN_TRIANGLE_PRESERVE_WATERLINE =
  terrainConfig.mesh.collapse.preserveWaterline;

/** World-space vertex de-duplication precision for clipped triangle borders. */
export const TERRAIN_TRIANGLE_VERTEX_KEY_SCALE =
  terrainConfig.mesh.vertexKeyScale;

/** Post-bake Laplacian smoothing pass applied to mesh vertex heights at the
 *  very end of terrain generation, before the per-cell triangle index is
 *  built. Each step replaces every vertex's height with a blend toward the
 *  average of its triangle-edge neighbors. `maxSteps` = number of passes
 *  (0 disables smoothing). `amount` is the blend factor per pass in [0, 1]
 *  (0 = no change, 1 = fully replace with neighbor average). */
export const TERRAIN_MESH_HEIGHT_SMOOTHING: {
  readonly maxSteps: number;
  readonly amount: number;
} = {
  maxSteps: terrainConfig.mesh.heightSmoothing.maxSteps,
  amount: terrainConfig.mesh.heightSmoothing.amount,
};

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
export const WATER_FULLY_OPAQUE = terrainConfig.water.fullyOpaque;

export type TerrainRuntimeConfig = {
  /** Signed altitude of the central ripple (CENTER bar). */
  centerMagnitude: number;
  /** Signed altitude of the team-separator ridges (DIVIDERS bar). */
  dividersMagnitude: number;
  /** Plateau lattice step (D-PLATEAU bar). 0 = NONE (terracing
   *  disabled — the sim short-circuits on step <= 0). */
  terrainDTerrain: number;
  /** Metal-extractor pad altitude step (D-DEPOSIT bar). */
  metalDepositStep: number;
  /** Fine-triangle subdivisions per land cell (TERRAIN DETAIL bar).
   *  0 = off (the sim clamps to 1 = one triangle per cell). */
  terrainDetail: number;
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

/** Vertical spacing between authored terrain plateau levels. Drives
 *  plateau snapping in `applyTerrainPlateaus` and building-footprint
 *  level snapping in `terrainBuildability`. */
export let TERRAIN_D_TERRAIN = BATTLE_CONFIG.terrainDTerrain.default;

/** Vertical step (world units) between metal-extractor pad altitude
 *  levels. A deposit ring's `dTerrainLevels` is multiplied by this
 *  to get the pad's `height`. Independent from `TERRAIN_D_TERRAIN`
 *  so the deposit lattice can use a different step than the plateau
 *  lattice. */
export let METAL_DEPOSIT_STEP = BATTLE_CONFIG.metalDepositStep.default;

/** Round-island TERRAIN GENERATION shape (sim authority, circle maps only):
 *  the fraction of the map's smaller dimension at which the land has fully
 *  descended to the seabed floor (`TILE_FLOOR_Y`). Drives the height falloff
 *  in `getTerrainMapBoundaryFade` and the matching Rust sampler. This is NOT
 *  a coloring knob — the renderer's outer-ring color/fade is configured
 *  separately by `terrainHorizonBlend` in worldRenderConfig.json and
 *  `COLORS.world.terrain.horizonBlend`; the horizon blend merely reads this
 *  generation boundary so the color seam tracks the land→seabed handoff. */
export const TERRAIN_CIRCLE_ISLAND_RADIUS_FRACTION =
  terrainConfig.generation.circleIsland.radiusFraction;
/** Width (fraction of min dimension) of the shoreline falloff band just
 *  inside `TERRAIN_CIRCLE_ISLAND_RADIUS_FRACTION` over which land ramps down
 *  to the seabed. Generation shape, not coloring. */
export const TERRAIN_CIRCLE_SHORELINE_WIDTH_FRACTION =
  terrainConfig.generation.circleIsland.shorelineWidthFraction;

/** The terrain height outside the round island. Keep this at the world floor:
 *  water is a separate plane above it, so the island edge visibly descends
 *  through the waterline instead of flattening at the water surface. */
export const TERRAIN_CIRCLE_UNDERWATER_HEIGHT = TILE_FLOOR_Y;

/** Fade authored terrain features to flat before the outer map buffer. */
export const TERRAIN_GENERATION_EDGE_TRANSITION_WIDTH_FRACTION =
  terrainConfig.generation.edgeFadeWidthFraction;

/** Terracing is enabled iff `TERRAIN_D_TERRAIN > 0` (the D-PLATEAU bar
 *  picks `0` for the "NONE" option). The other fields here remain
 *  static authored shape knobs for the snapping curve. */
export const TERRAIN_PLATEAU_CONFIG: {
  readonly shelfFractionOfStep: number;
  readonly rampEdgeSharpness: number;
  readonly buildableShelfHeightTolerance: number;
} = {
  shelfFractionOfStep: terrainConfig.generation.plateau.shelfFractionOfStep,
  rampEdgeSharpness: terrainConfig.generation.plateau.rampEdgeSharpness,
  buildableShelfHeightTolerance: terrainConfig.generation.plateau.buildableShelfHeightTolerance,
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
    changed = true;
  }

  const nextDepositStep = Math.max(0, config.metalDepositStep);
  if (METAL_DEPOSIT_STEP !== nextDepositStep) {
    METAL_DEPOSIT_STEP = nextDepositStep;
    changed = true;
  }

  // Subdivision count must stay >= 1 — terrainTileMap divides by it
  // and indexes from `subdiv - 1`. Battle bar options are {0,5,10,15,20};
  // 0 lands on 1 internally ("off" = one triangle per land cell).
  const nextTerrainDetail = Math.max(1, Math.floor(config.terrainDetail));
  if (TERRAIN_FINE_TRIANGLE_SUBDIV !== nextTerrainDetail) {
    TERRAIN_FINE_TRIANGLE_SUBDIV = nextTerrainDetail;
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
  radiusFraction: terrainConfig.generation.ripple.radiusFraction,
  phase: terrainConfig.generation.ripple.phase,
  components: terrainConfig.generation.ripple.components,
} as const;

export const TERRAIN_RIDGE_CONFIG = {
  innerRadiusFraction: terrainConfig.generation.ridge.innerRadiusFraction,
  outerRadiusFraction: terrainConfig.generation.ridge.outerRadiusFraction,
  halfWidthFraction: terrainConfig.generation.ridge.halfWidthFraction,
} as const;
