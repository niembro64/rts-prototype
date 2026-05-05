// Public terrain facade. Keep external imports stable while the terrain
// implementation is split into focused modules under ./terrain.
export type { TerrainShape } from '@/types/terrain';
export {
  AUTHORITATIVE_TERRAIN_SUBDIV,
  TERRAIN_CIRCLE_PERIMETER_EDGE_FRACTION,
  TERRAIN_CIRCLE_PERIMETER_TRANSITION_WIDTH_FRACTION,
  TERRAIN_CIRCLE_UNDERWATER_HEIGHT,
  TERRAIN_D_TERRAIN,
  TERRAIN_MAX_RENDER_Y,
  TERRAIN_MESH_SUBDIV,
  TERRAIN_PLATEAU_CONFIG,
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
  interpolateTerrainMeshQuadHeight,
  setAuthoritativeTerrainTileMap,
} from './terrain/terrainTileMap';
export {
  getTerrainPlateauLevelAt,
  isBuildableTerrainFootprint,
} from './terrain/terrainBuildability';
export {
  applySurfaceTilt,
  getSurfaceHeight,
  getSurfaceNormal,
  isFarFromWater,
  isWaterAt,
  projectHorizontalOntoSlope,
} from './terrain/terrainSurface';
