import { LAND_CELL_SIZE } from '../../../config';

/** Floor of the world's vertical extent: the bottom face of every 3D tile. */
export const TILE_FLOOR_Y = -1200;

/** Water surface position between TILE_FLOOR_Y and ground level 0. */
export const WATER_LEVEL_FRACTION = 0.71;
export const WATER_LEVEL = TILE_FLOOR_Y * (1 - WATER_LEVEL_FRACTION);

// Host sim, client prediction, and terrain rendering share this exact mesh.
export const AUTHORITATIVE_TERRAIN_SUBDIV = 1;
export const TERRAIN_MESH_SUBDIV = AUTHORITATIVE_TERRAIN_SUBDIV;

/** Add an averaged center vertex to an authoritative terrain sub-quad
 *  when the four corners are non-planar enough to make the old fixed
 *  diagonal visibly biased. Flat/planar cells stay at two triangles. */
export const TERRAIN_CENTER_FAN_HEIGHT_THRESHOLD = 1;

/** Magnitude only; TerrainShape decides the sign. */
export const TERRAIN_SHAPE_MAGNITUDE = 600;
export const TERRAIN_MAX_RENDER_Y = TERRAIN_SHAPE_MAGNITUDE * 2;

/** Vertical spacing between authored terrain plateau levels. */
export const TERRAIN_D_TERRAIN = 200 * (TERRAIN_SHAPE_MAGNITUDE / 800);

export const TERRAIN_CIRCLE_PERIMETER_EDGE_FRACTION = 0.49;
export const TERRAIN_CIRCLE_PERIMETER_TRANSITION_WIDTH_FRACTION = 0.10;
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

export const RIPPLE_RADIUS_FRACTION = 0.4;
export const RIPPLE_W1 = 200;
export const RIPPLE_W2 = 600;
export const RIPPLE_W3 = 600;
export const RIPPLE_PHASE = 1.7;

export const RIDGE_INNER_RADIUS_FRACTION = 0.1;
export const RIDGE_OUTER_RADIUS_FRACTION = 0.4;
export const RIDGE_HALF_WIDTH_FRACTION = 0.08;
