import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
import type { TerrainTileMap } from '@/types/terrain';
import { LAND_CELL_SIZE } from '../../../config';
import { assertCanonicalLandCellSize } from '../../landGrid';
import { getSimWasm } from '../../sim-wasm/init';
import {
  TERRAIN_FINE_TRIANGLE_SUBDIV,
  TERRAIN_MESH_HEIGHT_SMOOTHING,
  TERRAIN_TRIANGLE_FINAL_REPAIR_MAX_PASSES,
  TERRAIN_TRIANGLE_MAX_NEIGHBOR_LEVEL_DELTA,
  TERRAIN_TRIANGLE_MAX_SURFACE_ERROR,
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
import { getTerrainHeight } from './terrainHeightGenerator';
import { getMetalDepositFlatZones } from './terrainFlatZones';
import {
  TERRAIN_GENERATION_EXTENT_FRACTION,
  packTerrainFlatZoneRowsForWasm,
  packTerrainGenerationConfigForWasm,
} from './terrainGenerationConfig';

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

// Result of the Rust adaptive-mesh kernel, unpacked into the field names
// `buildTerrainTileMap` copies onto the TerrainTileMap. Topology generation,
// the crack-repair loop, vertex-height smoothing, neighbor metadata, and the
// cell index all live in `rts-sim-wasm` now — TypeScript only assembles this
// object. See `terrain_build_adaptive_mesh` in lib.rs.
type BuiltTerrainMesh = {
  vertexCoords: number[];
  vertexHeights: number[];
  triangleIndices: number[];
  triangleLevels: number[];
  triangleNeighborIndices: number[];
  triangleNeighborLevels: number[];
  cellTriangleOffsets: number[];
  cellTriangleIndices: number[];
};

const TERRAIN_MESH_EPSILON = 1e-6;

/** Number of header floats the Rust mesh kernel writes before the data
 *  sections: status, vertexCount, triangleCount, cellOffsetsLen, cellRefsCount. */
const TERRAIN_MESH_PACK_HEADER = 5;

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

/** Run the Rust adaptive-mesh kernel and splat its flat return buffer into a
 *  `BuiltTerrainMesh`. The kernel reads the same analytic terrain-height
 *  sampler the metal-deposit placement uses, so it must run after the deposit
 *  flat zones are installed (the host bootstrap orders it that way) and after
 *  the sim WASM module is initialized. There is no TypeScript fallback: the
 *  whole pipeline is Rust-owned (Delete The Old Path). */
function buildAdaptiveEquilateralTerrainMesh(
  mapWidth: number,
  mapHeight: number,
  cellSize: number,
  cellsX: number,
  cellsY: number,
  maxSubdiv: number,
): BuiltTerrainMesh {
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error(
      'buildTerrainTileMap requires the sim WASM module to be initialized',
    );
  }

  const lodConfig = Float64Array.from([
    TERRAIN_TRIANGLE_MAX_SURFACE_ERROR,
    TERRAIN_TRIANGLE_MIN_NORMAL_DOT,
    TERRAIN_TRIANGLE_MAX_NEIGHBOR_LEVEL_DELTA,
    TERRAIN_TRIANGLE_PRESERVE_WATERLINE ? 1 : 0,
    TERRAIN_TRIANGLE_SAMPLE_CENTROID ? 1 : 0,
    WATER_LEVEL,
    TERRAIN_TRIANGLE_VERTEX_KEY_SCALE,
    TERRAIN_TRIANGLE_FINAL_REPAIR_MAX_PASSES,
    TERRAIN_MESH_HEIGHT_SMOOTHING.maxSteps,
    TERRAIN_MESH_HEIGHT_SMOOTHING.amount,
  ]);

  const packed = sim.terrainBuildAdaptiveMesh(
    mapWidth,
    mapHeight,
    cellSize,
    cellsX,
    cellsY,
    maxSubdiv,
    TERRAIN_GENERATION_EXTENT_FRACTION,
    packTerrainGenerationConfigForWasm(),
    packTerrainFlatZoneRowsForWasm(getMetalDepositFlatZones()),
    lodConfig,
  );

  if (packed.length < TERRAIN_MESH_PACK_HEADER || packed[0] !== 1) {
    throw new Error('terrain adaptive-mesh kernel failed');
  }

  const vertexCount = packed[1];
  const triangleCount = packed[2];
  const cellOffsetsLen = packed[3];
  const cellRefsCount = packed[4];

  let offset = TERRAIN_MESH_PACK_HEADER;
  const take = (count: number): number[] => {
    const section = Array.from(packed.subarray(offset, offset + count));
    offset += count;
    return section;
  };

  const vertexCoords = take(vertexCount * 2);
  const vertexHeights = take(vertexCount);
  const triangleIndices = take(triangleCount * 3);
  const triangleLevels = take(triangleCount);
  const triangleNeighborIndices = take(triangleCount * 3);
  const triangleNeighborLevels = take(triangleCount * 3);
  const cellTriangleOffsets = take(cellOffsetsLen);
  const cellTriangleIndices = take(cellRefsCount);

  return {
    vertexCoords,
    vertexHeights,
    triangleIndices,
    triangleLevels,
    triangleNeighborIndices,
    triangleNeighborLevels,
    cellTriangleOffsets,
    cellTriangleIndices,
  };
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
  return terrainMeshNormalFromSampleInto(sample, { nx: 0, ny: 0, nz: 1 });
}

export function terrainMeshNormalFromSampleInto(
  sample: TerrainMeshSample,
  out: { nx: number; ny: number; nz: number },
): { nx: number; ny: number; nz: number } {
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
    const len = DMath.sqrt(nx * nx + vertical * vertical + nz * nz) || 1;
    out.nx = nx / len;
    out.ny = nz / len;
    out.nz = vertical / len;
    return out;
  }
  const { u, v, subSize, h00, h10, h11, h01 } = sample;
  const dHdx = u >= v ? (h10 - h00) / subSize : (h11 - h01) / subSize;
  const dHdz = u >= v ? (h11 - h10) / subSize : (h01 - h00) / subSize;
  const nx = -dHdx;
  const ny = -dHdz;
  const nz = 1;
  const len = DMath.sqrt(nx * nx + ny * ny + nz * nz);
  out.nx = nx / len;
  out.ny = ny / len;
  out.nz = nz / len;
  return out;
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
