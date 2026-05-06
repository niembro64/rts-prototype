// Public terrain facade. Keep external imports stable while the terrain
// implementation is split into focused modules under ./terrain.
export type { TerrainShape } from '@/types/terrain';
export {
  TERRAIN_CIRCLE_PERIMETER_EDGE_FRACTION,
  TERRAIN_CIRCLE_PERIMETER_TRANSITION_WIDTH_FRACTION,
  TERRAIN_CIRCLE_UNDERWATER_HEIGHT,
  TERRAIN_D_TERRAIN,
  TERRAIN_FINE_TRIANGLE_SUBDIV,
  TERRAIN_MAX_RENDER_Y,
  TERRAIN_PLATEAU_CONFIG,
  TERRAIN_TRIANGLE_FINAL_REPAIR_MAX_PASSES,
  TERRAIN_TRIANGLE_MAX_HEIGHT_ERROR,
  TERRAIN_TRIANGLE_MAX_NEIGHBOR_LEVEL_DELTA,
  TERRAIN_TRIANGLE_PRESERVE_WATERLINE,
  TERRAIN_TRIANGLE_SAMPLE_CENTROID,
  TERRAIN_TRIANGLE_VERTEX_KEY_SCALE,
  TILE_FLOOR_Y,
  WATER_LEVEL,
  WATER_LEVEL_FRACTION,
} from './terrain/terrainConfig';
export {
  getTerrainMapBoundaryFade,
  getTerrainHeight,
} from './terrain/terrainHeightGenerator';
export {
  getTerrainVersion,
  getTerrainTeamCount,
  setTerrainCenterShape,
  setTerrainDividersShape,
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
  projectHorizontalOntoSlope,
} from './terrain/terrainSurface';
