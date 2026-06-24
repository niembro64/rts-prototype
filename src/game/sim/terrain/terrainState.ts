import {
  type TerrainTileMap,
} from '@/types/terrain';
import { getTerrainDividerTeamCount } from '../playerLayout';
import { getSimWasm } from '../../sim-wasm/init';
import {
  applyTerrainRuntimeConfig,
  METAL_DEPOSIT_STEP,
  TERRAIN_CENTER_MAGNITUDE,
  TERRAIN_D_TERRAIN,
  TERRAIN_DIVIDERS_MAGNITUDE,
  TERRAIN_FINE_TRIANGLE_SUBDIV,
  TERRAIN_PERIMETER_MAGNITUDE,
  type TerrainRuntimeConfig,
} from './terrainConfig';

let mountainRippleAmplitude = TERRAIN_CENTER_MAGNITUDE;
let mountainSeparatorAmplitude = TERRAIN_DIVIDERS_MAGNITUDE;
let perimeterMagnitude = TERRAIN_PERIMETER_MAGNITUDE;
let teamCount = 0;
let terrainVersion = 1;
let authoritativeTerrainTileMap: TerrainTileMap | null = null;

export function getTerrainVersion(): number {
  return terrainVersion;
}

export function resetTerrainStateForDeterministicReplay(): void {
  mountainRippleAmplitude = TERRAIN_CENTER_MAGNITUDE;
  mountainSeparatorAmplitude = TERRAIN_DIVIDERS_MAGNITUDE;
  perimeterMagnitude = TERRAIN_PERIMETER_MAGNITUDE;
  teamCount = 0;
  terrainVersion = 1;
  authoritativeTerrainTileMap = null;
  const sim = getSimWasm();
  if (sim !== undefined) {
    sim.terrainClear();
  }
}

export function invalidateTerrainConfig(): void {
  authoritativeTerrainTileMap = null;
  terrainVersion++;
  // Drop the WASM-side mesh too so a stale install doesn't outlive
  // the JS state.
  const sim = getSimWasm();
  if (sim !== undefined) {
    sim.terrainClear();
  }
}

/** Copy the just-installed TerrainTileMap into WASM linear memory so
 *  hot-path samplers (terrain_get_surface_height / _normal) can read
 *  directly from Rust-side Vecs without crossing the boundary per
 *  call. Called from `setAuthoritativeTerrainTileMap` after the
 *  module-local assignment; the JS-side state remains authoritative
 *  for the rare structural query paths that haven't been ported. */
function installMeshIntoSim(map: TerrainTileMap): void {
  const sim = getSimWasm();
  if (sim === undefined) return;
  sim.terrainInstallMesh(
    Float64Array.from(map.meshVertexCoords),
    Float64Array.from(map.meshVertexHeights),
    Int32Array.from(map.meshTriangleIndices),
    Int32Array.from(map.meshTriangleLevels),
    Int32Array.from(map.meshTriangleNeighborIndices),
    Int32Array.from(map.meshTriangleNeighborLevels),
    Int32Array.from(map.meshCellTriangleOffsets),
    Int32Array.from(map.meshCellTriangleIndices),
    map.mapWidth,
    map.mapHeight,
    map.cellSize,
    map.subdiv,
    map.cellsX,
    map.cellsY,
  );
}

export function getMountainRippleAmplitude(): number {
  return mountainRippleAmplitude;
}

export function getMountainSeparatorAmplitude(): number {
  return mountainSeparatorAmplitude;
}

/** Currently-installed signed PERIMETER amplitude. The terrain height
 *  generator reads this to blend the outer ring toward its value. */
export function getTerrainPerimeterMagnitude(): number {
  return perimeterMagnitude;
}

export function getTerrainRuntimeConfig(): TerrainRuntimeConfig {
  return {
    centerMagnitude: TERRAIN_CENTER_MAGNITUDE,
    dividersMagnitude: TERRAIN_DIVIDERS_MAGNITUDE,
    perimeterMagnitude: TERRAIN_PERIMETER_MAGNITUDE,
    terrainDTerrain: TERRAIN_D_TERRAIN,
    metalDepositStep: METAL_DEPOSIT_STEP,
    terrainDetail: TERRAIN_FINE_TRIANGLE_SUBDIV,
  };
}

export function setTerrainRuntimeConfig(config: TerrainRuntimeConfig): void {
  if (!applyTerrainRuntimeConfig(config)) return;
  mountainRippleAmplitude = TERRAIN_CENTER_MAGNITUDE;
  mountainSeparatorAmplitude = TERRAIN_DIVIDERS_MAGNITUDE;
  perimeterMagnitude = TERRAIN_PERIMETER_MAGNITUDE;
  invalidateTerrainConfig();
}

export function setTerrainCenterMagnitude(value: number): void {
  if (value === mountainRippleAmplitude) return;
  mountainRippleAmplitude = value;
  applyTerrainRuntimeConfig({
    centerMagnitude: value,
    dividersMagnitude: TERRAIN_DIVIDERS_MAGNITUDE,
    perimeterMagnitude: TERRAIN_PERIMETER_MAGNITUDE,
    terrainDTerrain: TERRAIN_D_TERRAIN,
    metalDepositStep: METAL_DEPOSIT_STEP,
    terrainDetail: TERRAIN_FINE_TRIANGLE_SUBDIV,
  });
  invalidateTerrainConfig();
}

export function setTerrainDividersMagnitude(value: number): void {
  if (value === mountainSeparatorAmplitude) return;
  mountainSeparatorAmplitude = value;
  applyTerrainRuntimeConfig({
    centerMagnitude: TERRAIN_CENTER_MAGNITUDE,
    dividersMagnitude: value,
    perimeterMagnitude: TERRAIN_PERIMETER_MAGNITUDE,
    terrainDTerrain: TERRAIN_D_TERRAIN,
    metalDepositStep: METAL_DEPOSIT_STEP,
    terrainDetail: TERRAIN_FINE_TRIANGLE_SUBDIV,
  });
  invalidateTerrainConfig();
}

export function setTerrainPerimeterMagnitude(value: number): void {
  if (value === perimeterMagnitude) return;
  perimeterMagnitude = value;
  applyTerrainRuntimeConfig({
    centerMagnitude: TERRAIN_CENTER_MAGNITUDE,
    dividersMagnitude: TERRAIN_DIVIDERS_MAGNITUDE,
    perimeterMagnitude: value,
    terrainDTerrain: TERRAIN_D_TERRAIN,
    metalDepositStep: METAL_DEPOSIT_STEP,
    terrainDetail: TERRAIN_FINE_TRIANGLE_SUBDIV,
  });
  invalidateTerrainConfig();
}

export function setTerrainTeamCount(n: number): void {
  const next = getTerrainDividerTeamCount(n);
  if (next === teamCount) return;
  teamCount = next;
  invalidateTerrainConfig();
}

export function getTerrainTeamCount(): number {
  return teamCount;
}

export function getAuthoritativeTerrainTileMap(): TerrainTileMap | null {
  return authoritativeTerrainTileMap;
}

export function setAuthoritativeTerrainTileMap(map: TerrainTileMap | null): void {
  if (
    map &&
    authoritativeTerrainTileMap &&
    authoritativeTerrainTileMap.version === map.version &&
    authoritativeTerrainTileMap.mapWidth === map.mapWidth &&
    authoritativeTerrainTileMap.mapHeight === map.mapHeight &&
    authoritativeTerrainTileMap.cellSize === map.cellSize &&
    authoritativeTerrainTileMap.subdiv === map.subdiv &&
    authoritativeTerrainTileMap.verticesX === map.verticesX &&
    authoritativeTerrainTileMap.verticesY === map.verticesY
  ) {
    authoritativeTerrainTileMap = map;
    return;
  }
  if (!map && !authoritativeTerrainTileMap) return;
  authoritativeTerrainTileMap = map;
  terrainVersion++;
  // Mirror the new mesh into WASM linear memory (or clear the
  // WASM-side mesh on a null assignment).
  const sim = getSimWasm();
  if (sim !== undefined) {
    if (map) {
      installMeshIntoSim(map);
    } else {
      sim.terrainClear();
    }
  }
}

export function getInstalledTerrainTileMap(
  mapWidth: number,
  mapHeight: number,
  cellSize: number,
): TerrainTileMap | null {
  const map = authoritativeTerrainTileMap;
  if (!map) return null;
  if (
    map.mapWidth !== mapWidth ||
    map.mapHeight !== mapHeight ||
    map.cellSize !== cellSize ||
    map.subdiv !== TERRAIN_FINE_TRIANGLE_SUBDIV
  ) {
    return null;
  }
  return map;
}
