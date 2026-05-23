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

const _packGroups: PackedMinimapGroup[] = [];
const _packGroupPool: PackedMinimapGroup[] = [];
const _packGroupsByKey: (PackedMinimapGroup | undefined)[] = [];
const _packGroupKeys: number[] = [];

function rentMinimapGroup(
  typeTag: number,
  playerId: number,
  flags: number,
  estimatedBytes: number,
): PackedMinimapGroup {
  const group = _packGroupPool.pop();
  if (group !== undefined) {
    group.typeTag = typeTag;
    group.playerId = playerId;
    group.flags = flags;
    group.writer.reset(estimatedBytes);
    group.count = 0;
    group.lastId = 0;
    return group;
  }
  return {
    typeTag,
    playerId,
    flags,
    writer: new PackedBinaryWriter(estimatedBytes),
    count: 0,
    lastId: 0,
  };
}

function resetMinimapPackScratch(): void {
  for (let i = 0; i < _packGroupKeys.length; i++) {
    _packGroupsByKey[_packGroupKeys[i]] = undefined;
  }
  _packGroupKeys.length = 0;
  for (let i = 0; i < _packGroups.length; i++) {
    _packGroupPool.push(_packGroups[i]);
  }
  _packGroups.length = 0;
}

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
  resetMinimapPackScratch();
  const estimatedGroupBytes = Math.max(24, Math.ceil(entries.length / 4) * 8);

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const typeTag = entry.type === 'unit'
      ? ENTITY_SNAPSHOT_WIRE_TYPE_UNIT
      : ENTITY_SNAPSHOT_WIRE_TYPE_BUILDING;
    const flags = entry.radarOnly === true ? MINIMAP_ENTITY_FLAG_RADAR_ONLY : 0;
    const playerId = entry.playerId;
    const key = typeTag * 0x1000 + playerId * 0x10 + flags;
    let group = _packGroupsByKey[key];
    if (group === undefined) {
      group = rentMinimapGroup(typeTag, playerId, flags, estimatedGroupBytes);
      _packGroupsByKey[key] = group;
      _packGroupKeys.push(key);
      _packGroups.push(group);
    }

    group.writer.writeVarInt(entry.id - group.lastId);
    group.lastId = entry.id;
    group.writer.writeVarInt(entry.pos.x);
    group.writer.writeVarInt(entry.pos.y);
    group.count++;
  }

  let estimatedBytes = PACKED_BINARY_ROW_COUNT_BYTES + 4;
  for (let i = 0; i < _packGroups.length; i++) {
    estimatedBytes += _packGroups[i].writer.byteLength + 8;
  }

  const out = new PackedBinaryWriter(estimatedBytes, PACKED_BINARY_ROW_COUNT_BYTES);
  out.writeVarUint(_packGroups.length);
  for (let i = 0; i < _packGroups.length; i++) {
    const group = _packGroups[i];
    out.writeVarUint(group.typeTag);
    out.writeVarUint(group.playerId);
    out.writeVarUint(group.flags);
    out.writeVarUint(group.count);
    out.writeBytes(group.writer.finishBytes());
  }
  out.setUint32LE(0, entries.length);
  const packed = out.finishBytes();
  resetMinimapPackScratch();
  return packed;
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
