import type { TerrainTileMap } from '@/types/terrain';
import { LAND_CELL_SIZE } from '../../../config';
import { assertCanonicalLandCellSize } from '../../landGrid';
import {
  TERRAIN_FINE_TRIANGLE_SUBDIV,
  TERRAIN_TRIANGLE_FINAL_REPAIR_MAX_PASSES,
  TERRAIN_TRIANGLE_MAX_HEIGHT_ERROR,
  TERRAIN_TRIANGLE_MAX_NEIGHBOR_LEVEL_DELTA,
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
  triangle?: TerrainTriangleSample;
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

type TerrainMeshBuildContext = {
  mapWidth: number;
  mapHeight: number;
  fineEdge: number;
  fineHeight: number;
  rootSide: number;
  heightCache: Map<string, number>;
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

type TriangleEdgeOwner = {
  triangle: number;
  edge: number;
  a: number;
  b: number;
};

type TriangleEdgeSpan = TriangleEdgeOwner & {
  lineKey: string;
  start: number;
  end: number;
};

const SQRT3_OVER_2 = Math.sqrt(3) * 0.5;
const TERRAIN_MESH_EPSILON = 1e-6;
const TERRAIN_MESH_EDGE_EPSILON = 1e-4;
const INV_SQRT3 = 1 / Math.sqrt(3);

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

function latticePointAt(ctx: TerrainMeshBuildContext, i: number, j: number): MeshPoint {
  const x = ctx.fineEdge * (i + j * 0.5);
  const z = ctx.fineHeight * j;
  return {
    x,
    z,
    h: terrainHeightAtWorld(ctx, x, z),
  };
}

function terrainHeightAtWorld(ctx: TerrainMeshBuildContext, x: number, z: number): number {
  return getTerrainHeight(
    clampToMap(x, ctx.mapWidth),
    clampToMap(z, ctx.mapHeight),
    ctx.mapWidth,
    ctx.mapHeight,
  );
}

function terrainHeightAtLattice(ctx: TerrainMeshBuildContext, i: number, j: number): number {
  const key = latticeKey(i, j);
  const cached = ctx.heightCache.get(key);
  if (cached !== undefined) return cached;
  const x = ctx.fineEdge * (i + j * 0.5);
  const z = ctx.fineHeight * j;
  const h = terrainHeightAtWorld(ctx, x, z);
  ctx.heightCache.set(key, h);
  return h;
}

function terrainTriangleHierarchyLevel(
  ctx: TerrainMeshBuildContext,
  tri: TerrainHierarchyTriangle,
): number {
  const ratio = ctx.rootSide / Math.max(1, tri.side);
  return Math.max(0, Math.round(Math.log2(ratio)));
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
  const [a, b, c] = triangleWorldVertices(ctx, tri);
  const minX = Math.min(a.x, b.x, c.x);
  const maxX = Math.max(a.x, b.x, c.x);
  const minZ = Math.min(a.z, b.z, c.z);
  const maxZ = Math.max(a.z, b.z, c.z);
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

function forEachFinePointInTriangle(
  tri: TerrainHierarchyTriangle,
  visit: (i: number, j: number) => boolean,
): boolean {
  const n = tri.side;
  for (let a = 0; a <= n; a++) {
    for (let b = 0; b <= n; b++) {
      const inside = tri.down ? a + b >= n : a + b <= n;
      if (!inside) continue;
      if (visit(tri.i + a, tri.j + b)) return true;
    }
  }
  return false;
}

function canCollapseTerrainTriangle(
  ctx: TerrainMeshBuildContext,
  tri: TerrainHierarchyTriangle,
): boolean {
  const [a, b, c] = triangleWorldVertices(ctx, tri);
  let checked = 0;
  let failed = false;

  forEachFinePointInTriangle(tri, (i, j) => {
    const x = ctx.fineEdge * (i + j * 0.5);
    const z = ctx.fineHeight * j;
    if (!pointInsideMap(ctx, x, z)) return false;
    const bary = terrainBarycentricAt(x, z, a.x, a.z, b.x, b.z, c.x, c.z);
    if (!bary) return false;
    const actual = terrainHeightAtLattice(ctx, i, j);
    const approx = bary.wa * a.h + bary.wb * b.h + bary.wc * c.h;
    checked++;
    if (
      TERRAIN_TRIANGLE_PRESERVE_WATERLINE &&
      (actual < WATER_LEVEL) !== (approx < WATER_LEVEL)
    ) {
      failed = true;
      return true;
    }
    if (Math.abs(actual - approx) > TERRAIN_TRIANGLE_MAX_HEIGHT_ERROR) {
      failed = true;
      return true;
    }
    return false;
  });

  if (failed) return false;
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
    if (Math.abs(actual - approx) > TERRAIN_TRIANGLE_MAX_HEIGHT_ERROR) return false;
  }

  return true;
}

function terrainTriangleChildren(tri: TerrainHierarchyTriangle): TerrainHierarchyTriangle[] {
  const half = tri.side >> 1;
  if (half < 1) return [];
  const { i, j } = tri;
  if (!tri.down) {
    return [
      { i, j, side: half, down: false },
      { i: i + half, j, side: half, down: false },
      { i, j: j + half, side: half, down: false },
      { i, j, side: half, down: true },
    ];
  }
  return [
    { i: i + half, j, side: half, down: true },
    { i, j: j + half, side: half, down: true },
    { i: i + half, j: j + half, side: half, down: true },
    { i: i + half, j: j + half, side: half, down: false },
  ];
}

function buildTerrainTriangleLeaves(
  ctx: TerrainMeshBuildContext,
  tri: TerrainHierarchyTriangle,
  out: TerrainHierarchyTriangle[],
): void {
  if (!triangleBboxIntersectsMap(ctx, tri)) return;
  if (tri.side <= 1) {
    out.push(tri);
    return;
  }

  if (canCollapseTerrainTriangle(ctx, tri)) {
    out.push(tri);
    return;
  }

  const children = terrainTriangleChildren(tri);
  for (let i = 0; i < children.length; i++) {
    buildTerrainTriangleLeaves(ctx, children[i], out);
  }
}

function latticeSegmentKey(a: LatticePoint, b: LatticePoint): string {
  const ak = latticeKey(a.i, a.j);
  const bk = latticeKey(b.i, b.j);
  return ak < bk ? `${ak}|${bk}` : `${bk}|${ak}`;
}

function forEachTriangleUnitEdgeSegment(
  tri: TerrainHierarchyTriangle,
  visit: (a: LatticePoint, b: LatticePoint) => void,
): void {
  const verts = triangleLatticeVertices(tri);
  for (let edge = 0; edge < 3; edge++) {
    const a = verts[edge];
    const b = verts[(edge + 1) % 3];
    const di = b.i - a.i;
    const dj = b.j - a.j;
    const steps = Math.max(Math.abs(di), Math.abs(dj));
    if (steps <= 0) continue;
    const stepI = di / steps;
    const stepJ = dj / steps;
    for (let k = 0; k < steps; k++) {
      visit(
        { i: a.i + stepI * k, j: a.j + stepJ * k },
        { i: a.i + stepI * (k + 1), j: a.j + stepJ * (k + 1) },
      );
    }
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
    const segmentOwners = new Map<string, Array<{ leafIndex: number; level: number }>>();
    for (let leafIndex = 0; leafIndex < balanced.length; leafIndex++) {
      const leaf = balanced[leafIndex];
      const level = terrainTriangleHierarchyLevel(ctx, leaf);
      forEachTriangleUnitEdgeSegment(leaf, (a, b) => {
        const key = latticeSegmentKey(a, b);
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
    const children = terrainTriangleChildren(leaf);
    for (let c = 0; c < children.length; c++) {
      if (triangleBboxIntersectsMap(ctx, children[c])) next.push(children[c]);
    }
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

function meshEdgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function collectTriangleEdgeOwners(
  triangleIndices: readonly number[],
): Map<string, TriangleEdgeOwner[]> {
  const edgeOwners = new Map<string, TriangleEdgeOwner[]>();
  const triangleCount = Math.floor(triangleIndices.length / 3);
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const triOffset = triangle * 3;
    for (let edge = 0; edge < 3; edge++) {
      const a = triangleIndices[triOffset + edge];
      const b = triangleIndices[triOffset + ((edge + 1) % 3)];
      const key = meshEdgeKey(a, b);
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

  let lineKey: string;
  let aCoord: number;
  let bCoord: number;
  if (bestError === horizontalError) {
    lineKey = `h:${quantizedLineValue((az + bz) * 0.5)}`;
    aCoord = ax;
    bCoord = bx;
  } else if (bestError === diagAError) {
    lineKey = `a:${quantizedLineValue((diagA0 + diagA1) * 0.5)}`;
    aCoord = az;
    bCoord = bz;
  } else {
    lineKey = `b:${quantizedLineValue((diagB0 + diagB1) * 0.5)}`;
    aCoord = az;
    bCoord = bz;
  }

  return {
    ...owner,
    lineKey,
    start: Math.min(aCoord, bCoord),
    end: Math.max(aCoord, bCoord),
  };
}

function collectTriangleEdgeSpansByLine(
  vertexCoords: readonly number[],
  edgeOwners: ReadonlyMap<string, readonly TriangleEdgeOwner[]>,
): Map<string, TriangleEdgeSpan[]> {
  const spansByLine = new Map<string, TriangleEdgeSpan[]>();
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
  spansByLine: ReadonlyMap<string, readonly TriangleEdgeSpan[]>,
): Map<string, TriangleEdgeSpan> {
  const edgeSpans = new Map<string, TriangleEdgeSpan>();
  for (const spans of spansByLine.values()) {
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i];
      edgeSpans.set(`${span.triangle}:${span.edge}`, span);
    }
  }
  return edgeSpans;
}

function edgeSpansOverlap(a: TriangleEdgeSpan, b: TriangleEdgeSpan): boolean {
  if (a.triangle === b.triangle || a.lineKey !== b.lineKey) return false;
  return Math.min(a.end, b.end) - Math.max(a.start, b.start) > TERRAIN_MESH_EDGE_EPSILON;
}

function findOverlappingEdgeSpans(
  owner: TriangleEdgeOwner,
  spansByLine: ReadonlyMap<string, readonly TriangleEdgeSpan[]>,
  edgeSpans: ReadonlyMap<string, TriangleEdgeSpan>,
): TriangleEdgeSpan[] {
  const ownerSpan = edgeSpans.get(`${owner.triangle}:${owner.edge}`);
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
  lineKey: string,
  vertexCoords: readonly number[],
  vertexId: number,
): number {
  const x = vertexCoords[vertexId * 2];
  const z = vertexCoords[vertexId * 2 + 1];
  return lineKey.startsWith('h:') ? x : z;
}

function addSplitVertexForEdge(
  splitVerticesByEdge: Map<number, Set<number>>,
  vertexCoords: readonly number[],
  owner: TriangleEdgeOwner,
  ownerSpan: TriangleEdgeSpan,
  vertexId: number,
): void {
  if (vertexId === owner.a || vertexId === owner.b) return;
  const coord = edgeCoordinateForLine(ownerSpan.lineKey, vertexCoords, vertexId);
  if (
    coord <= ownerSpan.start + TERRAIN_MESH_EDGE_EPSILON ||
    coord >= ownerSpan.end - TERRAIN_MESH_EDGE_EPSILON
  ) {
    return;
  }
  const key = owner.triangle * 3 + owner.edge;
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
  const edgeOwners = collectTriangleEdgeOwners(triangleIndices);
  const spansByLine = collectTriangleEdgeSpansByLine(vertexCoords, edgeOwners);
  const edgeSpans = collectTriangleEdgeSpanIndex(spansByLine);
  const splitVerticesByEdge = new Map<number, Set<number>>();

  for (const owners of edgeOwners.values()) {
    if (owners.length !== 1) continue;
    const owner = owners[0];
    if (meshEdgeIsMapBoundary(ctx, vertexCoords, owner)) continue;
    const ownerSpan = edgeSpans.get(`${owner.triangle}:${owner.edge}`);
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
): { indices: number[]; levels: number[] } {
  const triangleCount = Math.floor(triangleIndices.length / 3);
  const neighborIndices = new Array<number>(triangleCount * 3).fill(-1);
  const neighborLevels = new Array<number>(triangleCount * 3).fill(-1);
  const edgeOwners = collectTriangleEdgeOwners(triangleIndices);
  const spansByLine = collectTriangleEdgeSpansByLine(vertexCoords, edgeOwners);
  const edgeSpans = collectTriangleEdgeSpanIndex(spansByLine);

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
  if ((leaves[leafIndex]?.side ?? 1) <= 1) return;
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
  mesh: BuiltTerrainMesh,
): Set<number> {
  const splitLeafIndices = new Set<number>();
  const maxDelta = Math.max(0, TERRAIN_TRIANGLE_MAX_NEIGHBOR_LEVEL_DELTA | 0);
  const edgeOwners = collectTriangleEdgeOwners(mesh.triangleIndices);
  const spansByLine = collectTriangleEdgeSpansByLine(mesh.vertexCoords, edgeOwners);
  const edgeSpans = collectTriangleEdgeSpanIndex(spansByLine);

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

  return splitLeafIndices;
}

function buildConformingMeshFromLeaves(
  ctx: TerrainMeshBuildContext,
  leaves: readonly TerrainHierarchyTriangle[],
  cellsX: number,
  cellsY: number,
  cellSize: number,
): BuiltTerrainMesh {
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

  const triangleNeighbors = buildTriangleNeighborMetadata(
    ctx,
    vertexCoords,
    triangleIndices,
    triangleLevels,
  );

  const cellBuckets: number[][] = Array.from({ length: cellsX * cellsY }, () => []);
  for (let tri = 0; tri < triangleIndices.length / 3; tri++) {
    const ia = triangleIndices[tri * 3];
    const ib = triangleIndices[tri * 3 + 1];
    const ic = triangleIndices[tri * 3 + 2];
    const ax = vertexCoords[ia * 2];
    const az = vertexCoords[ia * 2 + 1];
    const bx = vertexCoords[ib * 2];
    const bz = vertexCoords[ib * 2 + 1];
    const cx = vertexCoords[ic * 2];
    const cz = vertexCoords[ic * 2 + 1];
    const minCellX = Math.max(0, Math.min(cellsX - 1, Math.floor(Math.min(ax, bx, cx) / cellSize)));
    const maxCellX = Math.max(0, Math.min(cellsX - 1, Math.floor(Math.max(ax, bx, cx) / cellSize)));
    const minCellY = Math.max(0, Math.min(cellsY - 1, Math.floor(Math.min(az, bz, cz) / cellSize)));
    const maxCellY = Math.max(0, Math.min(cellsY - 1, Math.floor(Math.max(az, bz, cz) / cellSize)));
    for (let cy = minCellY; cy <= maxCellY; cy++) {
      for (let cx2 = minCellX; cx2 <= maxCellX; cx2++) {
        cellBuckets[cy * cellsX + cx2].push(tri);
      }
    }
  }

  const cellTriangleOffsets = new Array<number>(cellBuckets.length + 1);
  const cellTriangleIndices: number[] = [];
  for (let i = 0; i < cellBuckets.length; i++) {
    cellTriangleOffsets[i] = cellTriangleIndices.length;
    for (let j = 0; j < cellBuckets[i].length; j++) {
      cellTriangleIndices.push(cellBuckets[i][j]);
    }
  }
  cellTriangleOffsets[cellBuckets.length] = cellTriangleIndices.length;

  return {
    vertexCoords,
    vertexHeights,
    triangleIndices,
    triangleLevels,
    triangleLeafIndices,
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
    const mesh = buildConformingMeshFromLeaves(ctx, repairedLeaves, cellsX, cellsY, cellSize);
    const splitLeafIndices = findMeshNeighborDiscrepancyLeafIndices(ctx, repairedLeaves, mesh);
    if (splitLeafIndices.size === 0) return mesh;

    const nextLeaves = balanceTerrainTriangleLeaves(
      ctx,
      splitTerrainTriangleLeaves(ctx, repairedLeaves, splitLeafIndices),
    );
    if (nextLeaves.length === repairedLeaves.length) return mesh;
    repairedLeaves = nextLeaves;
  }

  return buildConformingMeshFromLeaves(ctx, repairedLeaves, cellsX, cellsY, cellSize);
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
    rootSide,
    heightCache: new Map<string, number>(),
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
  const cellsX = installedMap?.cellsX ?? Math.max(1, Math.ceil(mapWidth / size));
  const cellsZ = installedMap?.cellsY ?? Math.max(1, Math.ceil(mapHeight / size));
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
