// Public terrain facade. Keep external imports stable while the terrain
// implementation is split into focused modules under ./terrain.
export {
  METAL_DEPOSIT_STEP,
  TERRAIN_MAX_RENDER_Y,
  TERRAIN_SUBMERGED_BRIGHTNESS,
  TERRAIN_SUBMERGED_FADE_END_HEIGHT,
  TILE_FLOOR_Y,
  WATER_FULLY_OPAQUE,
  WATER_LEVEL,
  terrainUnderwaterBrightnessAtHeight,
  type TerrainRuntimeConfig,
} from './terrain/terrainConfig';
export {
  getTerrainRuntimeConfig,
  getTerrainPerimeterMagnitude,
  getTerrainVersion,
  getTerrainTeamCount,
  resetTerrainStateForDeterministicReplay,
  setTerrainRuntimeConfig,
  setTerrainCenterMagnitude,
  setTerrainRingMagnitude,
  setTerrainDividersMagnitude,
  setTerrainPerimeterMagnitude,
  setTerrainPrecedence,
  setTerrainTeamCount,
} from './terrain/terrainState';
export {
  setMetalDepositFlatZones,
  type TerrainFlatZone,
} from './terrain/terrainFlatZones';
export {
  buildTerrainTileMap,
  getTerrainMeshHeight,
  getTerrainMeshMaximumHeight,
  getTerrainMeshNormal,
  getTerrainMeshSample,
  getTerrainMeshView,
  setAuthoritativeTerrainTileMap,
  terrainMeshHeightFromSample,
  terrainMeshNormalFromSample,
} from './terrain/terrainTileMap';
export {
  buildTerrainBuildabilityGrid,
  evaluateBuildabilityFootprint,
  getBuildSquareTerrainHeightRange,
  getTerrainBuildabilityGridCell,
  getTerrainBuildabilityConfigKey,

} from './terrain/terrainBuildability';
export {
  applySurfaceTilt,
  getTerrainBedHeight,
  getTerrainBedNormal,
  getSurfaceHeight,
  getSurfaceNormal,
  isFarFromWater,
  isWaterAt,
} from './terrain/terrainSurface';
