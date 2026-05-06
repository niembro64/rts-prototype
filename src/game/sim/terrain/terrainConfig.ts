import { LAND_CELL_SIZE } from '../../../config';

/** Floor of the world's vertical extent: the bottom face of every 3D tile. */
export const TILE_FLOOR_Y = -1200;

/** Water surface position between TILE_FLOOR_Y and ground level 0. */
export const WATER_LEVEL_FRACTION = 0.71;
export const WATER_LEVEL = TILE_FLOOR_Y * (1 - WATER_LEVEL_FRACTION);

// Host sim, client prediction, and terrain rendering share this exact mesh.
// This is the finest equilateral-triangle edge resolution relative to
// LAND_CELL_SIZE. The baker groups fine triangles upward into larger
// authoritative triangles where error allows.
export const TERRAIN_FINE_TRIANGLE_SUBDIV = 3;

/** Maximum vertical deviation, in world units, allowed when a land cell is
 *  collapsed to a lower subdivision. Steep but planar cells simplify; curved,
 *  terraced, waterline, and ridge cells keep more triangles. */
export const TERRAIN_TRIANGLE_MAX_HEIGHT_ERROR = 20;

/** Maximum hierarchy-level jump allowed across touching triangle edges.
 *  `1` gives a 2:1 balanced transition band around high-detail terrain. */
export const TERRAIN_TRIANGLE_MAX_NEIGHBOR_LEVEL_DELTA = 1;

/** Hard cap for final mesh edge repair. Keeps terrain startup bounded even
 *  when a pathological map generates many transition edges. */
export const TERRAIN_TRIANGLE_FINAL_REPAIR_MAX_PASSES = 3;

/** Extra error sample at a triangle centroid catches peaks or valleys that do
 *  not land on the fine lattice points for that candidate triangle. */
export const TERRAIN_TRIANGLE_SAMPLE_CENTROID = true;

/** Never collapse a candidate triangle if the simplified plane moves the
 *  waterline classification of any checked point. */
export const TERRAIN_TRIANGLE_PRESERVE_WATERLINE = true;

/** World-space vertex de-duplication precision for clipped triangle borders. */
export const TERRAIN_TRIANGLE_VERTEX_KEY_SCALE = 1000;

/** Magnitude only; TerrainShape decides the sign. */
export const TERRAIN_SHAPE_MAGNITUDE = 800;
export const TERRAIN_MAX_RENDER_Y = TERRAIN_SHAPE_MAGNITUDE * 2;

/** Vertical spacing between authored terrain plateau levels. */
export const TERRAIN_D_TERRAIN = 500;

export const TERRAIN_CIRCLE_PERIMETER_EDGE_FRACTION = 0.49;
export const TERRAIN_CIRCLE_PERIMETER_TRANSITION_WIDTH_FRACTION = 0.1;
export const TERRAIN_CIRCLE_UNDERWATER_HEIGHT = WATER_LEVEL - TERRAIN_D_TERRAIN;

/** Fade authored terrain features to flat before the outer map buffer. */
export const TERRAIN_GENERATION_EDGE_TRANSITION_WIDTH_FRACTION = 0.04;

export const TERRAIN_PLATEAU_CONFIG = {
  enabled: true,
  shelfFractionOfStep: 0.99,
  rampEdgeSharpness: 0,
  buildableShelfHeightTolerance: 20,
  slopeSampleDistance: LAND_CELL_SIZE * 0.5,
  fullTerraceMaxSlope: 0.45,
  noTerraceMinSlope: 0.9,
} as const;

/** Three summed wave components form the central mountain ripple.
 *  Each carries its own wavelength and magnitude (the per-component
 *  weight in the sum, normalized to [0,1] before being scaled by the
 *  global mountain ripple amplitude). The component formulas differ
 *  in shape — see `getGeneratedNaturalTerrainHeight` — so wavelength
 *  means slightly different things per component, but magnitude is
 *  uniformly the relative weight. */
export const TERRAIN_RIPPLE_CONFIG = {
  radiusFraction: 0.4,
  phase: 1.7,
  components: [
    { wavelength: 200, magnitude: 0.9 },
    { wavelength: 600, magnitude: 0.0 },
    { wavelength: 600, magnitude: 0.0 },
    // { wavelength: 200, magnitude: 0.5 },
    // { wavelength: 600, magnitude: 0.3 },
    // { wavelength: 600, magnitude: 0.2 },
  ],
} as const;

export const TERRAIN_RIDGE_CONFIG = {
  innerRadiusFraction: 0.1,
  outerRadiusFraction: 0.4,
  halfWidthFraction: 0.08,
} as const;
