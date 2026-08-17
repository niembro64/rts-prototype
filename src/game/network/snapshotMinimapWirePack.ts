import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotMinimapEntity,
} from './NetworkTypes';
import {
  ENTITY_SNAPSHOT_WIRE_TYPE_BUILDING,
  ENTITY_SNAPSHOT_WIRE_TYPE_TOWER,
  ENTITY_SNAPSHOT_WIRE_TYPE_UNIT,
} from './stateSerializerEntities';
import {
  PackedBinaryReader,
  PackedBinaryWriter,
  readPackedBinaryRowCount,
} from './snapshotBinaryWire';
import { finishGroupedPackedRows } from './flagGroupedPackedRows';
import {
  MINIMAP_SNAPSHOT_WIRE_STRIDE,
  getMinimapSnapshotWireSource,
} from './stateSerializerMinimap';
import {
  activeFloat64WireValues,
} from './snapshotWireRows';
import {
  MINIMAP_CONTACT_FLAG_AIR,
  MINIMAP_CONTACT_FLAG_ALTITUDE,
  MINIMAP_CONTACT_FLAG_RADAR_ONLY,
  MINIMAP_CONTACT_FLAG_WATER,
  contactMediumMaskFromMinimapFlags,
  contactMediumMaskToMinimapFlags,
} from './contactMedium';

const PACKED_MINIMAP_ENTITIES_VERSION = 4;

export type PackedMinimapEntitiesWire = {
  v: typeof PACKED_MINIMAP_ENTITIES_VERSION;
  b: Uint8Array;
};

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

function minimapTypeToWireType(type: NetworkServerSnapshotMinimapEntity['type']): number {
  switch (type) {
    case 'unit':
      return ENTITY_SNAPSHOT_WIRE_TYPE_UNIT;
    case 'building':
      return ENTITY_SNAPSHOT_WIRE_TYPE_BUILDING;
  }
}

function wireTypeToMinimapType(typeTag: number): NetworkServerSnapshotMinimapEntity['type'] {
  switch (typeTag) {
    case ENTITY_SNAPSHOT_WIRE_TYPE_BUILDING:
      return 'building';
    case ENTITY_SNAPSHOT_WIRE_TYPE_TOWER:
      return 'building';
    default:
      return 'unit';
  }
}

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
    b: packMinimapEntitiesV4(entries),
  };
}

export function unpackMinimapEntitiesFromWire(
  packed: PackedMinimapEntitiesWire,
): NetworkServerSnapshot['minimapEntities'] {
  return unpackMinimapEntitiesBinary(packed.b);
}

export function isPackedMinimapEntitiesWire(
  value: unknown,
): value is PackedMinimapEntitiesWire {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<PackedMinimapEntitiesWire>;
  return (
    candidate.v === PACKED_MINIMAP_ENTITIES_VERSION &&
    candidate.b instanceof Uint8Array
  );
}

function packMinimapEntitiesV4(
  entries: readonly NetworkServerSnapshotMinimapEntity[],
): Uint8Array {
  resetMinimapPackScratch();
  const estimatedGroupBytes = Math.max(24, Math.ceil(entries.length / 4) * 8);
  const source = getMinimapSnapshotWireSource(entries);

  if (source !== undefined && source.count === entries.length) {
    const rows = activeFloat64WireValues(source, MINIMAP_SNAPSHOT_WIRE_STRIDE);
    for (let i = 0; i < source.count; i++) {
      const base = i * MINIMAP_SNAPSHOT_WIRE_STRIDE;
      assertCurrentContactFlags(rows[base + 5]);
      appendMinimapPackedRow(
        rows[base + 0],
        rows[base + 1],
        rows[base + 2],
        rows[base + 3],
        rows[base + 4],
        rows[base + 5],
        rows[base + 6],
        estimatedGroupBytes,
      );
    }

    return finishMinimapPackedRows(source.count);
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const radarOnly = entry.radarOnly === true;
    let flags = 0;
    let contactZ = 0;
    if (radarOnly) {
      if (entry.contactMediumMask === null) {
        throw new Error(`[minimap wire] contact ${entry.id} is missing contactMediumMask`);
      }
      if (typeof entry.contactZ !== 'number' || !Number.isFinite(entry.contactZ)) {
        throw new Error(`[minimap wire] contact ${entry.id} is missing finite contactZ`);
      }
      flags = MINIMAP_CONTACT_FLAG_RADAR_ONLY |
        MINIMAP_CONTACT_FLAG_ALTITUDE |
        contactMediumMaskToMinimapFlags(entry.contactMediumMask);
      assertCurrentContactFlags(flags);
      contactZ = entry.contactZ;
    }
    appendMinimapPackedRow(
      entry.id,
      entry.pos.x,
      entry.pos.y,
      minimapTypeToWireType(entry.type),
      entry.playerId,
      flags,
      contactZ,
      estimatedGroupBytes,
    );
  }

  return finishMinimapPackedRows(entries.length);
}

function appendMinimapPackedRow(
  id: number,
  x: number,
  y: number,
  typeTag: number,
  playerId: number,
  flags: number,
  contactZ: number,
  estimatedGroupBytes: number,
): void {
  const key = typeTag * 0x1000 + playerId * 0x10 + flags;
  let group = _packGroupsByKey[key];
  if (group === undefined) {
    group = rentMinimapGroup(typeTag, playerId, flags, estimatedGroupBytes);
    _packGroupsByKey[key] = group;
    _packGroupKeys.push(key);
    _packGroups.push(group);
  }

  group.writer.writeVarInt(id - group.lastId);
  group.lastId = id;
  group.writer.writeVarInt(x);
  group.writer.writeVarInt(y);
  if ((flags & MINIMAP_CONTACT_FLAG_ALTITUDE) !== 0) {
    group.writer.writeVarInt(contactZ);
  }
  group.count++;
}

function writeMinimapPackedGroupHeader(
  out: PackedBinaryWriter,
  group: PackedMinimapGroup,
): void {
  out.writeVarUint(group.typeTag);
  out.writeVarUint(group.playerId);
  out.writeVarUint(group.flags);
  out.writeVarUint(group.count);
}

function finishMinimapPackedRows(count: number): Uint8Array {
  const packed = finishGroupedPackedRows(_packGroups, count, writeMinimapPackedGroupHeader);
  resetMinimapPackScratch();
  return packed;
}

function assertCurrentContactFlags(flags: number): void {
  const radarOnly = (flags & MINIMAP_CONTACT_FLAG_RADAR_ONLY) !== 0;
  const hasAltitude = (flags & MINIMAP_CONTACT_FLAG_ALTITUDE) !== 0;
  const hasMedium = (flags & (MINIMAP_CONTACT_FLAG_AIR | MINIMAP_CONTACT_FLAG_WATER)) !== 0;
  if (radarOnly && (!hasAltitude || !hasMedium)) {
    throw new Error('[minimap wire] current contact row requires medium and altitude');
  }
  if (!radarOnly && (hasAltitude || hasMedium)) {
    throw new Error('[minimap wire] full-vision row cannot carry contact-only fields');
  }
}

function unpackMinimapEntitiesBinary(
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
    assertCurrentContactFlags(flags);
    const radarOnly = (flags & MINIMAP_CONTACT_FLAG_RADAR_ONLY) !== 0;
    const count = reader.readVarUint();
    let id = 0;
    for (let i = 0; i < count; i++) {
      id += reader.readVarInt();
      const x = reader.readVarInt();
      const y = reader.readVarInt();
      const contactZ = radarOnly ? reader.readVarInt() : null;
      const entry: NetworkServerSnapshotMinimapEntity = {
        id,
        pos: {
          x,
          y,
        },
        type: wireTypeToMinimapType(typeTag),
        playerId,
        radarOnly: null,
        contactMediumMask: null,
        contactZ: null,
      };
      if (radarOnly) {
        entry.radarOnly = true;
        entry.contactMediumMask = contactMediumMaskFromMinimapFlags(flags);
        entry.contactZ = contactZ;
      }
      entries[outIndex++] = entry;
    }
  }

  if (outIndex < entries.length) entries.length = outIndex;
  return entries;
}
