import {
  terrainShapeSign,
  type TerrainMapShape,
  type TerrainShape,
  type TerrainTileMap,
} from '@/types/terrain';
import { getTerrainDividerTeamCount } from '../playerLayout';
import { getSimWasm } from '../../sim-wasm/init';
import { TERRAIN_FINE_TRIANGLE_SUBDIV, TERRAIN_SHAPE_MAGNITUDE } from './terrainConfig';

let mountainRippleAmplitude = TERRAIN_SHAPE_MAGNITUDE;
let mountainSeparatorAmplitude = TERRAIN_SHAPE_MAGNITUDE;
let terrainMapShape: TerrainMapShape = 'circle';
let teamCount = 0;
let terrainVersion = 1;
let authoritativeTerrainTileMap: TerrainTileMap | null = null;

function shapeToAmplitude(shape: TerrainShape): number {
  return terrainShapeSign(shape) * TERRAIN_SHAPE_MAGNITUDE;
}

export function getTerrainVersion(): number {
  return terrainVersion;
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

export function getTerrainMapShape(): TerrainMapShape {
  return terrainMapShape;
}

export function setTerrainCenterShape(shape: TerrainShape): void {
  const next = shapeToAmplitude(shape);
  if (next === mountainRippleAmplitude) return;
  mountainRippleAmplitude = next;
  invalidateTerrainConfig();
}

export function setTerrainDividersShape(shape: TerrainShape): void {
  const next = shapeToAmplitude(shape);
  if (next === mountainSeparatorAmplitude) return;
  mountainSeparatorAmplitude = next;
  invalidateTerrainConfig();
}

export function setTerrainMapShape(shape: TerrainMapShape): void {
  if (shape !== 'square' && shape !== 'circle') {
    throw new Error(`Unknown terrain map shape: ${shape as string}`);
  }
  if (shape === terrainMapShape) return;
  terrainMapShape = shape;
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
