import type { TerrainTileMap } from '@/types/terrain';
import { LAND_CELL_SIZE } from '../../../config';
import { assertCanonicalLandCellSize } from '../../landGrid';
import {
  TERRAIN_ADAPTIVE_MAX_HEIGHT_ERROR,
  TERRAIN_CENTER_FAN_HEIGHT_THRESHOLD,
  TERRAIN_MESH_SUBDIV,
  TERRAIN_SMOOTHING_LAMBDA_Y,
  WATER_LEVEL,
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

type TerrainQuadHeights = {
  h00: number;
  h10: number;
  h11: number;
  h01: number;
  hc: number;
  centerFan: boolean;
};

const adaptiveQuadCache = new WeakMap<TerrainTileMap, Map<number, TerrainQuadHeights>>();

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
      centerHeights[idx] = terrainCenterFanHeight(h00, h10, h11, h01);
    }
  }

  smoothTerrainTriangleVerticesInPlace(
    heights,
    centerHeights,
    verticesX,
    verticesY,
    TERRAIN_SMOOTHING_LAMBDA_Y,
  );

  for (let qy = 0; qy < verticesY - 1; qy++) {
    const rowOff = qy * (verticesX - 1);
    for (let qx = 0; qx < verticesX - 1; qx++) {
      const idx = rowOff + qx;
      const h00 = terrainTileMapHeightAtVertexFromArrays(
        heights,
        verticesX,
        verticesY,
        TERRAIN_MESH_SUBDIV,
        qx,
        qy,
      );
      const h10 = terrainTileMapHeightAtVertexFromArrays(
        heights,
        verticesX,
        verticesY,
        TERRAIN_MESH_SUBDIV,
        qx + 1,
        qy,
      );
      const h11 = terrainTileMapHeightAtVertexFromArrays(
        heights,
        verticesX,
        verticesY,
        TERRAIN_MESH_SUBDIV,
        qx + 1,
        qy + 1,
      );
      const h01 = terrainTileMapHeightAtVertexFromArrays(
        heights,
        verticesX,
        verticesY,
        TERRAIN_MESH_SUBDIV,
        qx,
        qy + 1,
      );
      centerFanMask[idx] = shouldUseTerrainCenterFan(h00, h10, h11, h01, centerHeights[idx]) ? 1 : 0;
    }
  }

  const tileSubdivisions = buildAdaptiveTerrainTileSubdivisions(
    heights,
    centerHeights,
    centerFanMask,
    verticesX,
    verticesY,
    cellsX,
    cellsY,
    TERRAIN_MESH_SUBDIV,
  );

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
    tileSubdivisions,
  };
}

/** One Jacobi-style Laplacian pass over the triangle-vertex set
 *  (heightmap corners + per-quad center vertices). Each vertex pulls
 *  toward the mean height of every other vertex it shares a triangle
 *  edge with: corners ↔ 4 cardinal corners + up to 4 surrounding
 *  centers; centers ↔ their 4 corners. X/Z neighborhoods are
 *  symmetric on the regular grid, so only Y is persisted. */
function smoothTerrainTriangleVerticesInPlace(
  heights: number[],
  centerHeights: number[],
  verticesX: number,
  verticesY: number,
  lambdaY: number,
): void {
  if (lambdaY <= 0) return;
  const quadsX = verticesX - 1;
  const quadsY = verticesY - 1;
  const newCorner = new Array<number>(heights.length);
  const newCenter = new Array<number>(centerHeights.length);

  for (let vy = 0; vy < verticesY; vy++) {
    for (let vx = 0; vx < verticesX; vx++) {
      const idx = vy * verticesX + vx;
      let sum = 0;
      let count = 0;
      if (vx > 0) { sum += heights[idx - 1]; count++; }
      if (vx < verticesX - 1) { sum += heights[idx + 1]; count++; }
      if (vy > 0) { sum += heights[idx - verticesX]; count++; }
      if (vy < verticesY - 1) { sum += heights[idx + verticesX]; count++; }
      for (let dy = -1; dy <= 0; dy++) {
        const qy = vy + dy;
        if (qy < 0 || qy >= quadsY) continue;
        for (let dx = -1; dx <= 0; dx++) {
          const qx = vx + dx;
          if (qx < 0 || qx >= quadsX) continue;
          sum += centerHeights[qy * quadsX + qx];
          count++;
        }
      }
      const h = heights[idx];
      newCorner[idx] = count > 0 ? h + lambdaY * (sum / count - h) : h;
    }
  }

  for (let qy = 0; qy < quadsY; qy++) {
    for (let qx = 0; qx < quadsX; qx++) {
      const idx = qy * quadsX + qx;
      const h00 = heights[qy * verticesX + qx];
      const h10 = heights[qy * verticesX + qx + 1];
      const h11 = heights[(qy + 1) * verticesX + qx + 1];
      const h01 = heights[(qy + 1) * verticesX + qx];
      const mean = (h00 + h10 + h11 + h01) * 0.25;
      const h = centerHeights[idx];
      newCenter[idx] = h + lambdaY * (mean - h);
    }
  }

  for (let i = 0; i < heights.length; i++) heights[i] = newCorner[i];
  for (let i = 0; i < centerHeights.length; i++) centerHeights[i] = newCenter[i];
}

function terrainTileMapHeightAtVertexRaw(
  heights: readonly number[],
  verticesX: number,
  vx: number,
  vy: number,
): number {
  return heights[vy * verticesX + vx] ?? 0;
}

function terrainTileMapHeightAtVertexFromArrays(
  heights: readonly number[],
  verticesX: number,
  verticesY: number,
  maxSubdiv: number,
  vx: number,
  vy: number,
): number {
  const subdiv = Math.max(1, maxSubdiv | 0);
  const ix = vx >= 0 && vx < verticesX ? vx : Math.max(0, Math.min(verticesX - 1, vx));
  const iy = vy >= 0 && vy < verticesY ? vy : Math.max(0, Math.min(verticesY - 1, vy));
  if (subdiv > 1) {
    const onLandX = ix % subdiv === 0;
    const onLandY = iy % subdiv === 0;
    if (onLandX === onLandY) {
      return terrainTileMapHeightAtVertexRaw(heights, verticesX, ix, iy);
    }
    if (onLandX && !onLandY) {
      const y0 = Math.floor(iy / subdiv) * subdiv;
      const y1 = Math.min(verticesY - 1, y0 + subdiv);
      const t = y1 > y0 ? (iy - y0) / (y1 - y0) : 0;
      const h0 = terrainTileMapHeightAtVertexRaw(heights, verticesX, ix, y0);
      const h1 = terrainTileMapHeightAtVertexRaw(heights, verticesX, ix, y1);
      return h0 + (h1 - h0) * t;
    }
    const x0 = Math.floor(ix / subdiv) * subdiv;
    const x1 = Math.min(verticesX - 1, x0 + subdiv);
    const t = x1 > x0 ? (ix - x0) / (x1 - x0) : 0;
    const h0 = terrainTileMapHeightAtVertexRaw(heights, verticesX, x0, iy);
    const h1 = terrainTileMapHeightAtVertexRaw(heights, verticesX, x1, iy);
    return h0 + (h1 - h0) * t;
  }
  return terrainTileMapHeightAtVertexRaw(heights, verticesX, ix, iy);
}

function terrainTileMapHeightAtVertex(
  map: TerrainTileMap,
  vx: number,
  vy: number,
): number {
  return terrainTileMapHeightAtVertexFromArrays(
    map.heights,
    map.verticesX,
    map.verticesY,
    map.subdiv,
    vx,
    vy,
  );
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

function normalizeTerrainTileSubdivision(raw: number | undefined, maxSubdiv: number): number {
  const max = Math.max(1, maxSubdiv | 0);
  return Math.max(1, Math.min(max, Math.round(raw ?? max)));
}

function terrainTileSubdivisionAtMapCell(
  map: TerrainTileMap,
  cellX: number,
  cellY: number,
): number {
  const cx = Math.max(0, Math.min(map.cellsX - 1, cellX));
  const cy = Math.max(0, Math.min(map.cellsY - 1, cellY));
  const raw = (map.tileSubdivisions as readonly number[] | undefined)?.[cy * map.cellsX + cx];
  return normalizeTerrainTileSubdivision(raw, map.subdiv);
}

export function getTerrainTileSubdivisionAtCell(
  cellX: number,
  cellY: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number = LAND_CELL_SIZE,
): number {
  assertCanonicalLandCellSize('getTerrainTileSubdivisionAtCell cellSize', cellSize);
  const size = terrainCellSize(cellSize);
  const map = getInstalledTerrainTileMap(mapWidth, mapHeight, size);
  if (!map) return TERRAIN_MESH_SUBDIV;
  return terrainTileSubdivisionAtMapCell(map, cellX, cellY);
}

function terrainSubdivisionCandidates(maxSubdiv: number): number[] {
  const max = Math.max(1, maxSubdiv | 0);
  const candidates: number[] = [];
  for (let subdiv = 1; subdiv <= max; subdiv++) {
    candidates.push(subdiv);
  }
  return candidates;
}

function terrainCellSurfaceHeightFromArrays(
  heights: readonly number[],
  centerHeights: readonly number[],
  centerFanMask: readonly number[],
  verticesX: number,
  verticesY: number,
  maxSubdiv: number,
  cellX: number,
  cellY: number,
  candidateSubdiv: number,
  fx: number,
  fz: number,
): number {
  const subdiv = normalizeTerrainTileSubdivision(candidateSubdiv, maxSubdiv);
  if (subdiv === maxSubdiv) {
    return terrainFullSurfaceHeightFromArrays(
      heights,
      centerHeights,
      centerFanMask,
      verticesX,
      verticesY,
      maxSubdiv,
      cellX,
      cellY,
      fx,
      fz,
    );
  }
  const localX = Math.max(0, Math.min(1, fx));
  const localZ = Math.max(0, Math.min(1, fz));
  const subX = Math.min(subdiv - 1, Math.max(0, Math.floor(localX * subdiv)));
  const subZ = Math.min(subdiv - 1, Math.max(0, Math.floor(localZ * subdiv)));
  const u = Math.max(0, Math.min(1, localX * subdiv - subX));
  const v = Math.max(0, Math.min(1, localZ * subdiv - subZ));
  const fx0 = subX / subdiv;
  const fz0 = subZ / subdiv;
  const fx1 = (subX + 1) / subdiv;
  const fz1 = (subZ + 1) / subdiv;
  const h00 = terrainFullSurfaceHeightFromArrays(
    heights,
    centerHeights,
    centerFanMask,
    verticesX,
    verticesY,
    maxSubdiv,
    cellX,
    cellY,
    fx0,
    fz0,
  );
  const h10 = terrainFullSurfaceHeightFromArrays(
    heights,
    centerHeights,
    centerFanMask,
    verticesX,
    verticesY,
    maxSubdiv,
    cellX,
    cellY,
    fx1,
    fz0,
  );
  const h11 = terrainFullSurfaceHeightFromArrays(
    heights,
    centerHeights,
    centerFanMask,
    verticesX,
    verticesY,
    maxSubdiv,
    cellX,
    cellY,
    fx1,
    fz1,
  );
  const h01 = terrainFullSurfaceHeightFromArrays(
    heights,
    centerHeights,
    centerFanMask,
    verticesX,
    verticesY,
    maxSubdiv,
    cellX,
    cellY,
    fx0,
    fz1,
  );
  const hc = terrainFullSurfaceHeightFromArrays(
    heights,
    centerHeights,
    centerFanMask,
    verticesX,
    verticesY,
    maxSubdiv,
    cellX,
    cellY,
    (fx0 + fx1) * 0.5,
    (fz0 + fz1) * 0.5,
  );
  const centerFan = shouldUseTerrainCenterFan(h00, h10, h11, h01, hc);
  return interpolateTerrainMeshQuadHeight(u, v, h00, h10, h11, h01, hc, centerFan);
}

function terrainFullSurfaceHeightFromArrays(
  heights: readonly number[],
  centerHeights: readonly number[],
  centerFanMask: readonly number[],
  verticesX: number,
  verticesY: number,
  maxSubdiv: number,
  cellX: number,
  cellY: number,
  fx: number,
  fz: number,
): number {
  const subdiv = Math.max(1, maxSubdiv | 0);
  const localX = Math.max(0, Math.min(1, fx));
  const localZ = Math.max(0, Math.min(1, fz));
  const subX = Math.min(subdiv - 1, Math.max(0, Math.floor(localX * subdiv)));
  const subZ = Math.min(subdiv - 1, Math.max(0, Math.floor(localZ * subdiv)));
  const u = Math.max(0, Math.min(1, localX * subdiv - subX));
  const v = Math.max(0, Math.min(1, localZ * subdiv - subZ));
  const qx = cellX * subdiv + subX;
  const qy = cellY * subdiv + subZ;
  const h00 = terrainTileMapHeightAtVertexFromArrays(
    heights,
    verticesX,
    verticesY,
    subdiv,
    qx,
    qy,
  );
  const h10 = terrainTileMapHeightAtVertexFromArrays(
    heights,
    verticesX,
    verticesY,
    subdiv,
    qx + 1,
    qy,
  );
  const h11 = terrainTileMapHeightAtVertexFromArrays(
    heights,
    verticesX,
    verticesY,
    subdiv,
    qx + 1,
    qy + 1,
  );
  const h01 = terrainTileMapHeightAtVertexFromArrays(
    heights,
    verticesX,
    verticesY,
    subdiv,
    qx,
    qy + 1,
  );
  const quadIdx = qy * (verticesX - 1) + qx;
  const hc = centerHeights[quadIdx] ?? terrainCenterFanHeight(h00, h10, h11, h01);
  const centerFan = (centerFanMask[quadIdx] ?? 0) > 0;
  return interpolateTerrainMeshQuadHeight(u, v, h00, h10, h11, h01, hc, centerFan);
}

function terrainCellSimplificationError(
  heights: readonly number[],
  centerHeights: readonly number[],
  centerFanMask: readonly number[],
  verticesX: number,
  verticesY: number,
  maxSubdiv: number,
  cellX: number,
  cellY: number,
  candidateSubdiv: number,
  maxAllowedError: number,
): number {
  let maxError = 0;
  const checkPoint = (fx: number, fz: number): boolean => {
    const actual = terrainCellSurfaceHeightFromArrays(
      heights,
      centerHeights,
      centerFanMask,
      verticesX,
      verticesY,
      maxSubdiv,
      cellX,
      cellY,
      maxSubdiv,
      fx,
      fz,
    );
    const approx = terrainCellSurfaceHeightFromArrays(
      heights,
      centerHeights,
      centerFanMask,
      verticesX,
      verticesY,
      maxSubdiv,
      cellX,
      cellY,
      candidateSubdiv,
      fx,
      fz,
    );
    if ((actual < WATER_LEVEL) !== (approx < WATER_LEVEL)) {
      maxError = Number.POSITIVE_INFINITY;
      return true;
    }
    maxError = Math.max(maxError, Math.abs(actual - approx));
    return maxError > maxAllowedError;
  };

  for (let iy = 0; iy <= maxSubdiv; iy++) {
    const fz = iy / maxSubdiv;
    for (let ix = 0; ix <= maxSubdiv; ix++) {
      if (checkPoint(ix / maxSubdiv, fz)) return maxError;
    }
  }
  for (let iy = 0; iy < maxSubdiv; iy++) {
    const fz = (iy + 0.5) / maxSubdiv;
    for (let ix = 0; ix < maxSubdiv; ix++) {
      if (checkPoint((ix + 0.5) / maxSubdiv, fz)) return maxError;
    }
  }
  return maxError;
}

function buildAdaptiveTerrainTileSubdivisions(
  heights: readonly number[],
  centerHeights: readonly number[],
  centerFanMask: readonly number[],
  verticesX: number,
  verticesY: number,
  cellsX: number,
  cellsY: number,
  maxSubdiv: number,
): number[] {
  const fullSubdiv = Math.max(1, maxSubdiv | 0);
  const tileSubdivisions = new Array<number>(cellsX * cellsY);
  if (fullSubdiv <= 1) {
    tileSubdivisions.fill(1);
    return tileSubdivisions;
  }

  const candidates = terrainSubdivisionCandidates(fullSubdiv);
  for (let cy = 0; cy < cellsY; cy++) {
    for (let cx = 0; cx < cellsX; cx++) {
      let chosen = fullSubdiv;
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        if (candidate >= fullSubdiv) {
          chosen = fullSubdiv;
          break;
        }
        const error = terrainCellSimplificationError(
          heights,
          centerHeights,
          centerFanMask,
          verticesX,
          verticesY,
          fullSubdiv,
          cx,
          cy,
          candidate,
          TERRAIN_ADAPTIVE_MAX_HEIGHT_ERROR,
        );
        if (error <= TERRAIN_ADAPTIVE_MAX_HEIGHT_ERROR) {
          chosen = candidate;
          break;
        }
      }
      tileSubdivisions[cy * cellsX + cx] = chosen;
    }
  }
  return tileSubdivisions;
}

function terrainTileMapQuadAtAdaptiveSubdiv(
  map: TerrainTileMap,
  cellX: number,
  cellY: number,
  tileSubdiv: number,
  subX: number,
  subY: number,
): TerrainQuadHeights {
  const subdiv = normalizeTerrainTileSubdivision(tileSubdiv, map.subdiv);
  if (subdiv === map.subdiv) {
    const qx = cellX * map.subdiv + subX;
    const qy = cellY * map.subdiv + subY;
    const h00 = terrainTileMapHeightAtVertex(map, qx, qy);
    const h10 = terrainTileMapHeightAtVertex(map, qx + 1, qy);
    const h11 = terrainTileMapHeightAtVertex(map, qx + 1, qy + 1);
    const h01 = terrainTileMapHeightAtVertex(map, qx, qy + 1);
    return {
      h00,
      h10,
      h11,
      h01,
      hc: terrainTileMapCenterHeightAtQuad(map, qx, qy),
      centerFan: terrainTileMapUsesCenterFanAtQuad(map, qx, qy),
    };
  }

  let cache = adaptiveQuadCache.get(map);
  if (!cache) {
    cache = new Map<number, TerrainQuadHeights>();
    adaptiveQuadCache.set(map, cache);
  }
  const stride = map.subdiv + 1;
  const key = (((cellY * map.cellsX + cellX) * stride + subdiv) * stride + subY) * stride + subX;
  const cached = cache.get(key);
  if (cached) return cached;

  const fx0 = subX / subdiv;
  const fy0 = subY / subdiv;
  const fx1 = (subX + 1) / subdiv;
  const fy1 = (subY + 1) / subdiv;
  const h00 = terrainFullSurfaceHeightFromArrays(
    map.heights,
    map.centerHeights,
    map.centerFanMask,
    map.verticesX,
    map.verticesY,
    map.subdiv,
    cellX,
    cellY,
    fx0,
    fy0,
  );
  const h10 = terrainFullSurfaceHeightFromArrays(
    map.heights,
    map.centerHeights,
    map.centerFanMask,
    map.verticesX,
    map.verticesY,
    map.subdiv,
    cellX,
    cellY,
    fx1,
    fy0,
  );
  const h11 = terrainFullSurfaceHeightFromArrays(
    map.heights,
    map.centerHeights,
    map.centerFanMask,
    map.verticesX,
    map.verticesY,
    map.subdiv,
    cellX,
    cellY,
    fx1,
    fy1,
  );
  const h01 = terrainFullSurfaceHeightFromArrays(
    map.heights,
    map.centerHeights,
    map.centerFanMask,
    map.verticesX,
    map.verticesY,
    map.subdiv,
    cellX,
    cellY,
    fx0,
    fy1,
  );
  const hc = terrainFullSurfaceHeightFromArrays(
    map.heights,
    map.centerHeights,
    map.centerFanMask,
    map.verticesX,
    map.verticesY,
    map.subdiv,
    cellX,
    cellY,
    (fx0 + fx1) * 0.5,
    (fy0 + fy1) * 0.5,
  );
  const quad = {
    h00,
    h10,
    h11,
    h01,
    hc,
    centerFan: shouldUseTerrainCenterFan(h00, h10, h11, h01, hc),
  };
  cache.set(key, quad);
  return quad;
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
  const localX = px - cellX * size;
  const localZ = pz - cellZ * size;
  const installedMap = getInstalledTerrainTileMap(mapWidth, mapHeight, size);

  if (installedMap) {
    const tileSubdiv = terrainTileSubdivisionAtMapCell(installedMap, cellX, cellZ);
    const subSize = size / tileSubdiv;
    const subX = Math.min(
      tileSubdiv - 1,
      Math.max(0, Math.floor(localX / subSize)),
    );
    const subZ = Math.min(
      tileSubdiv - 1,
      Math.max(0, Math.floor(localZ / subSize)),
    );
    const x0 = cellX * size + subX * subSize;
    const z0 = cellZ * size + subZ * subSize;
    const u = Math.max(0, Math.min(1, (px - x0) / subSize));
    const v = Math.max(0, Math.min(1, (pz - z0) / subSize));
    const quad = terrainTileMapQuadAtAdaptiveSubdiv(
      installedMap,
      cellX,
      cellZ,
      tileSubdiv,
      subX,
      subZ,
    );
    return {
      u,
      v,
      subSize,
      h00: quad.h00,
      h10: quad.h10,
      h11: quad.h11,
      h01: quad.h01,
      hc: quad.hc,
      centerFan: quad.centerFan,
    };
  }

  const subSize = size / TERRAIN_MESH_SUBDIV;
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
