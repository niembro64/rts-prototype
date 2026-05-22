import type { PlayerId } from '../../types/sim';
import {
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_ROT,
  ENTITY_CHANGED_TURRETS,
  ENTITY_CHANGED_VEL,
} from '../../types/network';
import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotAction,
  NetworkServerSnapshotEntity,
  NetworkServerSnapshotTurret,
} from './NetworkTypes';

type UnitSub = NonNullable<NetworkServerSnapshotEntity['unit']>;
type BuildingSub = NonNullable<NetworkServerSnapshotEntity['building']>;
type FactorySub = NonNullable<BuildingSub['factory']>;
type WaypointSub = FactorySub['waypoints'][number];
type TurretAngular = NetworkServerSnapshotTurret['turret']['angular'];
type SuspensionSub = NonNullable<UnitSub['suspension']>;

const PACKED_ENTITIES_V1_VERSION = 1;
const PACKED_ENTITIES_V2_VERSION = 2;
const PACKED_ENTITIES_V3_VERSION = 3;
const PACKED_ENTITIES_V4_VERSION = 4;
const PACKED_ENTITIES_VERSION = 5;

// Bit flags for the packed unit row's optional-presence header.
// One bit per optional sub-field so the decoder can tell "missing"
// from "present but zero".
const UNIT_FLAG_HP = 1 << 0;
const UNIT_FLAG_VELOCITY = 1 << 1;
const UNIT_FLAG_UNIT_TYPE = 1 << 2;
const UNIT_FLAG_RADIUS = 1 << 3;
const UNIT_FLAG_BODY_CENTER_HEIGHT = 1 << 4;
const UNIT_FLAG_MASS = 1 << 5;
const UNIT_FLAG_SURFACE_NORMAL = 1 << 6;
const UNIT_FLAG_SUSPENSION = 1 << 7;
const UNIT_FLAG_SUSPENSION_LEG_CONTACT = 1 << 8;
const UNIT_FLAG_ORIENTATION = 1 << 9;
const UNIT_FLAG_ANGULAR_VELOCITY = 1 << 10;
const UNIT_FLAG_FIRE_DISABLED = 1 << 11;
const UNIT_FLAG_IS_COMMANDER = 1 << 12;
const UNIT_FLAG_BUILD_TARGET_ID = 1 << 13;
const UNIT_FLAG_BUILD_TARGET_NULL = 1 << 14;
const UNIT_FLAG_ACTIONS = 1 << 15;
const UNIT_FLAG_TURRETS = 1 << 16;
const UNIT_FLAG_BUILD = 1 << 17;
const UNIT_FLAG_BUILD_COMPLETE = 1 << 18;

const BUILDING_FLAG_TYPE = 1 << 0;
const BUILDING_FLAG_DIM = 1 << 1;
const BUILDING_FLAG_HP = 1 << 2;
const BUILDING_FLAG_BUILD = 1 << 3;
const BUILDING_FLAG_BUILD_COMPLETE = 1 << 4;
const BUILDING_FLAG_METAL_EXTRACTION_RATE = 1 << 5;
const BUILDING_FLAG_SOLAR = 1 << 6;
const BUILDING_FLAG_SOLAR_OPEN = 1 << 7;
const BUILDING_FLAG_TURRETS = 1 << 8;
const BUILDING_FLAG_FACTORY = 1 << 9;
const BUILDING_FLAG_FACTORY_PRODUCING = 1 << 10;

const ENTITY_FLAG_HAS_POS = 1 << 0;
const ENTITY_FLAG_HAS_ROTATION = 1 << 1;
const ENTITY_FLAG_HAS_CHANGED_FIELDS = 1 << 2;
const ENTITY_FLAG_TYPE_BUILDING = 1 << 3;
const ENTITY_FLAG_HAS_UNIT = 1 << 4;
const ENTITY_FLAG_HAS_BUILDING = 1 << 5;

const MOVEMENT_UNIT_FLAG_POS = 1 << 0;
const MOVEMENT_UNIT_FLAG_ROTATION = 1 << 1;
const MOVEMENT_UNIT_FLAG_VELOCITY = 1 << 2;
const MOVEMENT_UNIT_FLAG_ORIENTATION = 1 << 3;
const MOVEMENT_UNIT_FLAG_ANGULAR_VELOCITY = 1 << 4;
const MOVEMENT_UNIT_CHANGED_FIELDS =
  ENTITY_CHANGED_POS |
  ENTITY_CHANGED_ROT |
  ENTITY_CHANGED_VEL;
const PACKED_ENTITY_BINARY_HEADER_BYTES = 4;

const ACTION_FLAG_POS = 1 << 0;
const ACTION_FLAG_POS_Z = 1 << 1;
const ACTION_FLAG_PATH_EXP = 1 << 2;
const ACTION_FLAG_TARGET_ID = 1 << 3;
const ACTION_FLAG_BUILDING_TYPE = 1 << 4;
const ACTION_FLAG_GRID = 1 << 5;
const ACTION_FLAG_BUILDING_ID = 1 << 6;

const TURRET_FLAG_TARGET_ID = 1 << 0;
const TURRET_FLAG_FORCE_FIELD_RANGE = 1 << 1;

const WAYPOINT_FLAG_POS_Z = 1 << 0;

// One packed entity is a flat array. Layout per entity:
//   [flags, id, playerId, ...optional fields in fixed slot order]
// The flags field tells the decoder which optional fields follow.
//
// Detail rows stay in msgpack-friendly primitives (numbers, strings,
// nested arrays). V4 movement-only and split unit-turret rows use
// Uint8Array varint slabs so the high-count paths pay one binary field
// header instead of a MessagePack tag per coordinate. V5 keeps the same
// slabs but groups rows by stable header fields so flags/player/turret
// counts are paid once per group instead of once per row.
export type PackedEntityRow = unknown[];
export type PackedMovementUnitRows = number[];
export type PackedMovementUnitBytes = Uint8Array;
export type PackedUnitTurretRows = number[];
export type PackedUnitTurretBytes = Uint8Array;

export type PackedEntitySnapshotWireV1 = {
  v: typeof PACKED_ENTITIES_V1_VERSION;
  e: PackedEntityRow[];
};

export type PackedEntitySnapshotWireV2 = {
  v: typeof PACKED_ENTITIES_V2_VERSION;
  m?: PackedMovementUnitRows;
  e?: PackedEntityRow[];
};

export type PackedEntitySnapshotWireV3 = {
  v: typeof PACKED_ENTITIES_V3_VERSION;
  m?: PackedMovementUnitRows;
  t?: PackedUnitTurretRows;
  e?: PackedEntityRow[];
};

export type PackedEntitySnapshotWireV4 = {
  v: typeof PACKED_ENTITIES_V4_VERSION;
  m?: PackedMovementUnitBytes;
  t?: PackedUnitTurretBytes;
  e?: PackedEntityRow[];
};

export type PackedEntitySnapshotWireV5 = {
  v: typeof PACKED_ENTITIES_VERSION;
  m?: PackedMovementUnitBytes;
  t?: PackedUnitTurretBytes;
  e?: PackedEntityRow[];
};

export type PackedEntitySnapshotWire =
  | PackedEntitySnapshotWireV1
  | PackedEntitySnapshotWireV2
  | PackedEntitySnapshotWireV3
  | PackedEntitySnapshotWireV4
  | PackedEntitySnapshotWireV5;

export function packEntitiesForWire(
  entities: readonly NetworkServerSnapshotEntity[] | undefined,
): PackedEntitySnapshotWire | undefined {
  if (entities === undefined) return undefined;
  let movementRows: PackedMovementUnitGroupedWriter | undefined;
  let turretRows: PackedUnitTurretGroupedWriter | undefined;
  const detailRows: PackedEntityRow[] = [];
  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i];
    if (isMovementOnlyUnitDelta(entity)) {
      if (movementRows === undefined) movementRows = new PackedMovementUnitGroupedWriter(entities.length);
      appendMovementUnitDeltaRow(movementRows, entity);
    } else if (isSplitUnitTurretDelta(entity)) {
      if (hasMovementUnitDeltaFields(entity)) {
        if (movementRows === undefined) movementRows = new PackedMovementUnitGroupedWriter(entities.length);
        appendMovementUnitDeltaRow(movementRows, entity);
      }
      if (turretRows === undefined) turretRows = new PackedUnitTurretGroupedWriter(entities.length);
      appendUnitTurretDeltaRow(turretRows, entity);
    } else {
      detailRows.push(packEntityRow(entity));
    }
  }

  const packed: PackedEntitySnapshotWireV5 = { v: PACKED_ENTITIES_VERSION };
  const movementBytes = movementRows?.finish();
  const turretBytes = turretRows?.finish();
  if (movementBytes !== undefined) packed.m = movementBytes;
  if (turretBytes !== undefined) packed.t = turretBytes;
  if (detailRows.length > 0 || (movementBytes === undefined && turretBytes === undefined)) {
    packed.e = detailRows;
  }
  return packed;
}

export function unpackEntitiesFromWire(
  packed: PackedEntitySnapshotWire,
): NetworkServerSnapshotEntity[] {
  if (packed.v === PACKED_ENTITIES_V1_VERSION) {
    const rows = packed.e;
    const out: NetworkServerSnapshotEntity[] = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      out[i] = unpackEntityRow(rows[i]);
    }
    return out;
  }

  const movementRows = packed.m;
  const turretRows = packed.v === PACKED_ENTITIES_V3_VERSION ||
    packed.v === PACKED_ENTITIES_V4_VERSION ||
    packed.v === PACKED_ENTITIES_VERSION
    ? packed.t
    : undefined;
  const detailRows = packed.e;
  const movementCount = countMovementUnitDeltaRows(movementRows);
  const turretCount = countUnitTurretDeltaRows(turretRows);
  const detailCount = detailRows?.length ?? 0;
  const out: NetworkServerSnapshotEntity[] = new Array(movementCount + turretCount + detailCount);
  let outIndex = 0;
  if (movementRows !== undefined) {
    outIndex = unpackMovementUnitDeltaRows(movementRows, out, outIndex, packed.v);
  }
  if (turretRows !== undefined) {
    outIndex = unpackUnitTurretDeltaRows(turretRows, out, outIndex, packed.v);
  }
  if (detailRows !== undefined) {
    for (let i = 0; i < detailRows.length; i++) {
      out[outIndex++] = unpackEntityRow(detailRows[i]);
    }
  }
  return out;
}

export function isPackedEntitySnapshotWire(
  value: unknown,
): value is PackedEntitySnapshotWire {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<PackedEntitySnapshotWire>;
  if (candidate.v === PACKED_ENTITIES_V1_VERSION) return Array.isArray(candidate.e);
  if (candidate.v === PACKED_ENTITIES_V2_VERSION) {
    return (
      (candidate.m === undefined || isFiniteNumberArray(candidate.m)) &&
      (candidate.e === undefined || Array.isArray(candidate.e))
    );
  }
  if (candidate.v === PACKED_ENTITIES_V3_VERSION) {
    return (
      (candidate.m === undefined || isFiniteNumberArray(candidate.m)) &&
      (candidate.t === undefined || isFiniteNumberArray(candidate.t)) &&
      (candidate.e === undefined || Array.isArray(candidate.e))
    );
  }
  if (
    candidate.v === PACKED_ENTITIES_V4_VERSION ||
    candidate.v === PACKED_ENTITIES_VERSION
  ) {
    return (
      (candidate.m === undefined || candidate.m instanceof Uint8Array) &&
      (candidate.t === undefined || candidate.t instanceof Uint8Array) &&
      (candidate.e === undefined || Array.isArray(candidate.e))
    );
  }
  return false;
}

export function isPackedEntitiesField(value: unknown): value is PackedEntitySnapshotWire {
  return isPackedEntitySnapshotWire(value);
}

function packEntityRow(entity: NetworkServerSnapshotEntity): PackedEntityRow {
  let flags = 0;
  if (entity.pos !== undefined) flags |= ENTITY_FLAG_HAS_POS;
  if (entity.rotation !== undefined) flags |= ENTITY_FLAG_HAS_ROTATION;
  if (entity.changedFields !== undefined && entity.changedFields !== null) {
    flags |= ENTITY_FLAG_HAS_CHANGED_FIELDS;
  }
  if (entity.type === 'building') flags |= ENTITY_FLAG_TYPE_BUILDING;
  if (entity.unit !== undefined) flags |= ENTITY_FLAG_HAS_UNIT;
  if (entity.building !== undefined) flags |= ENTITY_FLAG_HAS_BUILDING;

  const row: PackedEntityRow = [flags, entity.id, entity.playerId];
  if ((flags & ENTITY_FLAG_HAS_POS) !== 0) {
    const pos = entity.pos!;
    row.push(pos.x, pos.y, pos.z);
  }
  if ((flags & ENTITY_FLAG_HAS_ROTATION) !== 0) {
    row.push(entity.rotation!);
  }
  if ((flags & ENTITY_FLAG_HAS_CHANGED_FIELDS) !== 0) {
    row.push(entity.changedFields!);
  }
  if (entity.unit !== undefined) {
    row.push(packUnit(entity.unit));
  }
  if (entity.building !== undefined) {
    row.push(packBuilding(entity.building));
  }
  return row;
}

function unpackEntityRow(row: PackedEntityRow): NetworkServerSnapshotEntity {
  let i = 0;
  const flags = row[i++] as number;
  const id = row[i++] as number;
  const playerId = row[i++] as PlayerId;
  const entity: NetworkServerSnapshotEntity = {
    id,
    type: (flags & ENTITY_FLAG_TYPE_BUILDING) !== 0 ? 'building' : 'unit',
    playerId,
  };
  if ((flags & ENTITY_FLAG_HAS_POS) !== 0) {
    const x = row[i++] as number;
    const y = row[i++] as number;
    const z = row[i++] as number;
    entity.pos = { x, y, z };
  }
  if ((flags & ENTITY_FLAG_HAS_ROTATION) !== 0) {
    entity.rotation = row[i++] as number;
  }
  if ((flags & ENTITY_FLAG_HAS_CHANGED_FIELDS) !== 0) {
    entity.changedFields = row[i++] as number;
  }
  if ((flags & ENTITY_FLAG_HAS_UNIT) !== 0) {
    entity.unit = unpackUnit(row[i++] as unknown[]);
  }
  if ((flags & ENTITY_FLAG_HAS_BUILDING) !== 0) {
    entity.building = unpackBuilding(row[i++] as unknown[]);
  }
  return entity;
}

function isFiniteNumberArray(value: unknown): value is number[] {
  if (!Array.isArray(value)) return false;
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'number' || !Number.isFinite(value[i])) return false;
  }
  return true;
}

class PackedEntityByteWriter {
  protected bytes: Uint8Array;
  protected view: DataView;
  protected length: number;

  constructor(estimatedBytes: number, initialLength = 0) {
    this.bytes = new Uint8Array(Math.max(16, estimatedBytes, initialLength));
    this.view = new DataView(this.bytes.buffer);
    this.length = initialLength;
  }

  writeVarUint(value: number): void {
    let v = Math.max(0, Math.floor(value));
    while (v >= 0x80) {
      this.writeByte((v % 0x80) | 0x80);
      v = Math.floor(v / 0x80);
    }
    this.writeByte(v);
  }

  writeVarInt(value: number): void {
    const v = Math.round(value);
    this.writeVarUint(v < 0 ? (-v * 2) - 1 : v * 2);
  }

  writeFloat64(value: number): void {
    this.ensureCapacity(8);
    this.view.setFloat64(this.length, value, true);
    this.length += 8;
  }

  writeBytes(bytes: Uint8Array): void {
    this.ensureCapacity(bytes.byteLength);
    this.bytes.set(bytes, this.length);
    this.length += bytes.byteLength;
  }

  setUint32LE(offset: number, value: number): void {
    this.view.setUint32(offset, Math.max(0, Math.floor(value)), true);
  }

  finishBytes(): Uint8Array {
    return this.bytes.subarray(0, this.length);
  }

  private writeByte(value: number): void {
    this.ensureCapacity(1);
    this.bytes[this.length++] = value;
  }

  private ensureCapacity(additionalBytes: number): void {
    const needed = this.length + additionalBytes;
    if (needed <= this.bytes.length) return;

    let nextLength = this.bytes.length;
    while (nextLength < needed) nextLength *= 2;
    const next = new Uint8Array(nextLength);
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }
}

class PackedEntityBinaryReader {
  private readonly view: DataView;
  private offset = PACKED_ENTITY_BINARY_HEADER_BYTES;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get count(): number {
    return packedEntityBinaryRowCount(this.bytes);
  }

  readVarUint(): number {
    let value = 0;
    let multiplier = 1;
    while (this.offset < this.bytes.byteLength) {
      const byte = this.bytes[this.offset++];
      value += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) return value;
      multiplier *= 0x80;
    }
    return value;
  }

  readVarInt(): number {
    const value = this.readVarUint();
    return value % 2 === 0 ? value / 2 : -((value + 1) / 2);
  }

  readFloat64(): number {
    if (this.offset + 8 > this.bytes.byteLength) {
      this.offset = this.bytes.byteLength;
      return 0;
    }
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }
}

function packedEntityBinaryRowCount(rows: Uint8Array): number {
  if (rows.byteLength < PACKED_ENTITY_BINARY_HEADER_BYTES) return 0;
  return (
    rows[0] +
    rows[1] * 0x100 +
    rows[2] * 0x10000 +
    rows[3] * 0x1000000
  );
}

type PackedMovementUnitGroup = {
  flags: number;
  playerId: PlayerId;
  writer: PackedEntityByteWriter;
  count: number;
  lastId: number;
};

type PackedUnitTurretGroup = {
  playerId: PlayerId;
  turretCount: number;
  writer: PackedEntityByteWriter;
  count: number;
  lastId: number;
};

class PackedMovementUnitGroupedWriter {
  private readonly groups: PackedMovementUnitGroup[] = [];
  private readonly groupsByKey: (PackedMovementUnitGroup | undefined)[] = [];
  private count = 0;

  constructor(private readonly estimatedRows: number) {}

  append(entity: NetworkServerSnapshotEntity): void {
    const flags = movementUnitDeltaFlags(entity);
    const playerId = entity.playerId;
    const key = flags * 0x100 + playerId;
    let group = this.groupsByKey[key];
    if (group === undefined) {
      group = {
        flags,
        playerId,
        writer: new PackedEntityByteWriter(Math.max(32, Math.ceil(this.estimatedRows / 4) * 18)),
        count: 0,
        lastId: 0,
      };
      this.groupsByKey[key] = group;
      this.groups.push(group);
    }

    group.writer.writeVarInt(entity.id - group.lastId);
    group.lastId = entity.id;
    writeMovementUnitDeltaPayload(group.writer, flags, entity);
    group.count++;
    this.count++;
  }

  finish(): Uint8Array | undefined {
    if (this.count === 0) return undefined;

    const chunks: Uint8Array[] = new Array(this.groups.length);
    let estimatedBytes = PACKED_ENTITY_BINARY_HEADER_BYTES + 4;
    for (let i = 0; i < this.groups.length; i++) {
      chunks[i] = this.groups[i].writer.finishBytes();
      estimatedBytes += chunks[i].byteLength + 8;
    }

    const out = new PackedEntityByteWriter(estimatedBytes, PACKED_ENTITY_BINARY_HEADER_BYTES);
    out.writeVarUint(this.groups.length);
    for (let i = 0; i < this.groups.length; i++) {
      const group = this.groups[i];
      out.writeVarUint(group.flags);
      out.writeVarUint(group.playerId);
      out.writeVarUint(group.count);
      out.writeBytes(chunks[i]);
    }
    out.setUint32LE(0, this.count);
    return out.finishBytes();
  }
}

class PackedUnitTurretGroupedWriter {
  private readonly groups: PackedUnitTurretGroup[] = [];
  private readonly groupsByKey: (PackedUnitTurretGroup | undefined)[] = [];
  private count = 0;

  constructor(private readonly estimatedRows: number) {}

  append(entity: NetworkServerSnapshotEntity): void {
    const turrets = entity.unit!.turrets!;
    const playerId = entity.playerId;
    const turretCount = turrets.length;
    const key = playerId * 0x100 + turretCount;
    let group = this.groupsByKey[key];
    if (group === undefined) {
      group = {
        playerId,
        turretCount,
        writer: new PackedEntityByteWriter(Math.max(32, Math.ceil(this.estimatedRows / 4) * 18)),
        count: 0,
        lastId: 0,
      };
      this.groupsByKey[key] = group;
      this.groups.push(group);
    }

    group.writer.writeVarInt(entity.id - group.lastId);
    group.lastId = entity.id;
    writeUnitTurretDeltaPayload(group.writer, turrets);
    group.count++;
    this.count++;
  }

  finish(): Uint8Array | undefined {
    if (this.count === 0) return undefined;

    const chunks: Uint8Array[] = new Array(this.groups.length);
    let estimatedBytes = PACKED_ENTITY_BINARY_HEADER_BYTES + 4;
    for (let i = 0; i < this.groups.length; i++) {
      chunks[i] = this.groups[i].writer.finishBytes();
      estimatedBytes += chunks[i].byteLength + 8;
    }

    const out = new PackedEntityByteWriter(estimatedBytes, PACKED_ENTITY_BINARY_HEADER_BYTES);
    out.writeVarUint(this.groups.length);
    for (let i = 0; i < this.groups.length; i++) {
      const group = this.groups[i];
      out.writeVarUint(group.playerId);
      out.writeVarUint(group.turretCount);
      out.writeVarUint(group.count);
      out.writeBytes(chunks[i]);
    }
    out.setUint32LE(0, this.count);
    return out.finishBytes();
  }
}

function isMovementOnlyUnitDelta(entity: NetworkServerSnapshotEntity): boolean {
  if (entity.type !== 'unit' || entity.building !== undefined) return false;
  const changedFields = entity.changedFields;
  if (
    changedFields === undefined ||
    changedFields === null ||
    changedFields === 0 ||
    (changedFields & ~MOVEMENT_UNIT_CHANGED_FIELDS) !== 0
  ) {
    return false;
  }
  if (((changedFields & ENTITY_CHANGED_POS) !== 0) !== (entity.pos !== undefined)) return false;
  if (((changedFields & ENTITY_CHANGED_ROT) !== 0) !== (entity.rotation !== undefined)) return false;

  const unit = entity.unit;
  if (unit === undefined) return true;
  if (unit.hp !== undefined) return false;
  if (unit.unitType !== undefined) return false;
  if (unit.radius !== undefined) return false;
  if (unit.bodyCenterHeight !== undefined) return false;
  if (unit.mass !== undefined) return false;
  if (unit.surfaceNormal !== undefined) return false;
  if (unit.suspension !== undefined) return false;
  if (unit.fireEnabled !== undefined) return false;
  if (unit.isCommander !== undefined) return false;
  if (unit.buildTargetId !== undefined) return false;
  if (unit.actions !== undefined) return false;
  if (unit.turrets !== undefined) return false;
  if (unit.build !== undefined) return false;
  if (unit.velocity !== undefined && (changedFields & ENTITY_CHANGED_VEL) === 0) return false;
  if (unit.orientation !== undefined && (changedFields & ENTITY_CHANGED_ROT) === 0) return false;
  if (unit.angularVelocity3 !== undefined && (changedFields & ENTITY_CHANGED_VEL) === 0) return false;
  return true;
}

function isSplitUnitTurretDelta(entity: NetworkServerSnapshotEntity): boolean {
  if (entity.type !== 'unit' || entity.building !== undefined) return false;
  const changedFields = entity.changedFields;
  if (
    changedFields === undefined ||
    changedFields === null ||
    changedFields === 0 ||
    (changedFields & ENTITY_CHANGED_TURRETS) === 0 ||
    (changedFields & ~(MOVEMENT_UNIT_CHANGED_FIELDS | ENTITY_CHANGED_TURRETS)) !== 0
  ) {
    return false;
  }
  if (((changedFields & ENTITY_CHANGED_POS) !== 0) !== (entity.pos !== undefined)) return false;
  if (((changedFields & ENTITY_CHANGED_ROT) !== 0) !== (entity.rotation !== undefined)) return false;

  const unit = entity.unit;
  if (unit === undefined || unit.turrets === undefined) return false;
  if (unit.hp !== undefined) return false;
  if (unit.unitType !== undefined) return false;
  if (unit.radius !== undefined) return false;
  if (unit.bodyCenterHeight !== undefined) return false;
  if (unit.mass !== undefined) return false;
  if (unit.surfaceNormal !== undefined) return false;
  if (unit.suspension !== undefined) return false;
  if (unit.fireEnabled !== undefined) return false;
  if (unit.isCommander !== undefined) return false;
  if (unit.buildTargetId !== undefined) return false;
  if (unit.actions !== undefined) return false;
  if (unit.build !== undefined) return false;
  if (unit.velocity !== undefined && (changedFields & ENTITY_CHANGED_VEL) === 0) return false;
  if (unit.orientation !== undefined && (changedFields & ENTITY_CHANGED_ROT) === 0) return false;
  if (unit.angularVelocity3 !== undefined && (changedFields & ENTITY_CHANGED_VEL) === 0) return false;
  return true;
}

function hasMovementUnitDeltaFields(entity: NetworkServerSnapshotEntity): boolean {
  const unit = entity.unit;
  return (
    entity.pos !== undefined ||
    entity.rotation !== undefined ||
    unit?.velocity !== undefined ||
    unit?.orientation !== undefined ||
    unit?.angularVelocity3 !== undefined
  );
}

function appendMovementUnitDeltaRow(
  rows: PackedMovementUnitGroupedWriter,
  entity: NetworkServerSnapshotEntity,
): void {
  rows.append(entity);
}

function movementUnitDeltaFlags(entity: NetworkServerSnapshotEntity): number {
  let flags = 0;
  const pos = entity.pos;
  const unit = entity.unit;
  const velocity = unit?.velocity;
  const orientation = unit?.orientation;
  const angularVelocity = unit?.angularVelocity3;
  if (pos !== undefined) flags |= MOVEMENT_UNIT_FLAG_POS;
  if (entity.rotation !== undefined) flags |= MOVEMENT_UNIT_FLAG_ROTATION;
  if (velocity !== undefined) flags |= MOVEMENT_UNIT_FLAG_VELOCITY;
  if (orientation !== undefined) flags |= MOVEMENT_UNIT_FLAG_ORIENTATION;
  if (angularVelocity !== undefined) flags |= MOVEMENT_UNIT_FLAG_ANGULAR_VELOCITY;
  return flags;
}

function writeMovementUnitDeltaPayload(
  rows: PackedEntityByteWriter,
  flags: number,
  entity: NetworkServerSnapshotEntity,
): void {
  const pos = entity.pos;
  const unit = entity.unit;
  const velocity = unit?.velocity;
  const orientation = unit?.orientation;
  const angularVelocity = unit?.angularVelocity3;
  if ((flags & MOVEMENT_UNIT_FLAG_POS) !== 0) {
    rows.writeVarInt(pos!.x);
    rows.writeVarInt(pos!.y);
    rows.writeVarInt(pos!.z);
  }
  if ((flags & MOVEMENT_UNIT_FLAG_ROTATION) !== 0) {
    rows.writeVarInt(entity.rotation!);
  }
  if ((flags & MOVEMENT_UNIT_FLAG_VELOCITY) !== 0) {
    rows.writeVarInt(velocity!.x);
    rows.writeVarInt(velocity!.y);
    rows.writeVarInt(velocity!.z);
  }
  if ((flags & MOVEMENT_UNIT_FLAG_ORIENTATION) !== 0) {
    rows.writeFloat64(orientation!.x);
    rows.writeFloat64(orientation!.y);
    rows.writeFloat64(orientation!.z);
    rows.writeFloat64(orientation!.w);
  }
  if ((flags & MOVEMENT_UNIT_FLAG_ANGULAR_VELOCITY) !== 0) {
    rows.writeFloat64(angularVelocity!.x);
    rows.writeFloat64(angularVelocity!.y);
    rows.writeFloat64(angularVelocity!.z);
  }
}

function appendUnitTurretDeltaRow(
  rows: PackedUnitTurretGroupedWriter,
  entity: NetworkServerSnapshotEntity,
): void {
  rows.append(entity);
}

function writeUnitTurretDeltaPayload(
  rows: PackedEntityByteWriter,
  turrets: readonly NetworkServerSnapshotTurret[],
): void {
  for (let i = 0; i < turrets.length; i++) {
    const turret = turrets[i];
    const angular = turret.turret.angular;
    let flags = 0;
    if (turret.targetId !== undefined) flags |= TURRET_FLAG_TARGET_ID;
    if (turret.currentForceFieldRange !== undefined) flags |= TURRET_FLAG_FORCE_FIELD_RANGE;
    rows.writeVarUint(flags);
    rows.writeVarUint(turret.turret.id);
    rows.writeVarUint(turret.state);
    rows.writeVarInt(angular.rot);
    rows.writeVarInt(angular.vel);
    rows.writeVarInt(angular.pitch);
    rows.writeVarInt(angular.pitchVel);
    if ((flags & TURRET_FLAG_TARGET_ID) !== 0) rows.writeVarUint(turret.targetId!);
    if ((flags & TURRET_FLAG_FORCE_FIELD_RANGE) !== 0) {
      rows.writeFloat64(turret.currentForceFieldRange!);
    }
  }
}

function movementUnitChangedFields(flags: number): number {
  let changedFields = 0;
  if ((flags & MOVEMENT_UNIT_FLAG_POS) !== 0) changedFields |= ENTITY_CHANGED_POS;
  if (
    (flags & (MOVEMENT_UNIT_FLAG_ROTATION | MOVEMENT_UNIT_FLAG_ORIENTATION)) !== 0
  ) {
    changedFields |= ENTITY_CHANGED_ROT;
  }
  if (
    (flags & (MOVEMENT_UNIT_FLAG_VELOCITY | MOVEMENT_UNIT_FLAG_ANGULAR_VELOCITY)) !== 0
  ) {
    changedFields |= ENTITY_CHANGED_VEL;
  }
  return changedFields;
}

function movementUnitDeltaRowWidth(flags: number): number {
  let width = 3;
  if ((flags & MOVEMENT_UNIT_FLAG_POS) !== 0) width += 3;
  if ((flags & MOVEMENT_UNIT_FLAG_ROTATION) !== 0) width += 1;
  if ((flags & MOVEMENT_UNIT_FLAG_VELOCITY) !== 0) width += 3;
  if ((flags & MOVEMENT_UNIT_FLAG_ORIENTATION) !== 0) width += 4;
  if ((flags & MOVEMENT_UNIT_FLAG_ANGULAR_VELOCITY) !== 0) width += 3;
  return width;
}

function countMovementUnitDeltaRows(
  rows: PackedMovementUnitRows | PackedMovementUnitBytes | undefined,
): number {
  if (rows === undefined) return 0;
  if (rows instanceof Uint8Array) return packedEntityBinaryRowCount(rows);
  let count = 0;
  let i = 0;
  while (i < rows.length) {
    const flags = rows[i] ?? 0;
    i += movementUnitDeltaRowWidth(flags);
    count++;
  }
  return count;
}

function unitTurretRowWidth(rows: PackedUnitTurretRows, offset: number): number {
  let width = 3;
  const turretCount = rows[offset + 2] ?? 0;
  for (let i = 0; i < turretCount; i++) {
    const flags = rows[offset + width] ?? 0;
    width += 7;
    if ((flags & TURRET_FLAG_TARGET_ID) !== 0) width += 1;
    if ((flags & TURRET_FLAG_FORCE_FIELD_RANGE) !== 0) width += 1;
  }
  return width;
}

function countUnitTurretDeltaRows(
  rows: PackedUnitTurretRows | PackedUnitTurretBytes | undefined,
): number {
  if (rows === undefined) return 0;
  if (rows instanceof Uint8Array) return packedEntityBinaryRowCount(rows);
  let count = 0;
  let i = 0;
  while (i < rows.length) {
    i += unitTurretRowWidth(rows, i);
    count++;
  }
  return count;
}

function unpackMovementUnitDeltaRows(
  rows: PackedMovementUnitRows | PackedMovementUnitBytes,
  out: NetworkServerSnapshotEntity[],
  outIndex: number,
  version: PackedEntitySnapshotWire['v'],
): number {
  if (rows instanceof Uint8Array) {
    if (version === PACKED_ENTITIES_VERSION) {
      return unpackMovementUnitDeltaGroupedBytes(rows, out, outIndex);
    }
    return unpackMovementUnitDeltaBytes(rows, out, outIndex);
  }

  let i = 0;
  while (i < rows.length) {
    const flags = rows[i++] as number;
    const id = rows[i++] as number;
    const playerId = rows[i++] as PlayerId;
    const entity: NetworkServerSnapshotEntity = {
      id,
      type: 'unit',
      playerId,
      changedFields: movementUnitChangedFields(flags),
    };
    if ((flags & MOVEMENT_UNIT_FLAG_POS) !== 0) {
      entity.pos = {
        x: rows[i++] as number,
        y: rows[i++] as number,
        z: rows[i++] as number,
      };
    }
    if ((flags & MOVEMENT_UNIT_FLAG_ROTATION) !== 0) {
      entity.rotation = rows[i++] as number;
    }
    if (
      (flags & (
        MOVEMENT_UNIT_FLAG_VELOCITY |
        MOVEMENT_UNIT_FLAG_ORIENTATION |
        MOVEMENT_UNIT_FLAG_ANGULAR_VELOCITY
      )) !== 0
    ) {
      const unit: UnitSub = {};
      if ((flags & MOVEMENT_UNIT_FLAG_VELOCITY) !== 0) {
        unit.velocity = {
          x: rows[i++] as number,
          y: rows[i++] as number,
          z: rows[i++] as number,
        };
      }
      if ((flags & MOVEMENT_UNIT_FLAG_ORIENTATION) !== 0) {
        unit.orientation = {
          x: rows[i++] as number,
          y: rows[i++] as number,
          z: rows[i++] as number,
          w: rows[i++] as number,
        };
      }
      if ((flags & MOVEMENT_UNIT_FLAG_ANGULAR_VELOCITY) !== 0) {
        unit.angularVelocity3 = {
          x: rows[i++] as number,
          y: rows[i++] as number,
          z: rows[i++] as number,
        };
      }
      entity.unit = unit;
    }
    out[outIndex++] = entity;
  }
  return outIndex;
}

function unpackMovementUnitDeltaBytes(
  rows: PackedMovementUnitBytes,
  out: NetworkServerSnapshotEntity[],
  outIndex: number,
): number {
  const reader = new PackedEntityBinaryReader(rows);
  const count = reader.count;
  for (let i = 0; i < count; i++) {
    const flags = reader.readVarUint();
    const id = reader.readVarUint();
    const playerId = reader.readVarUint() as PlayerId;
    out[outIndex++] = readMovementUnitDeltaByteEntity(reader, flags, id, playerId);
  }
  return outIndex;
}

function unpackMovementUnitDeltaGroupedBytes(
  rows: PackedMovementUnitBytes,
  out: NetworkServerSnapshotEntity[],
  outIndex: number,
): number {
  const reader = new PackedEntityBinaryReader(rows);
  const groupCount = reader.readVarUint();
  for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
    const flags = reader.readVarUint();
    const playerId = reader.readVarUint() as PlayerId;
    const count = reader.readVarUint();
    let id = 0;
    for (let i = 0; i < count; i++) {
      id += reader.readVarInt();
      out[outIndex++] = readMovementUnitDeltaByteEntity(reader, flags, id, playerId);
    }
  }
  return outIndex;
}

function readMovementUnitDeltaByteEntity(
  reader: PackedEntityBinaryReader,
  flags: number,
  id: number,
  playerId: PlayerId,
): NetworkServerSnapshotEntity {
  const entity: NetworkServerSnapshotEntity = {
    id,
    type: 'unit',
    playerId,
    changedFields: movementUnitChangedFields(flags),
  };
  if ((flags & MOVEMENT_UNIT_FLAG_POS) !== 0) {
    entity.pos = {
      x: reader.readVarInt(),
      y: reader.readVarInt(),
      z: reader.readVarInt(),
    };
  }
  if ((flags & MOVEMENT_UNIT_FLAG_ROTATION) !== 0) {
    entity.rotation = reader.readVarInt();
  }
  if (
    (flags & (
      MOVEMENT_UNIT_FLAG_VELOCITY |
      MOVEMENT_UNIT_FLAG_ORIENTATION |
      MOVEMENT_UNIT_FLAG_ANGULAR_VELOCITY
    )) !== 0
  ) {
    const unit: UnitSub = {};
    if ((flags & MOVEMENT_UNIT_FLAG_VELOCITY) !== 0) {
      unit.velocity = {
        x: reader.readVarInt(),
        y: reader.readVarInt(),
        z: reader.readVarInt(),
      };
    }
    if ((flags & MOVEMENT_UNIT_FLAG_ORIENTATION) !== 0) {
      unit.orientation = {
        x: reader.readFloat64(),
        y: reader.readFloat64(),
        z: reader.readFloat64(),
        w: reader.readFloat64(),
      };
    }
    if ((flags & MOVEMENT_UNIT_FLAG_ANGULAR_VELOCITY) !== 0) {
      unit.angularVelocity3 = {
        x: reader.readFloat64(),
        y: reader.readFloat64(),
        z: reader.readFloat64(),
      };
    }
    entity.unit = unit;
  }
  return entity;
}

function unpackUnitTurretDeltaRows(
  rows: PackedUnitTurretRows | PackedUnitTurretBytes,
  out: NetworkServerSnapshotEntity[],
  outIndex: number,
  version: PackedEntitySnapshotWire['v'],
): number {
  if (rows instanceof Uint8Array) {
    if (version === PACKED_ENTITIES_VERSION) {
      return unpackUnitTurretDeltaGroupedBytes(rows, out, outIndex);
    }
    return unpackUnitTurretDeltaBytes(rows, out, outIndex);
  }

  let i = 0;
  while (i < rows.length) {
    const id = rows[i++] as number;
    const playerId = rows[i++] as PlayerId;
    const turretCount = rows[i++] as number;
    const turrets: NetworkServerSnapshotTurret[] = new Array(turretCount);
    for (let turretIndex = 0; turretIndex < turretCount; turretIndex++) {
      const flags = rows[i++] as number;
      const turretId = rows[i++] as NetworkServerSnapshotTurret['turret']['id'];
      const state = rows[i++] as NetworkServerSnapshotTurret['state'];
      const angular: TurretAngular = {
        rot: rows[i++] as number,
        vel: rows[i++] as number,
        pitch: rows[i++] as number,
        pitchVel: rows[i++] as number,
      };
      const turret: NetworkServerSnapshotTurret = {
        turret: { id: turretId, angular },
        state,
      };
      if ((flags & TURRET_FLAG_TARGET_ID) !== 0) turret.targetId = rows[i++] as number;
      if ((flags & TURRET_FLAG_FORCE_FIELD_RANGE) !== 0) {
        turret.currentForceFieldRange = rows[i++] as number;
      }
      turrets[turretIndex] = turret;
    }
    out[outIndex++] = {
      id,
      type: 'unit',
      playerId,
      changedFields: ENTITY_CHANGED_TURRETS,
      unit: { turrets },
    };
  }
  return outIndex;
}

function unpackUnitTurretDeltaBytes(
  rows: PackedUnitTurretBytes,
  out: NetworkServerSnapshotEntity[],
  outIndex: number,
): number {
  const reader = new PackedEntityBinaryReader(rows);
  const count = reader.count;
  for (let i = 0; i < count; i++) {
    const id = reader.readVarUint();
    const playerId = reader.readVarUint() as PlayerId;
    const turretCount = reader.readVarUint();
    out[outIndex++] = readUnitTurretDeltaByteEntity(reader, id, playerId, turretCount);
  }
  return outIndex;
}

function unpackUnitTurretDeltaGroupedBytes(
  rows: PackedUnitTurretBytes,
  out: NetworkServerSnapshotEntity[],
  outIndex: number,
): number {
  const reader = new PackedEntityBinaryReader(rows);
  const groupCount = reader.readVarUint();
  for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
    const playerId = reader.readVarUint() as PlayerId;
    const turretCount = reader.readVarUint();
    const count = reader.readVarUint();
    let id = 0;
    for (let i = 0; i < count; i++) {
      id += reader.readVarInt();
      out[outIndex++] = readUnitTurretDeltaByteEntity(reader, id, playerId, turretCount);
    }
  }
  return outIndex;
}

function readUnitTurretDeltaByteEntity(
  reader: PackedEntityBinaryReader,
  id: number,
  playerId: PlayerId,
  turretCount: number,
): NetworkServerSnapshotEntity {
  const turrets: NetworkServerSnapshotTurret[] = new Array(turretCount);
  for (let turretIndex = 0; turretIndex < turretCount; turretIndex++) {
    const flags = reader.readVarUint();
    const turretId = reader.readVarUint() as NetworkServerSnapshotTurret['turret']['id'];
    const state = reader.readVarUint() as NetworkServerSnapshotTurret['state'];
    const angular: TurretAngular = {
      rot: reader.readVarInt(),
      vel: reader.readVarInt(),
      pitch: reader.readVarInt(),
      pitchVel: reader.readVarInt(),
    };
    const turret: NetworkServerSnapshotTurret = {
      turret: { id: turretId, angular },
      state,
    };
    if ((flags & TURRET_FLAG_TARGET_ID) !== 0) turret.targetId = reader.readVarUint();
    if ((flags & TURRET_FLAG_FORCE_FIELD_RANGE) !== 0) {
      turret.currentForceFieldRange = reader.readFloat64();
    }
    turrets[turretIndex] = turret;
  }
  return {
    id,
    type: 'unit',
    playerId,
    changedFields: ENTITY_CHANGED_TURRETS,
    unit: { turrets },
  };
}

function packUnit(unit: UnitSub): unknown[] {
  let flags = 0;
  if (unit.hp !== undefined) flags |= UNIT_FLAG_HP;
  if (unit.velocity !== undefined) flags |= UNIT_FLAG_VELOCITY;
  if (unit.unitType !== undefined) flags |= UNIT_FLAG_UNIT_TYPE;
  if (unit.radius !== undefined) flags |= UNIT_FLAG_RADIUS;
  if (unit.bodyCenterHeight !== undefined) flags |= UNIT_FLAG_BODY_CENTER_HEIGHT;
  if (unit.mass !== undefined) flags |= UNIT_FLAG_MASS;
  if (unit.surfaceNormal !== undefined) flags |= UNIT_FLAG_SURFACE_NORMAL;
  if (unit.suspension !== undefined) {
    flags |= UNIT_FLAG_SUSPENSION;
    if (unit.suspension.legContact === true) flags |= UNIT_FLAG_SUSPENSION_LEG_CONTACT;
  }
  if (unit.orientation !== undefined) flags |= UNIT_FLAG_ORIENTATION;
  if (unit.angularVelocity3 !== undefined) flags |= UNIT_FLAG_ANGULAR_VELOCITY;
  if (unit.fireEnabled === false) flags |= UNIT_FLAG_FIRE_DISABLED;
  if (unit.isCommander === true) flags |= UNIT_FLAG_IS_COMMANDER;
  if (unit.buildTargetId !== undefined) {
    flags |= UNIT_FLAG_BUILD_TARGET_ID;
    if (unit.buildTargetId === null) flags |= UNIT_FLAG_BUILD_TARGET_NULL;
  }
  if (unit.actions !== undefined) flags |= UNIT_FLAG_ACTIONS;
  if (unit.turrets !== undefined) flags |= UNIT_FLAG_TURRETS;
  if (unit.build !== undefined) {
    flags |= UNIT_FLAG_BUILD;
    if (unit.build.complete === true) flags |= UNIT_FLAG_BUILD_COMPLETE;
  }

  const row: unknown[] = [flags];
  if ((flags & UNIT_FLAG_HP) !== 0) {
    const hp = unit.hp!;
    row.push(hp.curr, hp.max);
  }
  if ((flags & UNIT_FLAG_VELOCITY) !== 0) {
    const v = unit.velocity!;
    row.push(v.x, v.y, v.z);
  }
  if ((flags & UNIT_FLAG_UNIT_TYPE) !== 0) row.push(unit.unitType!);
  if ((flags & UNIT_FLAG_RADIUS) !== 0) {
    const r = unit.radius!;
    row.push(r.body ?? 0, r.shot ?? 0, r.push ?? 0);
  }
  if ((flags & UNIT_FLAG_BODY_CENTER_HEIGHT) !== 0) row.push(unit.bodyCenterHeight!);
  if ((flags & UNIT_FLAG_MASS) !== 0) row.push(unit.mass!);
  if ((flags & UNIT_FLAG_SURFACE_NORMAL) !== 0) {
    const sn = unit.surfaceNormal!;
    row.push(sn.nx, sn.ny, sn.nz);
  }
  if ((flags & UNIT_FLAG_SUSPENSION) !== 0) {
    const s = unit.suspension!;
    row.push(s.offset.x, s.offset.y, s.offset.z, s.velocity.x, s.velocity.y, s.velocity.z);
  }
  if ((flags & UNIT_FLAG_ORIENTATION) !== 0) {
    const o = unit.orientation!;
    row.push(o.x, o.y, o.z, o.w);
  }
  if ((flags & UNIT_FLAG_ANGULAR_VELOCITY) !== 0) {
    const av = unit.angularVelocity3!;
    row.push(av.x, av.y, av.z);
  }
  if ((flags & UNIT_FLAG_BUILD_TARGET_ID) !== 0) {
    if ((flags & UNIT_FLAG_BUILD_TARGET_NULL) === 0) {
      row.push(unit.buildTargetId as number);
    }
  }
  if ((flags & UNIT_FLAG_ACTIONS) !== 0) {
    row.push(packActions(unit.actions!));
  }
  if ((flags & UNIT_FLAG_TURRETS) !== 0) {
    row.push(packTurrets(unit.turrets!));
  }
  if ((flags & UNIT_FLAG_BUILD) !== 0) {
    const build = unit.build!;
    row.push(build.paid.energy, build.paid.metal);
  }
  return row;
}

function unpackUnit(row: unknown[]): UnitSub {
  let i = 0;
  const flags = row[i++] as number;
  const unit: UnitSub = {};
  if ((flags & UNIT_FLAG_HP) !== 0) {
    const curr = row[i++] as number;
    const max = row[i++] as number;
    unit.hp = { curr, max };
  }
  if ((flags & UNIT_FLAG_VELOCITY) !== 0) {
    const x = row[i++] as number;
    const y = row[i++] as number;
    const z = row[i++] as number;
    unit.velocity = { x, y, z };
  }
  if ((flags & UNIT_FLAG_UNIT_TYPE) !== 0) {
    unit.unitType = row[i++] as number;
  }
  if ((flags & UNIT_FLAG_RADIUS) !== 0) {
    const body = row[i++] as number;
    const shot = row[i++] as number;
    const push = row[i++] as number;
    unit.radius = { body, shot, push };
  }
  if ((flags & UNIT_FLAG_BODY_CENTER_HEIGHT) !== 0) {
    unit.bodyCenterHeight = row[i++] as number;
  }
  if ((flags & UNIT_FLAG_MASS) !== 0) {
    unit.mass = row[i++] as number;
  }
  if ((flags & UNIT_FLAG_SURFACE_NORMAL) !== 0) {
    const nx = row[i++] as number;
    const ny = row[i++] as number;
    const nz = row[i++] as number;
    unit.surfaceNormal = { nx, ny, nz };
  }
  if ((flags & UNIT_FLAG_SUSPENSION) !== 0) {
    const ox = row[i++] as number;
    const oy = row[i++] as number;
    const oz = row[i++] as number;
    const vx = row[i++] as number;
    const vy = row[i++] as number;
    const vz = row[i++] as number;
    const suspension: SuspensionSub = {
      offset: { x: ox, y: oy, z: oz },
      velocity: { x: vx, y: vy, z: vz },
    };
    if ((flags & UNIT_FLAG_SUSPENSION_LEG_CONTACT) !== 0) suspension.legContact = true;
    unit.suspension = suspension;
  }
  if ((flags & UNIT_FLAG_ORIENTATION) !== 0) {
    const x = row[i++] as number;
    const y = row[i++] as number;
    const z = row[i++] as number;
    const w = row[i++] as number;
    unit.orientation = { x, y, z, w };
  }
  if ((flags & UNIT_FLAG_ANGULAR_VELOCITY) !== 0) {
    const x = row[i++] as number;
    const y = row[i++] as number;
    const z = row[i++] as number;
    unit.angularVelocity3 = { x, y, z };
  }
  if ((flags & UNIT_FLAG_FIRE_DISABLED) !== 0) {
    unit.fireEnabled = false;
  }
  if ((flags & UNIT_FLAG_IS_COMMANDER) !== 0) {
    unit.isCommander = true;
  }
  if ((flags & UNIT_FLAG_BUILD_TARGET_ID) !== 0) {
    unit.buildTargetId = (flags & UNIT_FLAG_BUILD_TARGET_NULL) !== 0
      ? null
      : (row[i++] as number);
  }
  if ((flags & UNIT_FLAG_ACTIONS) !== 0) {
    unit.actions = unpackActions(row[i++] as unknown[]);
  }
  if ((flags & UNIT_FLAG_TURRETS) !== 0) {
    unit.turrets = unpackTurrets(row[i++] as unknown[]);
  }
  if ((flags & UNIT_FLAG_BUILD) !== 0) {
    const energy = row[i++] as number;
    const metal = row[i++] as number;
    unit.build = {
      complete: (flags & UNIT_FLAG_BUILD_COMPLETE) !== 0,
      paid: { energy, metal },
    };
  }
  return unit;
}

function packBuilding(building: BuildingSub): unknown[] {
  let flags = 0;
  if (building.type !== undefined) flags |= BUILDING_FLAG_TYPE;
  if (building.dim !== undefined) flags |= BUILDING_FLAG_DIM;
  if (building.hp !== undefined) flags |= BUILDING_FLAG_HP;
  if (building.build !== undefined) {
    flags |= BUILDING_FLAG_BUILD;
    if (building.build.complete === true) flags |= BUILDING_FLAG_BUILD_COMPLETE;
  }
  if (building.metalExtractionRate !== undefined) flags |= BUILDING_FLAG_METAL_EXTRACTION_RATE;
  if (building.solar !== undefined) {
    flags |= BUILDING_FLAG_SOLAR;
    if (building.solar.open === true) flags |= BUILDING_FLAG_SOLAR_OPEN;
  }
  if (building.turrets !== undefined) flags |= BUILDING_FLAG_TURRETS;
  if (building.factory !== undefined) {
    flags |= BUILDING_FLAG_FACTORY;
    if (building.factory.producing === true) flags |= BUILDING_FLAG_FACTORY_PRODUCING;
  }

  const row: unknown[] = [flags];
  if ((flags & BUILDING_FLAG_TYPE) !== 0) row.push(building.type!);
  if ((flags & BUILDING_FLAG_DIM) !== 0) {
    const dim = building.dim!;
    row.push(dim.x, dim.y);
  }
  if ((flags & BUILDING_FLAG_HP) !== 0) {
    const hp = building.hp!;
    row.push(hp.curr, hp.max);
  }
  if ((flags & BUILDING_FLAG_BUILD) !== 0) {
    const build = building.build!;
    row.push(build.paid.energy, build.paid.metal);
  }
  if ((flags & BUILDING_FLAG_METAL_EXTRACTION_RATE) !== 0) {
    row.push(building.metalExtractionRate!);
  }
  if ((flags & BUILDING_FLAG_TURRETS) !== 0) {
    row.push(packTurrets(building.turrets!));
  }
  if ((flags & BUILDING_FLAG_FACTORY) !== 0) {
    row.push(packFactory(building.factory!));
  }
  return row;
}

function unpackBuilding(row: unknown[]): BuildingSub {
  let i = 0;
  const flags = row[i++] as number;
  const building: BuildingSub = {};
  if ((flags & BUILDING_FLAG_TYPE) !== 0) {
    building.type = row[i++] as number;
  }
  if ((flags & BUILDING_FLAG_DIM) !== 0) {
    const x = row[i++] as number;
    const y = row[i++] as number;
    building.dim = { x, y };
  }
  if ((flags & BUILDING_FLAG_HP) !== 0) {
    const curr = row[i++] as number;
    const max = row[i++] as number;
    building.hp = { curr, max };
  }
  if ((flags & BUILDING_FLAG_BUILD) !== 0) {
    const energy = row[i++] as number;
    const metal = row[i++] as number;
    building.build = {
      complete: (flags & BUILDING_FLAG_BUILD_COMPLETE) !== 0,
      paid: { energy, metal },
    };
  }
  if ((flags & BUILDING_FLAG_METAL_EXTRACTION_RATE) !== 0) {
    building.metalExtractionRate = row[i++] as number;
  }
  if ((flags & BUILDING_FLAG_SOLAR) !== 0) {
    building.solar = { open: (flags & BUILDING_FLAG_SOLAR_OPEN) !== 0 };
  }
  if ((flags & BUILDING_FLAG_TURRETS) !== 0) {
    building.turrets = unpackTurrets(row[i++] as unknown[]);
  }
  if ((flags & BUILDING_FLAG_FACTORY) !== 0) {
    building.factory = unpackFactory(
      row[i++] as unknown[],
      (flags & BUILDING_FLAG_FACTORY_PRODUCING) !== 0,
    );
  }
  return building;
}

function packActions(actions: readonly NetworkServerSnapshotAction[]): unknown[] {
  const out: unknown[] = new Array(actions.length);
  for (let i = 0; i < actions.length; i++) {
    out[i] = packAction(actions[i]);
  }
  return out;
}

function unpackActions(rows: unknown[]): NetworkServerSnapshotAction[] {
  const out: NetworkServerSnapshotAction[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    out[i] = unpackAction(rows[i] as unknown[]);
  }
  return out;
}

function packAction(action: NetworkServerSnapshotAction): unknown[] {
  let flags = 0;
  if (action.pos !== undefined) flags |= ACTION_FLAG_POS;
  if (action.posZ !== undefined) flags |= ACTION_FLAG_POS_Z;
  if (action.pathExp === true) flags |= ACTION_FLAG_PATH_EXP;
  if (action.targetId !== undefined) flags |= ACTION_FLAG_TARGET_ID;
  if (action.buildingType !== undefined) flags |= ACTION_FLAG_BUILDING_TYPE;
  if (action.grid !== undefined) flags |= ACTION_FLAG_GRID;
  if (action.buildingId !== undefined) flags |= ACTION_FLAG_BUILDING_ID;

  const row: unknown[] = [flags, action.type];
  if ((flags & ACTION_FLAG_POS) !== 0) {
    const pos = action.pos!;
    row.push(pos.x, pos.y);
  }
  if ((flags & ACTION_FLAG_POS_Z) !== 0) row.push(action.posZ!);
  if ((flags & ACTION_FLAG_TARGET_ID) !== 0) row.push(action.targetId!);
  if ((flags & ACTION_FLAG_BUILDING_TYPE) !== 0) row.push(action.buildingType!);
  if ((flags & ACTION_FLAG_GRID) !== 0) {
    const grid = action.grid!;
    row.push(grid.x, grid.y);
  }
  if ((flags & ACTION_FLAG_BUILDING_ID) !== 0) row.push(action.buildingId!);
  return row;
}

function unpackAction(row: unknown[]): NetworkServerSnapshotAction {
  let i = 0;
  const flags = row[i++] as number;
  const type = row[i++] as NetworkServerSnapshotAction['type'];
  const action: NetworkServerSnapshotAction = { type };
  if ((flags & ACTION_FLAG_POS) !== 0) {
    const x = row[i++] as number;
    const y = row[i++] as number;
    action.pos = { x, y };
  }
  if ((flags & ACTION_FLAG_POS_Z) !== 0) action.posZ = row[i++] as number;
  if ((flags & ACTION_FLAG_PATH_EXP) !== 0) action.pathExp = true;
  if ((flags & ACTION_FLAG_TARGET_ID) !== 0) action.targetId = row[i++] as number;
  if ((flags & ACTION_FLAG_BUILDING_TYPE) !== 0) action.buildingType = row[i++] as string;
  if ((flags & ACTION_FLAG_GRID) !== 0) {
    const x = row[i++] as number;
    const y = row[i++] as number;
    action.grid = { x, y };
  }
  if ((flags & ACTION_FLAG_BUILDING_ID) !== 0) action.buildingId = row[i++] as number;
  return action;
}

function packTurrets(turrets: readonly NetworkServerSnapshotTurret[]): unknown[] {
  const out: unknown[] = new Array(turrets.length);
  for (let i = 0; i < turrets.length; i++) {
    out[i] = packTurret(turrets[i]);
  }
  return out;
}

function unpackTurrets(rows: unknown[]): NetworkServerSnapshotTurret[] {
  const out: NetworkServerSnapshotTurret[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    out[i] = unpackTurret(rows[i] as unknown[]);
  }
  return out;
}

function packTurret(t: NetworkServerSnapshotTurret): unknown[] {
  let flags = 0;
  if (t.targetId !== undefined) flags |= TURRET_FLAG_TARGET_ID;
  if (t.currentForceFieldRange !== undefined) flags |= TURRET_FLAG_FORCE_FIELD_RANGE;

  const angular = t.turret.angular;
  const row: unknown[] = [
    flags,
    t.turret.id,
    t.state,
    angular.rot,
    angular.vel,
    angular.pitch,
    angular.pitchVel,
  ];
  if ((flags & TURRET_FLAG_TARGET_ID) !== 0) row.push(t.targetId!);
  if ((flags & TURRET_FLAG_FORCE_FIELD_RANGE) !== 0) row.push(t.currentForceFieldRange!);
  return row;
}

function unpackTurret(row: unknown[]): NetworkServerSnapshotTurret {
  const flags = row[0] as number;
  const id = row[1] as NetworkServerSnapshotTurret['turret']['id'];
  const state = row[2] as NetworkServerSnapshotTurret['state'];
  const angular: TurretAngular = {
    rot: row[3] as number,
    vel: row[4] as number,
    pitch: row[5] as number,
    pitchVel: row[6] as number,
  };
  let i = 7;
  const turret: NetworkServerSnapshotTurret = {
    turret: { id, angular },
    state,
  };
  if ((flags & TURRET_FLAG_TARGET_ID) !== 0) turret.targetId = row[i++] as number;
  if ((flags & TURRET_FLAG_FORCE_FIELD_RANGE) !== 0) {
    turret.currentForceFieldRange = row[i++] as number;
  }
  return turret;
}

function packFactory(factory: FactorySub): unknown[] {
  const waypointRows: unknown[] = new Array(factory.waypoints.length);
  for (let i = 0; i < factory.waypoints.length; i++) {
    waypointRows[i] = packWaypoint(factory.waypoints[i]);
  }
  return [
    factory.queue,
    factory.progress,
    factory.energyRate,
    factory.metalRate,
    waypointRows,
  ];
}

function unpackFactory(row: unknown[], producing: boolean): FactorySub {
  const queue = row[0] as number[];
  const progress = row[1] as number;
  const energyRate = row[2] as number;
  const metalRate = row[3] as number;
  const waypointRows = row[4] as unknown[];
  const waypoints: WaypointSub[] = new Array(waypointRows.length);
  for (let i = 0; i < waypointRows.length; i++) {
    waypoints[i] = unpackWaypoint(waypointRows[i] as unknown[]);
  }
  return { queue, progress, producing, energyRate, metalRate, waypoints };
}

function packWaypoint(waypoint: WaypointSub): unknown[] {
  let flags = 0;
  if (waypoint.posZ !== undefined) flags |= WAYPOINT_FLAG_POS_Z;
  const row: unknown[] = [flags, waypoint.pos.x, waypoint.pos.y, waypoint.type];
  if ((flags & WAYPOINT_FLAG_POS_Z) !== 0) row.push(waypoint.posZ!);
  return row;
}

function unpackWaypoint(row: unknown[]): WaypointSub {
  const flags = row[0] as number;
  const waypoint: WaypointSub = {
    pos: { x: row[1] as number, y: row[2] as number },
    type: row[3] as string,
  };
  if ((flags & WAYPOINT_FLAG_POS_Z) !== 0) waypoint.posZ = row[4] as number;
  return waypoint;
}

// Re-exported for tests / measurement harnesses that want to round-trip
// a snapshot's entities through the packed wire form.
export function roundTripEntitiesThroughWire(
  state: NetworkServerSnapshot,
): NetworkServerSnapshotEntity[] {
  const packed = packEntitiesForWire(state.entities);
  if (packed === undefined) return [...state.entities];
  return unpackEntitiesFromWire(packed);
}
