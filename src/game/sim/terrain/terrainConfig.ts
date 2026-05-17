import { LAND_CELL_SIZE } from '../../../config';
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

/** Maximum vertical deviation, in world units, allowed when a land cell is
 *  collapsed to a lower subdivision. Steep but planar cells simplify; curved,
 *  terraced, waterline, and ridge cells keep more triangles. */
export const TERRAIN_TRIANGLE_MAX_HEIGHT_ERROR = terrainConfig.terrainTriangleMaxHeightError;

/** Maximum hierarchy-level jump allowed across touching triangle edges.
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

/** Magnitude only; TerrainShape decides the sign. */
export const TERRAIN_SHAPE_MAGNITUDE = terrainConfig.terrainShapeMagnitude;
export const TERRAIN_MAX_RENDER_Y = TERRAIN_SHAPE_MAGNITUDE * 2;

/** Vertical spacing between authored terrain plateau levels. */
export const TERRAIN_D_TERRAIN = terrainConfig.terrainDTerrain;

export const TERRAIN_CIRCLE_PERIMETER_EDGE_FRACTION =
  terrainConfig.terrainCirclePerimeterEdgeFraction;
export const TERRAIN_CIRCLE_PERIMETER_TRANSITION_WIDTH_FRACTION =
  terrainConfig.terrainCirclePerimeterTransitionWidthFraction;
export const TERRAIN_CIRCLE_UNDERWATER_HEIGHT = WATER_LEVEL - TERRAIN_D_TERRAIN;

/** Fade authored terrain features to flat before the outer map buffer. */
export const TERRAIN_GENERATION_EDGE_TRANSITION_WIDTH_FRACTION =
  terrainConfig.terrainGenerationEdgeTransitionWidthFraction;

export const TERRAIN_PLATEAU_CONFIG = {
  enabled: terrainConfig.plateau.enabled,
  shelfFractionOfStep: terrainConfig.plateau.shelfFractionOfStep,
  rampEdgeSharpness: terrainConfig.plateau.rampEdgeSharpness,
  buildableShelfHeightTolerance: terrainConfig.plateau.buildableShelfHeightTolerance,
  slopeSampleDistance:
    LAND_CELL_SIZE * terrainConfig.plateau.slopeSampleDistanceLandCellMultiplier,
  fullTerraceMaxSlope: terrainConfig.plateau.fullTerraceMaxSlope,
  noTerraceMinSlope: terrainConfig.plateau.noTerraceMinSlope,
} as const;

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
