import type { TerrainBuildabilityGrid, TerrainTileMap } from '@/types/terrain';

const PACKED_TERRAIN_VERSION = 1;
const PACKED_BUILDABILITY_VERSION = 1;

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
  tl: Uint8Array;
  ni: Uint8Array;
  nl: Uint8Array;
  co: Uint8Array;
  ci: Uint8Array;
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
    ],
    vc: writeFloat32Bytes(terrain.meshVertexCoords),
    vh: writeFloat32Bytes(terrain.meshVertexHeights),
    ti: writeUint16Bytes(terrain.meshTriangleIndices),
    tl: writeInt8Bytes(terrain.meshTriangleLevels),
    ni: writeInt16Bytes(terrain.meshTriangleNeighborIndices),
    nl: writeInt8Bytes(terrain.meshTriangleNeighborLevels),
    co: writeUint16Bytes(terrain.meshCellTriangleOffsets),
    ci: writeUint16Bytes(terrain.meshCellTriangleIndices),
  };
}

export function unpackTerrainFromWire(
  packed: PackedTerrainTileMapWire,
): TerrainTileMap {
  const meta = packed.m;
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
    meshVertexCoords: readFloat32Bytes(packed.vc),
    meshVertexHeights: readFloat32Bytes(packed.vh),
    meshTriangleIndices: readUint16Bytes(packed.ti),
    meshTriangleLevels: readInt8Bytes(packed.tl),
    meshTriangleNeighborIndices: readInt16Bytes(packed.ni),
    meshTriangleNeighborLevels: readInt8Bytes(packed.nl),
    meshCellTriangleOffsets: readUint16Bytes(packed.co),
    meshCellTriangleIndices: readUint16Bytes(packed.ci),
  };
}

export function isPackedTerrainTileMapWire(
  value: unknown,
): value is PackedTerrainTileMapWire {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<PackedTerrainTileMapWire>;
  return (
    candidate.v === PACKED_TERRAIN_VERSION &&
    Array.isArray(candidate.m) &&
    candidate.m.length === 9 &&
    isBytes(candidate.vc) &&
    isBytes(candidate.vh) &&
    isBytes(candidate.ti) &&
    isBytes(candidate.tl) &&
    isBytes(candidate.ni) &&
    isBytes(candidate.nl) &&
    isBytes(candidate.co) &&
    isBytes(candidate.ci)
  );
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

function writeUint16Bytes(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) {
    view.setUint16(i * 2, values[i], true);
  }
  return bytes;
}

function readUint16Bytes(bytes: Uint8Array): number[] {
  const count = Math.floor(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    out[i] = view.getUint16(i * 2, true);
  }
  return out;
}

function writeInt16Bytes(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) {
    view.setInt16(i * 2, values[i], true);
  }
  return bytes;
}

function readInt16Bytes(bytes: Uint8Array): number[] {
  const count = Math.floor(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    out[i] = view.getInt16(i * 2, true);
  }
  return out;
}

function writeInt8Bytes(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) {
    view.setInt8(i, values[i]);
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
