import type { PlayerId } from '../../types/sim';
import {
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_ROT,
  ENTITY_CHANGED_TURRETS,
  ENTITY_CHANGED_VEL,
} from '../../types/network';
import { setQuatFromYaw } from '../math/Quaternion';
import { dequantizeRotation as deqRot } from './snapshotQuantization';
import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotAction,
  NetworkServerSnapshotEntity,
  NetworkServerSnapshotTurret,
} from './NetworkTypes';
import {
  PACKED_BINARY_ROW_COUNT_BYTES,
  PackedBinaryReader,
  PackedBinaryWriter,
  readPackedBinaryRowCount,
} from './snapshotBinaryWire';

type UnitSub = NonNullable<NetworkServerSnapshotEntity['unit']>;
type BuildingSub = NonNullable<NetworkServerSnapshotEntity['building']>;
type FactorySub = NonNullable<BuildingSub['factory']>;
type WaypointSub = FactorySub['rally'];
type TurretAngular = NetworkServerSnapshotTurret['turret']['angular'];

function createEmptyUnitSub(): UnitSub {
  return {
    unitBlueprintCode: null,
    hp: null,
    radius: null,
    bodyCenterHeight: null,
    mass: null,
    velocity: null,
    surfaceNormal: null,
    orientation: null,
    angularVelocity3: null,
    fireEnabled: null,
    isCommander: null,
    buildTargetId: null,
    buildTargetIdPresent: false,
    actions: null,
    turrets: null,
    build: null,
  };
}

function createEmptyBuildingSub(): BuildingSub {
  return {
    buildingBlueprintCode: null,
    dim: null,
    hp: null,
    build: null,
    metalExtractionRate: null,
    solar: null,
    turrets: null,
    factory: null,
  };
}

// Decode-side object pools for the per-unit movement-delta hot path
// (the dominant decode allocation at thousands of units). Reused across
// decodes and reset at the top of every unpackEntitiesFromWire.
//
// Safe to reuse because a decoded snapshot never outlives its decode:
// on the normal path it is applied synchronously within the decode's
// promise tick (consumers copy scalars out, never retaining the DTOs),
// and the async buffering paths (RemoteGameConnection.pendingSnapshot,
// the snapshot-impairment delay queue, NetworkSnapshotTransport pending)
// clone the snapshot into owned objects before holding it. So pooled
// objects are dead by the next decode.
type DecodedVec3 = { x: number; y: number; z: number };
type DecodedQuat = { x: number; y: number; z: number; w: number };

const _entityPool: NetworkServerSnapshotEntity[] = [];
let _entityPoolIndex = 0;
const _unitSubPool: UnitSub[] = [];
let _unitSubPoolIndex = 0;
const _vec3Pool: DecodedVec3[] = [];
let _vec3PoolIndex = 0;
const _quatPool: DecodedQuat[] = [];
let _quatPoolIndex = 0;

function resetDecodePools(): void {
  _entityPoolIndex = 0;
  _unitSubPoolIndex = 0;
  _vec3PoolIndex = 0;
  _quatPoolIndex = 0;
}

function rentDecodedEntity(): NetworkServerSnapshotEntity {
  let e = _entityPool[_entityPoolIndex];
  if (e === undefined) {
    e = {
      id: 0,
      type: 'unit',
      playerId: 0 as PlayerId,
      changedFields: null,
      pos: null,
      rotation: null,
      unit: null,
      building: null,
    };
    _entityPool[_entityPoolIndex] = e;
  } else {
    // Reset the conditionally-populated fields so a reused row can't
    // carry a zombie sub-object from the previous decode. id, type,
    // playerId and changedFields are always written by the caller.
    e.pos = null;
    e.rotation = null;
    e.unit = null;
    e.building = null;
  }
  _entityPoolIndex++;
  return e;
}

function rentDecodedUnitSub(): UnitSub {
  let u = _unitSubPool[_unitSubPoolIndex];
  if (u === undefined) {
    u = createEmptyUnitSub();
    _unitSubPool[_unitSubPoolIndex] = u;
  } else {
    u.unitBlueprintCode = null;
    u.hp = null;
    u.radius = null;
    u.bodyCenterHeight = null;
    u.mass = null;
    u.velocity = null;
    u.surfaceNormal = null;
    u.orientation = null;
    u.angularVelocity3 = null;
    u.fireEnabled = null;
    u.isCommander = null;
    u.buildTargetId = null;
    u.buildTargetIdPresent = false;
    u.actions = null;
    u.turrets = null;
    u.build = null;
  }
  _unitSubPoolIndex++;
  return u;
}

function rentDecodedVec3(x: number, y: number, z: number): DecodedVec3 {
  let v = _vec3Pool[_vec3PoolIndex];
  if (v === undefined) {
    v = { x, y, z };
    _vec3Pool[_vec3PoolIndex] = v;
  } else {
    v.x = x;
    v.y = y;
    v.z = z;
  }
  _vec3PoolIndex++;
  return v;
}

function rentDecodedQuat(x: number, y: number, z: number, w: number): DecodedQuat {
  let q = _quatPool[_quatPoolIndex];
  if (q === undefined) {
    q = { x, y, z, w };
    _quatPool[_quatPoolIndex] = q;
  } else {
    q.x = x;
    q.y = y;
    q.z = z;
    q.w = w;
  }
  _quatPoolIndex++;
  return q;
}

const PACKED_ENTITIES_V1_VERSION = 1;
const PACKED_ENTITIES_V2_VERSION = 2;
const PACKED_ENTITIES_V3_VERSION = 3;
const PACKED_ENTITIES_V4_VERSION = 4;
const PACKED_ENTITIES_V5_VERSION = 5;
const PACKED_ENTITIES_VERSION = 6;

// Bit flags for the packed unit row's optional-presence header.
// One bit per optional sub-field so the decoder can tell "missing"
// from "present but zero".
const UNIT_FLAG_HP = 1 << 0;
const UNIT_FLAG_VELOCITY = 1 << 1;
const UNIT_FLAG_BLUEPRINT_CODE = 1 << 2;
const UNIT_FLAG_RADIUS = 1 << 3;
const UNIT_FLAG_BODY_CENTER_HEIGHT = 1 << 4;
const UNIT_FLAG_MASS = 1 << 5;
const UNIT_FLAG_SURFACE_NORMAL = 1 << 6;
const UNIT_FLAG_RETIRED_SUSPENSION = 1 << 7;
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
const UNIT_FLAG_BUILD_INTERRUPTED = 1 << 19;

const BUILDING_FLAG_BLUEPRINT_CODE = 1 << 0;
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
const BUILDING_FLAG_BUILD_INTERRUPTED = 1 << 11;

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
const MOVEMENT_UNIT_FLAG_YAW_ORIENTATION = 1 << 5;
const MOVEMENT_UNIT_FLAG_YAW_ANGULAR_VELOCITY = 1 << 6;
const MOVEMENT_UNIT_CHANGED_FIELDS =
  ENTITY_CHANGED_POS |
  ENTITY_CHANGED_ROT |
  ENTITY_CHANGED_VEL;
const PACKED_ENTITY_BINARY_HEADER_BYTES = PACKED_BINARY_ROW_COUNT_BYTES;

const ACTION_FLAG_POS = 1 << 0;
const ACTION_FLAG_POS_Z = 1 << 1;
const ACTION_FLAG_PATH_EXP = 1 << 2;
const ACTION_FLAG_TARGET_ID = 1 << 3;
const ACTION_FLAG_BUILDING_BLUEPRINT_ID = 1 << 4;
const ACTION_FLAG_GRID = 1 << 5;
const ACTION_FLAG_BUILDING_ID = 1 << 6;

const TURRET_FLAG_TARGET_ID = 1 << 0;
const TURRET_FLAG_SHIELD_RANGE = 1 << 1;
const TURRET_FLAG_INACTIVE = 1 << 2;

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
// counts are paid once per group instead of once per row. V6 also
// compacts yaw-only airborne orientation from the already-shipped
// rotation channel and yaw-only angular velocity from three floats to
// one.
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
  m: PackedMovementUnitRows | undefined;
  e: PackedEntityRow[] | undefined;
};

export type PackedEntitySnapshotWireV3 = {
  v: typeof PACKED_ENTITIES_V3_VERSION;
  m: PackedMovementUnitRows | undefined;
  t: PackedUnitTurretRows | undefined;
  e: PackedEntityRow[] | undefined;
};

export type PackedEntitySnapshotWireV4 = {
  v: typeof PACKED_ENTITIES_V4_VERSION;
  m: PackedMovementUnitBytes | undefined;
  t: PackedUnitTurretBytes | undefined;
  e: PackedEntityRow[] | undefined;
};

export type PackedEntitySnapshotWireV5 = {
  v: typeof PACKED_ENTITIES_V5_VERSION;
  m: PackedMovementUnitBytes | undefined;
  t: PackedUnitTurretBytes | undefined;
  e: PackedEntityRow[] | undefined;
};

export type PackedEntitySnapshotWireV6 = {
  v: typeof PACKED_ENTITIES_VERSION;
  m: PackedMovementUnitBytes | undefined;
  t: PackedUnitTurretBytes | undefined;
  e: PackedEntityRow[] | undefined;
};

export type PackedEntitySnapshotWire =
  | PackedEntitySnapshotWireV1
  | PackedEntitySnapshotWireV2
  | PackedEntitySnapshotWireV3
  | PackedEntitySnapshotWireV4
  | PackedEntitySnapshotWireV5
  | PackedEntitySnapshotWireV6;

export function packEntitiesForWire(
  entities: readonly NetworkServerSnapshotEntity[] | undefined,
): PackedEntitySnapshotWire | undefined {
  if (entities === undefined) return undefined;
  resetEntityPackScratch();
  let detailRows: PackedEntityRow[] | undefined;
  try {
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      if (isMovementOnlyUnitDelta(entity)) {
        appendMovementUnitDeltaRow(entity, entities.length);
      } else if (isSplitUnitTurretDelta(entity)) {
        if (hasMovementUnitDeltaFields(entity)) {
          appendMovementUnitDeltaRow(entity, entities.length);
        }
        appendUnitTurretDeltaRow(entity, entities.length);
      } else {
        if (detailRows === undefined) detailRows = [];
        detailRows.push(packEntityRow(entity));
      }
    }

    const packed: PackedEntitySnapshotWireV6 = {
      v: PACKED_ENTITIES_VERSION,
      m: undefined,
      t: undefined,
      e: undefined,
    };
    const movementBytes = finishMovementUnitDeltaRows();
    const turretBytes = finishUnitTurretDeltaRows();
    if (movementBytes !== undefined) packed.m = movementBytes;
    if (turretBytes !== undefined) packed.t = turretBytes;
    if (
      detailRows !== undefined ||
      (movementBytes === undefined && turretBytes === undefined)
    ) {
      packed.e = detailRows ?? [];
    }
    return packed;
  } finally {
    resetEntityPackScratch();
  }
}

export function unpackEntitiesFromWire(
  packed: PackedEntitySnapshotWire,
): NetworkServerSnapshotEntity[] {
  resetDecodePools();
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
    packed.v === PACKED_ENTITIES_V5_VERSION ||
    packed.v === PACKED_ENTITIES_VERSION
    ? packed.t
    : undefined;
  const detailRows = packed.e;
  const movementCount = countMovementUnitDeltaRows(movementRows);
  const turretCount = countUnitTurretDeltaRows(turretRows);
  const detailCount = detailRows === undefined ? 0 : detailRows.length;
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
    candidate.v === PACKED_ENTITIES_V5_VERSION ||
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
  if (entity.pos !== null) flags |= ENTITY_FLAG_HAS_POS;
  if (entity.rotation !== null) flags |= ENTITY_FLAG_HAS_ROTATION;
  if (entity.changedFields !== null) {
    flags |= ENTITY_FLAG_HAS_CHANGED_FIELDS;
  }
  // Towers and buildings share the same wire row flag (static
  // structural shape). The TOWER vs BUILDING peer discriminator is
  // reconstructed on the receive side via isTowerBuildingBlueprintId().
  if (entity.type === 'building' || entity.type === 'tower') flags |= ENTITY_FLAG_TYPE_BUILDING;
  if (entity.unit !== null) flags |= ENTITY_FLAG_HAS_UNIT;
  if (entity.building !== null) flags |= ENTITY_FLAG_HAS_BUILDING;

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
  if (entity.unit !== null) {
    row.push(packUnit(entity.unit));
  }
  if (entity.building !== null) {
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
    pos: null,
    rotation: null,
    changedFields: null,
    unit: null,
    building: null,
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

type PackedMovementUnitGroup = {
  flags: number;
  playerId: PlayerId;
  writer: PackedBinaryWriter;
  count: number;
  lastId: number;
};

type PackedUnitTurretGroup = {
  playerId: PlayerId;
  turretCount: number;
  writer: PackedBinaryWriter;
  count: number;
  lastId: number;
};

const _movementGroups: PackedMovementUnitGroup[] = [];
const _movementGroupPool: PackedMovementUnitGroup[] = [];
const _movementGroupsByKey: (PackedMovementUnitGroup | undefined)[] = [];
const _movementGroupKeys: number[] = [];
let _movementRowCount = 0;

const _turretGroups: PackedUnitTurretGroup[] = [];
const _turretGroupPool: PackedUnitTurretGroup[] = [];
const _turretGroupsByKey: (PackedUnitTurretGroup | undefined)[] = [];
const _turretGroupKeys: number[] = [];
let _turretRowCount = 0;

function rentMovementGroup(
  flags: number,
  playerId: PlayerId,
  estimatedBytes: number,
): PackedMovementUnitGroup {
  const group = _movementGroupPool.pop();
  if (group !== undefined) {
    group.flags = flags;
    group.playerId = playerId;
    group.writer.reset(estimatedBytes);
    group.count = 0;
    group.lastId = 0;
    return group;
  }
  return {
    flags,
    playerId,
    writer: new PackedBinaryWriter(estimatedBytes),
    count: 0,
    lastId: 0,
  };
}

function rentTurretGroup(
  playerId: PlayerId,
  turretCount: number,
  estimatedBytes: number,
): PackedUnitTurretGroup {
  const group = _turretGroupPool.pop();
  if (group !== undefined) {
    group.playerId = playerId;
    group.turretCount = turretCount;
    group.writer.reset(estimatedBytes);
    group.count = 0;
    group.lastId = 0;
    return group;
  }
  return {
    playerId,
    turretCount,
    writer: new PackedBinaryWriter(estimatedBytes),
    count: 0,
    lastId: 0,
  };
}

function resetEntityPackScratch(): void {
  for (let i = 0; i < _movementGroupKeys.length; i++) {
    _movementGroupsByKey[_movementGroupKeys[i]] = undefined;
  }
  _movementGroupKeys.length = 0;
  for (let i = 0; i < _movementGroups.length; i++) {
    _movementGroupPool.push(_movementGroups[i]);
  }
  _movementGroups.length = 0;
  _movementRowCount = 0;

  for (let i = 0; i < _turretGroupKeys.length; i++) {
    _turretGroupsByKey[_turretGroupKeys[i]] = undefined;
  }
  _turretGroupKeys.length = 0;
  for (let i = 0; i < _turretGroups.length; i++) {
    _turretGroupPool.push(_turretGroups[i]);
  }
  _turretGroups.length = 0;
  _turretRowCount = 0;
}

function isMovementOnlyUnitDelta(entity: NetworkServerSnapshotEntity): boolean {
  if (entity.type !== 'unit' || entity.building !== null) return false;
  const changedFields = entity.changedFields;
  if (
    changedFields === null ||
    changedFields === 0 ||
    (changedFields & ~MOVEMENT_UNIT_CHANGED_FIELDS) !== 0
  ) {
    return false;
  }
  if (((changedFields & ENTITY_CHANGED_POS) !== 0) !== (entity.pos !== null)) return false;
  if (((changedFields & ENTITY_CHANGED_ROT) !== 0) !== (entity.rotation !== null)) return false;

  const unit = entity.unit;
  if (unit === null) return true;
  if (unit.hp !== null) return false;
  if (unit.unitBlueprintCode !== null) return false;
  if (unit.radius !== null) return false;
  if (unit.bodyCenterHeight !== null) return false;
  if (unit.mass !== null) return false;
  if (unit.surfaceNormal !== null) return false;
  if (unit.fireEnabled !== null) return false;
  if (unit.isCommander !== null) return false;
  if (unit.buildTargetIdPresent) return false;
  if (unit.actions !== null) return false;
  if (unit.turrets !== null) return false;
  if (unit.build !== null) return false;
  if (unit.velocity !== null && (changedFields & ENTITY_CHANGED_VEL) === 0) return false;
  if (unit.orientation !== null && (changedFields & ENTITY_CHANGED_ROT) === 0) return false;
  if (unit.angularVelocity3 !== null && (changedFields & ENTITY_CHANGED_VEL) === 0) return false;
  return true;
}

function isSplitUnitTurretDelta(entity: NetworkServerSnapshotEntity): boolean {
  if (entity.type !== 'unit' || entity.building !== null) return false;
  const changedFields = entity.changedFields;
  if (
    changedFields === null ||
    changedFields === 0 ||
    (changedFields & ENTITY_CHANGED_TURRETS) === 0 ||
    (changedFields & ~(MOVEMENT_UNIT_CHANGED_FIELDS | ENTITY_CHANGED_TURRETS)) !== 0
  ) {
    return false;
  }
  if (((changedFields & ENTITY_CHANGED_POS) !== 0) !== (entity.pos !== null)) return false;
  if (((changedFields & ENTITY_CHANGED_ROT) !== 0) !== (entity.rotation !== null)) return false;

  const unit = entity.unit;
  if (unit === null || unit.turrets === null) return false;
  if (unit.hp !== null) return false;
  if (unit.unitBlueprintCode !== null) return false;
  if (unit.radius !== null) return false;
  if (unit.bodyCenterHeight !== null) return false;
  if (unit.mass !== null) return false;
  if (unit.surfaceNormal !== null) return false;
  if (unit.fireEnabled !== null) return false;
  if (unit.isCommander !== null) return false;
  if (unit.buildTargetIdPresent) return false;
  if (unit.actions !== null) return false;
  if (unit.build !== null) return false;
  if (unit.velocity !== null && (changedFields & ENTITY_CHANGED_VEL) === 0) return false;
  if (unit.orientation !== null && (changedFields & ENTITY_CHANGED_ROT) === 0) return false;
  if (unit.angularVelocity3 !== null && (changedFields & ENTITY_CHANGED_VEL) === 0) return false;
  return true;
}

function hasMovementUnitDeltaFields(entity: NetworkServerSnapshotEntity): boolean {
  const unit = entity.unit;
  return (
    entity.pos !== null ||
    entity.rotation !== null ||
    (unit !== null && (
      unit.velocity !== null ||
      unit.orientation !== null ||
      unit.angularVelocity3 !== null
    ))
  );
}

function movementUnitDeltaFlags(entity: NetworkServerSnapshotEntity): number {
  let flags = 0;
  const pos = entity.pos;
  const unit = entity.unit;
  const velocity = unit === null ? null : unit.velocity;
  const orientation = unit === null ? null : unit.orientation;
  const angularVelocity = unit === null ? null : unit.angularVelocity3;
  if (pos !== null) flags |= MOVEMENT_UNIT_FLAG_POS;
  if (entity.rotation !== null) flags |= MOVEMENT_UNIT_FLAG_ROTATION;
  if (velocity !== null && velocity !== undefined) flags |= MOVEMENT_UNIT_FLAG_VELOCITY;
  if (orientation !== null && orientation !== undefined) {
    flags |= canCompactYawOrientation(entity, orientation)
      ? MOVEMENT_UNIT_FLAG_YAW_ORIENTATION
      : MOVEMENT_UNIT_FLAG_ORIENTATION;
  }
  if (angularVelocity !== null && angularVelocity !== undefined) {
    flags |= canCompactYawAngularVelocity(angularVelocity)
      ? MOVEMENT_UNIT_FLAG_YAW_ANGULAR_VELOCITY
      : MOVEMENT_UNIT_FLAG_ANGULAR_VELOCITY;
  }
  return flags;
}

function canCompactYawOrientation(
  entity: NetworkServerSnapshotEntity,
  orientation: NonNullable<UnitSub['orientation']>,
): boolean {
  return entity.rotation !== null &&
    orientation.x === 0 &&
    orientation.y === 0 &&
    Number.isFinite(orientation.z) &&
    Number.isFinite(orientation.w) &&
    Math.abs(orientation.z) <= 1.000001 &&
    Math.abs(orientation.w) <= 1.000001;
}

function canCompactYawAngularVelocity(
  angularVelocity: NonNullable<UnitSub['angularVelocity3']>,
): boolean {
  return angularVelocity.x === 0 && angularVelocity.y === 0;
}

function appendMovementUnitDeltaRow(
  entity: NetworkServerSnapshotEntity,
  estimatedRows: number,
): void {
  const flags = movementUnitDeltaFlags(entity);
  const playerId = entity.playerId;
  const key = flags * 0x100 + playerId;
  let group = _movementGroupsByKey[key];
  if (group === undefined) {
    group = rentMovementGroup(
      flags,
      playerId,
      Math.max(32, Math.ceil(estimatedRows / 4) * 18),
    );
    _movementGroupsByKey[key] = group;
    _movementGroupKeys.push(key);
    _movementGroups.push(group);
  }

  group.writer.writeVarInt(entity.id - group.lastId);
  group.lastId = entity.id;
  writeMovementUnitDeltaPayload(group.writer, flags, entity);
  group.count++;
  _movementRowCount++;
}

function finishMovementUnitDeltaRows(): Uint8Array | undefined {
  if (_movementRowCount === 0) return undefined;

  let estimatedBytes = PACKED_ENTITY_BINARY_HEADER_BYTES + 4;
  for (let i = 0; i < _movementGroups.length; i++) {
    estimatedBytes += _movementGroups[i].writer.byteLength + 8;
  }

  const out = new PackedBinaryWriter(estimatedBytes, PACKED_ENTITY_BINARY_HEADER_BYTES);
  out.writeVarUint(_movementGroups.length);
  for (let i = 0; i < _movementGroups.length; i++) {
    const group = _movementGroups[i];
    out.writeVarUint(group.flags);
    out.writeVarUint(group.playerId);
    out.writeVarUint(group.count);
    out.writeBytes(group.writer.finishBytes());
  }
  out.setUint32LE(0, _movementRowCount);
  return out.finishBytes();
}

function writeMovementUnitDeltaPayload(
  rows: PackedBinaryWriter,
  flags: number,
  entity: NetworkServerSnapshotEntity,
): void {
  const pos = entity.pos;
  const unit = entity.unit;
  const velocity = unit === null ? null : unit.velocity;
  const orientation = unit === null ? null : unit.orientation;
  const angularVelocity = unit === null ? null : unit.angularVelocity3;
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
  if ((flags & MOVEMENT_UNIT_FLAG_YAW_ANGULAR_VELOCITY) !== 0) {
    rows.writeFloat64(angularVelocity!.z);
  }
}

function appendUnitTurretDeltaRow(
  entity: NetworkServerSnapshotEntity,
  estimatedRows: number,
): void {
  const turrets = entity.unit!.turrets!;
  const playerId = entity.playerId;
  const turretCount = turrets.length;
  const key = playerId * 0x100 + turretCount;
  let group = _turretGroupsByKey[key];
  if (group === undefined) {
    group = rentTurretGroup(
      playerId,
      turretCount,
      Math.max(32, Math.ceil(estimatedRows / 4) * 18),
    );
    _turretGroupsByKey[key] = group;
    _turretGroupKeys.push(key);
    _turretGroups.push(group);
  }

  group.writer.writeVarInt(entity.id - group.lastId);
  group.lastId = entity.id;
  writeUnitTurretDeltaPayload(group.writer, turrets);
  group.count++;
  _turretRowCount++;
}

function finishUnitTurretDeltaRows(): Uint8Array | undefined {
  if (_turretRowCount === 0) return undefined;

  let estimatedBytes = PACKED_ENTITY_BINARY_HEADER_BYTES + 4;
  for (let i = 0; i < _turretGroups.length; i++) {
    estimatedBytes += _turretGroups[i].writer.byteLength + 8;
  }

  const out = new PackedBinaryWriter(estimatedBytes, PACKED_ENTITY_BINARY_HEADER_BYTES);
  out.writeVarUint(_turretGroups.length);
  for (let i = 0; i < _turretGroups.length; i++) {
    const group = _turretGroups[i];
    out.writeVarUint(group.playerId);
    out.writeVarUint(group.turretCount);
    out.writeVarUint(group.count);
    out.writeBytes(group.writer.finishBytes());
  }
  out.setUint32LE(0, _turretRowCount);
  return out.finishBytes();
}

function writeUnitTurretDeltaPayload(
  rows: PackedBinaryWriter,
  turrets: readonly NetworkServerSnapshotTurret[],
): void {
  for (let i = 0; i < turrets.length; i++) {
    const turret = turrets[i];
    const angular = turret.turret.angular;
    let flags = 0;
    if (turret.targetId !== null) flags |= TURRET_FLAG_TARGET_ID;
    if (turret.currentShieldRange !== null) flags |= TURRET_FLAG_SHIELD_RANGE;
    if (turret.active === false) flags |= TURRET_FLAG_INACTIVE;
    rows.writeVarUint(flags);
    rows.writeVarUint(turret.turret.turretBlueprintCode);
    rows.writeVarUint(turret.state);
    rows.writeVarInt(angular.rot);
    rows.writeVarInt(angular.vel);
    rows.writeVarInt(angular.pitch);
    rows.writeVarInt(angular.pitchVel);
    if ((flags & TURRET_FLAG_TARGET_ID) !== 0) rows.writeVarUint(turret.targetId!);
    if ((flags & TURRET_FLAG_SHIELD_RANGE) !== 0) {
      rows.writeFloat64(turret.currentShieldRange!);
    }
    // Legacy hpCurr slot is unconditional for wire compatibility — written
    // last after the conditional target/shield fields. Mirror in the matching
    // byte decoder readUnitTurretDeltaByteEntity.
    rows.writeFloat64(turret.hpCurr ?? 0);
  }
}

function movementUnitChangedFields(flags: number): number {
  let changedFields = 0;
  if ((flags & MOVEMENT_UNIT_FLAG_POS) !== 0) changedFields |= ENTITY_CHANGED_POS;
  if (
    (flags & (
      MOVEMENT_UNIT_FLAG_ROTATION |
      MOVEMENT_UNIT_FLAG_ORIENTATION |
      MOVEMENT_UNIT_FLAG_YAW_ORIENTATION
    )) !== 0
  ) {
    changedFields |= ENTITY_CHANGED_ROT;
  }
  if (
    (flags & (
      MOVEMENT_UNIT_FLAG_VELOCITY |
      MOVEMENT_UNIT_FLAG_ANGULAR_VELOCITY |
      MOVEMENT_UNIT_FLAG_YAW_ANGULAR_VELOCITY
    )) !== 0
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
  if ((flags & MOVEMENT_UNIT_FLAG_YAW_ANGULAR_VELOCITY) !== 0) width += 1;
  return width;
}

function countMovementUnitDeltaRows(
  rows: PackedMovementUnitRows | PackedMovementUnitBytes | undefined,
): number {
  if (rows === undefined) return 0;
  if (rows instanceof Uint8Array) return readPackedBinaryRowCount(rows);
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
    // 7 fixed (flags, blueprintCode, state, rot, vel, pitch, pitchVel)
    // + 1 unconditional trailing hpCurr.
    width += 8;
    if ((flags & TURRET_FLAG_TARGET_ID) !== 0) width += 1;
    if ((flags & TURRET_FLAG_SHIELD_RANGE) !== 0) width += 1;
  }
  return width;
}

function countUnitTurretDeltaRows(
  rows: PackedUnitTurretRows | PackedUnitTurretBytes | undefined,
): number {
  if (rows === undefined) return 0;
  if (rows instanceof Uint8Array) return readPackedBinaryRowCount(rows);
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
    if (version === PACKED_ENTITIES_V5_VERSION || version === PACKED_ENTITIES_VERSION) {
      return unpackMovementUnitDeltaGroupedBytes(rows, out, outIndex);
    }
    return unpackMovementUnitDeltaBytes(rows, out, outIndex);
  }

  let i = 0;
  while (i < rows.length) {
    const flags = rows[i++] as number;
    const id = rows[i++] as number;
    const playerId = rows[i++] as PlayerId;
    const entity = rentDecodedEntity();
    entity.id = id;
    entity.type = 'unit';
    entity.playerId = playerId;
    entity.changedFields = movementUnitChangedFields(flags);
    if ((flags & MOVEMENT_UNIT_FLAG_POS) !== 0) {
      entity.pos = rentDecodedVec3(rows[i++] as number, rows[i++] as number, rows[i++] as number);
    }
    if ((flags & MOVEMENT_UNIT_FLAG_ROTATION) !== 0) {
      entity.rotation = rows[i++] as number;
    }
    if (
      (flags & (
        MOVEMENT_UNIT_FLAG_VELOCITY |
        MOVEMENT_UNIT_FLAG_ORIENTATION |
        MOVEMENT_UNIT_FLAG_ANGULAR_VELOCITY |
        MOVEMENT_UNIT_FLAG_YAW_ORIENTATION |
        MOVEMENT_UNIT_FLAG_YAW_ANGULAR_VELOCITY
      )) !== 0
    ) {
      const unit = rentDecodedUnitSub();
      if ((flags & MOVEMENT_UNIT_FLAG_VELOCITY) !== 0) {
        unit.velocity = rentDecodedVec3(rows[i++] as number, rows[i++] as number, rows[i++] as number);
      }
      if ((flags & MOVEMENT_UNIT_FLAG_ORIENTATION) !== 0) {
        unit.orientation = rentDecodedQuat(
          rows[i++] as number,
          rows[i++] as number,
          rows[i++] as number,
          rows[i++] as number,
        );
      }
      if ((flags & MOVEMENT_UNIT_FLAG_YAW_ORIENTATION) !== 0) {
        const orientation = rentDecodedQuat(0, 0, 0, 1);
        setQuatFromYaw(orientation, deqRot(entity.rotation ?? 0));
        unit.orientation = orientation;
      }
      if ((flags & MOVEMENT_UNIT_FLAG_ANGULAR_VELOCITY) !== 0) {
        unit.angularVelocity3 = rentDecodedVec3(rows[i++] as number, rows[i++] as number, rows[i++] as number);
      }
      if ((flags & MOVEMENT_UNIT_FLAG_YAW_ANGULAR_VELOCITY) !== 0) {
        unit.angularVelocity3 = rentDecodedVec3(0, 0, rows[i++] as number);
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
  const reader = new PackedBinaryReader(rows);
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
  const reader = new PackedBinaryReader(rows);
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
  reader: PackedBinaryReader,
  flags: number,
  id: number,
  playerId: PlayerId,
): NetworkServerSnapshotEntity {
  const entity = rentDecodedEntity();
  entity.id = id;
  entity.type = 'unit';
  entity.playerId = playerId;
  entity.changedFields = movementUnitChangedFields(flags);
  if ((flags & MOVEMENT_UNIT_FLAG_POS) !== 0) {
    entity.pos = rentDecodedVec3(reader.readVarInt(), reader.readVarInt(), reader.readVarInt());
  }
  if ((flags & MOVEMENT_UNIT_FLAG_ROTATION) !== 0) {
    entity.rotation = reader.readVarInt();
  }
  if (
    (flags & (
      MOVEMENT_UNIT_FLAG_VELOCITY |
      MOVEMENT_UNIT_FLAG_ORIENTATION |
      MOVEMENT_UNIT_FLAG_ANGULAR_VELOCITY |
      MOVEMENT_UNIT_FLAG_YAW_ORIENTATION |
      MOVEMENT_UNIT_FLAG_YAW_ANGULAR_VELOCITY
    )) !== 0
  ) {
    const unit = rentDecodedUnitSub();
    if ((flags & MOVEMENT_UNIT_FLAG_VELOCITY) !== 0) {
      unit.velocity = rentDecodedVec3(reader.readVarInt(), reader.readVarInt(), reader.readVarInt());
    }
    if ((flags & MOVEMENT_UNIT_FLAG_ORIENTATION) !== 0) {
      unit.orientation = rentDecodedQuat(
        reader.readFloat64(),
        reader.readFloat64(),
        reader.readFloat64(),
        reader.readFloat64(),
      );
    }
    if ((flags & MOVEMENT_UNIT_FLAG_YAW_ORIENTATION) !== 0) {
      const orientation = rentDecodedQuat(0, 0, 0, 1);
      setQuatFromYaw(orientation, deqRot(entity.rotation ?? 0));
      unit.orientation = orientation;
    }
    if ((flags & MOVEMENT_UNIT_FLAG_ANGULAR_VELOCITY) !== 0) {
      unit.angularVelocity3 = rentDecodedVec3(
        reader.readFloat64(),
        reader.readFloat64(),
        reader.readFloat64(),
      );
    }
    if ((flags & MOVEMENT_UNIT_FLAG_YAW_ANGULAR_VELOCITY) !== 0) {
      unit.angularVelocity3 = rentDecodedVec3(0, 0, reader.readFloat64());
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
    if (version === PACKED_ENTITIES_V5_VERSION || version === PACKED_ENTITIES_VERSION) {
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
      const turretBlueprintCode = rows[i++] as NetworkServerSnapshotTurret['turret']['turretBlueprintCode'];
      const state = rows[i++] as NetworkServerSnapshotTurret['state'];
      const angular: TurretAngular = {
        rot: rows[i++] as number,
        vel: rows[i++] as number,
        pitch: rows[i++] as number,
        pitchVel: rows[i++] as number,
      };
      const turret: NetworkServerSnapshotTurret = {
        turret: { turretBlueprintCode, angular },
        state,
        targetId: null,
        active: null,
        currentShieldRange: null,
        hpCurr: null,
      };
      if ((flags & TURRET_FLAG_TARGET_ID) !== 0) turret.targetId = rows[i++] as number;
      if ((flags & TURRET_FLAG_INACTIVE) !== 0) turret.active = false;
      if ((flags & TURRET_FLAG_SHIELD_RANGE) !== 0) {
        turret.currentShieldRange = rows[i++] as number;
      }
    // Legacy hpCurr slot is unconditional — last element in the row.
      turret.hpCurr = rows[i++] as number;
      turrets[turretIndex] = turret;
    }
    out[outIndex++] = {
      id,
      type: 'unit',
      playerId,
      changedFields: ENTITY_CHANGED_TURRETS,
      pos: null,
      rotation: null,
      unit: {
        ...createEmptyUnitSub(),
        turrets,
      },
      building: null,
    };
  }
  return outIndex;
}

function unpackUnitTurretDeltaBytes(
  rows: PackedUnitTurretBytes,
  out: NetworkServerSnapshotEntity[],
  outIndex: number,
): number {
  const reader = new PackedBinaryReader(rows);
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
  const reader = new PackedBinaryReader(rows);
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
  reader: PackedBinaryReader,
  id: number,
  playerId: PlayerId,
  turretCount: number,
): NetworkServerSnapshotEntity {
  const turrets: NetworkServerSnapshotTurret[] = new Array(turretCount);
  for (let turretIndex = 0; turretIndex < turretCount; turretIndex++) {
    const flags = reader.readVarUint();
    const turretBlueprintCode = reader.readVarUint() as NetworkServerSnapshotTurret['turret']['turretBlueprintCode'];
    const state = reader.readVarUint() as NetworkServerSnapshotTurret['state'];
    const angular: TurretAngular = {
      rot: reader.readVarInt(),
      vel: reader.readVarInt(),
      pitch: reader.readVarInt(),
      pitchVel: reader.readVarInt(),
    };
    const turret: NetworkServerSnapshotTurret = {
      turret: { turretBlueprintCode, angular },
      state,
      targetId: null,
      active: null,
      currentShieldRange: null,
      hpCurr: null,
    };
    if ((flags & TURRET_FLAG_TARGET_ID) !== 0) turret.targetId = reader.readVarUint();
    if ((flags & TURRET_FLAG_INACTIVE) !== 0) turret.active = false;
    if ((flags & TURRET_FLAG_SHIELD_RANGE) !== 0) {
      turret.currentShieldRange = reader.readFloat64();
    }
    // Legacy hpCurr slot is unconditional — read last, mirroring the byte
    // encoders writeUnitTurretDeltaPayload (JS) and v6_write_turret_payload (Rust).
    turret.hpCurr = reader.readFloat64();
    turrets[turretIndex] = turret;
  }
  return {
    id,
    type: 'unit',
    playerId,
    changedFields: ENTITY_CHANGED_TURRETS,
    pos: null,
    rotation: null,
    unit: {
      ...createEmptyUnitSub(),
      turrets,
    },
    building: null,
  };
}

function packUnit(unit: UnitSub): unknown[] {
  let flags = 0;
  if (unit.hp !== null) flags |= UNIT_FLAG_HP;
  if (unit.velocity !== null) flags |= UNIT_FLAG_VELOCITY;
  if (unit.unitBlueprintCode !== null) flags |= UNIT_FLAG_BLUEPRINT_CODE;
  if (unit.radius !== null) flags |= UNIT_FLAG_RADIUS;
  if (unit.bodyCenterHeight !== null) flags |= UNIT_FLAG_BODY_CENTER_HEIGHT;
  if (unit.mass !== null) flags |= UNIT_FLAG_MASS;
  if (unit.surfaceNormal !== null) flags |= UNIT_FLAG_SURFACE_NORMAL;
  if (unit.orientation !== null) flags |= UNIT_FLAG_ORIENTATION;
  if (unit.angularVelocity3 !== null) flags |= UNIT_FLAG_ANGULAR_VELOCITY;
  if (unit.fireEnabled === false) flags |= UNIT_FLAG_FIRE_DISABLED;
  if (unit.isCommander === true) flags |= UNIT_FLAG_IS_COMMANDER;
  if (unit.buildTargetIdPresent) {
    flags |= UNIT_FLAG_BUILD_TARGET_ID;
    if (unit.buildTargetId === null) flags |= UNIT_FLAG_BUILD_TARGET_NULL;
  }
  if (unit.actions !== null) flags |= UNIT_FLAG_ACTIONS;
  if (unit.turrets !== null) flags |= UNIT_FLAG_TURRETS;
  if (unit.build !== null) {
    flags |= UNIT_FLAG_BUILD;
    if (unit.build.complete === true) flags |= UNIT_FLAG_BUILD_COMPLETE;
    if (unit.build.interrupted === true) flags |= UNIT_FLAG_BUILD_INTERRUPTED;
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
  if ((flags & UNIT_FLAG_BLUEPRINT_CODE) !== 0) row.push(unit.unitBlueprintCode!);
  if ((flags & UNIT_FLAG_RADIUS) !== 0) {
    const r = unit.radius!;
    row.push(r.visual ?? 0, r.hitbox ?? 0, r.collision ?? 0);
  }
  if ((flags & UNIT_FLAG_BODY_CENTER_HEIGHT) !== 0) row.push(unit.bodyCenterHeight!);
  if ((flags & UNIT_FLAG_MASS) !== 0) row.push(unit.mass!);
  if ((flags & UNIT_FLAG_SURFACE_NORMAL) !== 0) {
    const sn = unit.surfaceNormal!;
    row.push(sn.nx, sn.ny, sn.nz);
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
  const unit = createEmptyUnitSub();
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
  if ((flags & UNIT_FLAG_BLUEPRINT_CODE) !== 0) {
    unit.unitBlueprintCode = row[i++] as number;
  }
  if ((flags & UNIT_FLAG_RADIUS) !== 0) {
    const visual = row[i++] as number;
    const hitbox = row[i++] as number;
    const collision = row[i++] as number;
    unit.radius = { visual, hitbox, collision };
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
  if ((flags & UNIT_FLAG_RETIRED_SUSPENSION) !== 0) i += 6;
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
    unit.buildTargetIdPresent = true;
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
      interrupted: (flags & UNIT_FLAG_BUILD_INTERRUPTED) !== 0,
      paid: { energy, metal },
    };
  }
  return unit;
}

function packBuilding(building: BuildingSub): unknown[] {
  let flags = 0;
  if (building.buildingBlueprintCode !== null) flags |= BUILDING_FLAG_BLUEPRINT_CODE;
  if (building.dim !== null) flags |= BUILDING_FLAG_DIM;
  if (building.hp !== null) flags |= BUILDING_FLAG_HP;
  if (building.build !== null) {
    flags |= BUILDING_FLAG_BUILD;
    if (building.build.complete === true) flags |= BUILDING_FLAG_BUILD_COMPLETE;
    if (building.build.interrupted === true) flags |= BUILDING_FLAG_BUILD_INTERRUPTED;
  }
  if (building.metalExtractionRate !== null) flags |= BUILDING_FLAG_METAL_EXTRACTION_RATE;
  if (building.solar !== null) {
    flags |= BUILDING_FLAG_SOLAR;
    if (building.solar.open === true) flags |= BUILDING_FLAG_SOLAR_OPEN;
  }
  if (building.turrets !== null) flags |= BUILDING_FLAG_TURRETS;
  if (building.factory !== null) {
    flags |= BUILDING_FLAG_FACTORY;
    if (building.factory.producing === true) flags |= BUILDING_FLAG_FACTORY_PRODUCING;
  }

  const row: unknown[] = [flags];
  if ((flags & BUILDING_FLAG_BLUEPRINT_CODE) !== 0) row.push(building.buildingBlueprintCode!);
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
  const building = createEmptyBuildingSub();
  if ((flags & BUILDING_FLAG_BLUEPRINT_CODE) !== 0) {
    building.buildingBlueprintCode = row[i++] as number;
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
      interrupted: (flags & BUILDING_FLAG_BUILD_INTERRUPTED) !== 0,
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
  if (action.pos !== null) flags |= ACTION_FLAG_POS;
  if (action.posZ !== null) flags |= ACTION_FLAG_POS_Z;
  if (action.pathExp === true) flags |= ACTION_FLAG_PATH_EXP;
  if (action.targetId !== null) flags |= ACTION_FLAG_TARGET_ID;
  if (action.buildingBlueprintId !== null) flags |= ACTION_FLAG_BUILDING_BLUEPRINT_ID;
  if (action.grid !== null) flags |= ACTION_FLAG_GRID;
  if (action.buildingId !== null) flags |= ACTION_FLAG_BUILDING_ID;

  const row: unknown[] = [flags, action.type];
  if ((flags & ACTION_FLAG_POS) !== 0) {
    const pos = action.pos!;
    row.push(pos.x, pos.y);
  }
  if ((flags & ACTION_FLAG_POS_Z) !== 0) row.push(action.posZ!);
  if ((flags & ACTION_FLAG_TARGET_ID) !== 0) row.push(action.targetId!);
  if ((flags & ACTION_FLAG_BUILDING_BLUEPRINT_ID) !== 0) row.push(action.buildingBlueprintId!);
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
  const action: NetworkServerSnapshotAction = {
    type,
    pos: null,
    posZ: null,
    pathExp: null,
    targetId: null,
    buildingBlueprintId: null,
    grid: null,
    buildingId: null,
  };
  if ((flags & ACTION_FLAG_POS) !== 0) {
    const x = row[i++] as number;
    const y = row[i++] as number;
    action.pos = { x, y };
  }
  if ((flags & ACTION_FLAG_POS_Z) !== 0) action.posZ = row[i++] as number;
  if ((flags & ACTION_FLAG_PATH_EXP) !== 0) action.pathExp = true;
  if ((flags & ACTION_FLAG_TARGET_ID) !== 0) action.targetId = row[i++] as number;
  if ((flags & ACTION_FLAG_BUILDING_BLUEPRINT_ID) !== 0) action.buildingBlueprintId = row[i++] as string;
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
  if (t.targetId !== null) flags |= TURRET_FLAG_TARGET_ID;
  if (t.currentShieldRange !== null) flags |= TURRET_FLAG_SHIELD_RANGE;
  if (t.active === false) flags |= TURRET_FLAG_INACTIVE;

  const angular = t.turret.angular;
  const row: unknown[] = [
    flags,
    t.turret.turretBlueprintCode,
    t.state,
    angular.rot,
    angular.vel,
    angular.pitch,
    angular.pitchVel,
  ];
  if ((flags & TURRET_FLAG_TARGET_ID) !== 0) row.push(t.targetId!);
  if ((flags & TURRET_FLAG_SHIELD_RANGE) !== 0) row.push(t.currentShieldRange!);
  // Legacy hpCurr slot is unconditional — appended last after the conditional fields.
  row.push(t.hpCurr ?? 0);
  return row;
}

function unpackTurret(row: unknown[]): NetworkServerSnapshotTurret {
  const flags = row[0] as number;
  const turretBlueprintCode = row[1] as NetworkServerSnapshotTurret['turret']['turretBlueprintCode'];
  const state = row[2] as NetworkServerSnapshotTurret['state'];
  const angular: TurretAngular = {
    rot: row[3] as number,
    vel: row[4] as number,
    pitch: row[5] as number,
    pitchVel: row[6] as number,
  };
  let i = 7;
  const turret: NetworkServerSnapshotTurret = {
    turret: { turretBlueprintCode, angular },
    state,
    targetId: null,
    active: null,
    currentShieldRange: null,
    hpCurr: null,
  };
  if ((flags & TURRET_FLAG_TARGET_ID) !== 0) turret.targetId = row[i++] as number;
  if ((flags & TURRET_FLAG_INACTIVE) !== 0) turret.active = false;
  if ((flags & TURRET_FLAG_SHIELD_RANGE) !== 0) {
    turret.currentShieldRange = row[i++] as number;
  }
    // Legacy hpCurr slot is unconditional — last element after the conditional fields.
  turret.hpCurr = row[i++] as number;
  return turret;
}

function packFactory(factory: FactorySub): unknown[] {
  return [
    factory.selectedUnitBlueprintCode,
    factory.progress,
    factory.energyRate,
    factory.metalRate,
    packWaypoint(factory.rally),
  ];
}

function unpackFactory(row: unknown[], producing: boolean): FactorySub {
  const selectedUnitBlueprintCode = row[0] as number | null;
  const progress = row[1] as number;
  const energyRate = row[2] as number;
  const metalRate = row[3] as number;
  const rally = unpackWaypoint(row[4] as unknown[]);
  return { selectedUnitBlueprintCode, progress, producing, energyRate, metalRate, rally };
}

function packWaypoint(waypoint: WaypointSub): unknown[] {
  let flags = 0;
  if (waypoint.posZ !== null) flags |= WAYPOINT_FLAG_POS_Z;
  const row: unknown[] = [flags, waypoint.pos.x, waypoint.pos.y, waypoint.type];
  if ((flags & WAYPOINT_FLAG_POS_Z) !== 0) row.push(waypoint.posZ!);
  return row;
}

function unpackWaypoint(row: unknown[]): WaypointSub {
  const flags = row[0] as number;
  const waypoint: WaypointSub = {
    pos: { x: row[1] as number, y: row[2] as number },
    posZ: null,
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
