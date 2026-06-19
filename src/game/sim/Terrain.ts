// Public terrain facade. Keep external imports stable while the terrain
// implementation is split into focused modules under ./terrain.
export {
  
  
  TERRAIN_CIRCLE_UNDERWATER_HEIGHT,
  
  
  METAL_DEPOSIT_STEP,
  
  TERRAIN_MAX_RENDER_Y,
  
  
  
  
  
  
  
  
  
  
  
  
  TILE_FLOOR_Y,
  WATER_FULLY_OPAQUE,
  WATER_LEVEL,
  
  type TerrainRuntimeConfig,
} from './terrain/terrainConfig';
export {
  getTerrainRuntimeConfig,
  getTerrainMapShape,
  getTerrainVersion,
  getTerrainTeamCount,
  resetTerrainStateForDeterministicReplay,
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
