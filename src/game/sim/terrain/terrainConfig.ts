import { LAND_CELL_SIZE } from '../../../config';

/** Floor of the world's vertical extent: the bottom face of every 3D tile. */
export const TILE_FLOOR_Y = -1200;

/** Water surface position between TILE_FLOOR_Y and ground level 0. */
export const WATER_LEVEL_FRACTION = 0.71;
export const WATER_LEVEL = TILE_FLOOR_Y * (1 - WATER_LEVEL_FRACTION);

// Host sim, client prediction, and terrain rendering share this exact mesh.
// This is the max per-land-cell resolution; buildTerrainTileMap collapses
// cells that do not need it down to cheaper authoritative subdivisions.
export const AUTHORITATIVE_TERRAIN_SUBDIV = 4;
export const TERRAIN_MESH_SUBDIV = AUTHORITATIVE_TERRAIN_SUBDIV;

/** Maximum vertical deviation, in world units, allowed when a land cell is
 *  collapsed to a lower subdivision. Steep but planar cells simplify; curved,
 *  terraced, waterline, and ridge cells keep more triangles. */
export const TERRAIN_ADAPTIVE_MAX_HEIGHT_ERROR = 8;

/** Legacy diagnostic threshold for the old center-fan terrain split.
 *  Authoritative terrain now keeps every sub-quad at two triangles. */
export const TERRAIN_CENTER_FAN_HEIGHT_THRESHOLD = 0.5;

/** Legacy smoothing factors for experiments. The authoritative adaptive
 *  surface samples final vertices from the generated terrain curve exactly. */

const val = 0.5;
export const TERRAIN_SMOOTHING_LAMBDA_X = val;
export const TERRAIN_SMOOTHING_LAMBDA_Y = val;
export const TERRAIN_SMOOTHING_LAMBDA_Z = val;

/** Magnitude only; TerrainShape decides the sign. */
export const TERRAIN_SHAPE_MAGNITUDE = 400;
export const TERRAIN_MAX_RENDER_Y = TERRAIN_SHAPE_MAGNITUDE * 2;

/** Vertical spacing between authored terrain plateau levels. */
export const TERRAIN_D_TERRAIN = 200 * (TERRAIN_SHAPE_MAGNITUDE / 800);

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
