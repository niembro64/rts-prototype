import type { TerrainTileMap } from '@/types/terrain';
import { LAND_CELL_SIZE } from '../../../config';
import { assertCanonicalLandCellSize } from '../../landGrid';
import { getSimWasm } from '../../sim-wasm/init';
import {
  TERRAIN_FINE_TRIANGLE_SUBDIV,
  TERRAIN_MESH_HEIGHT_SMOOTHING,
  TERRAIN_TRIANGLE_FINAL_REPAIR_MAX_PASSES,
  TERRAIN_TRIANGLE_MAX_SURFACE_ERROR,
  TERRAIN_TRIANGLE_MAX_NEIGHBOR_LEVEL_DELTA,
  TERRAIN_TRIANGLE_MIN_NORMAL_DOT,
  TERRAIN_TRIANGLE_PRESERVE_WATERLINE,
  TERRAIN_TRIANGLE_SAMPLE_CENTROID,
  TERRAIN_TRIANGLE_VERTEX_KEY_SCALE,
  WATER_LEVEL,
} from './terrainConfig';
import {
  getAuthoritativeTerrainTileMap,
  getInstalledTerrainTileMap,
  getTerrainVersion,
  setAuthoritativeTerrainTileMap,
} from './terrainState';
import { createTerrainHeightSampler, getTerrainHeight } from './terrainHeightGenerator';
import { buildTerrainCellTriangleIndex } from './terrainCellTriangleIndex';

export { setAuthoritativeTerrainTileMap };

export type TerrainMeshSample = {
  u: number;
  v: number;
  subSize: number;
  h00: number;
  h10: number;
  h11: number;
  h01: number;
  triangle: TerrainTriangleSample | undefined;
};

export type TerrainMeshView = {
  vertexCount: number;
  triangleCount: number;
  vertexCoords: readonly number[];
  vertexHeights: readonly number[];
  triangleIndices: readonly number[];
  triangleLevels: readonly number[];
  triangleNeighborIndices: readonly number[];
  triangleNeighborLevels: readonly number[];
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

type LatticePoint = {
  i: number;
  j: number;
};

type TerrainHierarchyTriangle = {
  i: number;
  j: number;
  side: number;
  down: boolean;
};

type MeshPoint = {
  x: number;
  z: number;
  h: number;
};

type TerrainNormal = {
  nx: number;
  ny: number;
  nz: number;
};

type TerrainMeshBuildContext = {
  mapWidth: number;
  mapHeight: number;
  fineEdge: number;
  fineHeight: number;
  rootLevel: number;
  heightSampler: (x: number, z: number) => number;
  heightCache: Map<number, number>;
  normalCache: Map<number, TerrainNormal>;
};

type BuiltTerrainMesh = {
  vertexCoords: number[];
  vertexHeights: number[];
  triangleIndices: number[];
  triangleLevels: number[];
  triangleLeafIndices: number[];
  triangleNeighborIndices: number[];
  triangleNeighborLevels: number[];
  cellTriangleOffsets: number[];
  cellTriangleIndices: number[];
};

type TerrainMeshTopology = {
  vertexCoords: number[];
  vertexHeights: number[];
  triangleIndices: number[];
  triangleLevels: number[];
  triangleLeafIndices: number[];
};

type TriangleEdgeOwner = {
  triangle: number;
  edge: number;
  a: number;
  b: number;
};

type TriangleEdgeLineKind = 0 | 1 | 2;

type TriangleEdgeSpan = TriangleEdgeOwner & {
  lineKey: number;
  lineKind: TriangleEdgeLineKind;
  start: number;
  end: number;
};

type TerrainMeshEdgeMetadata = {
  edgeOwners: Map<number, TriangleEdgeOwner[]>;
  spansByLine: Map<number, TriangleEdgeSpan[]>;
  edgeSpans: Map<number, TriangleEdgeSpan>;
};

const SQRT3_OVER_2 = Math.sqrt(3) * 0.5;
const TERRAIN_MESH_EPSILON = 1e-6;
const TERRAIN_MESH_EDGE_EPSILON = 1e-4;
const INV_SQRT3 = 1 / Math.sqrt(3);
const TERRAIN_EDGE_LINE_KEY_BIAS = 0x100000000;
const TERRAIN_EDGE_LINE_KEY_STRIDE = 0x200000000;

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
  assertCanonicalLandCellSize('buildTerrainTileMap cellSize', cellSize);
  const size = terrainCellSize(cellSize);
  const cellsX = Math.max(1, Math.ceil(mapWidth / size));
  const cellsY = Math.max(1, Math.ceil(mapHeight / size));
  const maxSubdiv = Math.max(1, TERRAIN_FINE_TRIANGLE_SUBDIV | 0);

  const verticesX = cellsX * maxSubdiv + 1;
  const verticesY = cellsY * maxSubdiv + 1;

  const mesh = buildAdaptiveEquilateralTerrainMesh(
    mapWidth,
    mapHeight,
    size,
    cellsX,
    cellsY,
    maxSubdiv,
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
    meshVertexCoords: mesh.vertexCoords,
    meshVertexHeights: mesh.vertexHeights,
    meshTriangleIndices: mesh.triangleIndices,
    meshTriangleLevels: mesh.triangleLevels,
    meshTriangleNeighborIndices: mesh.triangleNeighborIndices,
    meshTriangleNeighborLevels: mesh.triangleNeighborLevels,
    meshCellTriangleOffsets: mesh.cellTriangleOffsets,
    meshCellTriangleIndices: mesh.cellTriangleIndices,
  };
}

function clampToMap(value: number, max: number): number {
  return value <= 0 ? 0 : value >= max ? max : value;
}

function nextPowerOfTwo(value: number): number {
  let n = 1;
  while (n < value) n <<= 1;
  return n;
}

function latticeKey(i: number, j: number): string {
  return `${i}:${j}`;
}

function latticeCacheKey(i: number, j: number): number {
  return (i + 0x100000) * 0x200000 + (j + 0x100000);
}

function latticePointAt(ctx: TerrainMeshBuildContext, i: number, j: number): MeshPoint {
  const x = ctx.fineEdge * (i + j * 0.5);
  const z = ctx.fineHeight * j;
  return {
    x,
    z,
    h: terrainHeightAtLattice(ctx, i, j),
  };
}

function terrainHeightAtWorld(ctx: TerrainMeshBuildContext, x: number, z: number): number {
  return ctx.heightSampler(
    clampToMap(x, ctx.mapWidth),
    clampToMap(z, ctx.mapHeight),
  );
}

function terrainHeightAtLattice(ctx: TerrainMeshBuildContext, i: number, j: number): number {
  const key = latticeCacheKey(i, j);
  const cached = ctx.heightCache.get(key);
  if (cached !== undefined) return cached;
  const x = ctx.fineEdge * (i + j * 0.5);
  const z = ctx.fineHeight * j;
  const h = terrainHeightAtWorld(ctx, x, z);
  ctx.heightCache.set(key, h);
  return h;
}

function normalizeTerrainNormal(
  nx: number,
  ny: number,
  nz: number,
): TerrainNormal {
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  return { nx: nx / len, ny: ny / len, nz: nz / len };
}

function terrainPlaneNormal(
  a: MeshPoint,
  b: MeshPoint,
  c: MeshPoint,
): TerrainNormal {
  const ux = b.x - a.x;
  const uy = b.h - a.h;
  const uz = b.z - a.z;
  const vx = c.x - a.x;
  const vy = c.h - a.h;
  const vz = c.z - a.z;
  let nx = uy * vz - uz * vy;
  let vertical = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  if (vertical < 0) {
    nx = -nx;
    vertical = -vertical;
    nz = -nz;
  }
  return normalizeTerrainNormal(nx, nz, vertical);
}

function terrainNormalAtLattice(
  ctx: TerrainMeshBuildContext,
  i: number,
  j: number,
): TerrainNormal {
  const key = latticeCacheKey(i, j);
  const cached = ctx.normalCache.get(key);
  if (cached !== undefined) return cached;

  const gx =
    (terrainHeightAtLattice(ctx, i + 1, j) -
      terrainHeightAtLattice(ctx, i - 1, j)) /
    (2 * ctx.fineEdge);
  const hj =
    terrainHeightAtLattice(ctx, i, j + 1) -
    terrainHeightAtLattice(ctx, i, j - 1);
  const gz = (hj - gx * ctx.fineEdge) / (2 * ctx.fineHeight);
  const normal = normalizeTerrainNormal(-gx, -gz, 1);
  ctx.normalCache.set(key, normal);
  return normal;
}

function terrainNormalAtWorld(
  ctx: TerrainMeshBuildContext,
  x: number,
  z: number,
): TerrainNormal {
  const eps = Math.max(1, Math.min(ctx.fineEdge, ctx.fineHeight));
  const x0 = clampToMap(x - eps, ctx.mapWidth);
  const x1 = clampToMap(x + eps, ctx.mapWidth);
  const z0 = clampToMap(z - eps, ctx.mapHeight);
  const z1 = clampToMap(z + eps, ctx.mapHeight);
  const gx =
    (terrainHeightAtWorld(ctx, x1, z) - terrainHeightAtWorld(ctx, x0, z)) /
    Math.max(TERRAIN_MESH_EPSILON, x1 - x0);
  const gz =
    (terrainHeightAtWorld(ctx, x, z1) - terrainHeightAtWorld(ctx, x, z0)) /
    Math.max(TERRAIN_MESH_EPSILON, z1 - z0);
  return normalizeTerrainNormal(-gx, -gz, 1);
}

function terrainNormalsExceedTolerance(
  a: TerrainNormal,
  b: TerrainNormal,
): boolean {
  return a.nx * b.nx + a.ny * b.ny + a.nz * b.nz < TERRAIN_TRIANGLE_MIN_NORMAL_DOT;
}

function terrainTriangleHierarchyLevel(
  ctx: TerrainMeshBuildContext,
  tri: TerrainHierarchyTriangle,
): number {
  const sideLevel = 31 - Math.clz32(Math.max(1, tri.side));
  return Math.max(0, ctx.rootLevel - sideLevel);
}

function triangleLatticeVertices(tri: TerrainHierarchyTriangle): [LatticePoint, LatticePoint, LatticePoint] {
  const { i, j, side } = tri;
  if (!tri.down) {
    return [
      { i, j },
      { i: i + side, j },
      { i, j: j + side },
    ];
  }
  return [
    { i: i + side, j },
    { i: i + side, j: j + side },
    { i, j: j + side },
  ];
}

function triangleWorldVertices(
  ctx: TerrainMeshBuildContext,
  tri: TerrainHierarchyTriangle,
): [MeshPoint, MeshPoint, MeshPoint] {
  const [a, b, c] = triangleLatticeVertices(tri);
  return [
    latticePointAt(ctx, a.i, a.j),
    latticePointAt(ctx, b.i, b.j),
    latticePointAt(ctx, c.i, c.j),
  ];
}

function triangleBboxIntersectsMap(ctx: TerrainMeshBuildContext, tri: TerrainHierarchyTriangle): boolean {
  const { i, j, side } = tri;
  const z0 = ctx.fineHeight * j;
  const z1 = ctx.fineHeight * (j + side);
  let ax: number;
  let bx: number;
  let cx: number;
  if (!tri.down) {
    ax = ctx.fineEdge * (i + j * 0.5);
    bx = ctx.fineEdge * (i + side + j * 0.5);
    cx = ctx.fineEdge * (i + (j + side) * 0.5);
  } else {
    ax = ctx.fineEdge * (i + side + j * 0.5);
    bx = ctx.fineEdge * (i + side + (j + side) * 0.5);
    cx = ctx.fineEdge * (i + (j + side) * 0.5);
  }
  const minX = Math.min(ax, bx, cx);
  const maxX = Math.max(ax, bx, cx);
  const minZ = Math.min(z0, z1);
  const maxZ = Math.max(z0, z1);
  return maxX > 0 && minX < ctx.mapWidth && maxZ > 0 && minZ < ctx.mapHeight;
}

function pointInsideMap(ctx: TerrainMeshBuildContext, x: number, z: number): boolean {
  return (
    x >= -TERRAIN_MESH_EPSILON &&
    z >= -TERRAIN_MESH_EPSILON &&
    x <= ctx.mapWidth + TERRAIN_MESH_EPSILON &&
    z <= ctx.mapHeight + TERRAIN_MESH_EPSILON
  );
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

function canCollapseTerrainTriangle(
  ctx: TerrainMeshBuildContext,
  tri: TerrainHierarchyTriangle,
): boolean {
  const [a, b, c] = triangleWorldVertices(ctx, tri);
  const planeNormal = terrainPlaneNormal(a, b, c);
  const planeNx = planeNormal.nx;
  const planeNy = planeNormal.ny;
  const planeNz = planeNormal.nz;
  const planeX = a.x;
  const planeZ = a.z;
  const planeH = a.h;
  const n = tri.side;
  const baryDenom = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
  if (Math.abs(baryDenom) <= TERRAIN_MESH_EPSILON) return false;
  const baryWaX = b.z - c.z;
  const baryWaZ = c.x - b.x;
  const baryWbX = c.z - a.z;
  const baryWbZ = a.x - c.x;
  const baryOriginX = c.x;
  const baryOriginZ = c.z;
  const minX = -TERRAIN_MESH_EPSILON;
  const minZ = -TERRAIN_MESH_EPSILON;
  const maxX = ctx.mapWidth + TERRAIN_MESH_EPSILON;
  const maxZ = ctx.mapHeight + TERRAIN_MESH_EPSILON;
  let checked = 0;

  if (!tri.down) {
    for (let offsetI = 0; offsetI <= n; offsetI++) {
      for (let offsetJ = 0, maxOffsetJ = n - offsetI; offsetJ <= maxOffsetJ; offsetJ++) {
        const i = tri.i + offsetI;
        const j = tri.j + offsetJ;
        const x = ctx.fineEdge * (i + j * 0.5);
        const z = ctx.fineHeight * j;
        if (x < minX || z < minZ || x > maxX || z > maxZ) continue;
        const baryX = x - baryOriginX;
        const baryZ = z - baryOriginZ;
        const wa = (baryWaX * baryX + baryWaZ * baryZ) / baryDenom;
        const wb = (baryWbX * baryX + baryWbZ * baryZ) / baryDenom;
        const wc = 1 - wa - wb;
        const actual = terrainHeightAtLattice(ctx, i, j);
        const approx = wa * a.h + wb * b.h + wc * c.h;
        checked++;
        if (
          TERRAIN_TRIANGLE_PRESERVE_WATERLINE &&
          (actual < WATER_LEVEL) !== (approx < WATER_LEVEL)
        ) {
          return false;
        }
        if (
          Math.abs(
            planeNx * (x - planeX) +
              planeNy * (z - planeZ) +
              planeNz * (actual - planeH),
          ) >
          TERRAIN_TRIANGLE_MAX_SURFACE_ERROR
        ) {
          return false;
        }
        if (
          actual >= WATER_LEVEL &&
          terrainNormalsExceedTolerance(
            terrainNormalAtLattice(ctx, i, j),
            planeNormal,
          )
        ) {
          return false;
        }
      }
    }
  } else {
    for (let offsetI = 0; offsetI <= n; offsetI++) {
      for (let offsetJ = n - offsetI; offsetJ <= n; offsetJ++) {
        const i = tri.i + offsetI;
        const j = tri.j + offsetJ;
        const x = ctx.fineEdge * (i + j * 0.5);
        const z = ctx.fineHeight * j;
        if (x < minX || z < minZ || x > maxX || z > maxZ) continue;
        const baryX = x - baryOriginX;
        const baryZ = z - baryOriginZ;
        const wa = (baryWaX * baryX + baryWaZ * baryZ) / baryDenom;
        const wb = (baryWbX * baryX + baryWbZ * baryZ) / baryDenom;
        const wc = 1 - wa - wb;
        const actual = terrainHeightAtLattice(ctx, i, j);
        const approx = wa * a.h + wb * b.h + wc * c.h;
        checked++;
        if (
          TERRAIN_TRIANGLE_PRESERVE_WATERLINE &&
          (actual < WATER_LEVEL) !== (approx < WATER_LEVEL)
        ) {
          return false;
        }
        if (
          Math.abs(
            planeNx * (x - planeX) +
              planeNy * (z - planeZ) +
              planeNz * (actual - planeH),
          ) >
          TERRAIN_TRIANGLE_MAX_SURFACE_ERROR
        ) {
          return false;
        }
        if (
          actual >= WATER_LEVEL &&
          terrainNormalsExceedTolerance(
            terrainNormalAtLattice(ctx, i, j),
            planeNormal,
          )
        ) {
          return false;
        }
      }
    }
  }

  if (checked === 0) return true;

  const centroidX = (a.x + b.x + c.x) / 3;
  const centroidZ = (a.z + b.z + c.z) / 3;
  if (TERRAIN_TRIANGLE_SAMPLE_CENTROID && pointInsideMap(ctx, centroidX, centroidZ)) {
    const actual = terrainHeightAtWorld(ctx, centroidX, centroidZ);
    const approx = (a.h + b.h + c.h) / 3;
    if (
      TERRAIN_TRIANGLE_PRESERVE_WATERLINE &&
      (actual < WATER_LEVEL) !== (approx < WATER_LEVEL)
    ) {
      return false;
    }
    if (
      Math.abs(
        planeNx * (centroidX - planeX) +
          planeNy * (centroidZ - planeZ) +
          planeNz * (actual - planeH),
      ) >
      TERRAIN_TRIANGLE_MAX_SURFACE_ERROR
    ) {
      return false;
    }
    if (
      actual >= WATER_LEVEL &&
      terrainNormalsExceedTolerance(
        terrainNormalAtWorld(ctx, centroidX, centroidZ),
        planeNormal,
      )
    ) {
      return false;
    }
  }

  return true;
}

function appendTerrainTriangleChildren(
  tri: TerrainHierarchyTriangle,
  out: TerrainHierarchyTriangle[],
): void {
  const half = tri.side >> 1;
  if (half < 1) return;
  const { i, j } = tri;
  if (!tri.down) {
    out.push(
      { i, j, side: half, down: false },
      { i: i + half, j, side: half, down: false },
      { i, j: j + half, side: half, down: false },
      { i, j, side: half, down: true },
    );
    return;
  }
  out.push(
    { i: i + half, j, side: half, down: true },
    { i, j: j + half, side: half, down: true },
    { i: i + half, j: j + half, side: half, down: true },
    { i: i + half, j: j + half, side: half, down: false },
  );
}

function pushTerrainTriangleChildrenForStack(
  tri: TerrainHierarchyTriangle,
  stack: TerrainHierarchyTriangle[],
): void {
  const half = tri.side >> 1;
  if (half < 1) return;
  const { i, j } = tri;
  if (!tri.down) {
    stack.push(
      { i, j, side: half, down: true },
      { i, j: j + half, side: half, down: false },
      { i: i + half, j, side: half, down: false },
      { i, j, side: half, down: false },
    );
    return;
  }
  stack.push(
    { i: i + half, j: j + half, side: half, down: false },
    { i: i + half, j: j + half, side: half, down: true },
    { i, j: j + half, side: half, down: true },
    { i: i + half, j, side: half, down: true },
  );
}

function appendIntersectingTerrainTriangleChildren(
  ctx: TerrainMeshBuildContext,
  tri: TerrainHierarchyTriangle,
  out: TerrainHierarchyTriangle[],
): void {
  const childStart = out.length;
  appendTerrainTriangleChildren(tri, out);
  for (let c = childStart; c < out.length; c++) {
    if (!triangleBboxIntersectsMap(ctx, out[c])) {
      out.splice(c, 1);
      c--;
    }
  }
}

function buildTerrainTriangleLeaves(
  ctx: TerrainMeshBuildContext,
  tri: TerrainHierarchyTriangle,
  out: TerrainHierarchyTriangle[],
): void {
  const stack: TerrainHierarchyTriangle[] = [tri];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || !triangleBboxIntersectsMap(ctx, current)) continue;
    if (current.side <= 1) {
      out.push(current);
      continue;
    }

    if (canCollapseTerrainTriangle(ctx, current)) {
      out.push(current);
      continue;
    }

    pushTerrainTriangleChildrenForStack(current, stack);
  }
}

function latticeSegmentPointKey(i: number, j: number): number {
  return latticeCacheKey(i, j);
}

function latticeSegmentKeyFromCoords(
  ai: number,
  aj: number,
  bi: number,
  bj: number,
): number {
  let orientation = 0;
  let startI = ai;
  let startJ = aj;
  if (aj === bj) {
    orientation = 0;
    if (bi < ai) {
      startI = bi;
      startJ = bj;
    }
  } else if (ai === bi) {
    orientation = 1;
    if (bj < aj) {
      startI = bi;
      startJ = bj;
    }
  } else {
    orientation = 2;
    if (bi < ai) {
      startI = bi;
      startJ = bj;
    }
  }
  return latticeSegmentPointKey(startI, startJ) * 3 + orientation;
}

function forEachUnitSegmentOnLatticeEdge(
  ai: number,
  aj: number,
  bi: number,
  bj: number,
  visit: (key: number) => void,
): void {
  const di = bi - ai;
  const dj = bj - aj;
  const steps = Math.max(Math.abs(di), Math.abs(dj));
  if (steps <= 0) return;
  const stepI = di / steps;
  const stepJ = dj / steps;
  for (let k = 0; k < steps; k++) {
    const startI = ai + stepI * k;
    const startJ = aj + stepJ * k;
    visit(latticeSegmentKeyFromCoords(
      startI,
      startJ,
      startI + stepI,
      startJ + stepJ,
    ));
  }
}

function forEachTriangleUnitEdgeSegmentKey(
  tri: TerrainHierarchyTriangle,
  visit: (key: number) => void,
): void {
  const { i, j, side } = tri;
  if (!tri.down) {
    forEachUnitSegmentOnLatticeEdge(i, j, i + side, j, visit);
    forEachUnitSegmentOnLatticeEdge(i + side, j, i, j + side, visit);
    forEachUnitSegmentOnLatticeEdge(i, j + side, i, j, visit);
  } else {
    forEachUnitSegmentOnLatticeEdge(i + side, j, i + side, j + side, visit);
    forEachUnitSegmentOnLatticeEdge(i + side, j + side, i, j + side, visit);
    forEachUnitSegmentOnLatticeEdge(i, j + side, i + side, j, visit);
  }
}

function balanceTerrainTriangleLeaves(
  ctx: TerrainMeshBuildContext,
  leaves: readonly TerrainHierarchyTriangle[],
): TerrainHierarchyTriangle[] {
  const maxDelta = Math.max(0, TERRAIN_TRIANGLE_MAX_NEIGHBOR_LEVEL_DELTA | 0);
  if (leaves.length <= 1) return [...leaves];

  let balanced = [...leaves];
  const maxPasses = terrainTriangleHierarchyLevel(ctx, {
    i: 0,
    j: 0,
    side: 1,
    down: false,
  }) + 1;

  for (let pass = 0; pass < maxPasses; pass++) {
    const segmentOwners = new Map<number, Array<{ leafIndex: number; level: number }>>();
    for (let leafIndex = 0; leafIndex < balanced.length; leafIndex++) {
      const leaf = balanced[leafIndex];
      const level = terrainTriangleHierarchyLevel(ctx, leaf);
      forEachTriangleUnitEdgeSegmentKey(leaf, (key) => {
        const owners = segmentOwners.get(key);
        if (owners) {
          owners.push({ leafIndex, level });
        } else {
          segmentOwners.set(key, [{ leafIndex, level }]);
        }
      });
    }

    const splitLeaves = new Set<number>();
    for (const owners of segmentOwners.values()) {
      if (owners.length < 2) continue;
      let highestLevel = 0;
      for (let i = 0; i < owners.length; i++) {
        highestLevel = Math.max(highestLevel, owners[i].level);
      }
      for (let i = 0; i < owners.length; i++) {
        const owner = owners[i];
        const leaf = balanced[owner.leafIndex];
        if (leaf.side > 1 && highestLevel - owner.level > maxDelta) {
          splitLeaves.add(owner.leafIndex);
        }
      }
    }

    if (splitLeaves.size === 0) return balanced;

    balanced = splitTerrainTriangleLeaves(ctx, balanced, splitLeaves);
  }

  return balanced;
}

function splitTerrainTriangleLeaves(
  ctx: TerrainMeshBuildContext,
  leaves: readonly TerrainHierarchyTriangle[],
  splitLeaves: ReadonlySet<number>,
): TerrainHierarchyTriangle[] {
  const next: TerrainHierarchyTriangle[] = [];
  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i];
    if (!splitLeaves.has(i) || leaf.side <= 1) {
      next.push(leaf);
      continue;
    }
    appendIntersectingTerrainTriangleChildren(ctx, leaf, next);
  }
  return next;
}

function edgeLatticePoints(
  a: LatticePoint,
  b: LatticePoint,
  vertexSet: ReadonlySet<string>,
  includeStart: boolean,
  includeEnd: boolean,
): LatticePoint[] {
  const di = b.i - a.i;
  const dj = b.j - a.j;
  const steps = Math.max(Math.abs(di), Math.abs(dj));
  const out: LatticePoint[] = [];
  if (steps <= 0) return out;
  const stepI = di / steps;
  const stepJ = dj / steps;
  for (let k = 0; k <= steps; k++) {
    if (k === 0 && !includeStart) continue;
    if (k === steps && !includeEnd) continue;
    const i = a.i + stepI * k;
    const j = a.j + stepJ * k;
    if (k === 0 || k === steps || vertexSet.has(latticeKey(i, j))) {
      out.push({ i, j });
    }
  }
  return out;
}

function triangleBoundaryLatticePoints(
  tri: TerrainHierarchyTriangle,
  vertexSet: ReadonlySet<string>,
): LatticePoint[] {
  const [a, b, c] = triangleLatticeVertices(tri);
  return [
    ...edgeLatticePoints(a, b, vertexSet, true, true),
    ...edgeLatticePoints(b, c, vertexSet, false, true),
    ...edgeLatticePoints(c, a, vertexSet, false, false),
  ];
}

function removeDuplicateMeshPoints(points: readonly MeshPoint[]): MeshPoint[] {
  const out: MeshPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const prev = out[out.length - 1];
    if (
      prev &&
      Math.abs(prev.x - p.x) <= TERRAIN_MESH_EPSILON &&
      Math.abs(prev.z - p.z) <= TERRAIN_MESH_EPSILON
    ) {
      continue;
    }
    out.push(p);
  }
  if (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (
      Math.abs(first.x - last.x) <= TERRAIN_MESH_EPSILON &&
      Math.abs(first.z - last.z) <= TERRAIN_MESH_EPSILON
    ) {
      out.pop();
    }
  }
  return out;
}

function lineIntersectionPoint(
  ctx: TerrainMeshBuildContext,
  a: MeshPoint,
  b: MeshPoint,
  t: number,
): MeshPoint {
  const x = a.x + (b.x - a.x) * t;
  const z = a.z + (b.z - a.z) * t;
  return { x, z, h: terrainHeightAtWorld(ctx, x, z) };
}

function clipPolygonAgainstBoundary(
  points: readonly MeshPoint[],
  inside: (p: MeshPoint) => boolean,
  intersect: (a: MeshPoint, b: MeshPoint) => MeshPoint,
): MeshPoint[] {
  if (points.length === 0) return [];
  const out: MeshPoint[] = [];
  let prev = points[points.length - 1];
  let prevInside = inside(prev);
  for (let i = 0; i < points.length; i++) {
    const curr = points[i];
    const currInside = inside(curr);
    if (currInside !== prevInside) out.push(intersect(prev, curr));
    if (currInside) out.push(curr);
    prev = curr;
    prevInside = currInside;
  }
  return removeDuplicateMeshPoints(out);
}

function clipPolygonToMap(
  ctx: TerrainMeshBuildContext,
  points: readonly MeshPoint[],
): MeshPoint[] {
  let clipped = removeDuplicateMeshPoints(points);
  clipped = clipPolygonAgainstBoundary(
    clipped,
    (p) => p.x >= 0,
    (a, b) => lineIntersectionPoint(ctx, a, b, (0 - a.x) / (b.x - a.x || 1)),
  );
  clipped = clipPolygonAgainstBoundary(
    clipped,
    (p) => p.x <= ctx.mapWidth,
    (a, b) => lineIntersectionPoint(ctx, a, b, (ctx.mapWidth - a.x) / (b.x - a.x || 1)),
  );
  clipped = clipPolygonAgainstBoundary(
    clipped,
    (p) => p.z >= 0,
    (a, b) => lineIntersectionPoint(ctx, a, b, (0 - a.z) / (b.z - a.z || 1)),
  );
  clipped = clipPolygonAgainstBoundary(
    clipped,
    (p) => p.z <= ctx.mapHeight,
    (a, b) => lineIntersectionPoint(ctx, a, b, (ctx.mapHeight - a.z) / (b.z - a.z || 1)),
  );
  return removeDuplicateMeshPoints(clipped);
}

function polygonSignedArea(points: readonly MeshPoint[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.z - b.x * a.z;
  }
  return area * 0.5;
}

function worldVertexKey(x: number, z: number): string {
  return `${Math.round(x * TERRAIN_TRIANGLE_VERTEX_KEY_SCALE)}:${Math.round(z * TERRAIN_TRIANGLE_VERTEX_KEY_SCALE)}`;
}

function meshEdgeKey(a: number, b: number, vertexKeyBase: number): number {
  return a < b ? a * vertexKeyBase + b : b * vertexKeyBase + a;
}

function triangleEdgeKey(triangle: number, edge: number): number {
  return triangle * 3 + edge;
}

function terrainEdgeLineKey(kind: TriangleEdgeLineKind, value: number): number {
  return kind * TERRAIN_EDGE_LINE_KEY_STRIDE
    + quantizedLineValue(value)
    + TERRAIN_EDGE_LINE_KEY_BIAS;
}

function collectTriangleEdgeOwners(
  triangleIndices: readonly number[],
): Map<number, TriangleEdgeOwner[]> {
  let maxVertexId = 0;
  for (let i = 0; i < triangleIndices.length; i++) {
    if (triangleIndices[i] > maxVertexId) maxVertexId = triangleIndices[i];
  }
  const vertexKeyBase = maxVertexId + 1;
  const edgeOwners = new Map<number, TriangleEdgeOwner[]>();
  const triangleCount = Math.floor(triangleIndices.length / 3);
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const triOffset = triangle * 3;
    for (let edge = 0; edge < 3; edge++) {
      const a = triangleIndices[triOffset + edge];
      const b = triangleIndices[triOffset + ((edge + 1) % 3)];
      const key = meshEdgeKey(a, b, vertexKeyBase);
      const owners = edgeOwners.get(key);
      const owner = { triangle, edge, a, b };
      if (owners) owners.push(owner);
      else edgeOwners.set(key, [owner]);
    }
  }
  return edgeOwners;
}

function meshEdgeIsMapBoundary(
  ctx: TerrainMeshBuildContext,
  vertexCoords: readonly number[],
  owner: TriangleEdgeOwner,
): boolean {
  const ax = vertexCoords[owner.a * 2];
  const az = vertexCoords[owner.a * 2 + 1];
  const bx = vertexCoords[owner.b * 2];
  const bz = vertexCoords[owner.b * 2 + 1];
  return (
    (Math.abs(ax) <= TERRAIN_MESH_EDGE_EPSILON && Math.abs(bx) <= TERRAIN_MESH_EDGE_EPSILON) ||
    (Math.abs(ax - ctx.mapWidth) <= TERRAIN_MESH_EDGE_EPSILON &&
      Math.abs(bx - ctx.mapWidth) <= TERRAIN_MESH_EDGE_EPSILON) ||
    (Math.abs(az) <= TERRAIN_MESH_EDGE_EPSILON && Math.abs(bz) <= TERRAIN_MESH_EDGE_EPSILON) ||
    (Math.abs(az - ctx.mapHeight) <= TERRAIN_MESH_EDGE_EPSILON &&
      Math.abs(bz - ctx.mapHeight) <= TERRAIN_MESH_EDGE_EPSILON)
  );
}

function quantizedLineValue(value: number): number {
  return Math.round(value * TERRAIN_TRIANGLE_VERTEX_KEY_SCALE);
}

function edgeSpanForOwner(
  vertexCoords: readonly number[],
  owner: TriangleEdgeOwner,
): TriangleEdgeSpan | null {
  const ax = vertexCoords[owner.a * 2];
  const az = vertexCoords[owner.a * 2 + 1];
  const bx = vertexCoords[owner.b * 2];
  const bz = vertexCoords[owner.b * 2 + 1];
  const horizontalError = Math.abs(az - bz);
  const diagA0 = ax - az * INV_SQRT3;
  const diagA1 = bx - bz * INV_SQRT3;
  const diagB0 = ax + az * INV_SQRT3;
  const diagB1 = bx + bz * INV_SQRT3;
  const diagAError = Math.abs(diagA0 - diagA1);
  const diagBError = Math.abs(diagB0 - diagB1);
  const bestError = Math.min(horizontalError, diagAError, diagBError);
  if (bestError > TERRAIN_MESH_EDGE_EPSILON) return null;

  let lineKind: TriangleEdgeLineKind;
  let lineValue: number;
  let aCoord: number;
  let bCoord: number;
  if (bestError === horizontalError) {
    lineKind = 0;
    lineValue = (az + bz) * 0.5;
    aCoord = ax;
    bCoord = bx;
  } else if (bestError === diagAError) {
    lineKind = 1;
    lineValue = (diagA0 + diagA1) * 0.5;
    aCoord = az;
    bCoord = bz;
  } else {
    lineKind = 2;
    lineValue = (diagB0 + diagB1) * 0.5;
    aCoord = az;
    bCoord = bz;
  }

  return {
    ...owner,
    lineKey: terrainEdgeLineKey(lineKind, lineValue),
    lineKind,
    start: Math.min(aCoord, bCoord),
    end: Math.max(aCoord, bCoord),
  };
}

function collectTriangleEdgeSpansByLine(
  vertexCoords: readonly number[],
  edgeOwners: ReadonlyMap<number, readonly TriangleEdgeOwner[]>,
): Map<number, TriangleEdgeSpan[]> {
  const spansByLine = new Map<number, TriangleEdgeSpan[]>();
  for (const owners of edgeOwners.values()) {
    for (let i = 0; i < owners.length; i++) {
      const span = edgeSpanForOwner(vertexCoords, owners[i]);
      if (!span) continue;
      const spans = spansByLine.get(span.lineKey);
      if (spans) spans.push(span);
      else spansByLine.set(span.lineKey, [span]);
    }
  }
  for (const spans of spansByLine.values()) {
    spans.sort((a, b) => a.start - b.start || a.end - b.end);
  }
  return spansByLine;
}

function collectTriangleEdgeSpanIndex(
  spansByLine: ReadonlyMap<number, readonly TriangleEdgeSpan[]>,
): Map<number, TriangleEdgeSpan> {
  const edgeSpans = new Map<number, TriangleEdgeSpan>();
  for (const spans of spansByLine.values()) {
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i];
      edgeSpans.set(triangleEdgeKey(span.triangle, span.edge), span);
    }
  }
  return edgeSpans;
}

function buildTerrainMeshEdgeMetadata(
  vertexCoords: readonly number[],
  triangleIndices: readonly number[],
): TerrainMeshEdgeMetadata {
  const edgeOwners = collectTriangleEdgeOwners(triangleIndices);
  const spansByLine = collectTriangleEdgeSpansByLine(vertexCoords, edgeOwners);
  const edgeSpans = collectTriangleEdgeSpanIndex(spansByLine);
  return { edgeOwners, spansByLine, edgeSpans };
}

function edgeSpansOverlap(a: TriangleEdgeSpan, b: TriangleEdgeSpan): boolean {
  if (a.triangle === b.triangle || a.lineKey !== b.lineKey) return false;
  return Math.min(a.end, b.end) - Math.max(a.start, b.start) > TERRAIN_MESH_EDGE_EPSILON;
}

function findOverlappingEdgeSpans(
  owner: TriangleEdgeOwner,
  spansByLine: ReadonlyMap<number, readonly TriangleEdgeSpan[]>,
  edgeSpans: ReadonlyMap<number, TriangleEdgeSpan>,
): TriangleEdgeSpan[] {
  const ownerSpan = edgeSpans.get(triangleEdgeKey(owner.triangle, owner.edge));
  if (!ownerSpan) return [];
  const candidates = spansByLine.get(ownerSpan.lineKey);
  if (!candidates) return [];
  const out: TriangleEdgeSpan[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (candidate.end <= ownerSpan.start + TERRAIN_MESH_EDGE_EPSILON) continue;
    if (candidate.start >= ownerSpan.end - TERRAIN_MESH_EDGE_EPSILON) break;
    if (edgeSpansOverlap(ownerSpan, candidate)) out.push(candidate);
  }
  return out;
}

function edgeCoordinateForLine(
  lineKind: TriangleEdgeLineKind,
  vertexCoords: readonly number[],
  vertexId: number,
): number {
  const x = vertexCoords[vertexId * 2];
  const z = vertexCoords[vertexId * 2 + 1];
  return lineKind === 0 ? x : z;
}

function addSplitVertexForEdge(
  splitVerticesByEdge: Map<number, Set<number>>,
  vertexCoords: readonly number[],
  owner: TriangleEdgeOwner,
  ownerSpan: TriangleEdgeSpan,
  vertexId: number,
): void {
  if (vertexId === owner.a || vertexId === owner.b) return;
  const coord = edgeCoordinateForLine(ownerSpan.lineKind, vertexCoords, vertexId);
  if (
    coord <= ownerSpan.start + TERRAIN_MESH_EDGE_EPSILON ||
    coord >= ownerSpan.end - TERRAIN_MESH_EDGE_EPSILON
  ) {
    return;
  }
  const key = triangleEdgeKey(owner.triangle, owner.edge);
  let vertices = splitVerticesByEdge.get(key);
  if (!vertices) {
    vertices = new Set<number>();
    splitVerticesByEdge.set(key, vertices);
  }
  vertices.add(vertexId);
}

function collectMeshEdgeSplitVertices(
  ctx: TerrainMeshBuildContext,
  vertexCoords: readonly number[],
  triangleIndices: readonly number[],
): Map<number, Set<number>> {
  const { edgeOwners, spansByLine, edgeSpans } = buildTerrainMeshEdgeMetadata(
    vertexCoords,
    triangleIndices,
  );
  const splitVerticesByEdge = new Map<number, Set<number>>();

  for (const owners of edgeOwners.values()) {
    if (owners.length !== 1) continue;
    const owner = owners[0];
    if (meshEdgeIsMapBoundary(ctx, vertexCoords, owner)) continue;
    const ownerSpan = edgeSpans.get(triangleEdgeKey(owner.triangle, owner.edge));
    if (!ownerSpan) continue;

    const overlaps = findOverlappingEdgeSpans(owner, spansByLine, edgeSpans);
    for (let i = 0; i < overlaps.length; i++) {
      const overlap = overlaps[i];
      addSplitVertexForEdge(splitVerticesByEdge, vertexCoords, owner, ownerSpan, overlap.a);
      addSplitVertexForEdge(splitVerticesByEdge, vertexCoords, owner, ownerSpan, overlap.b);
    }
  }

  return splitVerticesByEdge;
}

function pushUniqueVertex(out: number[], vertexId: number): void {
  if (out[out.length - 1] !== vertexId) out.push(vertexId);
}

function triangleAreaFromVertexIds(
  vertexCoords: readonly number[],
  a: number,
  b: number,
  c: number,
): number {
  const ax = vertexCoords[a * 2];
  const az = vertexCoords[a * 2 + 1];
  const bx = vertexCoords[b * 2];
  const bz = vertexCoords[b * 2 + 1];
  const cx = vertexCoords[c * 2];
  const cz = vertexCoords[c * 2 + 1];
  return (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
}

function polygonSignedAreaFromVertexIds(
  vertexCoords: readonly number[],
  polygon: readonly number[],
): number {
  let area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    area +=
      vertexCoords[a * 2] * vertexCoords[b * 2 + 1] -
      vertexCoords[b * 2] * vertexCoords[a * 2 + 1];
  }
  return area * 0.5;
}

function triangulateConvexPolygonVertexIds(
  vertexCoords: readonly number[],
  polygon: readonly number[],
  level: number,
  leafIndex: number,
  outIndices: number[],
  outLevels: number[],
  outLeafIndices: number[],
): void {
  let work = [...polygon];
  if (work.length < 3) return;
  if (polygonSignedAreaFromVertexIds(vertexCoords, work) < 0) work = work.reverse();

  let guard = work.length * work.length;
  while (work.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < work.length; i++) {
      const prev = work[(i + work.length - 1) % work.length];
      const curr = work[i];
      const next = work[(i + 1) % work.length];
      if (triangleAreaFromVertexIds(vertexCoords, prev, curr, next) <= TERRAIN_MESH_EPSILON) {
        continue;
      }
      outIndices.push(prev, curr, next);
      outLevels.push(level);
      outLeafIndices.push(leafIndex);
      work.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) return;
  }

  if (
    work.length === 3 &&
    triangleAreaFromVertexIds(vertexCoords, work[0], work[1], work[2]) > TERRAIN_MESH_EPSILON
  ) {
    outIndices.push(work[0], work[1], work[2]);
    outLevels.push(level);
    outLeafIndices.push(leafIndex);
  }
}

function sortedSplitVerticesForTriangleEdge(
  vertexCoords: readonly number[],
  a: number,
  b: number,
  splitVertices: ReadonlySet<number> | undefined,
): number[] {
  if (!splitVertices || splitVertices.size === 0) return [];
  const ax = vertexCoords[a * 2];
  const az = vertexCoords[a * 2 + 1];
  const bx = vertexCoords[b * 2];
  const bz = vertexCoords[b * 2 + 1];
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq <= TERRAIN_MESH_EPSILON) return [];
  return [...splitVertices].sort((va, vb) => {
    const tax = vertexCoords[va * 2] - ax;
    const taz = vertexCoords[va * 2 + 1] - az;
    const tbx = vertexCoords[vb * 2] - ax;
    const tbz = vertexCoords[vb * 2 + 1] - az;
    return (tax * dx + taz * dz) / lenSq - (tbx * dx + tbz * dz) / lenSq;
  });
}

function resolveMeshTriangleEdgeSplits(
  ctx: TerrainMeshBuildContext,
  vertexCoords: readonly number[],
  triangleIndices: readonly number[],
  triangleLevels: readonly number[],
  triangleLeafIndices: readonly number[],
): {
  triangleIndices: number[];
  triangleLevels: number[];
  triangleLeafIndices: number[];
} {
  let indices = [...triangleIndices];
  let levels = [...triangleLevels];
  let leafIndices = [...triangleLeafIndices];
  const maxIterations = terrainTriangleHierarchyLevel(ctx, {
    i: 0,
    j: 0,
    side: 1,
    down: false,
  }) + 2;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const splitVerticesByEdge = collectMeshEdgeSplitVertices(ctx, vertexCoords, indices);
    if (splitVerticesByEdge.size === 0) break;

    const nextIndices: number[] = [];
    const nextLevels: number[] = [];
    const nextLeafIndices: number[] = [];

    for (let tri = 0; tri < indices.length / 3; tri++) {
      const base = tri * 3;
      const a = indices[base];
      const b = indices[base + 1];
      const c = indices[base + 2];
      const polygon: number[] = [];
      pushUniqueVertex(polygon, a);
      for (const v of sortedSplitVerticesForTriangleEdge(
        vertexCoords,
        a,
        b,
        splitVerticesByEdge.get(base),
      )) {
        pushUniqueVertex(polygon, v);
      }
      pushUniqueVertex(polygon, b);
      for (const v of sortedSplitVerticesForTriangleEdge(
        vertexCoords,
        b,
        c,
        splitVerticesByEdge.get(base + 1),
      )) {
        pushUniqueVertex(polygon, v);
      }
      pushUniqueVertex(polygon, c);
      for (const v of sortedSplitVerticesForTriangleEdge(
        vertexCoords,
        c,
        a,
        splitVerticesByEdge.get(base + 2),
      )) {
        pushUniqueVertex(polygon, v);
      }
      if (polygon.length > 1 && polygon[0] === polygon[polygon.length - 1]) polygon.pop();

      triangulateConvexPolygonVertexIds(
        vertexCoords,
        polygon,
        levels[tri] ?? 0,
        leafIndices[tri] ?? -1,
        nextIndices,
        nextLevels,
        nextLeafIndices,
      );
    }

    indices = nextIndices;
    levels = nextLevels;
    leafIndices = nextLeafIndices;
  }

  return {
    triangleIndices: indices,
    triangleLevels: levels,
    triangleLeafIndices: leafIndices,
  };
}

function buildTriangleNeighborMetadata(
  ctx: TerrainMeshBuildContext,
  vertexCoords: readonly number[],
  triangleIndices: readonly number[],
  triangleLevels: readonly number[],
  edgeMetadata: TerrainMeshEdgeMetadata = buildTerrainMeshEdgeMetadata(
    vertexCoords,
    triangleIndices,
  ),
): { indices: number[]; levels: number[] } {
  const triangleCount = Math.floor(triangleIndices.length / 3);
  const neighborIndices = new Array<number>(triangleCount * 3).fill(-1);
  const neighborLevels = new Array<number>(triangleCount * 3).fill(-1);
  const { edgeOwners, spansByLine, edgeSpans } = edgeMetadata;

  for (const owners of edgeOwners.values()) {
    if (owners.length !== 2) continue;
    const a = owners[0];
    const b = owners[1];
    const aOffset = a.triangle * 3 + a.edge;
    const bOffset = b.triangle * 3 + b.edge;
    neighborIndices[aOffset] = b.triangle;
    neighborLevels[aOffset] = triangleLevels[b.triangle] ?? -1;
    neighborIndices[bOffset] = a.triangle;
    neighborLevels[bOffset] = triangleLevels[a.triangle] ?? -1;
  }

  for (const owners of edgeOwners.values()) {
    for (let i = 0; i < owners.length; i++) {
      const owner = owners[i];
      const ownerOffset = owner.triangle * 3 + owner.edge;
      if (neighborLevels[ownerOffset] >= 0 || meshEdgeIsMapBoundary(ctx, vertexCoords, owner)) {
        continue;
      }
      const overlaps = findOverlappingEdgeSpans(owner, spansByLine, edgeSpans);
      let bestTriangle = -1;
      let bestLevel = -1;
      for (let o = 0; o < overlaps.length; o++) {
        const candidate = overlaps[o];
        const level = triangleLevels[candidate.triangle] ?? -1;
        if (level > bestLevel) {
          bestLevel = level;
          bestTriangle = candidate.triangle;
        }
      }
      if (bestTriangle >= 0) {
        neighborIndices[ownerOffset] = bestTriangle;
        neighborLevels[ownerOffset] = bestLevel;
      }
    }
  }

  return { indices: neighborIndices, levels: neighborLevels };
}

function markTriangleLeafForSplit(
  leaves: readonly TerrainHierarchyTriangle[],
  triangleLeafIndices: readonly number[],
  splitLeafIndices: Set<number>,
  triangle: number,
): void {
  const leafIndex = triangleLeafIndices[triangle];
  if (leafIndex === undefined || leafIndex < 0) return;
  const leaf = leaves[leafIndex];
  if (leaf === undefined || leaf.side <= 1) return;
  splitLeafIndices.add(leafIndex);
}

function markCoarserTriangleLeafForSplit(
  leaves: readonly TerrainHierarchyTriangle[],
  triangleLeafIndices: readonly number[],
  triangleLevels: readonly number[],
  splitLeafIndices: Set<number>,
  aTriangle: number,
  bTriangle: number,
): void {
  const aLevel = triangleLevels[aTriangle] ?? 0;
  const bLevel = triangleLevels[bTriangle] ?? 0;
  if (aLevel <= bLevel) {
    markTriangleLeafForSplit(leaves, triangleLeafIndices, splitLeafIndices, aTriangle);
  }
  if (bLevel <= aLevel) {
    markTriangleLeafForSplit(leaves, triangleLeafIndices, splitLeafIndices, bTriangle);
  }
}

function findMeshNeighborDiscrepancyLeafIndices(
  ctx: TerrainMeshBuildContext,
  leaves: readonly TerrainHierarchyTriangle[],
  mesh: TerrainMeshTopology,
): { splitLeafIndices: Set<number>; edgeMetadata: TerrainMeshEdgeMetadata } {
  const splitLeafIndices = new Set<number>();
  const maxDelta = Math.max(0, TERRAIN_TRIANGLE_MAX_NEIGHBOR_LEVEL_DELTA | 0);
  const edgeMetadata = buildTerrainMeshEdgeMetadata(
    mesh.vertexCoords,
    mesh.triangleIndices,
  );
  const { edgeOwners, spansByLine, edgeSpans } = edgeMetadata;

  for (const owners of edgeOwners.values()) {
    if (owners.length === 2) {
      const a = owners[0];
      const b = owners[1];
      const aLevel = mesh.triangleLevels[a.triangle] ?? 0;
      const bLevel = mesh.triangleLevels[b.triangle] ?? 0;
      if (Math.abs(aLevel - bLevel) > maxDelta) {
        markCoarserTriangleLeafForSplit(
          leaves,
          mesh.triangleLeafIndices,
          mesh.triangleLevels,
          splitLeafIndices,
          a.triangle,
          b.triangle,
        );
      }
      continue;
    }

    if (owners.length > 2) {
      for (let i = 0; i < owners.length; i++) {
        markTriangleLeafForSplit(
          leaves,
          mesh.triangleLeafIndices,
          splitLeafIndices,
          owners[i].triangle,
        );
      }
      continue;
    }

    const owner = owners[0];
    if (meshEdgeIsMapBoundary(ctx, mesh.vertexCoords, owner)) continue;

    const overlaps = findOverlappingEdgeSpans(owner, spansByLine, edgeSpans);
    if (overlaps.length === 0) {
      markTriangleLeafForSplit(
        leaves,
        mesh.triangleLeafIndices,
        splitLeafIndices,
        owner.triangle,
      );
      continue;
    }

    for (let i = 0; i < overlaps.length; i++) {
      markCoarserTriangleLeafForSplit(
        leaves,
        mesh.triangleLeafIndices,
        mesh.triangleLevels,
        splitLeafIndices,
        owner.triangle,
        overlaps[i].triangle,
      );
    }
  }

  return { splitLeafIndices, edgeMetadata };
}

/** Laplacian smoothing of mesh vertex heights using triangle-edge adjacency.
 *  Each pass replaces every vertex height with a blend of itself and the
 *  mean of its neighbors. Vertex positions and the triangle index are
 *  untouched — only heights change. */
function smoothMeshVertexHeights(
  vertexHeights: number[],
  triangleIndices: readonly number[],
): void {
  const steps = Math.max(0, TERRAIN_MESH_HEIGHT_SMOOTHING.maxSteps | 0);
  const amount = Math.max(0, Math.min(1, TERRAIN_MESH_HEIGHT_SMOOTHING.amount));
  if (steps <= 0 || amount <= 0 || vertexHeights.length === 0) return;

  const sim = getSimWasm();
  if (sim !== undefined) {
    const wasmVertexHeights = Float64Array.from(vertexHeights);
    const ok = sim.terrainSmoothMeshVertexHeights(
      wasmVertexHeights,
      Int32Array.from(triangleIndices),
      steps,
      amount,
    );
    if (ok !== 0) {
      for (let i = 0; i < vertexHeights.length; i++) {
        vertexHeights[i] = wasmVertexHeights[i];
      }
      return;
    }
  }

  const vertexCount = vertexHeights.length;
  const neighborSets = new Array<Set<number>>(vertexCount);
  for (let i = 0; i < vertexCount; i++) neighborSets[i] = new Set<number>();
  for (let t = 0; t < triangleIndices.length; t += 3) {
    const a = triangleIndices[t];
    const b = triangleIndices[t + 1];
    const c = triangleIndices[t + 2];
    neighborSets[a].add(b); neighborSets[a].add(c);
    neighborSets[b].add(a); neighborSets[b].add(c);
    neighborSets[c].add(a); neighborSets[c].add(b);
  }
  const neighbors: number[][] = neighborSets.map((s) => [...s]);

  const next = new Array<number>(vertexCount);
  for (let pass = 0; pass < steps; pass++) {
    for (let v = 0; v < vertexCount; v++) {
      const ns = neighbors[v];
      if (ns.length === 0) { next[v] = vertexHeights[v]; continue; }
      let sum = 0;
      for (let k = 0; k < ns.length; k++) sum += vertexHeights[ns[k]];
      const avg = sum / ns.length;
      next[v] = vertexHeights[v] + (avg - vertexHeights[v]) * amount;
    }
    for (let v = 0; v < vertexCount; v++) vertexHeights[v] = next[v];
  }
}

function buildConformingMeshTopologyFromLeaves(
  ctx: TerrainMeshBuildContext,
  leaves: readonly TerrainHierarchyTriangle[],
): TerrainMeshTopology {
  const leafVertexSet = new Set<string>();
  for (let i = 0; i < leaves.length; i++) {
    const verts = triangleLatticeVertices(leaves[i]);
    for (let v = 0; v < verts.length; v++) {
      leafVertexSet.add(latticeKey(verts[v].i, verts[v].j));
    }
  }

  const vertexIds = new Map<string, number>();
  const vertexCoords: number[] = [];
  const vertexHeights: number[] = [];
  let triangleIndices: number[] = [];
  let triangleLevels: number[] = [];
  let triangleLeafIndices: number[] = [];
  const addVertex = (p: MeshPoint): number => {
    const x = clampToMap(p.x, ctx.mapWidth);
    const z = clampToMap(p.z, ctx.mapHeight);
    const key = worldVertexKey(x, z);
    const existing = vertexIds.get(key);
    if (existing !== undefined) return existing;
    const id = vertexHeights.length;
    vertexIds.set(key, id);
    vertexCoords.push(x, z);
    vertexHeights.push(terrainHeightAtWorld(ctx, x, z));
    return id;
  };
  const addPolygon = (
    points: readonly MeshPoint[],
    level: number,
    leafIndex: number,
  ): void => {
    const polygon = points.map((p) => addVertex(p));
    triangulateConvexPolygonVertexIds(
      vertexCoords,
      polygon,
      level,
      leafIndex,
      triangleIndices,
      triangleLevels,
      triangleLeafIndices,
    );
  };

  for (let i = 0; i < leaves.length; i++) {
    const sourceLevel = terrainTriangleHierarchyLevel(ctx, leaves[i]);
    const latticePoints = triangleBoundaryLatticePoints(leaves[i], leafVertexSet);
    const polygon = latticePoints.map((p) => latticePointAt(ctx, p.i, p.j));
    let clipped = clipPolygonToMap(ctx, polygon);
    if (clipped.length < 3) continue;
    if (polygonSignedArea(clipped) < 0) clipped = [...clipped].reverse();
    addPolygon(clipped, sourceLevel, i);
  }

  const resolvedTriangles = resolveMeshTriangleEdgeSplits(
    ctx,
    vertexCoords,
    triangleIndices,
    triangleLevels,
    triangleLeafIndices,
  );
  triangleIndices = resolvedTriangles.triangleIndices;
  triangleLevels = resolvedTriangles.triangleLevels;
  triangleLeafIndices = resolvedTriangles.triangleLeafIndices;

  return {
    vertexCoords,
    vertexHeights,
    triangleIndices,
    triangleLevels,
    triangleLeafIndices,
  };
}

function finalizeConformingMeshTopology(
  ctx: TerrainMeshBuildContext,
  topology: TerrainMeshTopology,
  cellsX: number,
  cellsY: number,
  cellSize: number,
  edgeMetadata?: TerrainMeshEdgeMetadata,
): BuiltTerrainMesh {
  const vertexHeights = [...topology.vertexHeights];
  smoothMeshVertexHeights(vertexHeights, topology.triangleIndices);

  const triangleNeighbors = buildTriangleNeighborMetadata(
    ctx,
    topology.vertexCoords,
    topology.triangleIndices,
    topology.triangleLevels,
    edgeMetadata,
  );

  const { cellTriangleOffsets, cellTriangleIndices } = buildTerrainCellTriangleIndex({
    cellsX,
    cellsY,
    cellSize,
    vertexCoords: topology.vertexCoords,
    triangleIndices: topology.triangleIndices,
  });

  return {
    vertexCoords: topology.vertexCoords,
    vertexHeights,
    triangleIndices: topology.triangleIndices,
    triangleLevels: topology.triangleLevels,
    triangleLeafIndices: topology.triangleLeafIndices,
    triangleNeighborIndices: triangleNeighbors.indices,
    triangleNeighborLevels: triangleNeighbors.levels,
    cellTriangleOffsets,
    cellTriangleIndices,
  };
}

function buildValidatedConformingMeshFromLeaves(
  ctx: TerrainMeshBuildContext,
  leaves: readonly TerrainHierarchyTriangle[],
  cellsX: number,
  cellsY: number,
  cellSize: number,
): BuiltTerrainMesh {
  let repairedLeaves = [...leaves];
  const maxPasses = terrainTriangleHierarchyLevel(ctx, {
    i: 0,
    j: 0,
    side: 1,
    down: false,
  }) + 2;
  const boundedMaxPasses = Math.max(
    0,
    Math.min(maxPasses, TERRAIN_TRIANGLE_FINAL_REPAIR_MAX_PASSES | 0),
  );

  for (let pass = 0; pass < boundedMaxPasses; pass++) {
    const topology = buildConformingMeshTopologyFromLeaves(ctx, repairedLeaves);
    const { splitLeafIndices, edgeMetadata } = findMeshNeighborDiscrepancyLeafIndices(
      ctx,
      repairedLeaves,
      topology,
    );
    if (splitLeafIndices.size === 0) {
      return finalizeConformingMeshTopology(
        ctx,
        topology,
        cellsX,
        cellsY,
        cellSize,
        edgeMetadata,
      );
    }

    const nextLeaves = balanceTerrainTriangleLeaves(
      ctx,
      splitTerrainTriangleLeaves(ctx, repairedLeaves, splitLeafIndices),
    );
    if (nextLeaves.length === repairedLeaves.length) {
      return finalizeConformingMeshTopology(
        ctx,
        topology,
        cellsX,
        cellsY,
        cellSize,
        edgeMetadata,
      );
    }
    repairedLeaves = nextLeaves;
  }

  return finalizeConformingMeshTopology(
    ctx,
    buildConformingMeshTopologyFromLeaves(ctx, repairedLeaves),
    cellsX,
    cellsY,
    cellSize,
  );
}

function buildAdaptiveEquilateralTerrainMesh(
  mapWidth: number,
  mapHeight: number,
  cellSize: number,
  cellsX: number,
  cellsY: number,
  maxSubdiv: number,
): BuiltTerrainMesh {
  const fineEdge = cellSize / Math.max(1, maxSubdiv);
  const fineHeight = fineEdge * SQRT3_OVER_2;
  const rootSide = nextPowerOfTwo(
    Math.max(
      1,
      Math.ceil(Math.max(mapWidth / fineEdge, mapHeight / fineHeight)),
    ),
  );
  const ctx: TerrainMeshBuildContext = {
    mapWidth,
    mapHeight,
    fineEdge,
    fineHeight,
    rootLevel: 31 - Math.clz32(rootSide),
    heightSampler: createTerrainHeightSampler(mapWidth, mapHeight),
    heightCache: new Map<number, number>(),
    normalCache: new Map<number, TerrainNormal>(),
  };
  const rows = Math.ceil(mapHeight / fineHeight);
  const cols = Math.ceil(mapWidth / fineEdge);
  const leaves: TerrainHierarchyTriangle[] = [];

  for (let j = -rootSide; j <= rows + rootSide; j += rootSide) {
    for (let i = -rootSide * 2; i <= cols + rootSide * 2; i += rootSide) {
      buildTerrainTriangleLeaves(ctx, { i, j, side: rootSide, down: false }, leaves);
      buildTerrainTriangleLeaves(ctx, { i, j, side: rootSide, down: true }, leaves);
    }
  }

  const balancedLeaves = balanceTerrainTriangleLeaves(ctx, leaves);
  return buildValidatedConformingMeshFromLeaves(ctx, balancedLeaves, cellsX, cellsY, cellSize);
}

export function getTerrainMeshView(
  mapWidth: number,
  mapHeight: number,
  cellSize: number = LAND_CELL_SIZE,
): TerrainMeshView | null {
  assertCanonicalLandCellSize('getTerrainMeshView cellSize', cellSize);
  const size = terrainCellSize(cellSize);
  const map = getInstalledTerrainTileMap(mapWidth, mapHeight, size);
  if (!map) return null;
  return {
    vertexCount: map.meshVertexHeights.length,
    triangleCount: Math.floor(map.meshTriangleIndices.length / 3),
    vertexCoords: map.meshVertexCoords,
    vertexHeights: map.meshVertexHeights,
    triangleIndices: map.meshTriangleIndices,
    triangleLevels: map.meshTriangleLevels,
    triangleNeighborIndices: map.meshTriangleNeighborIndices,
    triangleNeighborLevels: map.meshTriangleNeighborLevels,
  };
}

function terrainTriangleSampleFromGlobalMesh(
  map: TerrainTileMap,
  px: number,
  pz: number,
  cellX: number,
  cellY: number,
): TerrainTriangleSample | null {
  const cellIdx = cellY * map.cellsX + cellX;
  const start = map.meshCellTriangleOffsets[cellIdx] ?? 0;
  const end = map.meshCellTriangleOffsets[cellIdx + 1] ?? start;
  let best: TerrainTriangleSample | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let ref = start; ref < end; ref++) {
    const tri = map.meshCellTriangleIndices[ref];
    const triOffset = tri * 3;
    const ia = map.meshTriangleIndices[triOffset];
    const ib = map.meshTriangleIndices[triOffset + 1];
    const ic = map.meshTriangleIndices[triOffset + 2];
    const ax = map.meshVertexCoords[ia * 2];
    const az = map.meshVertexCoords[ia * 2 + 1];
    const bx = map.meshVertexCoords[ib * 2];
    const bz = map.meshVertexCoords[ib * 2 + 1];
    const cx = map.meshVertexCoords[ic * 2];
    const cz = map.meshVertexCoords[ic * 2 + 1];
    const bary = terrainBarycentricAt(px, pz, ax, az, bx, bz, cx, cz);
    if (!bary) continue;
    const score = Math.min(bary.wa, bary.wb, bary.wc);
    if (score < -1e-5 && score <= bestScore) continue;
    const weights = score >= -1e-5
      ? bary
      : normalizeBarycentricWeights(bary.wa, bary.wb, bary.wc);
    const sample = {
      ax,
      az,
      ah: map.meshVertexHeights[ia] ?? 0,
      bx,
      bz,
      bh: map.meshVertexHeights[ib] ?? 0,
      cx,
      cz,
      ch: map.meshVertexHeights[ic] ?? 0,
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
    candidateMap.subdiv === TERRAIN_FINE_TRIANGLE_SUBDIV
      ? candidateMap
      : null;
  const cellsX = installedMap !== null ? installedMap.cellsX : Math.max(1, Math.ceil(mapWidth / size));
  const cellsZ = installedMap !== null ? installedMap.cellsY : Math.max(1, Math.ceil(mapHeight / size));
  const maxX = cellsX * size;
  const maxZ = cellsZ * size;
  const px = x <= 0 ? 0 : x >= maxX ? maxX : x;
  const pz = z <= 0 ? 0 : z >= maxZ ? maxZ : z;
  const cellX = Math.min(cellsX - 1, Math.max(0, Math.floor(px / size)));
  const cellZ = Math.min(cellsZ - 1, Math.max(0, Math.floor(pz / size)));

  if (installedMap) {
    const triangle = terrainTriangleSampleFromGlobalMesh(installedMap, px, pz, cellX, cellZ);
    if (triangle) {
      return {
        u: triangle.wb,
        v: triangle.wc,
        subSize: size / installedMap.subdiv,
        h00: triangle.ah,
        h10: triangle.bh,
        h11: triangle.ch,
        h01: triangle.ah,
        triangle,
      };
    }
  }

  const localX = px - cellX * size;
  const localZ = pz - cellZ * size;
  const subSize = size / TERRAIN_FINE_TRIANGLE_SUBDIV;
  const subX = Math.min(
    TERRAIN_FINE_TRIANGLE_SUBDIV - 1,
    Math.max(0, Math.floor(localX / subSize)),
  );
  const subZ = Math.min(
    TERRAIN_FINE_TRIANGLE_SUBDIV - 1,
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
  return {
    u,
    v,
    subSize,
    h00,
    h10,
    h11,
    h01,
    triangle: undefined,
  };
}

function interpolateTerrainMeshQuadHeight(
  u: number,
  v: number,
  h00: number,
  h10: number,
  h11: number,
  h01: number,
): number {
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
    const uy = tri.bh - tri.ah;
    const uz = tri.bz - tri.az;
    const vx = tri.cx - tri.ax;
    const vy = tri.ch - tri.ah;
    const vz = tri.cz - tri.az;
    let nx = uy * vz - uz * vy;
    let vertical = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    if (vertical < 0) {
      nx = -nx;
      vertical = -vertical;
      nz = -nz;
    }
    const len = Math.sqrt(nx * nx + vertical * vertical + nz * nz) || 1;
    return { nx: nx / len, ny: nz / len, nz: vertical / len };
  }
  const { u, v, subSize, h00, h10, h11, h01 } = sample;
  const dHdx = u >= v ? (h10 - h00) / subSize : (h11 - h01) / subSize;
  const dHdz = u >= v ? (h11 - h10) / subSize : (h01 - h00) / subSize;
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
