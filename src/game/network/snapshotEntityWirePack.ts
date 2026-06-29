import type { PlayerId } from '../../types/sim';
import {
  ENTITY_CHANGED_ACTIONS,
  ENTITY_CHANGED_BUILDING,
  ENTITY_CHANGED_HP,
  ENTITY_CHANGED_NORMAL,
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
import {
  ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE,
  ENTITY_SNAPSHOT_WIRE_ACTION_STRIDE,
  ENTITY_SNAPSHOT_WIRE_KIND_BUILDING,
  ENTITY_SNAPSHOT_WIRE_KIND_UNIT,
  ENTITY_SNAPSHOT_WIRE_TURRET_STRIDE,
  ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE,
  appendEntitySnapshotWireSourceRow,
  createEntitySnapshotWireSource,
  recordEntitySnapshotWireSourceChangedFields,
  registerEntitySnapshotWireSource,
} from './stateSerializerEntities';
import { reserveFloat64WireRows } from './snapshotWireRows';

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
// and the async buffering paths (LocalGameConnection wire loopback and
// the snapshot-impairment delay queue)
// clone the snapshot into owned objects before holding it. So pooled
// objects are dead by the next decode.
type DecodedVec3 = { x: number; y: number; z: number };
type DecodedHp = { curr: number; max: number };
type DecodedNormal = { nx: number; ny: number; nz: number };
type DecodedQuat = { x: number; y: number; z: number; w: number };

const _entityPool: NetworkServerSnapshotEntity[] = [];
let _entityPoolIndex = 0;
const _unitSubPool: UnitSub[] = [];
let _unitSubPoolIndex = 0;
const _buildingSubPool: BuildingSub[] = [];
let _buildingSubPoolIndex = 0;
const _vec3Pool: DecodedVec3[] = [];
let _vec3PoolIndex = 0;
const _hpPool: DecodedHp[] = [];
let _hpPoolIndex = 0;
const _normalPool: DecodedNormal[] = [];
let _normalPoolIndex = 0;
const _quatPool: DecodedQuat[] = [];
let _quatPoolIndex = 0;
const _scratchDecodedQuat: DecodedQuat = { x: 0, y: 0, z: 0, w: 1 };
const _decodedEntityWireSource = createEntitySnapshotWireSource();
let _decodedEntityWireSourceHasTypedRows = false;

function resetDecodePools(): void {
  _entityPoolIndex = 0;
  _unitSubPoolIndex = 0;
  _buildingSubPoolIndex = 0;
  _vec3PoolIndex = 0;
  _hpPoolIndex = 0;
  _normalPoolIndex = 0;
  _quatPoolIndex = 0;
}

function resetDecodedEntityWireSource(): void {
  _decodedEntityWireSource.count = 0;
  _decodedEntityWireSource.typedPlaceholderRows = 0;
  _decodedEntityWireSource.nonPlaceholderEntityRows = 0;
  _decodedEntityWireSource.typedEntityRows = 0;
  _decodedEntityWireSource.rawEntityRows = 0;
  _decodedEntityWireSource.basicChangedFieldsOr = 0;
  _decodedEntityWireSource.unitChangedFieldsOr = 0;
  _decodedEntityWireSource.buildingChangedFieldsOr = 0;
  _decodedEntityWireSource.basicRows.count = 0;
  _decodedEntityWireSource.unitRows.count = 0;
  _decodedEntityWireSource.buildingRows.count = 0;
  _decodedEntityWireSource.actionRows.count = 0;
  _decodedEntityWireSource.actionStrings.length = 0;
  _decodedEntityWireSource.turretRows.count = 0;
  _decodedEntityWireSource.factorySelectedUnitRows.count = 0;
  _decodedEntityWireSource.waypointRows.count = 0;
  _decodedEntityWireSource.waypointStrings.length = 0;
  _decodedEntityWireSourceHasTypedRows = false;
}

function appendDecodedFallbackEntityWireSourceRow(): void {
  appendEntitySnapshotWireSourceRow(_decodedEntityWireSource, 0, -1);
}

function appendDecodedUnitEntityWireRow(): { values: Float64Array; base: number } {
  const rowIndex = reserveFloat64WireRows(
    _decodedEntityWireSource.unitRows,
    1,
    ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE,
  );
  const values = _decodedEntityWireSource.unitRows.values;
  const base = rowIndex * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
  values.fill(0, base, base + ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE);
  appendEntitySnapshotWireSourceRow(
    _decodedEntityWireSource,
    ENTITY_SNAPSHOT_WIRE_KIND_UNIT,
    rowIndex,
    true,
  );
  _decodedEntityWireSourceHasTypedRows = true;
  return { values, base };
}

function appendDecodedBuildingEntityWireRow(): { values: Float64Array; base: number } {
  const rowIndex = reserveFloat64WireRows(
    _decodedEntityWireSource.buildingRows,
    1,
    ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE,
  );
  const values = _decodedEntityWireSource.buildingRows.values;
  const base = rowIndex * ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE;
  values.fill(0, base, base + ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE);
  appendEntitySnapshotWireSourceRow(
    _decodedEntityWireSource,
    ENTITY_SNAPSHOT_WIRE_KIND_BUILDING,
    rowIndex,
    true,
  );
  _decodedEntityWireSourceHasTypedRows = true;
  return { values, base };
}

function appendDecodedActionWireRows(
  actions: readonly NetworkServerSnapshotAction[] | null,
): { offset: number; count: number } {
  const count = actions?.length ?? 0;
  if (count === 0) return { offset: -1, count: 0 };
  const offset = reserveFloat64WireRows(
    _decodedEntityWireSource.actionRows,
    count,
    ENTITY_SNAPSHOT_WIRE_ACTION_STRIDE,
  );
  const values = _decodedEntityWireSource.actionRows.values;
  const strings = _decodedEntityWireSource.actionStrings;
  for (let i = 0; i < count; i++) {
    const action = actions![i];
    const pos = action.pos;
    const grid = action.grid;
    const base = (offset + i) * ENTITY_SNAPSHOT_WIRE_ACTION_STRIDE;
    values[base + 0] = action.type;
    values[base + 1] = pos !== null ? 1 : 0;
    values[base + 2] = pos !== null ? pos.x : 0;
    values[base + 3] = pos !== null ? pos.y : 0;
    values[base + 4] = action.posZ !== null ? 1 : 0;
    values[base + 5] = action.posZ ?? 0;
    values[base + 6] = action.pathExp === true ? 1 : 0;
    values[base + 7] = action.targetId !== null ? 1 : 0;
    values[base + 8] = action.targetId ?? 0;
    values[base + 9] = action.buildingBlueprintId !== null ? 1 : 0;
    values[base + 10] = action.buildingBlueprintId !== null ? strings.length : 0;
    if (action.buildingBlueprintId !== null) strings.push(action.buildingBlueprintId);
    values[base + 11] = grid !== null ? 1 : 0;
    values[base + 12] = grid !== null ? grid.x : 0;
    values[base + 13] = grid !== null ? grid.y : 0;
    values[base + 14] = action.buildingId !== null ? 1 : 0;
    values[base + 15] = action.buildingId ?? 0;
    values[base + 16] = action.waitGather === true ? 1 : 0;
    values[base + 17] = action.waitGroupId !== null && action.waitGroupId !== undefined ? 1 : 0;
    values[base + 18] = action.waitGroupId ?? 0;
  }
  return { offset, count };
}

function appendDecodedTurretWireRows(
  turrets: readonly NetworkServerSnapshotTurret[] | null,
): { offset: number; count: number } {
  const count = turrets?.length ?? 0;
  if (count === 0) return { offset: -1, count: 0 };
  const offset = reserveFloat64WireRows(
    _decodedEntityWireSource.turretRows,
    count,
    ENTITY_SNAPSHOT_WIRE_TURRET_STRIDE,
  );
  const values = _decodedEntityWireSource.turretRows.values;
  for (let i = 0; i < count; i++) {
    const src = turrets![i];
    const angular = src.turret.angular;
    const base = (offset + i) * ENTITY_SNAPSHOT_WIRE_TURRET_STRIDE;
    values[base + 0] = angular.rot;
    values[base + 1] = angular.vel;
    values[base + 2] = angular.pitch;
    values[base + 3] = angular.pitchVel;
    values[base + 4] = src.turret.turretBlueprintCode;
    values[base + 5] = src.state;
    values[base + 6] = src.targetId !== null ? 1 : 0;
    values[base + 7] = src.targetId ?? 0;
    values[base + 8] = src.currentShieldRange !== null ? 1 : 0;
    values[base + 9] = src.currentShieldRange ?? 0;
    values[base + 10] = src.active === false ? 1 : 0;
  }
  return { offset, count };
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

function rentDecodedTypedDeltaPlaceholder(
  id: number,
  type: NetworkServerSnapshotEntity['type'],
  playerId: PlayerId,
  changedFields: number,
): NetworkServerSnapshotEntity {
  const e = rentDecodedEntity();
  e.id = id;
  e.type = type;
  e.playerId = playerId;
  e.changedFields = changedFields;
  e.pos = null;
  e.rotation = null;
  e.unit = null;
  e.building = null;
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

function rentDecodedBuildingSub(): BuildingSub {
  let b = _buildingSubPool[_buildingSubPoolIndex];
  if (b === undefined) {
    b = createEmptyBuildingSub();
    _buildingSubPool[_buildingSubPoolIndex] = b;
  } else {
    b.buildingBlueprintCode = null;
    b.dim = null;
    b.hp = null;
    b.build = null;
    b.metalExtractionRate = null;
    b.solar = null;
    b.turrets = null;
    b.factory = null;
  }
  _buildingSubPoolIndex++;
  return b;
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

function rentDecodedHp(curr: number, max: number): DecodedHp {
  let hp = _hpPool[_hpPoolIndex];
  if (hp === undefined) {
    hp = { curr, max };
    _hpPool[_hpPoolIndex] = hp;
  } else {
    hp.curr = curr;
    hp.max = max;
  }
  _hpPoolIndex++;
  return hp;
}

function rentDecodedNormal(nx: number, ny: number, nz: number): DecodedNormal {
  let n = _normalPool[_normalPoolIndex];
  if (n === undefined) {
    n = { nx, ny, nz };
    _normalPool[_normalPoolIndex] = n;
  } else {
    n.nx = nx;
    n.ny = ny;
    n.nz = nz;
  }
  _normalPoolIndex++;
  return n;
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

const PACKED_ENTITIES_VERSION = 15;
const PACKED_ENTITIES_MIN_SUPPORTED_VERSION = 13;

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
const MOVEMENT_UNIT_FLAG_SURFACE_NORMAL = 1 << 7;
const MOVEMENT_UNIT_FLAG_HP = 1 << 8;

const BUILDING_DELTA_FLAG_POS = 1 << 0;
const BUILDING_DELTA_FLAG_ROTATION = 1 << 1;
const BUILDING_DELTA_FLAG_HP = 1 << 2;
const BUILDING_DELTA_FLAG_BUILD = 1 << 3;

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
// sub-object. V11 adds finite factory production queues. V12 adds surface
// normals to the compact movement slab so motion+normal sparse rows avoid
// detail-row fallback. V13 lets HP ride that same compact unit delta slab
// so movement/turret/HP rows avoid detail-row fallback. V14 adds compact
// building POS/ROT/HP delta rows. V15 lets building build-state ride the
// compact building delta slab.
export type PackedEntityRow = unknown[];
export type PackedMovementUnitBytes = Uint8Array;
export type PackedUnitTurretBytes = Uint8Array;
export type PackedBuildingDeltaBytes = Uint8Array;

export type PackedEntitySnapshotWire = {
  v: number;
  m: PackedMovementUnitBytes | undefined;
  t: PackedUnitTurretBytes | undefined;
  b?: PackedBuildingDeltaBytes | undefined;
  e: PackedEntityRow[] | undefined;
};

type UnpackEntitiesFromWireOptions = {
  materializeTypedDeltas?: boolean;
};

export function unpackEntitiesFromWire(
  packed: PackedEntitySnapshotWire,
  options: UnpackEntitiesFromWireOptions = {},
): NetworkServerSnapshotEntity[] {
  resetDecodePools();
  resetDecodedEntityWireSource();
  const materializeTypedDeltas = options.materializeTypedDeltas !== false;
  const movementRows = packed.m;
  const turretRows = packed.t;
  const buildingRows = packed.b;
  const detailRows = packed.e;
  const movementCount = countMovementUnitDeltaRows(movementRows);
  const turretCount = countUnitTurretDeltaRows(turretRows);
  const buildingCount = countBuildingDeltaRows(buildingRows);
  const detailCount = detailRows === undefined ? 0 : detailRows.length;
  const out: Array<NetworkServerSnapshotEntity | undefined> = new Array(
    movementCount + turretCount + buildingCount + detailCount,
  );
  let outIndex = 0;
  if (movementRows !== undefined) {
    outIndex = unpackMovementUnitDeltaRows(
      movementRows,
      out,
      outIndex,
      materializeTypedDeltas,
    );
  }
  if (buildingRows !== undefined) {
    outIndex = unpackBuildingDeltaRows(
      buildingRows,
      out,
      outIndex,
      materializeTypedDeltas,
    );
  }
  if (turretRows !== undefined) {
    outIndex = unpackUnitTurretDeltaRows(
      turretRows,
      out,
      outIndex,
      materializeTypedDeltas,
    );
  }
  if (detailRows !== undefined) {
    for (let i = 0; i < detailRows.length; i++) {
      const entity = unpackDetailEntityRow(detailRows[i]);
      if (!materializeTypedDeltas && tryAppendDecodedDetailTypedPlaceholderWireRow(entity)) {
        outIndex++;
      } else {
        out[outIndex++] = entity;
        appendDecodedFallbackEntityWireSourceRow();
      }
    }
  }
  if (
    _decodedEntityWireSourceHasTypedRows &&
    _decodedEntityWireSource.count === out.length
  ) {
    registerEntitySnapshotWireSource(out as NetworkServerSnapshotEntity[], _decodedEntityWireSource);
  }
  return out as NetworkServerSnapshotEntity[];
}

export function isPackedEntitySnapshotWire(
  value: unknown,
): value is PackedEntitySnapshotWire {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<PackedEntitySnapshotWire>;
  if (
    typeof candidate.v !== 'number' ||
    candidate.v < PACKED_ENTITIES_MIN_SUPPORTED_VERSION ||
    candidate.v > PACKED_ENTITIES_VERSION
  ) {
    return false;
  }
  if (candidate.v < 14 && candidate.b !== undefined) return false;
  return (
    (candidate.m === undefined || candidate.m instanceof Uint8Array) &&
    (candidate.t === undefined || candidate.t instanceof Uint8Array) &&
    (candidate.b === undefined || candidate.b instanceof Uint8Array) &&
    (candidate.e === undefined || Array.isArray(candidate.e))
  );
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

const DECODED_TYPED_UNIT_DETAIL_FIELDS =
  ENTITY_CHANGED_POS |
  ENTITY_CHANGED_ROT |
  ENTITY_CHANGED_VEL |
  ENTITY_CHANGED_NORMAL |
  ENTITY_CHANGED_HP |
  ENTITY_CHANGED_ACTIONS |
  ENTITY_CHANGED_TURRETS |
  ENTITY_CHANGED_BUILDING;

function tryAppendDecodedDetailTypedPlaceholderWireRow(
  entity: NetworkServerSnapshotEntity,
): boolean {
  const changedFields = entity.changedFields;
  if (changedFields === null || changedFields === 0) return false;
  if (entity.type !== 'unit') return false;
  if ((changedFields & ~DECODED_TYPED_UNIT_DETAIL_FIELDS) !== 0) return false;
  const unit = entity.unit;
  if (unit === null) return false;

  if ((changedFields & ENTITY_CHANGED_POS) !== 0 && entity.pos === null) return false;
  if ((changedFields & ENTITY_CHANGED_ROT) !== 0 && entity.rotation === null) return false;
  if ((changedFields & ENTITY_CHANGED_VEL) !== 0 && unit.velocity === null) return false;
  if ((changedFields & ENTITY_CHANGED_NORMAL) !== 0 && unit.surfaceNormal === null) return false;
  if ((changedFields & ENTITY_CHANGED_HP) !== 0 && unit.hp === null) return false;

  const wireRow = appendDecodedUnitEntityWireRow();
  const values = wireRow.values;
  const base = wireRow.base;
  values[base + 0] = entity.id;
  if (entity.pos !== null) {
    values[base + 1] = entity.pos.x;
    values[base + 2] = entity.pos.y;
    values[base + 3] = entity.pos.z;
  }
  values[base + 4] = entity.rotation ?? 0;
  values[base + 5] = entity.playerId;
  values[base + 6] = 1;
  values[base + 7] = changedFields;
  recordEntitySnapshotWireSourceChangedFields(
    _decodedEntityWireSource,
    ENTITY_SNAPSHOT_WIRE_KIND_UNIT,
    changedFields,
  );

  if (unit.hp !== null) {
    values[base + 8] = unit.hp.curr;
    values[base + 9] = unit.hp.max;
  }
  if (unit.velocity !== null) {
    values[base + 10] = unit.velocity.x;
    values[base + 11] = unit.velocity.y;
    values[base + 12] = unit.velocity.z;
  }
  if (unit.surfaceNormal !== null) {
    values[base + 23] = 1;
    values[base + 24] = unit.surfaceNormal.nx;
    values[base + 25] = unit.surfaceNormal.ny;
    values[base + 26] = unit.surfaceNormal.nz;
  }
  if (unit.orientation !== null) {
    values[base + 27] = 1;
    values[base + 28] = unit.orientation.x;
    values[base + 29] = unit.orientation.y;
    values[base + 30] = unit.orientation.z;
    values[base + 31] = unit.orientation.w;
  }
  if (unit.angularVelocity3 !== null) {
    values[base + 32] = 1;
    values[base + 33] = unit.angularVelocity3.x;
    values[base + 34] = unit.angularVelocity3.y;
    values[base + 35] = unit.angularVelocity3.z;
  }
  if (unit.buildTargetIdPresent) {
    values[base + 38] = 1;
    values[base + 39] = unit.buildTargetId === null ? 1 : 0;
    values[base + 40] = unit.buildTargetId ?? 0;
  }
  if (unit.actions !== null) {
    const actionRows = appendDecodedActionWireRows(unit.actions);
    values[base + 41] = 1;
    values[base + 42] = actionRows.count;
    values[base + 50] = actionRows.offset;
  }
  if (unit.turrets !== null) {
    const turretRows = appendDecodedTurretWireRows(unit.turrets);
    values[base + 43] = 1;
    values[base + 44] = turretRows.count;
    values[base + 49] = turretRows.offset;
  }
  if (unit.build !== null) {
    values[base + 45] = 1;
    values[base + 46] = unit.build.complete ? 1 : 0;
    values[base + 47] = unit.build.paid.energy;
    values[base + 48] = unit.build.paid.metal;
    values[base + 63] = unit.build.interrupted ? 1 : 0;
  }
  if (unit.repeatQueue !== null && unit.repeatQueue !== undefined) {
    values[base + 53] = 1;
    values[base + 54] = unit.repeatQueue ? 1 : 0;
  }
  if (unit.holdPosition !== null && unit.holdPosition !== undefined) {
    values[base + 55] = 1;
    values[base + 56] = unit.holdPosition ? 1 : 0;
  }
  if (unit.moveState !== null && unit.moveState !== undefined) {
    values[base + 59] = 1;
    values[base + 60] = unit.moveState === 'roam' ? 2 : unit.moveState === 'holdPosition' ? 1 : 0;
  }
  if (
    unit.wantCloak !== null && unit.wantCloak !== undefined ||
    unit.cloaked !== null && unit.cloaked !== undefined
  ) {
    values[base + 61] = 1;
    values[base + 62] = unit.cloaked === true ? 2 : unit.wantCloak === true ? 1 : 0;
  }
  return true;
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
  if ((flags & MOVEMENT_UNIT_FLAG_SURFACE_NORMAL) !== 0) changedFields |= ENTITY_CHANGED_NORMAL;
  if ((flags & MOVEMENT_UNIT_FLAG_HP) !== 0) changedFields |= ENTITY_CHANGED_HP;
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

function buildingDeltaChangedFields(flags: number): number {
  let changedFields = 0;
  if ((flags & BUILDING_DELTA_FLAG_POS) !== 0) changedFields |= ENTITY_CHANGED_POS;
  if ((flags & BUILDING_DELTA_FLAG_ROTATION) !== 0) changedFields |= ENTITY_CHANGED_ROT;
  if ((flags & BUILDING_DELTA_FLAG_HP) !== 0) changedFields |= ENTITY_CHANGED_HP;
  if ((flags & BUILDING_DELTA_FLAG_BUILD) !== 0) changedFields |= ENTITY_CHANGED_BUILDING;
  return changedFields;
}

function countBuildingDeltaRows(
  rows: PackedBuildingDeltaBytes | undefined,
): number {
  if (rows === undefined) return 0;
  return readPackedBinaryRowCount(rows);
}

function unpackMovementUnitDeltaRows(
  rows: PackedMovementUnitBytes,
  out: Array<NetworkServerSnapshotEntity | undefined>,
  outIndex: number,
  materializeEntity: boolean,
): number {
  return unpackMovementUnitDeltaGroupedBytes(rows, out, outIndex, materializeEntity);
}

function unpackMovementUnitDeltaGroupedBytes(
  rows: PackedMovementUnitBytes,
  out: Array<NetworkServerSnapshotEntity | undefined>,
  outIndex: number,
  materializeEntity: boolean,
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
      const entity = readMovementUnitDeltaByteEntity(
        reader,
        flags,
        id,
        playerId,
        materializeEntity,
      );
      if (entity !== undefined) out[outIndex] = entity;
      outIndex++;
    }
  }
  return outIndex;
}

function readMovementUnitDeltaByteEntity(
  reader: PackedBinaryReader,
  flags: number,
  id: number,
  playerId: PlayerId,
  materializeEntity: boolean,
): NetworkServerSnapshotEntity | undefined {
  const wireRow = appendDecodedUnitEntityWireRow();
  const wireValues = wireRow.values;
  const wireBase = wireRow.base;
  const changedFields = movementUnitChangedFields(flags);
  wireValues[wireBase + 0] = id;
  wireValues[wireBase + 5] = playerId;
  wireValues[wireBase + 6] = 1;
  wireValues[wireBase + 7] = changedFields;
  recordEntitySnapshotWireSourceChangedFields(
    _decodedEntityWireSource,
    ENTITY_SNAPSHOT_WIRE_KIND_UNIT,
    changedFields,
  );

  const entity = materializeEntity
    ? rentDecodedTypedDeltaPlaceholder(id, 'unit', playerId, changedFields)
    : undefined;
  if ((flags & MOVEMENT_UNIT_FLAG_POS) !== 0) {
    const x = reader.readVarInt();
    const y = reader.readVarInt();
    const z = reader.readVarInt();
    if (entity !== undefined) entity.pos = rentDecodedVec3(x, y, z);
    wireValues[wireBase + 1] = x;
    wireValues[wireBase + 2] = y;
    wireValues[wireBase + 3] = z;
  }
  if ((flags & MOVEMENT_UNIT_FLAG_ROTATION) !== 0) {
    const rotation = reader.readVarInt();
    if (entity !== undefined) entity.rotation = rotation;
    wireValues[wireBase + 4] = rotation;
  }
  if (
    (flags & (
      MOVEMENT_UNIT_FLAG_VELOCITY |
      MOVEMENT_UNIT_FLAG_SURFACE_NORMAL |
      MOVEMENT_UNIT_FLAG_HP |
      MOVEMENT_UNIT_FLAG_ORIENTATION |
      MOVEMENT_UNIT_FLAG_ANGULAR_VELOCITY |
      MOVEMENT_UNIT_FLAG_YAW_ORIENTATION |
      MOVEMENT_UNIT_FLAG_YAW_ANGULAR_VELOCITY
    )) !== 0
  ) {
    const unit = materializeEntity ? rentDecodedUnitSub() : null;
    if ((flags & MOVEMENT_UNIT_FLAG_VELOCITY) !== 0) {
      const x = reader.readVarInt();
      const y = reader.readVarInt();
      const z = reader.readVarInt();
      if (unit !== null) unit.velocity = rentDecodedVec3(x, y, z);
      wireValues[wireBase + 10] = x;
      wireValues[wireBase + 11] = y;
      wireValues[wireBase + 12] = z;
    }
    if ((flags & MOVEMENT_UNIT_FLAG_SURFACE_NORMAL) !== 0) {
      const nx = reader.readVarInt();
      const ny = reader.readVarInt();
      const nz = reader.readVarInt();
      if (unit !== null) unit.surfaceNormal = rentDecodedNormal(nx, ny, nz);
      wireValues[wireBase + 23] = 1;
      wireValues[wireBase + 24] = nx;
      wireValues[wireBase + 25] = ny;
      wireValues[wireBase + 26] = nz;
    }
    if ((flags & MOVEMENT_UNIT_FLAG_HP) !== 0) {
      const curr = reader.readFloat64();
      const max = reader.readFloat64();
      if (unit !== null) unit.hp = rentDecodedHp(curr, max);
      wireValues[wireBase + 8] = curr;
      wireValues[wireBase + 9] = max;
    }
    if ((flags & MOVEMENT_UNIT_FLAG_ORIENTATION) !== 0) {
      const x = reader.readFloat64();
      const y = reader.readFloat64();
      const z = reader.readFloat64();
      const w = reader.readFloat64();
      if (unit !== null) unit.orientation = rentDecodedQuat(x, y, z, w);
      wireValues[wireBase + 27] = 1;
      wireValues[wireBase + 28] = x;
      wireValues[wireBase + 29] = y;
      wireValues[wireBase + 30] = z;
      wireValues[wireBase + 31] = w;
    }
    if ((flags & MOVEMENT_UNIT_FLAG_YAW_ORIENTATION) !== 0) {
      const yaw = deqRot(wireValues[wireBase + 4]);
      const orientation = materializeEntity ? rentDecodedQuat(0, 0, 0, 1) : _scratchDecodedQuat;
      setQuatFromYaw(orientation, yaw);
      if (unit !== null) unit.orientation = orientation;
      wireValues[wireBase + 27] = 1;
      wireValues[wireBase + 28] = orientation.x;
      wireValues[wireBase + 29] = orientation.y;
      wireValues[wireBase + 30] = orientation.z;
      wireValues[wireBase + 31] = orientation.w;
    }
    if ((flags & MOVEMENT_UNIT_FLAG_ANGULAR_VELOCITY) !== 0) {
      const x = reader.readFloat64();
      const y = reader.readFloat64();
      const z = reader.readFloat64();
      if (unit !== null) unit.angularVelocity3 = rentDecodedVec3(x, y, z);
      wireValues[wireBase + 32] = 1;
      wireValues[wireBase + 33] = x;
      wireValues[wireBase + 34] = y;
      wireValues[wireBase + 35] = z;
    }
    if ((flags & MOVEMENT_UNIT_FLAG_YAW_ANGULAR_VELOCITY) !== 0) {
      const z = reader.readFloat64();
      if (unit !== null) unit.angularVelocity3 = rentDecodedVec3(0, 0, z);
      wireValues[wireBase + 32] = 1;
      wireValues[wireBase + 33] = 0;
      wireValues[wireBase + 34] = 0;
      wireValues[wireBase + 35] = z;
    }
    if (unit !== null && entity !== undefined) entity.unit = unit;
  }
  return entity;
}

function unpackBuildingDeltaRows(
  rows: PackedBuildingDeltaBytes,
  out: Array<NetworkServerSnapshotEntity | undefined>,
  outIndex: number,
  materializeEntity: boolean,
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
      const entity = readBuildingDeltaByteEntity(
        reader,
        flags,
        id,
        playerId,
        materializeEntity,
      );
      if (entity !== undefined) out[outIndex] = entity;
      outIndex++;
    }
  }
  return outIndex;
}

function readBuildingDeltaByteEntity(
  reader: PackedBinaryReader,
  flags: number,
  id: number,
  playerId: PlayerId,
  materializeEntity: boolean,
): NetworkServerSnapshotEntity | undefined {
  const wireRow = appendDecodedBuildingEntityWireRow();
  const wireValues = wireRow.values;
  const wireBase = wireRow.base;
  const changedFields = buildingDeltaChangedFields(flags);
  wireValues[wireBase + 0] = id;
  wireValues[wireBase + 5] = playerId;
  wireValues[wireBase + 6] = 1;
  wireValues[wireBase + 7] = changedFields;
  recordEntitySnapshotWireSourceChangedFields(
    _decodedEntityWireSource,
    ENTITY_SNAPSHOT_WIRE_KIND_BUILDING,
    changedFields,
  );

  const entity = materializeEntity
    ? rentDecodedTypedDeltaPlaceholder(id, 'building', playerId, changedFields)
    : undefined;
  if ((flags & BUILDING_DELTA_FLAG_POS) !== 0) {
    const x = reader.readVarInt();
    const y = reader.readVarInt();
    const z = reader.readVarInt();
    if (entity !== undefined) entity.pos = rentDecodedVec3(x, y, z);
    wireValues[wireBase + 1] = x;
    wireValues[wireBase + 2] = y;
    wireValues[wireBase + 3] = z;
  }
  if ((flags & BUILDING_DELTA_FLAG_ROTATION) !== 0) {
    const rotation = reader.readVarInt();
    if (entity !== undefined) entity.rotation = rotation;
    wireValues[wireBase + 4] = rotation;
  }
  if ((flags & BUILDING_DELTA_FLAG_HP) !== 0) {
    const curr = reader.readFloat64();
    const max = reader.readFloat64();
    if (materializeEntity) {
      const building = rentDecodedBuildingSub();
      building.hp = rentDecodedHp(curr, max);
      if (entity !== undefined) entity.building = building;
    }
    wireValues[wireBase + 13] = curr;
    wireValues[wireBase + 14] = max;
  }
  if ((flags & BUILDING_DELTA_FLAG_BUILD) !== 0) {
    const complete = reader.readVarUint() !== 0;
    const interrupted = reader.readVarUint() !== 0;
    const paidEnergy = reader.readFloat64();
    const paidMetal = reader.readFloat64();
    if (materializeEntity && entity !== undefined) {
      const building = entity.building ?? rentDecodedBuildingSub();
      building.build = {
        complete,
        interrupted,
        paid: {
          energy: paidEnergy,
          metal: paidMetal,
        },
      };
      entity.building = building;
    }
    wireValues[wireBase + 15] = complete ? 1 : 0;
    wireValues[wireBase + 16] = paidEnergy;
    wireValues[wireBase + 17] = paidMetal;
    wireValues[wireBase + 34] = interrupted ? 1 : 0;
  }
  return entity;
}

function unpackUnitTurretDeltaRows(
  rows: PackedUnitTurretBytes,
  out: Array<NetworkServerSnapshotEntity | undefined>,
  outIndex: number,
  materializeEntity: boolean,
): number {
  return unpackUnitTurretDeltaGroupedBytes(rows, out, outIndex, materializeEntity);
}

function unpackUnitTurretDeltaGroupedBytes(
  rows: PackedUnitTurretBytes,
  out: Array<NetworkServerSnapshotEntity | undefined>,
  outIndex: number,
  materializeEntity: boolean,
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
      const entity = readUnitTurretDeltaByteEntity(
        reader,
        id,
        playerId,
        turretCount,
        materializeEntity,
      );
      if (entity !== undefined) out[outIndex] = entity;
      outIndex++;
    }
  }
  return outIndex;
}

function readUnitTurretDeltaByteEntity(
  reader: PackedBinaryReader,
  id: number,
  playerId: PlayerId,
  turretCount: number,
  materializeEntity: boolean,
): NetworkServerSnapshotEntity | undefined {
  const wireRow = appendDecodedUnitEntityWireRow();
  const wireValues = wireRow.values;
  const wireBase = wireRow.base;
  const turretRowOffset = reserveFloat64WireRows(
    _decodedEntityWireSource.turretRows,
    turretCount,
    ENTITY_SNAPSHOT_WIRE_TURRET_STRIDE,
  );
  const turretWireValues = _decodedEntityWireSource.turretRows.values;
  turretWireValues.fill(
    0,
    turretRowOffset * ENTITY_SNAPSHOT_WIRE_TURRET_STRIDE,
    (turretRowOffset + turretCount) * ENTITY_SNAPSHOT_WIRE_TURRET_STRIDE,
  );
  wireValues[wireBase + 0] = id;
  wireValues[wireBase + 5] = playerId;
  wireValues[wireBase + 6] = 1;
  wireValues[wireBase + 7] = ENTITY_CHANGED_TURRETS;
  recordEntitySnapshotWireSourceChangedFields(
    _decodedEntityWireSource,
    ENTITY_SNAPSHOT_WIRE_KIND_UNIT,
    ENTITY_CHANGED_TURRETS,
  );
  wireValues[wireBase + 43] = turretCount > 0 ? 1 : 0;
  wireValues[wireBase + 44] = turretCount;
  wireValues[wireBase + 49] = turretRowOffset;

  const turrets: NetworkServerSnapshotTurret[] | null = materializeEntity
    ? new Array(turretCount)
    : null;
  for (let turretIndex = 0; turretIndex < turretCount; turretIndex++) {
    const flags = reader.readVarUint();
    const turretBlueprintCode = reader.readVarUint() as NetworkServerSnapshotTurret['turret']['turretBlueprintCode'];
    const state = reader.readVarUint() as NetworkServerSnapshotTurret['state'];
    const rot = reader.readVarInt();
    const vel = reader.readVarInt();
    const pitch = reader.readVarInt();
    const pitchVel = reader.readVarInt();
    const turret: NetworkServerSnapshotTurret | null = turrets !== null
      ? {
          turret: {
            turretBlueprintCode,
            angular: {
              rot,
              vel,
              pitch,
              pitchVel,
            },
          },
          state,
          targetId: null,
          active: null,
          currentShieldRange: null,
        }
      : null;
    const turretWireBase = (turretRowOffset + turretIndex) * ENTITY_SNAPSHOT_WIRE_TURRET_STRIDE;
    turretWireValues[turretWireBase + 0] = rot;
    turretWireValues[turretWireBase + 1] = vel;
    turretWireValues[turretWireBase + 2] = pitch;
    turretWireValues[turretWireBase + 3] = pitchVel;
    turretWireValues[turretWireBase + 4] = turretBlueprintCode;
    turretWireValues[turretWireBase + 5] = state;
    if ((flags & TURRET_FLAG_TARGET_ID) !== 0) {
      const targetId = reader.readVarUint();
      if (turret !== null) turret.targetId = targetId;
      turretWireValues[turretWireBase + 6] = 1;
      turretWireValues[turretWireBase + 7] = targetId;
    }
    if ((flags & TURRET_FLAG_INACTIVE) !== 0) {
      if (turret !== null) turret.active = false;
      turretWireValues[turretWireBase + 10] = 1;
    }
    if ((flags & TURRET_FLAG_SHIELD_RANGE) !== 0) {
      const shieldRange = reader.readFloat64();
      if (turret !== null) turret.currentShieldRange = shieldRange;
      turretWireValues[turretWireBase + 8] = 1;
      turretWireValues[turretWireBase + 9] = shieldRange;
    }
    if (turrets !== null && turret !== null) turrets[turretIndex] = turret;
  }
  const entity = materializeEntity
    ? rentDecodedTypedDeltaPlaceholder(
        id,
        'unit',
        playerId,
        ENTITY_CHANGED_TURRETS,
      )
    : undefined;
  if (turrets !== null && entity !== undefined) {
    const unit = rentDecodedUnitSub();
    unit.turrets = turrets;
    entity.unit = unit;
  }
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
    const other = row[i++] as number;
    const hitbox = row[i++] as number;
    const collision = row[i++] as number;
    unit.radius = { other, hitbox, collision };
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
  const building = rentDecodedBuildingSub();
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
