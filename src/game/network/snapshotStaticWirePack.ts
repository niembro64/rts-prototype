import type { TerrainBuildabilityGrid, TerrainTileMap } from '@/types/terrain';
import {
  PackedBinaryReader,
  PackedBinaryWriter,
} from './snapshotBinaryWire';
import { buildTerrainCellTriangleIndex } from '../sim/terrain/terrainCellTriangleIndex';

const PACKED_TERRAIN_VERSION = 5;
const PACKED_BUILDABILITY_VERSION = 1;
const TERRAIN_TRIANGLE_INDICES_DELTA = 1 << 2;

type TerrainMeta = [
  mapWidth: number,
  mapHeight: number,
  cellSize: number,
  subdiv: number,
  cellsX: number,
  cellsY: number,
  verticesX: number,
  verticesY: number,
  version: number,
  flags: number,
];

type BuildabilityMeta = [
  mapWidth: number,
  mapHeight: number,
  cellSize: number,
  cellsX: number,
  cellsY: number,
  version: number,
];

export type PackedTerrainTileMapWire = {
  v: typeof PACKED_TERRAIN_VERSION;
  m: TerrainMeta;
  vc: Uint8Array;
  vh: Uint8Array;
  ti: Uint8Array;
  tw: Uint8Array;
};

export type PackedTerrainBuildabilityGridWire = {
  v: typeof PACKED_BUILDABILITY_VERSION;
  m: BuildabilityMeta;
  k: string;
  r: number[];
};

export function packTerrainForWire(
  terrain: TerrainTileMap | undefined,
): PackedTerrainTileMapWire | undefined {
  if (terrain === undefined) return undefined;
  const triangleIndices = writeTriangleIndexDeltaBytes(terrain.meshTriangleIndices);
  const flags = TERRAIN_TRIANGLE_INDICES_DELTA;

  return {
    v: PACKED_TERRAIN_VERSION,
    m: [
      terrain.mapWidth,
      terrain.mapHeight,
      terrain.cellSize,
      terrain.subdiv,
      terrain.cellsX,
      terrain.cellsY,
      terrain.verticesX,
      terrain.verticesY,
      terrain.version,
      flags,
    ],
    vc: writeFloat32Bytes(terrain.meshVertexCoords),
    vh: writeFloat32Bytes(terrain.meshVertexHeights),
    ti: triangleIndices,
    tw: writeInt8Bytes(terrain.meshTriangleWallFlags),
  };
}

export function unpackTerrainFromWire(
  packed: PackedTerrainTileMapWire,
): TerrainTileMap {
  const meta = packed.m;
  if ((meta[9] | 0) !== TERRAIN_TRIANGLE_INDICES_DELTA) {
    throw new Error('[terrain wire] current V5 packet requires delta triangle indices');
  }
  const meshVertexCoords = readFloat32Bytes(packed.vc);
  const meshVertexHeights = readFloat32Bytes(packed.vh);
  const meshTriangleIndices = readTriangleIndexDeltaBytes(packed.ti);
  const meshTriangleWallFlags = readInt8Bytes(packed.tw);
  const cellIndex = buildTerrainCellTriangleIndex({
    cellsX: meta[4],
    cellsY: meta[5],
    cellSize: meta[2],
    vertexCoords: meshVertexCoords,
    triangleIndices: meshTriangleIndices,
  });
  return {
    mapWidth: meta[0],
    mapHeight: meta[1],
    cellSize: meta[2],
    subdiv: meta[3],
    cellsX: meta[4],
    cellsY: meta[5],
    verticesX: meta[6],
    verticesY: meta[7],
    version: meta[8],
    meshVertexCoords,
    meshVertexHeights,
    meshTriangleIndices,
    meshTriangleWallFlags,
    // These hierarchy/neighbor arrays were only consumed during mesh
    // baking. Runtime sampling uses vertices, triangles, and cell buckets.
    meshTriangleLevels: [],
    meshTriangleNeighborIndices: [],
    meshTriangleNeighborLevels: [],
    meshCellTriangleOffsets: cellIndex.cellTriangleOffsets,
    meshCellTriangleIndices: cellIndex.cellTriangleIndices,
  };
}

export function isPackedTerrainTileMapWire(
  value: unknown,
): value is PackedTerrainTileMapWire {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<PackedTerrainTileMapWire>;
  return candidate.v === PACKED_TERRAIN_VERSION &&
    Array.isArray(candidate.m) &&
    candidate.m.length === 10 &&
    (candidate.m[9] | 0) === TERRAIN_TRIANGLE_INDICES_DELTA &&
    isBytes(candidate.vc) &&
    isBytes(candidate.vh) &&
    isBytes(candidate.ti) &&
    isBytes(candidate.tw);
}

export function packBuildabilityForWire(
  buildability: TerrainBuildabilityGrid | undefined,
): PackedTerrainBuildabilityGridWire | undefined {
  if (buildability === undefined) return undefined;
  return {
    v: PACKED_BUILDABILITY_VERSION,
    m: [
      buildability.mapWidth,
      buildability.mapHeight,
      buildability.cellSize,
      buildability.cellsX,
      buildability.cellsY,
      buildability.version,
    ],
    k: buildability.configKey,
    r: encodeBuildabilityRuns(buildability.flags, buildability.levels),
  };
}

export function unpackBuildabilityFromWire(
  packed: PackedTerrainBuildabilityGridWire,
): TerrainBuildabilityGrid {
  const meta = packed.m;
  const cellCount = Math.max(0, Math.floor(meta[3] * meta[4]));
  const decoded = decodeBuildabilityRuns(packed.r, cellCount);
  return {
    mapWidth: meta[0],
    mapHeight: meta[1],
    cellSize: meta[2],
    cellsX: meta[3],
    cellsY: meta[4],
    version: meta[5],
    configKey: packed.k,
    flags: decoded.flags,
    levels: decoded.levels,
  };
}

export function isPackedBuildabilityGridWire(
  value: unknown,
): value is PackedTerrainBuildabilityGridWire {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<PackedTerrainBuildabilityGridWire>;
  return (
    candidate.v === PACKED_BUILDABILITY_VERSION &&
    Array.isArray(candidate.m) &&
    candidate.m.length === 6 &&
    typeof candidate.k === 'string' &&
    Array.isArray(candidate.r)
  );
}

function encodeBuildabilityRuns(
  flags: readonly number[],
  levels: readonly number[],
): number[] {
  const count = Math.min(flags.length, levels.length);
  const runs: number[] = [];
  let i = 0;
  while (i < count) {
    const flag = flags[i] | 0;
    const level = levels[i] | 0;
    let runLength = 1;
    i++;
    while (
      i < count &&
      (flags[i] | 0) === flag &&
      (levels[i] | 0) === level
    ) {
      runLength++;
      i++;
    }
    runs.push(runLength, flag, level);
  }
  return runs;
}

function decodeBuildabilityRuns(
  runs: readonly number[],
  cellCount: number,
): { flags: number[]; levels: number[] } {
  const flags = new Array<number>(cellCount);
  const levels = new Array<number>(cellCount);
  let out = 0;
  for (let i = 0; i + 2 < runs.length && out < cellCount; i += 3) {
    const runLength = Math.max(0, Math.floor(runs[i]));
    const flag = runs[i + 1] | 0;
    const level = runs[i + 2] | 0;
    const end = Math.min(cellCount, out + runLength);
    while (out < end) {
      flags[out] = flag;
      levels[out] = level;
      out++;
    }
  }
  while (out < cellCount) {
    flags[out] = 0;
    levels[out] = 0;
    out++;
  }
  return { flags, levels };
}

function writeFloat32Bytes(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) {
    view.setFloat32(i * 4, values[i], true);
  }
  return bytes;
}

function readFloat32Bytes(bytes: Uint8Array): number[] {
  const count = Math.floor(bytes.byteLength / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 4);
  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    out[i] = view.getFloat32(i * 4, true);
  }
  return out;
}

function writeTriangleIndexDeltaBytes(values: readonly number[]): Uint8Array {
  const triangleCount = Math.floor(values.length / 3);
  const writer = new PackedBinaryWriter(Math.max(16, triangleCount * 4));
  writer.writeVarUint(triangleCount);
  let previousBase = 0;
  for (let tri = 0; tri < triangleCount; tri++) {
    const offset = tri * 3;
    const a = values[offset];
    const b = values[offset + 1];
    const c = values[offset + 2];
    writer.writeVarInt(a - previousBase);
    writer.writeVarInt(b - a);
    writer.writeVarInt(c - a);
    previousBase = a;
  }
  return writer.finishBytes();
}

function readTriangleIndexDeltaBytes(bytes: Uint8Array): number[] {
  const reader = new PackedBinaryReader(bytes, 0);
  const triangleCount = reader.readVarUint();
  const out = new Array<number>(triangleCount * 3);
  let previousBase = 0;
  for (let tri = 0; tri < triangleCount; tri++) {
    const offset = tri * 3;
    const a = previousBase + reader.readVarInt();
    const b = a + reader.readVarInt();
    const c = a + reader.readVarInt();
    out[offset] = a;
    out[offset + 1] = b;
    out[offset + 2] = c;
    previousBase = a;
  }
  return out;
}

function writeInt8Bytes(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) {
    bytes[i] = values[i] & 0xff;
  }
  return bytes;
}

function readInt8Bytes(bytes: Uint8Array): number[] {
  const out = new Array<number>(bytes.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < bytes.byteLength; i++) {
    out[i] = view.getInt8(i);
  }
  return out;
}

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}
