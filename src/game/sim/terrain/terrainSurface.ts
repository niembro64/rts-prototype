import { LAND_CELL_SIZE } from '../../../config';
import { WATER_LEVEL } from './terrainConfig';
import { findDepositFlatZoneAt } from './terrainFlatZones';
import {
  getTerrainMeshHeight,
  getTerrainMeshSample,
  terrainMeshHeightFromSample,
  terrainMeshNormalFromSample,
} from './terrainTileMap';

const WATER_CLEARANCE_SAMPLES = 8;

export function getSurfaceNormal(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number = LAND_CELL_SIZE,
): { nx: number; ny: number; nz: number } {
  const sample = getTerrainMeshSample(x, z, mapWidth, mapHeight, cellSize);
  const h0 = terrainMeshHeightFromSample(sample);
  if (h0 < WATER_LEVEL) return { nx: 0, ny: 0, nz: 1 };
  return terrainMeshNormalFromSample(sample);
}

export function projectHorizontalOntoSlope(
  hx: number,
  hy: number,
  n: { nx: number; ny: number; nz: number },
): { x: number; y: number; z: number } {
  const dot = hx * n.nx + hy * n.ny;
  const tx = hx - dot * n.nx;
  const ty = hy - dot * n.ny;
  const tz = -dot * n.nz;
  const m = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
  return { x: tx / m, y: ty / m, z: tz / m };
}

export function applySurfaceTilt(
  vx: number,
  vy: number,
  vz: number,
  n: { nx: number; ny: number; nz: number },
): { x: number; y: number; z: number } {
  const sinT2 = n.nx * n.nx + n.ny * n.ny;
  if (sinT2 < 1e-12) return { x: vx, y: vy, z: vz };
  const sinT = Math.sqrt(sinT2);
  const cosT = n.nz;
  const kx = -n.ny / sinT;
  const ky = n.nx / sinT;
  const kdotv = kx * vx + ky * vy;
  const crossX = ky * vz;
  const crossY = -kx * vz;
  const crossZ = kx * vy - ky * vx;
  const oneMinusCos = 1 - cosT;
  return {
    x: vx * cosT + crossX * sinT + kx * kdotv * oneMinusCos,
    y: vy * cosT + crossY * sinT + ky * kdotv * oneMinusCos,
    z: vz * cosT + crossZ * sinT,
  };
}

export function getSurfaceHeight(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number = LAND_CELL_SIZE,
): number {
  return Math.max(
    WATER_LEVEL,
    getTerrainMeshHeight(x, z, mapWidth, mapHeight, cellSize),
  );
}

export function isWaterAt(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number = LAND_CELL_SIZE,
): boolean {
  const flatZone = findDepositFlatZoneAt(x, z);
  if (flatZone) return flatZone.height < WATER_LEVEL;
  return (
    getTerrainMeshHeight(x, z, mapWidth, mapHeight, cellSize) < WATER_LEVEL
  );
}

export function isFarFromWater(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  bufferPx: number,
): boolean {
  if (isWaterAt(x, z, mapWidth, mapHeight)) return false;
  if (bufferPx <= 0) return true;
  for (let i = 0; i < WATER_CLEARANCE_SAMPLES; i++) {
    const a = (i / WATER_CLEARANCE_SAMPLES) * Math.PI * 2;
    const px = x + Math.cos(a) * bufferPx;
    const pz = z + Math.sin(a) * bufferPx;
    if (isWaterAt(px, pz, mapWidth, mapHeight)) return false;
  }
  return true;
}
