import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotMinimapEntity,
} from './NetworkTypes';
import {
  ENTITY_SNAPSHOT_WIRE_TYPE_BUILDING,
  ENTITY_SNAPSHOT_WIRE_TYPE_UNIT,
} from './stateSerializerEntities';
import {
  PACKED_BINARY_ROW_COUNT_BYTES,
  PackedBinaryReader,
  PackedBinaryWriter,
  readPackedBinaryRowCount,
} from './snapshotBinaryWire';

const PACKED_MINIMAP_ENTITIES_V1_VERSION = 1;
const PACKED_MINIMAP_ENTITIES_VERSION = 2;
const PACKED_MINIMAP_ENTITY_STRIDE = 6;
const MINIMAP_ENTITY_FLAG_RADAR_ONLY = 0x01;

export type PackedMinimapEntitiesWireV1 = {
  v: typeof PACKED_MINIMAP_ENTITIES_V1_VERSION;
  r: number[];
};

export type PackedMinimapEntitiesWireV2 = {
  v: typeof PACKED_MINIMAP_ENTITIES_VERSION;
  b: Uint8Array;
};

export type PackedMinimapEntitiesWire =
  | PackedMinimapEntitiesWireV1
  | PackedMinimapEntitiesWireV2;

type PackedMinimapGroup = {
  typeTag: number;
  playerId: number;
  flags: number;
  writer: PackedBinaryWriter;
  count: number;
  lastId: number;
};

export function packMinimapEntitiesForWire(
  entries: readonly NetworkServerSnapshotMinimapEntity[] | undefined,
): PackedMinimapEntitiesWire | undefined {
  if (entries === undefined) return undefined;

  return {
    v: PACKED_MINIMAP_ENTITIES_VERSION,
    b: packMinimapEntitiesV2(entries),
  };
}

export function unpackMinimapEntitiesFromWire(
  packed: PackedMinimapEntitiesWire,
): NetworkServerSnapshot['minimapEntities'] {
  if (packed.v === PACKED_MINIMAP_ENTITIES_VERSION) {
    return unpackMinimapEntitiesV2(packed.b);
  }

  const rows = packed.r;
  const count = Math.floor(rows.length / PACKED_MINIMAP_ENTITY_STRIDE);
  const entries: NetworkServerSnapshotMinimapEntity[] = new Array(count);

  for (let i = 0; i < count; i++) {
    const base = i * PACKED_MINIMAP_ENTITY_STRIDE;
    const flags = rows[base + 5] ?? 0;
    const entry: NetworkServerSnapshotMinimapEntity = {
      id: rows[base + 0] ?? 0,
      pos: {
        x: rows[base + 1] ?? 0,
        y: rows[base + 2] ?? 0,
      },
      type: rows[base + 3] === ENTITY_SNAPSHOT_WIRE_TYPE_BUILDING
        ? 'building'
        : 'unit',
      playerId: (rows[base + 4] ?? 1) as NetworkServerSnapshotMinimapEntity['playerId'],
    };
    if ((flags & MINIMAP_ENTITY_FLAG_RADAR_ONLY) !== 0) {
      entry.radarOnly = true;
    }
    entries[i] = entry;
  }

  return entries;
}

export function isPackedMinimapEntitiesWire(
  value: unknown,
): value is PackedMinimapEntitiesWire {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<PackedMinimapEntitiesWire>;
  if (candidate.v === PACKED_MINIMAP_ENTITIES_V1_VERSION) {
    return Array.isArray(candidate.r);
  }
  return (
    candidate.v === PACKED_MINIMAP_ENTITIES_VERSION &&
    candidate.b instanceof Uint8Array
  );
}

function packMinimapEntitiesV2(
  entries: readonly NetworkServerSnapshotMinimapEntity[],
): Uint8Array {
  const groups: PackedMinimapGroup[] = [];
  const groupsByKey: (PackedMinimapGroup | undefined)[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const typeTag = entry.type === 'unit'
      ? ENTITY_SNAPSHOT_WIRE_TYPE_UNIT
      : ENTITY_SNAPSHOT_WIRE_TYPE_BUILDING;
    const flags = entry.radarOnly === true ? MINIMAP_ENTITY_FLAG_RADAR_ONLY : 0;
    const playerId = entry.playerId;
    const key = typeTag * 0x1000 + playerId * 0x10 + flags;
    let group = groupsByKey[key];
    if (group === undefined) {
      group = {
        typeTag,
        playerId,
        flags,
        writer: new PackedBinaryWriter(Math.max(24, Math.ceil(entries.length / 4) * 8)),
        count: 0,
        lastId: 0,
      };
      groupsByKey[key] = group;
      groups.push(group);
    }

    group.writer.writeVarInt(entry.id - group.lastId);
    group.lastId = entry.id;
    group.writer.writeVarInt(entry.pos.x);
    group.writer.writeVarInt(entry.pos.y);
    group.count++;
  }

  const chunks: Uint8Array[] = new Array(groups.length);
  let estimatedBytes = PACKED_BINARY_ROW_COUNT_BYTES + 4;
  for (let i = 0; i < groups.length; i++) {
    chunks[i] = groups[i].writer.finishBytes();
    estimatedBytes += chunks[i].byteLength + 8;
  }

  const out = new PackedBinaryWriter(estimatedBytes, PACKED_BINARY_ROW_COUNT_BYTES);
  out.writeVarUint(groups.length);
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    out.writeVarUint(group.typeTag);
    out.writeVarUint(group.playerId);
    out.writeVarUint(group.flags);
    out.writeVarUint(group.count);
    out.writeBytes(chunks[i]);
  }
  out.setUint32LE(0, entries.length);
  return out.finishBytes();
}

function unpackMinimapEntitiesV2(
  rows: Uint8Array,
): NetworkServerSnapshot['minimapEntities'] {
  const totalCount = readPackedBinaryRowCount(rows);
  const entries: NetworkServerSnapshotMinimapEntity[] = new Array(totalCount);
  const reader = new PackedBinaryReader(rows);
  const groupCount = reader.readVarUint();
  let outIndex = 0;

  for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
    const typeTag = reader.readVarUint();
    const playerId = reader.readVarUint() as NetworkServerSnapshotMinimapEntity['playerId'];
    const flags = reader.readVarUint();
    const count = reader.readVarUint();
    let id = 0;
    for (let i = 0; i < count; i++) {
      id += reader.readVarInt();
      const entry: NetworkServerSnapshotMinimapEntity = {
        id,
        pos: {
          x: reader.readVarInt(),
          y: reader.readVarInt(),
        },
        type: typeTag === ENTITY_SNAPSHOT_WIRE_TYPE_BUILDING
          ? 'building'
          : 'unit',
        playerId,
      };
      if ((flags & MINIMAP_ENTITY_FLAG_RADAR_ONLY) !== 0) {
        entry.radarOnly = true;
      }
      entries[outIndex++] = entry;
    }
  }

  if (outIndex < entries.length) entries.length = outIndex;
  return entries;
}
