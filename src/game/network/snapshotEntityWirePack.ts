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
  NetworkServerSnapshotAction,
  NetworkServerSnapshotEntity,
  NetworkServerSnapshotTurret,
} from './NetworkTypes';
import {
  PackedBinaryReader,
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
    fireState: null,
    trajectoryMode: null,
    repeatQueue: null,
    moveState: null,
    holdPosition: null,
    wantCloak: null,
    cloaked: null,
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
// and the async buffering paths (LocalGameConnection wire loopback,
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
    u.fireState = null;
    u.trajectoryMode = null;
    u.repeatQueue = null;
    u.moveState = null;
    u.holdPosition = null;
    u.wantCloak = null;
    u.cloaked = null;
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

const PACKED_ENTITIES_VERSION = 11;

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
const UNIT_FLAG_CLOAK_STATE_PRESENT = 1 << 8;
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
const UNIT_FLAG_REPEAT_PRESENT = 1 << 20;
const UNIT_FLAG_REPEAT_ENABLED = 1 << 21;
const UNIT_FLAG_HOLD_POSITION_PRESENT = 1 << 22;
const UNIT_FLAG_HOLD_POSITION_ENABLED = 1 << 23;
const UNIT_FLAG_TRAJECTORY_PRESENT = 1 << 24;
const UNIT_FLAG_TRAJECTORY_HIGH = 1 << 25;
const UNIT_FLAG_TRAJECTORY_AUTO = 1 << 26;
const UNIT_FLAG_MOVE_STATE_PRESENT = 1 << 27;
const UNIT_FLAG_MOVE_STATE_HOLD = 1 << 28;
const UNIT_FLAG_MOVE_STATE_ROAM = 1 << 29;
const UNIT_FLAG_FIRE_STATE_PRESENT = 1 << 30;

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

const ACTION_FLAG_POS = 1 << 0;
const ACTION_FLAG_POS_Z = 1 << 1;
const ACTION_FLAG_PATH_EXP = 1 << 2;
const ACTION_FLAG_TARGET_ID = 1 << 3;
const ACTION_FLAG_BUILDING_BLUEPRINT_ID = 1 << 4;
const ACTION_FLAG_GRID = 1 << 5;
const ACTION_FLAG_BUILDING_ID = 1 << 6;
const ACTION_FLAG_WAIT_GATHER = 1 << 7;
const ACTION_FLAG_WAIT_GROUP_ID = 1 << 8;

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
// one. V7 adds a detail-row unit repeat command-state bit pair. V8 adds
// the unit hold-position command-state bit pair. V9 adds unit trajectory
// mode. V10 adds factory guard target ids to the detail-row factory
// sub-object. V11 adds finite factory production queues.
export type PackedEntityRow = unknown[];
export type PackedMovementUnitBytes = Uint8Array;
export type PackedUnitTurretBytes = Uint8Array;

export type PackedEntitySnapshotWire = {
  v: typeof PACKED_ENTITIES_VERSION;
  m: PackedMovementUnitBytes | undefined;
  t: PackedUnitTurretBytes | undefined;
  e: PackedEntityRow[] | undefined;
};

export function unpackEntitiesFromWire(
  packed: PackedEntitySnapshotWire,
): NetworkServerSnapshotEntity[] {
  resetDecodePools();
  const movementRows = packed.m;
  const turretRows = packed.t;
  const detailRows = packed.e;
  const movementCount = countMovementUnitDeltaRows(movementRows);
  const turretCount = countUnitTurretDeltaRows(turretRows);
  const detailCount = detailRows === undefined ? 0 : detailRows.length;
  const out: NetworkServerSnapshotEntity[] = new Array(movementCount + turretCount + detailCount);
  let outIndex = 0;
  if (movementRows !== undefined) {
    outIndex = unpackMovementUnitDeltaRows(movementRows, out, outIndex);
  }
  if (turretRows !== undefined) {
    outIndex = unpackUnitTurretDeltaRows(turretRows, out, outIndex);
  }
  if (detailRows !== undefined) {
    for (let i = 0; i < detailRows.length; i++) {
      out[outIndex++] = unpackDetailEntityRow(detailRows[i]);
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
  if (candidate.v !== PACKED_ENTITIES_VERSION) return false;
  return (
    (candidate.m === undefined || candidate.m instanceof Uint8Array) &&
    (candidate.t === undefined || candidate.t instanceof Uint8Array) &&
    (candidate.e === undefined || Array.isArray(candidate.e))
  );
}

export function isPackedEntitiesField(value: unknown): value is PackedEntitySnapshotWire {
  return isPackedEntitySnapshotWire(value);
}

function unpackDetailEntityRow(row: PackedEntityRow): NetworkServerSnapshotEntity {
  let i = 0;
  const flags = row[i++] as number;
  const id = row[i++] as number;
  const playerId = row[i++] as PlayerId;
  const entity = rentDecodedEntity();
  entity.id = id;
  entity.type = (flags & ENTITY_FLAG_TYPE_BUILDING) !== 0 ? 'building' : 'unit';
  entity.playerId = playerId;
  entity.changedFields = null;
  if ((flags & ENTITY_FLAG_HAS_POS) !== 0) {
    const x = row[i++] as number;
    const y = row[i++] as number;
    const z = row[i++] as number;
    entity.pos = rentDecodedVec3(x, y, z);
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

function countMovementUnitDeltaRows(
  rows: PackedMovementUnitBytes | undefined,
): number {
  if (rows === undefined) return 0;
  return readPackedBinaryRowCount(rows);
}

function countUnitTurretDeltaRows(
  rows: PackedUnitTurretBytes | undefined,
): number {
  if (rows === undefined) return 0;
  return readPackedBinaryRowCount(rows);
}

function unpackMovementUnitDeltaRows(
  rows: PackedMovementUnitBytes,
  out: NetworkServerSnapshotEntity[],
  outIndex: number,
): number {
  return unpackMovementUnitDeltaGroupedBytes(rows, out, outIndex);
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
  rows: PackedUnitTurretBytes,
  out: NetworkServerSnapshotEntity[],
  outIndex: number,
): number {
  return unpackUnitTurretDeltaGroupedBytes(rows, out, outIndex);
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
    };
    if ((flags & TURRET_FLAG_TARGET_ID) !== 0) turret.targetId = reader.readVarUint();
    if ((flags & TURRET_FLAG_INACTIVE) !== 0) turret.active = false;
    if ((flags & TURRET_FLAG_SHIELD_RANGE) !== 0) {
      turret.currentShieldRange = reader.readFloat64();
    }
    turrets[turretIndex] = turret;
  }
  const entity = rentDecodedEntity();
  entity.id = id;
  entity.type = 'unit';
  entity.playerId = playerId;
  entity.changedFields = ENTITY_CHANGED_TURRETS;
  const unit = rentDecodedUnitSub();
  unit.turrets = turrets;
  entity.unit = unit;
  return entity;
}

function unpackUnit(row: unknown[]): UnitSub {
  let i = 0;
  const flags = row[i++] as number;
  const unit = rentDecodedUnitSub();
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
  if ((flags & UNIT_FLAG_FIRE_STATE_PRESENT) !== 0) {
    const code = row[i++] as number;
    unit.fireState = code === 2 ? 'holdFire' : code === 1 ? 'returnFire' : 'fireAtWill';
  }
  if ((flags & UNIT_FLAG_CLOAK_STATE_PRESENT) !== 0) {
    const code = row[i++] as number;
    unit.wantCloak = code >= 1;
    unit.cloaked = code >= 2;
  }
  if ((flags & UNIT_FLAG_TRAJECTORY_PRESENT) !== 0) {
    unit.trajectoryMode = (flags & UNIT_FLAG_TRAJECTORY_AUTO) !== 0
      ? 'auto'
      : (flags & UNIT_FLAG_TRAJECTORY_HIGH) !== 0 ? 'high' : 'low';
  }
  if ((flags & UNIT_FLAG_REPEAT_PRESENT) !== 0) {
    unit.repeatQueue = (flags & UNIT_FLAG_REPEAT_ENABLED) !== 0;
  }
  if ((flags & UNIT_FLAG_HOLD_POSITION_PRESENT) !== 0) {
    unit.holdPosition = (flags & UNIT_FLAG_HOLD_POSITION_ENABLED) !== 0;
  }
  if ((flags & UNIT_FLAG_MOVE_STATE_PRESENT) !== 0) {
    unit.moveState = (flags & UNIT_FLAG_MOVE_STATE_HOLD) !== 0
      ? 'holdPosition'
      : (flags & UNIT_FLAG_MOVE_STATE_ROAM) !== 0 ? 'roam' : 'maneuver';
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

function unpackActions(rows: unknown[]): NetworkServerSnapshotAction[] {
  const out: NetworkServerSnapshotAction[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    out[i] = unpackAction(rows[i] as unknown[]);
  }
  return out;
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
    waitGather: null,
    waitGroupId: null,
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
  if ((flags & ACTION_FLAG_WAIT_GATHER) !== 0) action.waitGather = true;
  if ((flags & ACTION_FLAG_WAIT_GROUP_ID) !== 0) action.waitGroupId = row[i++] as number;
  return action;
}

function unpackTurrets(rows: unknown[]): NetworkServerSnapshotTurret[] {
  const out: NetworkServerSnapshotTurret[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    out[i] = unpackTurret(rows[i] as unknown[]);
  }
  return out;
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
  };
  if ((flags & TURRET_FLAG_TARGET_ID) !== 0) turret.targetId = row[i++] as number;
  if ((flags & TURRET_FLAG_INACTIVE) !== 0) turret.active = false;
  if ((flags & TURRET_FLAG_SHIELD_RANGE) !== 0) {
    turret.currentShieldRange = row[i++] as number;
  }
  return turret;
}

function unpackFactory(row: unknown[], producing: boolean): FactorySub {
  const selectedUnitBlueprintCode = row[0] as number | null;
  const progress = row[1] as number;
  const energyRate = row[2] as number;
  const metalRate = row[3] as number;
  const rally = unpackWaypoint(row[4] as unknown[]);
  const routeRow = row[5] as unknown[] | null | undefined;
  const route = routeRow !== null && routeRow !== undefined
    ? unpackWaypointRoute(routeRow)
    : null;
  const guardTargetId = row.length > 6 ? row[6] as number | null : null;
  const repeat = row.length > 7 ? row[7] !== 0 : true;
  const queue = row.length > 8 ? row[8] as number[] | null : null;
  return { selectedUnitBlueprintCode, progress, producing, repeat, queue, energyRate, metalRate, guardTargetId, rally, route };
}

function unpackWaypointRoute(rows: unknown[]): WaypointSub[] {
  const out: WaypointSub[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    out[i] = unpackWaypoint(rows[i] as unknown[]);
  }
  return out;
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
