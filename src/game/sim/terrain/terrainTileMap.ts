import type { TerrainTileMap } from '@/types/terrain';
import { LAND_CELL_SIZE } from '../../../config';
import { assertCanonicalLandCellSize } from '../../landGrid';
import {
  TERRAIN_CENTER_FAN_HEIGHT_THRESHOLD,
  TERRAIN_MESH_SUBDIV,
} from './terrainConfig';
import {
  getInstalledTerrainTileMap,
  getTerrainVersion,
  setAuthoritativeTerrainTileMap,
} from './terrainState';
import { getTerrainHeight } from './terrainHeightGenerator';

export { setAuthoritativeTerrainTileMap };

export type TerrainMeshSample = {
  u: number;
  v: number;
  subSize: number;
  h00: number;
  h10: number;
  h11: number;
  h01: number;
  hc: number;
  centerFan: boolean;
};

function terrainCellSize(cellSize: number | undefined): number {
  return cellSize !== undefined && cellSize > 0
    ? cellSize
    : LAND_CELL_SIZE;
}

export function buildTerrainTileMap(
  mapWidth: number,
  mapHeight: number,
  cellSize: number = LAND_CELL_SIZE,
): TerrainTileMap {
  // Terrain grid is canonical — see landGrid.CANONICAL_LAND_CELL_SIZE.
  // Any non-canonical caller is silently mis-aligning sim/render/host
  // grids; hard-fail in dev so drift can't slip through.
  assertCanonicalLandCellSize('buildTerrainTileMap cellSize', cellSize);
  const size = terrainCellSize(cellSize);
  const cellsX = Math.max(1, Math.ceil(mapWidth / size));
  const cellsY = Math.max(1, Math.ceil(mapHeight / size));
  const verticesX = cellsX * TERRAIN_MESH_SUBDIV + 1;
  const verticesY = cellsY * TERRAIN_MESH_SUBDIV + 1;
  const subSize = size / TERRAIN_MESH_SUBDIV;
  const heights = new Array<number>(verticesX * verticesY);
  const quadCount = (verticesX - 1) * (verticesY - 1);
  const centerHeights = new Array<number>(quadCount);
  const centerFanMask = new Array<number>(quadCount);

  for (let vy = 0; vy < verticesY; vy++) {
    const z = Math.min(mapHeight, vy * subSize);
    const rowOff = vy * verticesX;
    for (let vx = 0; vx < verticesX; vx++) {
      const x = Math.min(mapWidth, vx * subSize);
      heights[rowOff + vx] = getTerrainHeight(x, z, mapWidth, mapHeight);
    }
  }

  for (let qy = 0; qy < verticesY - 1; qy++) {
    const rowOff = qy * (verticesX - 1);
    for (let qx = 0; qx < verticesX - 1; qx++) {
      const idx = rowOff + qx;
      const h00 = terrainTileMapHeightAtVertexRaw(heights, verticesX, qx, qy);
      const h10 = terrainTileMapHeightAtVertexRaw(heights, verticesX, qx + 1, qy);
      const h11 = terrainTileMapHeightAtVertexRaw(heights, verticesX, qx + 1, qy + 1);
      const h01 = terrainTileMapHeightAtVertexRaw(heights, verticesX, qx, qy + 1);
      const hc = terrainCenterFanHeight(h00, h10, h11, h01);
      centerHeights[idx] = hc;
      centerFanMask[idx] = shouldUseTerrainCenterFan(h00, h10, h11, h01, hc) ? 1 : 0;
    }
  }

  return {
    mapWidth,
    mapHeight,
    cellSize: size,
    subdiv: TERRAIN_MESH_SUBDIV,
    cellsX,
    cellsY,
    verticesX,
    verticesY,
    version: getTerrainVersion(),
    heights,
    centerHeights,
    centerFanMask,
  };
}

function terrainTileMapHeightAtVertexRaw(
  heights: readonly number[],
  verticesX: number,
  vx: number,
  vy: number,
): number {
  return heights[vy * verticesX + vx] ?? 0;
}

function terrainTileMapHeightAtVertex(
  map: TerrainTileMap,
  vx: number,
  vy: number,
): number {
  const ix = Math.max(0, Math.min(map.verticesX - 1, vx));
  const iy = Math.max(0, Math.min(map.verticesY - 1, vy));
  return map.heights[iy * map.verticesX + ix] ?? 0;
}

function terrainTileMapCenterHeightAtQuad(
  map: TerrainTileMap,
  qx: number,
  qy: number,
): number {
  const quadsX = map.verticesX - 1;
  const ix = Math.max(0, Math.min(quadsX - 1, qx));
  const iy = Math.max(0, Math.min(map.verticesY - 2, qy));
  const idx = iy * quadsX + ix;
  const stored = (map.centerHeights as readonly number[] | undefined)?.[idx];
  if (stored !== undefined) return stored;
  const h00 = terrainTileMapHeightAtVertex(map, ix, iy);
  const h10 = terrainTileMapHeightAtVertex(map, ix + 1, iy);
  const h11 = terrainTileMapHeightAtVertex(map, ix + 1, iy + 1);
  const h01 = terrainTileMapHeightAtVertex(map, ix, iy + 1);
  return terrainCenterFanHeight(h00, h10, h11, h01);
}

function terrainTileMapUsesCenterFanAtQuad(
  map: TerrainTileMap,
  qx: number,
  qy: number,
): boolean {
  const quadsX = map.verticesX - 1;
  const ix = Math.max(0, Math.min(quadsX - 1, qx));
  const iy = Math.max(0, Math.min(map.verticesY - 2, qy));
  return ((map.centerFanMask as readonly number[] | undefined)?.[iy * quadsX + ix] ?? 0) > 0;
}

function clampToMeshExtent(
  value: number,
  cells: number,
  cellSize: number,
): number {
  const max = cells * cellSize;
  if (value <= 0) return 0;
  if (value >= max) return max;
  return value;
}

export function getTerrainMeshSample(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number = LAND_CELL_SIZE,
): TerrainMeshSample {
  assertCanonicalLandCellSize('getTerrainMeshSample cellSize', cellSize);
  const size = terrainCellSize(cellSize);
  const cellsX = Math.max(1, Math.ceil(mapWidth / size));
  const cellsZ = Math.max(1, Math.ceil(mapHeight / size));
  const px = clampToMeshExtent(x, cellsX, size);
  const pz = clampToMeshExtent(z, cellsZ, size);
  const cellX = Math.min(cellsX - 1, Math.max(0, Math.floor(px / size)));
  const cellZ = Math.min(cellsZ - 1, Math.max(0, Math.floor(pz / size)));
  const subSize = size / TERRAIN_MESH_SUBDIV;
  const localX = px - cellX * size;
  const localZ = pz - cellZ * size;
  const subX = Math.min(
    TERRAIN_MESH_SUBDIV - 1,
    Math.max(0, Math.floor(localX / subSize)),
  );
  const subZ = Math.min(
    TERRAIN_MESH_SUBDIV - 1,
    Math.max(0, Math.floor(localZ / subSize)),
  );
  const x0 = cellX * size + subX * subSize;
  const z0 = cellZ * size + subZ * subSize;
  const x1 = x0 + subSize;
  const z1 = z0 + subSize;
  const u = Math.max(0, Math.min(1, (px - x0) / subSize));
  const v = Math.max(0, Math.min(1, (pz - z0) / subSize));
  const installedMap = getInstalledTerrainTileMap(mapWidth, mapHeight, size);

  if (installedMap) {
    const vx = cellX * TERRAIN_MESH_SUBDIV + subX;
    const vz = cellZ * TERRAIN_MESH_SUBDIV + subZ;
    return {
      u,
      v,
      subSize,
      h00: terrainTileMapHeightAtVertex(installedMap, vx, vz),
      h10: terrainTileMapHeightAtVertex(installedMap, vx + 1, vz),
      h11: terrainTileMapHeightAtVertex(installedMap, vx + 1, vz + 1),
      h01: terrainTileMapHeightAtVertex(installedMap, vx, vz + 1),
      hc: terrainTileMapCenterHeightAtQuad(installedMap, vx, vz),
      centerFan: terrainTileMapUsesCenterFanAtQuad(installedMap, vx, vz),
    };
  }

  const h00 = getTerrainHeight(x0, z0, mapWidth, mapHeight);
  const h10 = getTerrainHeight(x1, z0, mapWidth, mapHeight);
  const h11 = getTerrainHeight(x1, z1, mapWidth, mapHeight);
  const h01 = getTerrainHeight(x0, z1, mapWidth, mapHeight);
  const hc = terrainCenterFanHeight(h00, h10, h11, h01);
  return {
    u,
    v,
    subSize,
    h00,
    h10,
    h11,
    h01,
    hc,
    centerFan: shouldUseTerrainCenterFan(h00, h10, h11, h01, hc),
  };
}

export function terrainCenterFanHeight(
  h00: number,
  h10: number,
  h11: number,
  h01: number,
): number {
  return (h00 + h10 + h11 + h01) * 0.25;
}

export function shouldUseTerrainCenterFan(
  h00: number,
  h10: number,
  h11: number,
  h01: number,
  hc: number = terrainCenterFanHeight(h00, h10, h11, h01),
  threshold: number = TERRAIN_CENTER_FAN_HEIGHT_THRESHOLD,
): boolean {
  const fixedDiagonalCenter = (h00 + h11) * 0.5;
  const oppositeDiagonalCenter = (h10 + h01) * 0.5;
  return Math.max(
    Math.abs(hc - fixedDiagonalCenter),
    Math.abs(hc - oppositeDiagonalCenter),
  ) > threshold;
}

export function interpolateTerrainMeshQuadHeight(
  u: number,
  v: number,
  h00: number,
  h10: number,
  h11: number,
  h01: number,
  hc: number = (h00 + h11) * 0.5,
  centerFan: boolean = false,
): number {
  if (centerFan) {
    if (v <= u && v <= 1 - u) {
      return (1 - u - v) * h00 + (u - v) * h10 + (2 * v) * hc;
    }
    if (u >= v && u >= 1 - v) {
      return (u - v) * h10 + (u + v - 1) * h11 + (2 * (1 - u)) * hc;
    }
    if (v >= u && v >= 1 - u) {
      return (u + v - 1) * h11 + (v - u) * h01 + (2 * (1 - v)) * hc;
    }
    return (v - u) * h01 + (1 - v - u) * h00 + (2 * u) * hc;
  }
  if (u >= v) {
    return (1 - u) * h00 + (u - v) * h10 + v * h11;
  }
  return (1 - v) * h00 + u * h11 + (v - u) * h01;
}

export function terrainMeshHeightFromSample(sample: TerrainMeshSample): number {
  return interpolateTerrainMeshQuadHeight(
    sample.u,
    sample.v,
    sample.h00,
    sample.h10,
    sample.h11,
    sample.h01,
    sample.hc,
    sample.centerFan,
  );
}

export function terrainMeshNormalFromSample(sample: TerrainMeshSample): {
  nx: number;
  ny: number;
  nz: number;
} {
  const { u, v, subSize, h00, h10, h11, h01, hc, centerFan } = sample;
  let dHdx: number;
  let dHdz: number;
  if (centerFan) {
    if (v <= u && v <= 1 - u) {
      dHdx = (h10 - h00) / subSize;
      dHdz = (-h00 - h10 + 2 * hc) / subSize;
    } else if (u >= v && u >= 1 - v) {
      dHdx = (h10 + h11 - 2 * hc) / subSize;
      dHdz = (h11 - h10) / subSize;
    } else if (v >= u && v >= 1 - u) {
      dHdx = (h11 - h01) / subSize;
      dHdz = (h11 + h01 - 2 * hc) / subSize;
    } else {
      dHdx = (-h01 - h00 + 2 * hc) / subSize;
      dHdz = (h01 - h00) / subSize;
    }
  } else {
    dHdx = u >= v ? (h10 - h00) / subSize : (h11 - h01) / subSize;
    dHdz = u >= v ? (h11 - h10) / subSize : (h01 - h00) / subSize;
  }
  const nx = -dHdx;
  const ny = -dHdz;
  const nz = 1;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  return { nx: nx / len, ny: ny / len, nz: nz / len };
}

export function getTerrainMeshHeight(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number = LAND_CELL_SIZE,
): number {
  return terrainMeshHeightFromSample(
    getTerrainMeshSample(x, z, mapWidth, mapHeight, cellSize),
  );
}

export function getTerrainMeshNormal(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number = LAND_CELL_SIZE,
): { nx: number; ny: number; nz: number } {
  return terrainMeshNormalFromSample(
    getTerrainMeshSample(x, z, mapWidth, mapHeight, cellSize),
  );
}
