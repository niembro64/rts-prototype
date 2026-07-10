import { BATTLE_CONFIG } from '../../../battleBarConfig';
import terrainConfig from './terrainConfig.json';

/** Floor of the world's vertical extent: the bottom face of every 3D tile. */
export const TILE_FLOOR_Y = terrainConfig.world.floorY;

/** Water surface position between TILE_FLOOR_Y and ground level 0. */
const WATER_LEVEL_FRACTION = terrainConfig.water.levelFraction;
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


/** Maximum source-surface normal divergence allowed inside a collapsed
 *  triangle. This catches curved terrain whose sampled points happen to stay
 *  within the positional error tolerance. */
const TERRAIN_TRIANGLE_MAX_NORMAL_ANGLE_DEGREES =
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
  /** Signed altitude of the map perimeter ring (PERIMETER bar). 0 =
   *  flat square (no boundary override); negative dishes the outer
   *  ring below water (round-island); positive raises a rim wall. */
  perimeterMagnitude: number;
  /** Plateau lattice step (D-PLATEAU bar). 0 = NONE (terracing
   *  disabled — the sim short-circuits on step <= 0). */
  terrainDTerrain: number;
  /** Plateau wall slope angle in degrees from horizontal. Values near
   *  90 produce cliff-like walls; lower values widen each wall into a
   *  gentler heightfield ramp. */
  plateauWallSlopeDegrees: number;
  /** Waters-edge BEACH slope in degrees (BEACH bar). Beach shoreline
   *  slices compress the terrain gradient through the waterline down
   *  to (at most) this slope so ground units can wade in and out.
   *  0 is a valid beach: a perfectly flat shelf at the water level,
   *  fading back to natural terrain over the beach fade radius. Beach
   *  shaping is disabled via shoreline.beachFadeRadius = 0 in
   *  terrainConfig.json. */
  watersEdgeBeachSlopeDegrees: number;
  /** Waters-edge CLIFF height in world units (W-CLIFF bar). Cliff
   *  shoreline slices snap heights near the waterline away from it
   *  into a single plateau-style wall of this total height. 0
   *  disables cliff shaping. */
  watersEdgeCliffHeight: number;
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
/** Currently-installed signed PERIMETER amplitude (matches the active
 *  battle's PERIMETER bar pick). The terrain heightmap blends the
 *  outer ring toward this value — 0 leaves the natural square map,
 *  negative sinks the ring below water (round-island), positive raises
 *  a rim. */
export let TERRAIN_PERIMETER_MAGNITUDE = BATTLE_CONFIG.perimeterMagnitude.default;

/** Conservative upper bound on terrain heights — center/dividers/
 *  perimeter features can stack, so sum their absolute amplitudes. */
function computeTerrainMaxRenderY(
  centerMag: number,
  dividersMag: number,
  perimeterMag: number,
): number {
  return Math.abs(centerMag) + Math.abs(dividersMag) + Math.abs(perimeterMag);
}
export let TERRAIN_MAX_RENDER_Y = computeTerrainMaxRenderY(
  TERRAIN_CENTER_MAGNITUDE,
  TERRAIN_DIVIDERS_MAGNITUDE,
  TERRAIN_PERIMETER_MAGNITUDE,
);

/** Vertical spacing between authored terrain plateau levels. Drives
 *  plateau snapping in `applyTerrainPlateaus` and building-footprint
 *  level snapping in `terrainBuildability`. */
export let TERRAIN_D_TERRAIN = BATTLE_CONFIG.terrainDTerrain.default;

/** Slope angle of the D-PLATEAU transition band, measured from horizontal.
 *  89deg keeps the old near-cliff behavior; lower values widen the band
 *  before deposit flat zones are blended in. */
export let TERRAIN_PLATEAU_WALL_SLOPE_DEGREES =
  BATTLE_CONFIG.plateauWallSlopeDegrees.default;

/** Currently-installed waters-edge BEACH slope (degrees). Beach
 *  shoreline slices compress the terrain gradient through the
 *  waterline to at most this slope. 0 = beach shaping off. */
export let TERRAIN_WATERS_EDGE_BEACH_SLOPE_DEGREES =
  BATTLE_CONFIG.watersEdgeBeachSlopeDegrees.default;

/** Currently-installed waters-edge CLIFF height (world units). Cliff
 *  shoreline slices snap the waterline into a plateau-style wall of
 *  this total height. 0 = cliff shaping off. */
export let TERRAIN_WATERS_EDGE_CLIFF_HEIGHT =
  BATTLE_CONFIG.watersEdgeCliffHeight.default;

/** Vertical step (world units) between metal-extractor pad altitude
 *  levels. A deposit ring's `dTerrainLevels` is multiplied by this
 *  to get the pad's `height`. Independent from `TERRAIN_D_TERRAIN`
 *  so the deposit lattice can use a different step than the plateau
 *  lattice. */
export let METAL_DEPOSIT_STEP = BATTLE_CONFIG.metalDepositStep.default;

/** PERIMETER ring shape (sim authority): fractions of the map's smaller
 *  dimension marking where the perimeter override begins and where it
 *  reaches full strength. Inside `innerRadiusFraction` the natural terrain
 *  is untouched; from there to `outerRadiusFraction` the height cosine-blends
 *  toward the signed PERIMETER magnitude; beyond `outerRadiusFraction` (out
 *  to the map edge) the terrain is flat at exactly that magnitude. Drives the
 *  weight in `getTerrainMapBoundaryFade` and the matching Rust sampler. NOT a
 *  coloring knob — the renderer's outer-ring color/fade is configured
 *  separately by `terrainHorizonBlend` in worldRenderConfig.json and
 *  `COLORS.world.terrain.horizonBlend`; the horizon blend merely reads this
 *  weight so the color seam tracks the perimeter handoff. */
export const TERRAIN_PERIMETER_CONFIG = {
  innerRadiusFraction: terrainConfig.generation.perimeter.innerRadiusFraction,
  outerRadiusFraction: terrainConfig.generation.perimeter.outerRadiusFraction,
} as const;

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
  if (TERRAIN_PERIMETER_MAGNITUDE !== config.perimeterMagnitude) {
    TERRAIN_PERIMETER_MAGNITUDE = config.perimeterMagnitude;
    changed = true;
  }
  if (changed) {
    TERRAIN_MAX_RENDER_Y = computeTerrainMaxRenderY(
      TERRAIN_CENTER_MAGNITUDE,
      TERRAIN_DIVIDERS_MAGNITUDE,
      TERRAIN_PERIMETER_MAGNITUDE,
    );
  }

  const nextDTerrain = Math.max(0, config.terrainDTerrain);
  if (TERRAIN_D_TERRAIN !== nextDTerrain) {
    TERRAIN_D_TERRAIN = nextDTerrain;
    changed = true;
  }

  const rawPlateauWallSlopeDegrees = Number(config.plateauWallSlopeDegrees);
  const nextPlateauWallSlopeDegrees = Number.isFinite(
    rawPlateauWallSlopeDegrees,
  )
    ? Math.max(1, Math.min(89, Math.floor(rawPlateauWallSlopeDegrees)))
    : TERRAIN_PLATEAU_WALL_SLOPE_DEGREES;
  if (TERRAIN_PLATEAU_WALL_SLOPE_DEGREES !== nextPlateauWallSlopeDegrees) {
    TERRAIN_PLATEAU_WALL_SLOPE_DEGREES = nextPlateauWallSlopeDegrees;
    changed = true;
  }

  const rawBeachSlopeDegrees = Number(config.watersEdgeBeachSlopeDegrees);
  const nextBeachSlopeDegrees = Number.isFinite(rawBeachSlopeDegrees)
    ? Math.max(0, Math.min(89, rawBeachSlopeDegrees))
    : TERRAIN_WATERS_EDGE_BEACH_SLOPE_DEGREES;
  if (TERRAIN_WATERS_EDGE_BEACH_SLOPE_DEGREES !== nextBeachSlopeDegrees) {
    TERRAIN_WATERS_EDGE_BEACH_SLOPE_DEGREES = nextBeachSlopeDegrees;
    changed = true;
  }

  const rawWatersEdgeCliffHeight = Number(config.watersEdgeCliffHeight);
  const nextWatersEdgeCliffHeight = Number.isFinite(rawWatersEdgeCliffHeight)
    ? Math.max(0, rawWatersEdgeCliffHeight)
    : TERRAIN_WATERS_EDGE_CLIFF_HEIGHT;
  if (TERRAIN_WATERS_EDGE_CLIFF_HEIGHT !== nextWatersEdgeCliffHeight) {
    TERRAIN_WATERS_EDGE_CLIFF_HEIGHT = nextWatersEdgeCliffHeight;
    changed = true;
  }

  const nextDepositStep = Math.max(0, config.metalDepositStep);
  if (METAL_DEPOSIT_STEP !== nextDepositStep) {
    METAL_DEPOSIT_STEP = nextDepositStep;
    changed = true;
  }

  // Subdivision count must stay >= 1 — terrainTileMap divides by it
  // and indexes from `subdiv - 1`. Battle bar option 0 lands on 1
  // internally ("off" = one triangle-edge subdivision per land cell).
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

/** The three reorderable height-transform stages of the generation
 *  pipeline. `terrainConfig.json`'s `pipeline` array drives the order:
 *  rearrange its entries to reorder these stages. The other entries
 *  (naturalField, mapBoundary, gradientEstimate front; floorClamp
 *  last) are pinned because they build the shaped surface / its slope
 *  or terminate the pipeline — boot fails loudly if they move. */
export type TerrainPipelineTransformStep =
  | 'plateauTerracing'
  | 'metalDepositPads'
  | 'watersEdgeShoreline';

const TERRAIN_PIPELINE_FIXED_PREFIX = [
  'naturalField',
  'mapBoundary',
  'gradientEstimate',
] as const;
const TERRAIN_PIPELINE_TRANSFORM_STEPS: readonly TerrainPipelineTransformStep[] = [
  'plateauTerracing',
  'metalDepositPads',
  'watersEdgeShoreline',
];

function readTerrainPipelineTransformOrder(): readonly TerrainPipelineTransformStep[] {
  const pipeline: readonly string[] = terrainConfig.pipeline;
  const expectedLength =
    TERRAIN_PIPELINE_FIXED_PREFIX.length + TERRAIN_PIPELINE_TRANSFORM_STEPS.length + 1;
  if (!Array.isArray(pipeline) || pipeline.length !== expectedLength) {
    throw new Error(
      `terrainConfig.json pipeline must list exactly ${expectedLength} stages; got ${pipeline?.length}`,
    );
  }
  TERRAIN_PIPELINE_FIXED_PREFIX.forEach((step, i) => {
    if (pipeline[i] !== step) {
      throw new Error(
        `terrainConfig.json pipeline[${i}] must be "${step}" (pinned — it builds the shaped surface); got "${pipeline[i]}"`,
      );
    }
  });
  if (pipeline[expectedLength - 1] !== 'floorClamp') {
    throw new Error(
      `terrainConfig.json pipeline must end with "floorClamp"; got "${pipeline[expectedLength - 1]}"`,
    );
  }
  const middle = pipeline.slice(
    TERRAIN_PIPELINE_FIXED_PREFIX.length,
    expectedLength - 1,
  ) as TerrainPipelineTransformStep[];
  for (const step of TERRAIN_PIPELINE_TRANSFORM_STEPS) {
    if (middle.filter((entry) => entry === step).length !== 1) {
      throw new Error(
        `terrainConfig.json pipeline must contain "${step}" exactly once between the pinned stages; got [${middle.join(', ')}]`,
      );
    }
  }
  return middle;
}

/** Authored order of the reorderable transform stages, validated at boot. */
export const TERRAIN_PIPELINE_TRANSFORM_ORDER = readTerrainPipelineTransformOrder();

/** Wire codes for the transform order (packed into the wasm config
 *  slice so Rust executes the identical order). */
export const TERRAIN_PIPELINE_TRANSFORM_CODES: Readonly<
  Record<TerrainPipelineTransformStep, number>
> = {
  plateauTerracing: 0,
  metalDepositPads: 1,
  watersEdgeShoreline: 2,
};

/** Static shoreline (waters-edge) shape knobs. The shoreline pattern is
 *  team-periodic — each player's slice is split into a beach half
 *  (centered on the player's spoke) and a cliff half (centered on the
 *  divider ridge) so every player gets an identical shoreline, joined
 *  by wall-steep end caps derived from the PLATEAU WALL slope.
 *  `beachFadeRadius` and `cliffFadeRadius` are horizontal world-unit
 *  distances from the water's edge over which each operator's effect
 *  raised-cosine-fades from full (at the waterline) back to the
 *  natural surface, on both the land and water sides, following the
 *  water's curves (0 = that operator disabled). The cliff's
 *  wall REGION classification is unaffected, so inland wall loops stay
 *  closed in WALL TRIS with flattened geometry. The live BEACH slope /
 *  CLIFF height come from the battle bars (`TERRAIN_WATERS_EDGE_*`
 *  above). */
export const TERRAIN_SHORELINE_CONFIG = {
  beachFadeRadius: terrainConfig.generation.shoreline.beachFadeRadius,
  cliffFadeRadius: terrainConfig.generation.shoreline.cliffFadeRadius,
} as const;
