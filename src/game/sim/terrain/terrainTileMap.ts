import type { TerrainTileMap } from '@/types/terrain';
import { LAND_CELL_SIZE } from '../../../config';
import { assertCanonicalLandCellSize } from '../../landGrid';
import {
  TERRAIN_ADAPTIVE_MAX_HEIGHT_ERROR,
  TERRAIN_CENTER_FAN_HEIGHT_THRESHOLD,
  TERRAIN_MESH_SUBDIV,
  WATER_LEVEL,
} from './terrainConfig';
import {
  getAuthoritativeTerrainTileMap,
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
  triangle?: TerrainTriangleSample;
};

export type TerrainTileMeshView = {
  vertexOffset: number;
  vertexCount: number;
  triangleOffset: number;
  triangleCount: number;
  vertexCoords: readonly number[];
  vertexHeights: readonly number[];
  triangleIndices: readonly number[];
};

type TerrainTriangleSample = {
  ax: number;
  az: number;
  ah: number;
  bx: number;
  bz: number;
  bh: number;
  cx: number;
  cz: number;
  ch: number;
  wa: number;
  wb: number;
  wc: number;
};

type LocalMeshVertex = {
  fx: number;
  fz: number;
  h: number;
};

const TERRAIN_TILE_EDGE_NORTH = 0;
const TERRAIN_TILE_EDGE_EAST = 1;
const TERRAIN_TILE_EDGE_SOUTH = 2;
const TERRAIN_TILE_EDGE_WEST = 3;
const TERRAIN_MESH_EPSILON = 1e-7;

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
  const maxSubdiv = Math.max(1, TERRAIN_MESH_SUBDIV | 0);
  const subSize = size / maxSubdiv;
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

  // Center-fan topology is disabled: all authoritative sub-quads use the
  // normal two-triangle diagonal split. The legacy center arrays stay in the
  // snapshot so older consumers see a complete map shape, but the mask is zero.
  for (let qy = 0; qy < verticesY - 1; qy++) {
    const rowOff = qy * (verticesX - 1);
    for (let qx = 0; qx < verticesX - 1; qx++) {
      const idx = rowOff + qx;
      const h00 = terrainTileMapHeightAtVertexRaw(heights, verticesX, qx, qy);
      const h10 = terrainTileMapHeightAtVertexRaw(heights, verticesX, qx + 1, qy);
      const h11 = terrainTileMapHeightAtVertexRaw(heights, verticesX, qx + 1, qy + 1);
      const h01 = terrainTileMapHeightAtVertexRaw(heights, verticesX, qx, qy + 1);
      centerHeights[idx] = terrainCenterFanHeight(h00, h10, h11, h01);
      centerFanMask[idx] = 0;
    }
  }

  const tileSubdivisions = buildAdaptiveTerrainTileSubdivisions(
    mapWidth,
    mapHeight,
    size,
    cellsX,
    cellsY,
    maxSubdiv,
  );
  const {
    tileEdgeSubdivisions,
    tileVertexOffsets,
    tileVertexCoords,
    tileVertexHeights,
    tileTriangleOffsets,
    tileTriangleIndices,
  } = buildAdaptiveTerrainTileMeshes(
    mapWidth,
    mapHeight,
    size,
    cellsX,
    cellsY,
    maxSubdiv,
    tileSubdivisions,
  );

  return {
    mapWidth,
    mapHeight,
    cellSize: size,
    subdiv: maxSubdiv,
    cellsX,
    cellsY,
    verticesX,
    verticesY,
    version: getTerrainVersion(),
    heights,
    centerHeights,
    centerFanMask,
    tileSubdivisions,
    tileEdgeSubdivisions,
    tileVertexOffsets,
    tileVertexCoords,
    tileVertexHeights,
    tileTriangleOffsets,
    tileTriangleIndices,
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

function clamp01(value: number): number {
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

function generatedTerrainHeightAtCellFraction(
  mapWidth: number,
  mapHeight: number,
  cellSize: number,
  cellX: number,
  cellY: number,
  fx: number,
  fz: number,
): number {
  const x = Math.min(mapWidth, Math.max(0, (cellX + clamp01(fx)) * cellSize));
  const z = Math.min(mapHeight, Math.max(0, (cellY + clamp01(fz)) * cellSize));
  return getTerrainHeight(x, z, mapWidth, mapHeight);
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
    if (max % subdiv === 0) candidates.push(subdiv);
  }
  return candidates;
}

function greatestCommonDivisor(a: number, b: number): number {
  let x = Math.max(1, Math.abs(a | 0));
  let y = Math.max(1, Math.abs(b | 0));
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
}

function leastCommonMultiple(a: number, b: number): number {
  const x = Math.max(1, a | 0);
  const y = Math.max(1, b | 0);
  return Math.abs((x / greatestCommonDivisor(x, y)) * y);
}

function terrainCellSurfaceHeightFromGenerator(
  mapWidth: number,
  mapHeight: number,
  cellSize: number,
  maxSubdiv: number,
  cellX: number,
  cellY: number,
  candidateSubdiv: number,
  fx: number,
  fz: number,
): number {
  const subdiv = normalizeTerrainTileSubdivision(candidateSubdiv, maxSubdiv);
  const localX = clamp01(fx);
  const localZ = clamp01(fz);
  const subX = Math.min(subdiv - 1, Math.max(0, Math.floor(localX * subdiv)));
  const subZ = Math.min(subdiv - 1, Math.max(0, Math.floor(localZ * subdiv)));
  const u = clamp01(localX * subdiv - subX);
  const v = clamp01(localZ * subdiv - subZ);
  const fx0 = subX / subdiv;
  const fz0 = subZ / subdiv;
  const fx1 = (subX + 1) / subdiv;
  const fz1 = (subZ + 1) / subdiv;
  const h00 = generatedTerrainHeightAtCellFraction(
    mapWidth,
    mapHeight,
    cellSize,
    cellX,
    cellY,
    fx0,
    fz0,
  );
  const h10 = generatedTerrainHeightAtCellFraction(
    mapWidth,
    mapHeight,
    cellSize,
    cellX,
    cellY,
    fx1,
    fz0,
  );
  const h11 = generatedTerrainHeightAtCellFraction(
    mapWidth,
    mapHeight,
    cellSize,
    cellX,
    cellY,
    fx1,
    fz1,
  );
  const h01 = generatedTerrainHeightAtCellFraction(
    mapWidth,
    mapHeight,
    cellSize,
    cellX,
    cellY,
    fx0,
    fz1,
  );
  return interpolateTerrainMeshQuadHeight(
    u,
    v,
    h00,
    h10,
    h11,
    h01,
    terrainCenterFanHeight(h00, h10, h11, h01),
    false,
  );
}

function terrainCellSimplificationError(
  mapWidth: number,
  mapHeight: number,
  cellSize: number,
  maxSubdiv: number,
  cellX: number,
  cellY: number,
  candidateSubdiv: number,
  maxAllowedError: number,
): number {
  let maxError = 0;
  const checkPoint = (fx: number, fz: number): boolean => {
    const actual = generatedTerrainHeightAtCellFraction(
      mapWidth,
      mapHeight,
      cellSize,
      cellX,
      cellY,
      fx,
      fz,
    );
    const approx = terrainCellSurfaceHeightFromGenerator(
      mapWidth,
      mapHeight,
      cellSize,
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

  const sampleSubdiv = Math.max(1, maxSubdiv * 2);
  for (let iy = 0; iy <= sampleSubdiv; iy++) {
    const fz = iy / sampleSubdiv;
    for (let ix = 0; ix <= sampleSubdiv; ix++) {
      if (checkPoint(ix / sampleSubdiv, fz)) return maxError;
    }
  }
  for (let iy = 0; iy < sampleSubdiv; iy++) {
    const fz = (iy + 0.5) / sampleSubdiv;
    for (let ix = 0; ix < sampleSubdiv; ix++) {
      if (checkPoint((ix + 0.5) / sampleSubdiv, fz)) return maxError;
    }
  }
  return maxError;
}

function buildAdaptiveTerrainTileSubdivisions(
  mapWidth: number,
  mapHeight: number,
  cellSize: number,
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
          mapWidth,
          mapHeight,
          cellSize,
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

function terrainTileBaseSubdivision(
  tileSubdivisions: readonly number[],
  cellsX: number,
  cellsY: number,
  cellX: number,
  cellY: number,
  maxSubdiv: number,
): number {
  if (cellX < 0 || cellX >= cellsX || cellY < 0 || cellY >= cellsY) return 0;
  return normalizeTerrainTileSubdivision(tileSubdivisions[cellY * cellsX + cellX], maxSubdiv);
}

function terrainTouchingEdgeSubdivision(
  selfSubdiv: number,
  neighborSubdiv: number,
  maxSubdiv: number,
): number {
  if (neighborSubdiv <= 0) return selfSubdiv;
  return Math.min(maxSubdiv, leastCommonMultiple(selfSubdiv, neighborSubdiv));
}

function terrainCoordKey(fx: number, fz: number): string {
  return `${Math.round(clamp01(fx) * 1_000_000_000)}:${Math.round(clamp01(fz) * 1_000_000_000)}`;
}

function terrainTriangleArea2(
  vertices: readonly LocalMeshVertex[],
  a: number,
  b: number,
  c: number,
): number {
  const va = vertices[a];
  const vb = vertices[b];
  const vc = vertices[c];
  return (vb.fx - va.fx) * (vc.fz - va.fz) - (vb.fz - va.fz) * (vc.fx - va.fx);
}

function triangulateConvexLocalPolygon(
  vertices: readonly LocalMeshVertex[],
  polygon: readonly number[],
  out: number[],
): void {
  const remaining: number[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const id = polygon[i];
    if (remaining[remaining.length - 1] !== id) remaining.push(id);
  }
  if (remaining.length > 1 && remaining[0] === remaining[remaining.length - 1]) {
    remaining.pop();
  }

  while (remaining.length > 3) {
    let ear = -1;
    for (let i = 0; i < remaining.length; i++) {
      const prev = remaining[(i + remaining.length - 1) % remaining.length];
      const curr = remaining[i];
      const next = remaining[(i + 1) % remaining.length];
      if (Math.abs(terrainTriangleArea2(vertices, prev, curr, next)) > TERRAIN_MESH_EPSILON) {
        ear = i;
        out.push(prev, curr, next);
        break;
      }
    }
    if (ear < 0) return;
    remaining.splice(ear, 1);
  }

  if (
    remaining.length === 3 &&
    Math.abs(terrainTriangleArea2(vertices, remaining[0], remaining[1], remaining[2])) >
      TERRAIN_MESH_EPSILON
  ) {
    out.push(remaining[0], remaining[1], remaining[2]);
  }
}

function buildTerrainTileLocalMesh(
  mapWidth: number,
  mapHeight: number,
  cellSize: number,
  cellX: number,
  cellY: number,
  baseSubdiv: number,
  northSubdiv: number,
  eastSubdiv: number,
  southSubdiv: number,
  westSubdiv: number,
): {
  vertices: LocalMeshVertex[];
  triangles: number[];
} {
  const vertices: LocalMeshVertex[] = [];
  const vertexIds = new Map<string, number>();
  const addVertex = (fxRaw: number, fzRaw: number): number => {
    const fx = clamp01(fxRaw);
    const fz = clamp01(fzRaw);
    const key = terrainCoordKey(fx, fz);
    const existing = vertexIds.get(key);
    if (existing !== undefined) return existing;
    const id = vertices.length;
    vertexIds.set(key, id);
    vertices.push({
      fx,
      fz,
      h: generatedTerrainHeightAtCellFraction(
        mapWidth,
        mapHeight,
        cellSize,
        cellX,
        cellY,
        fx,
        fz,
      ),
    });
    return id;
  };

  for (let vy = 0; vy <= baseSubdiv; vy++) {
    for (let vx = 0; vx <= baseSubdiv; vx++) {
      addVertex(vx / baseSubdiv, vy / baseSubdiv);
    }
  }
  for (let i = 1; i < northSubdiv; i++) addVertex(i / northSubdiv, 0);
  for (let i = 1; i < eastSubdiv; i++) addVertex(1, i / eastSubdiv);
  for (let i = 1; i < southSubdiv; i++) addVertex(i / southSubdiv, 1);
  for (let i = 1; i < westSubdiv; i++) addVertex(0, i / westSubdiv);

  const verticesOnSegment = (a: number, b: number): number[] => {
    const va = vertices[a];
    const vb = vertices[b];
    const dx = vb.fx - va.fx;
    const dz = vb.fz - va.fz;
    const lenSq = dx * dx + dz * dz;
    const found: Array<{ id: number; t: number }> = [];
    for (let id = 0; id < vertices.length; id++) {
      const p = vertices[id];
      const relX = p.fx - va.fx;
      const relZ = p.fz - va.fz;
      const cross = relX * dz - relZ * dx;
      if (Math.abs(cross) > TERRAIN_MESH_EPSILON) continue;
      const t = lenSq > 0 ? (relX * dx + relZ * dz) / lenSq : 0;
      if (t < -TERRAIN_MESH_EPSILON || t > 1 + TERRAIN_MESH_EPSILON) continue;
      found.push({ id, t: clamp01(t) });
    }
    found.sort((left, right) => left.t - right.t);
    const ids: number[] = [];
    for (let i = 0; i < found.length; i++) {
      const id = found[i].id;
      if (ids[ids.length - 1] !== id) ids.push(id);
    }
    return ids;
  };

  const triangles: number[] = [];
  const addBaseTriangle = (a: number, b: number, c: number): void => {
    const ab = verticesOnSegment(a, b);
    const bc = verticesOnSegment(b, c);
    const ca = verticesOnSegment(c, a);
    const polygon = [...ab];
    for (let i = 1; i < bc.length; i++) polygon.push(bc[i]);
    for (let i = 1; i < ca.length - 1; i++) polygon.push(ca[i]);
    triangulateConvexLocalPolygon(vertices, polygon, triangles);
  };

  for (let y = 0; y < baseSubdiv; y++) {
    for (let x = 0; x < baseSubdiv; x++) {
      const tl = addVertex(x / baseSubdiv, y / baseSubdiv);
      const tr = addVertex((x + 1) / baseSubdiv, y / baseSubdiv);
      const br = addVertex((x + 1) / baseSubdiv, (y + 1) / baseSubdiv);
      const bl = addVertex(x / baseSubdiv, (y + 1) / baseSubdiv);
      addBaseTriangle(tl, tr, br);
      addBaseTriangle(tl, br, bl);
    }
  }

  return { vertices, triangles };
}

function buildAdaptiveTerrainTileMeshes(
  mapWidth: number,
  mapHeight: number,
  cellSize: number,
  cellsX: number,
  cellsY: number,
  maxSubdiv: number,
  tileSubdivisions: readonly number[],
): {
  tileEdgeSubdivisions: number[];
  tileVertexOffsets: number[];
  tileVertexCoords: number[];
  tileVertexHeights: number[];
  tileTriangleOffsets: number[];
  tileTriangleIndices: number[];
} {
  const tileCount = cellsX * cellsY;
  const tileEdgeSubdivisions = new Array<number>(tileCount * 4);
  const tileVertexOffsets = new Array<number>(tileCount + 1);
  const tileVertexCoords: number[] = [];
  const tileVertexHeights: number[] = [];
  const tileTriangleOffsets = new Array<number>(tileCount + 1);
  const tileTriangleIndices: number[] = [];

  for (let cy = 0; cy < cellsY; cy++) {
    for (let cx = 0; cx < cellsX; cx++) {
      const tileIdx = cy * cellsX + cx;
      const self = terrainTileBaseSubdivision(tileSubdivisions, cellsX, cellsY, cx, cy, maxSubdiv);
      const north = terrainTouchingEdgeSubdivision(
        self,
        terrainTileBaseSubdivision(tileSubdivisions, cellsX, cellsY, cx, cy - 1, maxSubdiv),
        maxSubdiv,
      );
      const east = terrainTouchingEdgeSubdivision(
        self,
        terrainTileBaseSubdivision(tileSubdivisions, cellsX, cellsY, cx + 1, cy, maxSubdiv),
        maxSubdiv,
      );
      const south = terrainTouchingEdgeSubdivision(
        self,
        terrainTileBaseSubdivision(tileSubdivisions, cellsX, cellsY, cx, cy + 1, maxSubdiv),
        maxSubdiv,
      );
      const west = terrainTouchingEdgeSubdivision(
        self,
        terrainTileBaseSubdivision(tileSubdivisions, cellsX, cellsY, cx - 1, cy, maxSubdiv),
        maxSubdiv,
      );
      const edgeOffset = tileIdx * 4;
      tileEdgeSubdivisions[edgeOffset + TERRAIN_TILE_EDGE_NORTH] = north;
      tileEdgeSubdivisions[edgeOffset + TERRAIN_TILE_EDGE_EAST] = east;
      tileEdgeSubdivisions[edgeOffset + TERRAIN_TILE_EDGE_SOUTH] = south;
      tileEdgeSubdivisions[edgeOffset + TERRAIN_TILE_EDGE_WEST] = west;

      const mesh = buildTerrainTileLocalMesh(
        mapWidth,
        mapHeight,
        cellSize,
        cx,
        cy,
        self,
        north,
        east,
        south,
        west,
      );

      tileVertexOffsets[tileIdx] = tileVertexHeights.length;
      for (let i = 0; i < mesh.vertices.length; i++) {
        const vertex = mesh.vertices[i];
        tileVertexCoords.push(vertex.fx, vertex.fz);
        tileVertexHeights.push(vertex.h);
      }
      tileTriangleOffsets[tileIdx] = tileTriangleIndices.length;
      for (let i = 0; i < mesh.triangles.length; i++) {
        tileTriangleIndices.push(mesh.triangles[i]);
      }
    }
  }
  tileVertexOffsets[tileCount] = tileVertexHeights.length;
  tileTriangleOffsets[tileCount] = tileTriangleIndices.length;

  return {
    tileEdgeSubdivisions,
    tileVertexOffsets,
    tileVertexCoords,
    tileVertexHeights,
    tileTriangleOffsets,
    tileTriangleIndices,
  };
}

function terrainTileMeshViewFromMap(
  map: TerrainTileMap,
  cellX: number,
  cellY: number,
): TerrainTileMeshView | null {
  const cx = Math.max(0, Math.min(map.cellsX - 1, cellX));
  const cy = Math.max(0, Math.min(map.cellsY - 1, cellY));
  const tileIdx = cy * map.cellsX + cx;
  const vertexOffsets = map.tileVertexOffsets as readonly number[] | undefined;
  const vertexCoords = map.tileVertexCoords as readonly number[] | undefined;
  const vertexHeights = map.tileVertexHeights as readonly number[] | undefined;
  const triangleOffsets = map.tileTriangleOffsets as readonly number[] | undefined;
  const triangleIndices = map.tileTriangleIndices as readonly number[] | undefined;
  const vertexOffset = vertexOffsets?.[tileIdx];
  const nextVertexOffset = vertexOffsets?.[tileIdx + 1];
  const triangleOffset = triangleOffsets?.[tileIdx];
  const nextTriangleOffset = triangleOffsets?.[tileIdx + 1];
  if (
    !vertexCoords ||
    !vertexHeights ||
    !triangleIndices ||
    vertexOffset === undefined ||
    nextVertexOffset === undefined ||
    triangleOffset === undefined ||
    nextTriangleOffset === undefined
  ) {
    return null;
  }

  return {
    vertexOffset,
    vertexCount: Math.max(0, nextVertexOffset - vertexOffset),
    triangleOffset,
    triangleCount: Math.max(0, Math.floor((nextTriangleOffset - triangleOffset) / 3)),
    vertexCoords,
    vertexHeights,
    triangleIndices,
  };
}

export function getTerrainTileMeshAtCell(
  cellX: number,
  cellY: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number = LAND_CELL_SIZE,
): TerrainTileMeshView | null {
  assertCanonicalLandCellSize('getTerrainTileMeshAtCell cellSize', cellSize);
  const size = terrainCellSize(cellSize);
  const map = getInstalledTerrainTileMap(mapWidth, mapHeight, size);
  if (!map) return null;
  return terrainTileMeshViewFromMap(map, cellX, cellY);
}

function terrainBarycentricAt(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
): { wa: number; wb: number; wc: number } | null {
  const denom = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  if (Math.abs(denom) <= TERRAIN_MESH_EPSILON) return null;
  const wa = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / denom;
  const wb = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / denom;
  return { wa, wb, wc: 1 - wa - wb };
}

function normalizeBarycentricWeights(
  wa: number,
  wb: number,
  wc: number,
): { wa: number; wb: number; wc: number } {
  const ca = Math.max(0, wa);
  const cb = Math.max(0, wb);
  const cc = Math.max(0, wc);
  const sum = ca + cb + cc;
  if (sum <= 0) return { wa: 1, wb: 0, wc: 0 };
  return { wa: ca / sum, wb: cb / sum, wc: cc / sum };
}

function terrainTriangleSampleFromMesh(
  map: TerrainTileMap,
  cellX: number,
  cellY: number,
  fx: number,
  fz: number,
): TerrainTriangleSample | null {
  const mesh = terrainTileMeshViewFromMap(map, cellX, cellY);
  if (!mesh || mesh.triangleCount <= 0) return null;

  let best: TerrainTriangleSample | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  const px = clamp01(fx);
  const pz = clamp01(fz);
  for (let tri = 0; tri < mesh.triangleCount; tri++) {
    const triOffset = mesh.triangleOffset + tri * 3;
    const ia = mesh.triangleIndices[triOffset];
    const ib = mesh.triangleIndices[triOffset + 1];
    const ic = mesh.triangleIndices[triOffset + 2];
    const aCoord = (mesh.vertexOffset + ia) * 2;
    const bCoord = (mesh.vertexOffset + ib) * 2;
    const cCoord = (mesh.vertexOffset + ic) * 2;
    const ax = mesh.vertexCoords[aCoord];
    const az = mesh.vertexCoords[aCoord + 1];
    const bx = mesh.vertexCoords[bCoord];
    const bz = mesh.vertexCoords[bCoord + 1];
    const cx = mesh.vertexCoords[cCoord];
    const cz = mesh.vertexCoords[cCoord + 1];
    const bary = terrainBarycentricAt(px, pz, ax, az, bx, bz, cx, cz);
    if (!bary) continue;
    const score = Math.min(bary.wa, bary.wb, bary.wc);
    if (score < -1e-5 && score <= bestScore) continue;
    const weights = score >= -1e-5
      ? bary
      : normalizeBarycentricWeights(bary.wa, bary.wb, bary.wc);
    const sample = {
      ax: (cellX + ax) * map.cellSize,
      az: (cellY + az) * map.cellSize,
      ah: mesh.vertexHeights[mesh.vertexOffset + ia] ?? 0,
      bx: (cellX + bx) * map.cellSize,
      bz: (cellY + bz) * map.cellSize,
      bh: mesh.vertexHeights[mesh.vertexOffset + ib] ?? 0,
      cx: (cellX + cx) * map.cellSize,
      cz: (cellY + cz) * map.cellSize,
      ch: mesh.vertexHeights[mesh.vertexOffset + ic] ?? 0,
      wa: weights.wa,
      wb: weights.wb,
      wc: weights.wc,
    };
    if (score >= -1e-5) return sample;
    best = sample;
    bestScore = score;
  }

  return best;
}

export function getTerrainMeshSample(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number = LAND_CELL_SIZE,
): TerrainMeshSample {
  let size = LAND_CELL_SIZE;
  if (cellSize !== LAND_CELL_SIZE && cellSize > 0) {
    assertCanonicalLandCellSize('getTerrainMeshSample cellSize', cellSize);
    size = terrainCellSize(cellSize);
  }
  const candidateMap = getAuthoritativeTerrainTileMap();
  const installedMap =
    candidateMap &&
    candidateMap.mapWidth === mapWidth &&
    candidateMap.mapHeight === mapHeight &&
    candidateMap.cellSize === size &&
    candidateMap.subdiv === TERRAIN_MESH_SUBDIV
      ? candidateMap
      : null;
  const cellsX = installedMap?.cellsX ?? Math.max(1, Math.ceil(mapWidth / size));
  const cellsZ = installedMap?.cellsY ?? Math.max(1, Math.ceil(mapHeight / size));
  const maxX = cellsX * size;
  const maxZ = cellsZ * size;
  const px = x <= 0 ? 0 : x >= maxX ? maxX : x;
  const pz = z <= 0 ? 0 : z >= maxZ ? maxZ : z;
  const cellX = Math.min(cellsX - 1, Math.max(0, Math.floor(px / size)));
  const cellZ = Math.min(cellsZ - 1, Math.max(0, Math.floor(pz / size)));
  const localX = px - cellX * size;
  const localZ = pz - cellZ * size;

  if (installedMap) {
    const rawTileSubdiv =
      (installedMap.tileSubdivisions as readonly number[] | undefined)?.[cellZ * installedMap.cellsX + cellX] ??
      installedMap.subdiv;
    const tileSubdiv = normalizeTerrainTileSubdivision(rawTileSubdiv, installedMap.subdiv);
    const triangle = terrainTriangleSampleFromMesh(
      installedMap,
      cellX,
      cellZ,
      localX / size,
      localZ / size,
    );
    if (triangle) {
      return {
        u: triangle.wb,
        v: triangle.wc,
        subSize: size / tileSubdiv,
        h00: triangle.ah,
        h10: triangle.bh,
        h11: triangle.ch,
        h01: triangle.ah,
        hc: triangle.ah,
        centerFan: false,
        triangle,
      };
    }
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
  const h00 = getTerrainHeight(
    Math.min(mapWidth, x0),
    Math.min(mapHeight, z0),
    mapWidth,
    mapHeight,
  );
  const h10 = getTerrainHeight(
    Math.min(mapWidth, x1),
    Math.min(mapHeight, z0),
    mapWidth,
    mapHeight,
  );
  const h11 = getTerrainHeight(
    Math.min(mapWidth, x1),
    Math.min(mapHeight, z1),
    mapWidth,
    mapHeight,
  );
  const h01 = getTerrainHeight(
    Math.min(mapWidth, x0),
    Math.min(mapHeight, z1),
    mapWidth,
    mapHeight,
  );
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
    centerFan: false,
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
  if (sample.triangle) {
    const tri = sample.triangle;
    return tri.wa * tri.ah + tri.wb * tri.bh + tri.wc * tri.ch;
  }
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
  if (sample.triangle) {
    const tri = sample.triangle;
    const ux = tri.bx - tri.ax;
    const uz = tri.bz - tri.az;
    const uh = tri.bh - tri.ah;
    const vx = tri.cx - tri.ax;
    const vz = tri.cz - tri.az;
    const vh = tri.ch - tri.ah;
    let nx = uh * vz - uz * vh;
    let ny = uz * vx - ux * vz;
    let nz = ux * vh - uh * vx;
    if (ny < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    return { nx: nx / len, ny: nz / len, nz: ny / len };
  }
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
