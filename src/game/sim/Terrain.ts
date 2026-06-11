// Public terrain facade. Keep external imports stable while the terrain
// implementation is split into focused modules under ./terrain.
export {
  TERRAIN_CIRCLE_ISLAND_RADIUS_FRACTION,
  TERRAIN_CIRCLE_SHORELINE_WIDTH_FRACTION,
  TERRAIN_CIRCLE_UNDERWATER_HEIGHT,
  TERRAIN_GENERATION_EDGE_TRANSITION_WIDTH_FRACTION,
  TERRAIN_D_TERRAIN,
  METAL_DEPOSIT_STEP,
  TERRAIN_FINE_TRIANGLE_SUBDIV,
  TERRAIN_MAX_RENDER_Y,
  TERRAIN_PLATEAU_CONFIG,
  TERRAIN_RIDGE_CONFIG,
  TERRAIN_RIPPLE_CONFIG,
  TERRAIN_TRIANGLE_FINAL_REPAIR_MAX_PASSES,
  TERRAIN_TRIANGLE_MAX_HEIGHT_ERROR,
  TERRAIN_TRIANGLE_MAX_NORMAL_ANGLE_DEGREES,
  TERRAIN_TRIANGLE_MAX_NEIGHBOR_LEVEL_DELTA,
  TERRAIN_TRIANGLE_MAX_SURFACE_ERROR,
  TERRAIN_TRIANGLE_MIN_NORMAL_DOT,
  TERRAIN_TRIANGLE_PRESERVE_WATERLINE,
  TERRAIN_TRIANGLE_SAMPLE_CENTROID,
  TERRAIN_TRIANGLE_VERTEX_KEY_SCALE,
  TILE_FLOOR_Y,
  WATER_FULLY_OPAQUE,
  WATER_LEVEL,
  WATER_LEVEL_FRACTION,
  type TerrainRuntimeConfig,
} from './terrain/terrainConfig';
export {
  createTerrainHeightSampler,
  getTerrainMapBoundaryFade,
  getTerrainHeight,
} from './terrain/terrainHeightGenerator';
export {
  getTerrainRuntimeConfig,
  getTerrainMapShape,
  getTerrainVersion,
  getTerrainTeamCount,
  setTerrainRuntimeConfig,
  setTerrainCenterMagnitude,
  setTerrainDividersMagnitude,
  setTerrainMapShape,
  setTerrainTeamCount,
} from './terrain/terrainState';
export {
  setMetalDepositFlatZones,
  type TerrainFlatZone,
} from './terrain/terrainFlatZones';
export {
  buildTerrainTileMap,
  getTerrainMeshHeight,
  getTerrainMeshNormal,
  getTerrainMeshSample,
  getTerrainMeshView,
  setAuthoritativeTerrainTileMap,
  terrainMeshHeightFromSample,
  terrainMeshNormalFromSample,
  type TerrainMeshView,
} from './terrain/terrainTileMap';
export {
  buildTerrainBuildabilityGrid,
  evaluateBuildabilityFootprint,
  getTerrainBuildabilityGridCell,
  getTerrainBuildabilityConfigKey,
  getTerrainPlateauLevelAt,
  isBuildableTerrainFootprint,
  type FootprintBuildability,
  type TerrainBuildabilityCell,
} from './terrain/terrainBuildability';
export {
  applySurfaceTilt,
  getSurfaceHeight,
  getSurfaceNormal,
  isFarFromWater,
  isWaterAt,
} from './terrain/terrainSurface';
