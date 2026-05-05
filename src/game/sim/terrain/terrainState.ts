import {
  terrainShapeSign,
  type TerrainMapShape,
  type TerrainShape,
  type TerrainTileMap,
} from '@/types/terrain';
import { getTerrainDividerTeamCount } from '../playerLayout';
import { TERRAIN_MESH_SUBDIV, TERRAIN_SHAPE_MAGNITUDE } from './terrainConfig';

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
    map.subdiv !== TERRAIN_MESH_SUBDIV
  ) {
    return null;
  }
  return map;
}
