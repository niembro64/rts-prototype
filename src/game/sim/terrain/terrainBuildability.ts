import { LAND_CELL_SIZE } from '../../../config';
import { TERRAIN_D_TERRAIN, TERRAIN_PLATEAU_CONFIG } from './terrainConfig';
import { findDepositFlatZoneAt } from './terrainFlatZones';
import { getTerrainMeshHeight } from './terrainTileMap';
import { isWaterAt } from './terrainSurface';

export function getTerrainPlateauLevelAt(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number = LAND_CELL_SIZE,
): number | null {
  if (!TERRAIN_PLATEAU_CONFIG.enabled) return 0;
  const step = TERRAIN_D_TERRAIN;
  if (step <= 0) return 0;
  const flatZone = findDepositFlatZoneAt(x, z);
  const height = flatZone
    ? flatZone.height
    : getTerrainMeshHeight(x, z, mapWidth, mapHeight, cellSize);
  const level = Math.round(height / step);
  return Math.abs(height - level * step) <=
    TERRAIN_PLATEAU_CONFIG.buildableShelfHeightTolerance
    ? level
    : null;
}

export function isBuildableTerrainFootprint(
  centerX: number,
  centerZ: number,
  halfWidth: number,
  halfDepth: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number = LAND_CELL_SIZE,
): boolean {
  const rx = Math.max(0, halfWidth - 1);
  const rz = Math.max(0, halfDepth - 1);
  const samples: [number, number][] = [
    [centerX, centerZ],
    [centerX - rx, centerZ - rz],
    [centerX + rx, centerZ - rz],
    [centerX - rx, centerZ + rz],
    [centerX + rx, centerZ + rz],
    [centerX, centerZ - rz],
    [centerX, centerZ + rz],
    [centerX - rx, centerZ],
    [centerX + rx, centerZ],
  ];

  let footprintLevel: number | null = null;
  for (const [sx, sz] of samples) {
    if (isWaterAt(sx, sz, mapWidth, mapHeight, cellSize)) return false;
    const level = getTerrainPlateauLevelAt(
      sx,
      sz,
      mapWidth,
      mapHeight,
      cellSize,
    );
    if (level === null) return false;
    if (footprintLevel === null) {
      footprintLevel = level;
    } else if (level !== footprintLevel) {
      return false;
    }
  }
  return true;
}
