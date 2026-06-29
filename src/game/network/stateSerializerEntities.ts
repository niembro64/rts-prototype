import type { WorldState } from '../sim/WorldState';
import type { Entity, PlayerId } from '../sim/types';
import { NO_ENTITY_ID } from '../sim/types';
import {
  ENTITY_SLOT_BUILD_FLAG_COMPLETE,
  ENTITY_SLOT_BUILD_FLAG_HAS_BUILDABLE,
  ENTITY_SLOT_BUILD_FLAG_INTERRUPTED,
  ENTITY_SLOT_UNIT_MOTION_HAS_ANGULAR_VELOCITY,
  ENTITY_SLOT_UNIT_MOTION_HAS_ORIENTATION,
  ENTITY_SLOT_UNIT_MOTION_HAS_SURFACE_NORMAL,
  type EntityStateViews,
} from '../sim/EntitySlotRegistry';
import { getBuildFraction } from '../sim/buildableHelpers';
import { isCommander } from '../sim/combat/combatUtils';
import {
  readCombatTargetingTurretFsmInto,
  type CombatTargetingTurretFsmOut,
} from '../sim/combat/targetingInputStamping';
import type {
  NetworkServerSnapshotAction,
  NetworkServerSnapshotEntity,
  NetworkServerSnapshotTurret,
} from './NetworkManager';
import {
  ENTITY_CHANGED_ACTIONS,
  ENTITY_CHANGED_BUILDING,
  ENTITY_CHANGED_COMBAT_MODE,
  ENTITY_CHANGED_FACTORY,
  ENTITY_CHANGED_HP,
  ENTITY_CHANGED_NORMAL,
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_ROT,
  ENTITY_CHANGED_TURRETS,
  ENTITY_CHANGED_VEL,
  actionTypeToCode,
  buildingBlueprintIdToCode,
  turretBlueprintIdToCode,
  turretStateToCode,
  unitBlueprintIdToCode,
} from '../../types/network';
import {
  createActionDto,
  createTurretDto,
  createWaypointDto,
  type WaypointDto,
} from './snapshotDtoCopy';
import {
  turretAimMotionIsSnapshotVisible,
  turretShouldEncodeInactive,
} from './turretSnapshotFields';
import {
  createFloat64WireRows,
  createUint32WireRows,
  reserveFloat64WireRows,
  reserveUint32WireRows,
  type Float64WireRows,
  type Uint32WireRows,
} from './snapshotWireRows';
import {
  clearNetworkUnitActions,
  clearNetworkUnitCombatMode,
  clearNetworkUnitStaticFields,
  clearNetworkUnitSurfaceNormal,
  createNetworkUnitSnapshot,
  writeNetworkUnitActions,
  writeNetworkUnitCombatMode,
  writeNetworkUnitStaticFields,
  writeNetworkUnitSurfaceNormal,
  writeNetworkUnitVelocity,
} from './unitSnapshotFields';
import type { SnapshotVisibility } from './stateSerializerVisibility';
import {
  quantizeEntityPosition as qPos,
  quantizeNormal as qNormal,
  quantizeRotation as qRot,
  quantizeVelocity as qVel,
} from './snapshotQuantization';
import { encodeFactoryProductionQueue } from './factoryProductionQueueWire';
import { isMetalExtractorBlueprintId } from '../../types/buildingTypes';
import {
  ENTITY_STATE_KIND_BUILDING,
  ENTITY_STATE_KIND_TOWER,
  ENTITY_STATE_KIND_UNIT,
} from '../sim-wasm/init';

const INITIAL_ENTITY_POOL = 200;
const MAX_WEAPONS_PER_ENTITY = 8;
const MAX_ACTIONS_PER_ENTITY = 16;
const TYPED_PLACEHOLDER_UNIT_MOTION_FIELDS =
  ENTITY_CHANGED_POS |
  ENTITY_CHANGED_ROT |
  ENTITY_CHANGED_VEL |
  ENTITY_CHANGED_NORMAL;
const TYPED_PLACEHOLDER_UNIT_SLAB_FIELDS =
  TYPED_PLACEHOLDER_UNIT_MOTION_FIELDS |
  ENTITY_CHANGED_HP |
  ENTITY_CHANGED_BUILDING;
const TYPED_PLACEHOLDER_UNIT_TRIGGER_FIELDS =
  ENTITY_CHANGED_VEL |
  ENTITY_CHANGED_HP |
  ENTITY_CHANGED_ACTIONS |
  ENTITY_CHANGED_TURRETS |
  ENTITY_CHANGED_BUILDING |
  ENTITY_CHANGED_NORMAL;
const TYPED_PLACEHOLDER_UNIT_DELTA_FIELDS =
  TYPED_PLACEHOLDER_UNIT_MOTION_FIELDS |
  ENTITY_CHANGED_HP |
  ENTITY_CHANGED_ACTIONS |
  ENTITY_CHANGED_TURRETS |
  ENTITY_CHANGED_BUILDING;
const TYPED_PLACEHOLDER_BUILDING_TRIGGER_FIELDS =
  ENTITY_CHANGED_HP |
  ENTITY_CHANGED_TURRETS |
  ENTITY_CHANGED_BUILDING;
const TYPED_PLACEHOLDER_BUILDING_DELTA_FIELDS =
  ENTITY_CHANGED_POS |
  ENTITY_CHANGED_ROT |
  ENTITY_CHANGED_HP |
  ENTITY_CHANGED_TURRETS |
  ENTITY_CHANGED_BUILDING;
const TYPED_PLACEHOLDER_BUILDING_SLAB_FIELDS =
  ENTITY_CHANGED_POS |
  ENTITY_CHANGED_ROT |
  ENTITY_CHANGED_HP |
  ENTITY_CHANGED_BUILDING;
const BUILDING_ACTIVE_STATE_BLUEPRINT_CODES = new Set<number>([
  buildingBlueprintIdToCode('buildingSolar'),
  buildingBlueprintIdToCode('buildingWind'),
  buildingBlueprintIdToCode('buildingExtractor'),
  buildingBlueprintIdToCode('buildingExtractorT2'),
  buildingBlueprintIdToCode('buildingRadar'),
  buildingBlueprintIdToCode('buildingResourceConverter'),
]);
const _snapshotTurretFsm: CombatTargetingTurretFsmOut = {
  stateCode: 0,
  targetId: -1,
};
const _directTurretFsm: CombatTargetingTurretFsmOut = {
  stateCode: 0,
  targetId: -1,
};

export const ENTITY_SNAPSHOT_WIRE_KIND_BASIC = 1;
export const ENTITY_SNAPSHOT_WIRE_KIND_UNIT = 2;
export const ENTITY_SNAPSHOT_WIRE_KIND_BUILDING = 3;
export const ENTITY_SNAPSHOT_WIRE_TYPE_UNIT = 1;
export const ENTITY_SNAPSHOT_WIRE_TYPE_BUILDING = 2;
export const ENTITY_SNAPSHOT_WIRE_TYPE_TOWER = 3;
export const ENTITY_SNAPSHOT_WIRE_BASIC_STRIDE = 9;
// Unit row layout: see appendDirectUnitEntityWireRow for the exact slot order.
// Slots 51+ carry V11 command/build/cloak state that used to force a RAW
// entity fallback.
export const ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE = 64;
export const ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE = 42;
export const ENTITY_SNAPSHOT_WIRE_ACTION_STRIDE = 19;
// Turret row layout: rot, vel, pitch, pitchVel, id, state, hasTarget,
// targetId, hasShieldRange, shieldRange, inactive. Stride shrank from
// 12 → 10 when the 2 angular acceleration slots (acc, pitchAcc) were
// removed alongside movementAccel, then grew to 11 for the V11 inactive bit.
export const ENTITY_SNAPSHOT_WIRE_TURRET_STRIDE = 11;
export const ENTITY_SNAPSHOT_WIRE_WAYPOINT_STRIDE = 5;

export type EntitySnapshotWireSource = {
  count: number;
  kinds: Uint32Array;
  rowIndices: Int32Array;
  typedPlaceholderMarks: Uint8Array;
  typedPlaceholderRows: number;
  nonPlaceholderEntityIndices: Uint32Array;
  nonPlaceholderEntityRows: number;
  typedEntityRows: number;
  rawEntityRows: number;
  basicChangedFieldsOr: number;
  unitChangedFieldsOr: number;
  buildingChangedFieldsOr: number;
  basicRows: Float64WireRows;
  unitRows: Float64WireRows;
  buildingRows: Float64WireRows;
  actionRows: Float64WireRows;
  actionStrings: string[];
  turretRows: Float64WireRows;
  factorySelectedUnitRows: Uint32WireRows;
  waypointRows: Float64WireRows;
  waypointStrings: string[];
};

type UnitSub = NonNullable<NetworkServerSnapshotEntity['unit']>;
type BuildingSub = NonNullable<NetworkServerSnapshotEntity['building']>;
type FactorySub = NonNullable<BuildingSub['factory']>;
type PooledEntry = {
  entity: NetworkServerSnapshotEntity;
  entityPos: { x: number; y: number; z: number };
  unitSub: UnitSub;
  unitHp: NonNullable<UnitSub['hp']>;
  unitVelocity: NonNullable<UnitSub['velocity']>;
  unitBuild: NonNullable<UnitSub['build']>;
  buildingDim: { x: number; y: number };
  solarSub: { open: boolean };
  buildingSub: BuildingSub;
  buildingHp: NonNullable<BuildingSub['hp']>;
  buildingBuild: NonNullable<BuildingSub['build']>;
  factorySub: FactorySub;
  turrets: NetworkServerSnapshotTurret[];
  actions: NetworkServerSnapshotAction[];
  rally: WaypointDto;
  route: WaypointDto[];
};
const entityWireSource = createEntitySnapshotWireSource(INITIAL_ENTITY_POOL);
const entityWireSources = new WeakMap<object, EntitySnapshotWireSource>();

export function createEntitySnapshotWireSource(rowCapacity = 0): EntitySnapshotWireSource {
  const capacity = Math.max(0, Math.floor(rowCapacity));
  return {
    count: 0,
    kinds: new Uint32Array(capacity),
    rowIndices: new Int32Array(capacity),
    typedPlaceholderMarks: new Uint8Array(capacity),
    typedPlaceholderRows: 0,
    nonPlaceholderEntityIndices: new Uint32Array(capacity),
    nonPlaceholderEntityRows: 0,
    typedEntityRows: 0,
    rawEntityRows: 0,
    basicChangedFieldsOr: 0,
    unitChangedFieldsOr: 0,
    buildingChangedFieldsOr: 0,
    basicRows: createFloat64WireRows(),
    unitRows: createFloat64WireRows(),
    buildingRows: createFloat64WireRows(),
    actionRows: createFloat64WireRows(),
    actionStrings: [],
    turretRows: createFloat64WireRows(),
    factorySelectedUnitRows: createUint32WireRows(),
    waypointRows: createFloat64WireRows(),
    waypointStrings: [],
  };
}

export function ensureEntitySnapshotWireSourceCapacity(
  source: EntitySnapshotWireSource,
  rowCount: number,
): void {
  if (rowCount <= source.kinds.length) return;
  let nextCapacity = Math.max(4, source.kinds.length);
  while (nextCapacity < rowCount) nextCapacity *= 2;
  const kinds = new Uint32Array(nextCapacity);
  const rowIndices = new Int32Array(nextCapacity);
  const typedPlaceholderMarks = new Uint8Array(nextCapacity);
  const nonPlaceholderEntityIndices = new Uint32Array(nextCapacity);
  if (source.count > 0) {
    kinds.set(source.kinds.subarray(0, source.count));
    rowIndices.set(source.rowIndices.subarray(0, source.count));
    typedPlaceholderMarks.set(source.typedPlaceholderMarks.subarray(0, source.count));
    nonPlaceholderEntityIndices.set(
      source.nonPlaceholderEntityIndices.subarray(0, source.nonPlaceholderEntityRows),
    );
  }
  source.kinds = kinds;
  source.rowIndices = rowIndices;
  source.typedPlaceholderMarks = typedPlaceholderMarks;
  source.nonPlaceholderEntityIndices = nonPlaceholderEntityIndices;
}

export function appendEntitySnapshotWireSourceRow(
  source: EntitySnapshotWireSource,
  kind: number,
  rowIndex: number,
  typedPlaceholder = false,
  changedFields = 0,
): void {
  const index = source.count;
  ensureEntitySnapshotWireSourceCapacity(source, index + 1);
  source.kinds[index] = kind;
  source.rowIndices[index] = rowIndex;
  source.typedPlaceholderMarks[index] = typedPlaceholder ? 1 : 0;
  if (typedPlaceholder) source.typedPlaceholderRows++;
  else source.nonPlaceholderEntityIndices[source.nonPlaceholderEntityRows++] = index;
  if (kind === 0) source.rawEntityRows++;
  else source.typedEntityRows++;
  recordEntitySnapshotWireSourceChangedFields(source, kind, changedFields);
  source.count = index + 1;
}

export function recordEntitySnapshotWireSourceChangedFields(
  source: EntitySnapshotWireSource,
  kind: number,
  changedFields: number,
): void {
  if (changedFields === 0) return;
  switch (kind) {
    case ENTITY_SNAPSHOT_WIRE_KIND_BASIC:
      source.basicChangedFieldsOr |= changedFields;
      break;
    case ENTITY_SNAPSHOT_WIRE_KIND_UNIT:
      source.unitChangedFieldsOr |= changedFields;
      break;
    case ENTITY_SNAPSHOT_WIRE_KIND_BUILDING:
      source.buildingChangedFieldsOr |= changedFields;
      break;
  }
}

export function copyEntitySnapshotWireSourceMetadataInto(
  src: EntitySnapshotWireSource,
  dst: EntitySnapshotWireSource,
): void {
  dst.count = 0;
  ensureEntitySnapshotWireSourceCapacity(dst, src.count);
  if (src.count > 0) {
    dst.kinds.set(src.kinds.subarray(0, src.count));
    dst.rowIndices.set(src.rowIndices.subarray(0, src.count));
    dst.typedPlaceholderMarks.set(src.typedPlaceholderMarks.subarray(0, src.count));
    dst.nonPlaceholderEntityIndices.set(
      src.nonPlaceholderEntityIndices.subarray(0, src.nonPlaceholderEntityRows),
    );
  }
  dst.typedPlaceholderRows = src.typedPlaceholderRows;
  dst.nonPlaceholderEntityRows = src.nonPlaceholderEntityRows;
  dst.typedEntityRows = src.typedEntityRows;
  dst.rawEntityRows = src.rawEntityRows;
  dst.basicChangedFieldsOr = src.basicChangedFieldsOr;
  dst.unitChangedFieldsOr = src.unitChangedFieldsOr;
  dst.buildingChangedFieldsOr = src.buildingChangedFieldsOr;
  dst.count = src.count;
}

export function removeEntitySnapshotWireSourceRow(
  source: EntitySnapshotWireSource,
  index: number,
): void {
  if (index < 0 || index >= source.count) return;
  if (source.kinds[index] === 0) {
    source.rawEntityRows = Math.max(0, source.rawEntityRows - 1);
  } else {
    source.typedEntityRows = Math.max(0, source.typedEntityRows - 1);
  }
  if (source.typedPlaceholderMarks[index] !== 0) {
    source.typedPlaceholderRows = Math.max(0, source.typedPlaceholderRows - 1);
  }
  const nextCount = source.count - 1;
  let nextNonPlaceholderRows = 0;
  if (index < nextCount) {
    source.kinds.copyWithin(index, index + 1, source.count);
    source.rowIndices.copyWithin(index, index + 1, source.count);
    source.typedPlaceholderMarks.copyWithin(index, index + 1, source.count);
  }
  for (let i = 0; i < source.nonPlaceholderEntityRows; i++) {
    const entityIndex = source.nonPlaceholderEntityIndices[i];
    if (entityIndex === index) continue;
    source.nonPlaceholderEntityIndices[nextNonPlaceholderRows++] =
      entityIndex > index ? entityIndex - 1 : entityIndex;
  }
  source.nonPlaceholderEntityRows = nextNonPlaceholderRows;
  source.typedPlaceholderMarks[nextCount] = 0;
  source.count = nextCount;
}

function writeTurretsToPool(
  pool: PooledEntry,
  entity: Entity,
  weapons: NonNullable<Entity['combat']>['turrets'],
  canReferenceEntityId: ((id: number | undefined) => boolean) | undefined,
): NetworkServerSnapshotTurret[] {
  const count = weapons.length;
  while (pool.turrets.length < count) pool.turrets.push(createTurretDto());
  pool.turrets.length = count;
  for (let i = 0; i < count; i++) {
    const src = weapons[i];
    const dst = pool.turrets[i];
    const t = dst.turret;
    t.turretBlueprintCode = turretBlueprintIdToCode(src.config.turretBlueprintId);
    // Head-only turrets render a sphere only, so the client doesn't orient
    // anything from these values. Beam/laser presentation travels as beam
    // endpoint updates instead of turret yaw/pitch on the entity row.
    if (!turretAimMotionIsSnapshotVisible(src)) {
      t.angular.rot = 0;
      t.angular.vel = 0;
      t.angular.pitch = 0;
      t.angular.pitchVel = 0;
    } else {
      t.angular.rot = qRot(src.rotation);
      t.angular.vel = qRot(src.angularVelocity);
      // Acceleration intentionally omitted from the wire: it's the
      // instantaneous damped-spring force at this tick (depends on
      // error-to-target), not a constant, and integrating it across an
      // arbitrary client-side dt overshoots. Clients predict turret
      // motion from velocity alone.
      t.angular.pitch = qRot(src.pitch);
      t.angular.pitchVel = qRot(src.pitchVelocity);
    }
    const hasTargetingFsm = readCombatTargetingTurretFsmInto(entity, i, _snapshotTurretFsm);
    const targetId = hasTargetingFsm ? _snapshotTurretFsm.targetId : (src.target ?? -1);
    const wireTargetId = targetId === -1 ? null : targetId;
    dst.targetId = wireTargetId !== null &&
      canReferenceEntityId !== undefined &&
      canReferenceEntityId(wireTargetId) === false
      ? null
      : wireTargetId;
    dst.state = hasTargetingFsm ? _snapshotTurretFsm.stateCode : turretStateToCode(src.state);
    dst.active = turretShouldEncodeInactive(src, targetId) ? false : null;
    const shield = src.shield;
    dst.currentShieldRange = shield !== null ? shield.range : null;
  }
  return pool.turrets;
}

function createPooledEntry(): PooledEntry {
  const turrets: NetworkServerSnapshotTurret[] = [];
  for (let i = 0; i < MAX_WEAPONS_PER_ENTITY; i++) turrets.push(createTurretDto());
  const actions: NetworkServerSnapshotAction[] = [];
  for (let i = 0; i < MAX_ACTIONS_PER_ENTITY; i++) actions.push(createActionDto());
  const rally = createWaypointDto();
  const route: WaypointDto[] = [];
  const entityPos = { x: 0, y: 0, z: 0 };
  const unitSub = createNetworkUnitSnapshot();
  const unitHp = unitSub.hp ?? (unitSub.hp = { curr: 0, max: 0 });
  const unitVelocity = unitSub.velocity ?? (unitSub.velocity = { x: 0, y: 0, z: 0 });
  const unitBuild = {
    complete: false,
    interrupted: false,
    paid: { energy: 0, metal: 0 },
  };
  const buildingHp = { curr: 0, max: 0 };
  const buildingBuild = {
    complete: false,
    interrupted: false,
    paid: { energy: 0, metal: 0 },
  };
  return {
    entity: {
      id: 0,
      type: 'unit',
      pos: entityPos,
      rotation: 0,
      playerId: 1 as PlayerId,
      changedFields: null,
      unit: null,
      building: null,
    },
    entityPos,
    unitSub,
    unitHp,
    unitVelocity,
    unitBuild,
    buildingDim: { x: 0, y: 0 },
    solarSub: { open: false },
    buildingSub: {
      buildingBlueprintCode: null, dim: null, hp: buildingHp,
      build: buildingBuild,
      metalExtractionRate: null,
      solar: null,
      turrets: null,
      factory: null,
    },
    buildingHp,
    buildingBuild,
    factorySub: {
      selectedUnitBlueprintCode: null, progress: 0, producing: false,
      repeat: true,
      queue: null,
      energyRate: 0, metalRate: 0,
      guardTargetId: null,
      rally,
      route: null,
    },
    turrets,
    actions,
    rally,
    route,
  };
}

const pool: PooledEntry[] = [];
let poolIndex = 0;

for (let i = 0; i < INITIAL_ENTITY_POOL; i++) {
  pool.push(createPooledEntry());
}

function getPooledEntry(): PooledEntry {
  if (poolIndex >= pool.length) {
    pool.push(createPooledEntry());
  }
  return pool[poolIndex++];
}

export function resetEntitySnapshotPool(): void {
  poolIndex = 0;
  resetEntitySnapshotWireSource();
}

type EntitySnapshotPoolStats = {
  retainedEntries: number;
  activeEntries: number;
  warmEntries: number;
};

export function getEntitySnapshotPoolStats(): EntitySnapshotPoolStats {
  return {
    retainedEntries: pool.length,
    activeEntries: poolIndex,
    warmEntries: INITIAL_ENTITY_POOL,
  };
}

export function trimEntitySnapshotPool(maxRetained = INITIAL_ENTITY_POOL): EntitySnapshotPoolStats {
  poolIndex = 0;
  const retained = Math.max(INITIAL_ENTITY_POOL, Math.floor(maxRetained));
  if (pool.length > retained) {
    pool.length = retained;
  }
  while (pool.length < INITIAL_ENTITY_POOL) {
    pool.push(createPooledEntry());
  }
  resetEntitySnapshotWireSource();
  return getEntitySnapshotPoolStats();
}

export function registerEntitySnapshotWireSource(
  entities: NetworkServerSnapshotEntity[],
  source: EntitySnapshotWireSource = entityWireSource,
): void {
  entityWireSources.set(entities, source);
}

export function getEntitySnapshotWireSource(
  entities: readonly NetworkServerSnapshotEntity[],
): EntitySnapshotWireSource | undefined {
  return entityWireSources.get(entities);
}

export function unregisterEntitySnapshotWireSource(
  entities: readonly NetworkServerSnapshotEntity[],
): void {
  entityWireSources.delete(entities);
}

function resetEntitySnapshotWireSource(): void {
  entityWireSource.count = 0;
  entityWireSource.typedPlaceholderRows = 0;
  entityWireSource.nonPlaceholderEntityRows = 0;
  entityWireSource.typedEntityRows = 0;
  entityWireSource.rawEntityRows = 0;
  entityWireSource.basicChangedFieldsOr = 0;
  entityWireSource.unitChangedFieldsOr = 0;
  entityWireSource.buildingChangedFieldsOr = 0;
  entityWireSource.basicRows.count = 0;
  entityWireSource.unitRows.count = 0;
  entityWireSource.buildingRows.count = 0;
  entityWireSource.actionRows.count = 0;
  entityWireSource.actionStrings.length = 0;
  entityWireSource.turretRows.count = 0;
  entityWireSource.factorySelectedUnitRows.count = 0;
  entityWireSource.waypointRows.count = 0;
  entityWireSource.waypointStrings.length = 0;
}

function fireStateToWireCode(value: UnitSub['fireState']): number {
  return value === 'holdFire' ? 2 : value === 'returnFire' ? 1 : 0;
}

function trajectoryModeToWireCode(value: UnitSub['trajectoryMode']): number {
  return value === 'auto' ? 2 : value === 'high' ? 1 : 0;
}

function moveStateToWireCode(value: UnitSub['moveState']): number {
  return value === 'roam' ? 2 : value === 'holdPosition' ? 1 : 0;
}

function canReferenceSnapshotEntityId(
  world: WorldState,
  visibility: SnapshotVisibility | undefined,
  id: number | undefined,
): boolean {
  return id === undefined || visibility === undefined || visibility.canReferenceEntityId(world, id);
}

function appendDirectBasicEntityWireRow(
  entity: Entity,
  changedFields: number | undefined,
  typedPlaceholder = false,
): void {
  const rows = entityWireSource.basicRows;
  const rowIndex = reserveFloat64WireRows(rows, 1, ENTITY_SNAPSHOT_WIRE_BASIC_STRIDE);
  const values = rows.values;
  const base = rowIndex * ENTITY_SNAPSHOT_WIRE_BASIC_STRIDE;
  const isFull = changedFields === undefined;
  const changedMask = changedFields ?? 0;
  const ownership = entity.ownership;
  values[base + 0] = entity.id;
  values[base + 1] = entity.type === 'unit'
    ? ENTITY_SNAPSHOT_WIRE_TYPE_UNIT
    : ENTITY_SNAPSHOT_WIRE_TYPE_BUILDING;
  values[base + 2] = isFull || (changedMask & ENTITY_CHANGED_POS) ? qPos(entity.transform.x) : 0;
  values[base + 3] = isFull || (changedMask & ENTITY_CHANGED_POS) ? qPos(entity.transform.y) : 0;
  values[base + 4] = isFull || (changedMask & ENTITY_CHANGED_POS) ? qPos(entity.transform.z) : 0;
  values[base + 5] = isFull || (changedMask & ENTITY_CHANGED_ROT) ? qRot(entity.transform.rotation) : 0;
  values[base + 6] = ownership !== null ? ownership.playerId : 1;
  values[base + 7] = isFull ? 0 : 1;
  values[base + 8] = changedFields ?? 0;
  appendEntitySnapshotWireSourceRow(
    entityWireSource,
    ENTITY_SNAPSHOT_WIRE_KIND_BASIC,
    rowIndex,
    typedPlaceholder,
    changedFields ?? 0,
  );
}

function appendDirectActionWireRows(
  entity: Entity,
  world: WorldState,
  visibility: SnapshotVisibility | undefined,
): { offset: number; count: number } {
  const actions = entity.unit?.actions ?? [];
  const count = actions.length;
  if (count === 0) return { offset: -1, count: 0 };
  const rows = entityWireSource.actionRows;
  const offset = reserveFloat64WireRows(rows, count, ENTITY_SNAPSHOT_WIRE_ACTION_STRIDE);
  const values = rows.values;
  const strings = entityWireSource.actionStrings;
  for (let i = 0; i < count; i++) {
    const action = actions[i];
    const base = (offset + i) * ENTITY_SNAPSHOT_WIRE_ACTION_STRIDE;
    values[base + 0] = actionTypeToCode(action.type);
    values[base + 1] = action.x !== undefined ? 1 : 0;
    values[base + 2] = action.x ?? 0;
    values[base + 3] = action.y ?? 0;
    values[base + 4] = action.z !== undefined ? 1 : 0;
    values[base + 5] = action.z ?? 0;
    values[base + 6] = action.isPathExpansion === true ? 1 : 0;
    const targetId = canReferenceSnapshotEntityId(world, visibility, action.targetId)
      ? action.targetId
      : undefined;
    values[base + 7] = targetId !== undefined ? 1 : 0;
    values[base + 8] = targetId ?? 0;
    values[base + 9] = action.buildingBlueprintId !== undefined ? 1 : 0;
    values[base + 10] = action.buildingBlueprintId !== undefined ? strings.length : 0;
    if (action.buildingBlueprintId !== undefined) strings.push(action.buildingBlueprintId);
    values[base + 11] = action.gridX !== undefined ? 1 : 0;
    values[base + 12] = action.gridX ?? 0;
    values[base + 13] = action.gridY ?? 0;
    const buildingId = canReferenceSnapshotEntityId(world, visibility, action.buildingId)
      ? action.buildingId
      : undefined;
    values[base + 14] = buildingId !== undefined ? 1 : 0;
    values[base + 15] = buildingId ?? 0;
    values[base + 16] = action.waitGather === true ? 1 : 0;
    values[base + 17] = action.waitGroupId !== undefined ? 1 : 0;
    values[base + 18] = action.waitGroupId ?? 0;
  }
  return { offset, count };
}

function appendDirectTurretWireRows(
  entity: Entity,
  world: WorldState,
  visibility: SnapshotVisibility | undefined,
  canSeePrivateDetails: boolean,
): { offset: number; count: number } {
  const combat = entity.combat;
  const turrets = combat !== null ? combat.turrets : undefined;
  const count = turrets !== undefined ? turrets.length : 0;
  if (count === 0) return { offset: -1, count: 0 };
  const rows = entityWireSource.turretRows;
  const offset = reserveFloat64WireRows(rows, count, ENTITY_SNAPSHOT_WIRE_TURRET_STRIDE);
  const values = rows.values;
  for (let i = 0; i < count; i++) {
    const src = turrets![i];
    const base = (offset + i) * ENTITY_SNAPSHOT_WIRE_TURRET_STRIDE;
    if (!turretAimMotionIsSnapshotVisible(src)) {
      values[base + 0] = 0;
      values[base + 1] = 0;
      values[base + 2] = 0;
      values[base + 3] = 0;
    } else {
      values[base + 0] = qRot(src.rotation);
      values[base + 1] = qRot(src.angularVelocity);
      values[base + 2] = qRot(src.pitch);
      values[base + 3] = qRot(src.pitchVelocity);
    }
    const hasTargetingFsm = readCombatTargetingTurretFsmInto(entity, i, _directTurretFsm);
    const targetId = hasTargetingFsm ? _directTurretFsm.targetId : (src.target ?? -1);
    const wireTargetId = targetId === -1 ? undefined : targetId;
    const canSendTarget = canSeePrivateDetails &&
      canReferenceSnapshotEntityId(world, visibility, wireTargetId);
    values[base + 4] = turretBlueprintIdToCode(src.config.turretBlueprintId);
    values[base + 5] = hasTargetingFsm ? _directTurretFsm.stateCode : turretStateToCode(src.state);
    values[base + 6] = canSendTarget && wireTargetId !== undefined ? 1 : 0;
    values[base + 7] = canSendTarget ? wireTargetId ?? 0 : 0;
    values[base + 8] = src.shield !== null ? 1 : 0;
    values[base + 9] = src.shield !== null ? src.shield.range : 0;
    values[base + 10] = turretShouldEncodeInactive(src, targetId) ? 1 : 0;
  }
  return { offset, count };
}

function appendDirectFactorySelectedUnitWireRow(entity: Entity): { offset: number; hasValue: number } {
  const selectedUnitBlueprintId = entity.factory?.selectedUnitBlueprintId;
  if (selectedUnitBlueprintId === null || selectedUnitBlueprintId === undefined) {
    return { offset: -1, hasValue: 0 };
  }
  const rows = entityWireSource.factorySelectedUnitRows;
  const offset = reserveUint32WireRows(rows, 1, 1);
  rows.values[offset] = unitBlueprintIdToCode(selectedUnitBlueprintId);
  return { offset, hasValue: 1 };
}

function appendDirectFactoryQueueWireRows(entity: Entity): { offset: number; count: number } {
  const factory = entity.factory;
  if (factory === null) return { offset: -1, count: -1 };
  const queue = encodeFactoryProductionQueue(factory.productionQueue);
  if (queue === null) return { offset: -1, count: -1 };
  if (queue.length === 0) return { offset: -1, count: 0 };
  const rows = entityWireSource.factorySelectedUnitRows;
  const offset = reserveUint32WireRows(rows, queue.length, 1);
  for (let i = 0; i < queue.length; i++) rows.values[offset + i] = queue[i];
  return { offset, count: queue.length };
}

function appendDirectFactoryRallyWireRow(entity: Entity): number {
  const factory = entity.factory;
  if (factory === null) return -1;
  const rows = entityWireSource.waypointRows;
  const offset = reserveFloat64WireRows(rows, 1, ENTITY_SNAPSHOT_WIRE_WAYPOINT_STRIDE);
  const values = rows.values;
  const strings = entityWireSource.waypointStrings;
  const base = offset * ENTITY_SNAPSHOT_WIRE_WAYPOINT_STRIDE;
  values[base + 0] = factory.rallyX;
  values[base + 1] = factory.rallyY;
  values[base + 2] = factory.rallyZ !== null && factory.rallyZ !== undefined ? 1 : 0;
  values[base + 3] = factory.rallyZ ?? 0;
  values[base + 4] = strings.length;
  strings.push(factory.rallyType);
  return offset;
}

function appendDirectFactoryRouteWireRows(entity: Entity): { offset: number; count: number } {
  const defaultWaypoints = entity.factory?.defaultWaypoints;
  if (defaultWaypoints === null || defaultWaypoints === undefined || defaultWaypoints.length <= 1) {
    return { offset: -1, count: -1 };
  }
  const rows = entityWireSource.waypointRows;
  const offset = reserveFloat64WireRows(rows, defaultWaypoints.length, ENTITY_SNAPSHOT_WIRE_WAYPOINT_STRIDE);
  const values = rows.values;
  const strings = entityWireSource.waypointStrings;
  for (let i = 0; i < defaultWaypoints.length; i++) {
    const waypoint = defaultWaypoints[i];
    const base = (offset + i) * ENTITY_SNAPSHOT_WIRE_WAYPOINT_STRIDE;
    values[base + 0] = waypoint.x;
    values[base + 1] = waypoint.y;
    values[base + 2] = waypoint.z !== null && waypoint.z !== undefined ? 1 : 0;
    values[base + 3] = waypoint.z ?? 0;
    values[base + 4] = strings.length;
    strings.push(waypoint.type);
  }
  return { offset, count: defaultWaypoints.length };
}

function appendDirectUnitEntityWireRow(
  entity: Entity,
  changedFields: number | undefined,
  world: WorldState,
  visibility: SnapshotVisibility | undefined,
  typedPlaceholder = false,
): void {
  const unit = entity.unit!;
  const rows = entityWireSource.unitRows;
  const rowIndex = reserveFloat64WireRows(rows, 1, ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE);
  const values = rows.values;
  const base = rowIndex * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
  const isFull = changedFields === undefined;
  const changedMask = changedFields ?? 0;
  const ownership = entity.ownership;
  const canSeePrivateDetails = visibility !== undefined
    ? visibility.canSeePrivateEntityDetails(entity)
    : true;
  const shouldEmitActions = canSeePrivateDetails &&
    (isFull || (changedMask & ENTITY_CHANGED_ACTIONS) !== 0);
  const shouldEmitTurrets = entity.combat !== null &&
    entity.combat.turrets.length > 0 &&
    (isFull || (changedMask & ENTITY_CHANGED_TURRETS) !== 0);
  const actionRows = shouldEmitActions
    ? appendDirectActionWireRows(entity, world, visibility)
    : { offset: -1, count: 0 };
  const turretRows = shouldEmitTurrets
    ? appendDirectTurretWireRows(entity, world, visibility, canSeePrivateDetails)
    : { offset: -1, count: 0 };
  const hasPos = isFull || (changedMask & ENTITY_CHANGED_POS) !== 0;
  const hasRot = isFull || (changedMask & ENTITY_CHANGED_ROT) !== 0;
  const hasHp = isFull || (changedMask & ENTITY_CHANGED_HP) !== 0;
  const hasVel = isFull || (changedMask & ENTITY_CHANGED_VEL) !== 0;
  const hasNormal = isFull || (changedMask & ENTITY_CHANGED_NORMAL) !== 0;
  const hasBuild = (isFull || (changedMask & ENTITY_CHANGED_BUILDING) !== 0) && entity.buildable !== null;
  const hasBuildTarget = canSeePrivateDetails &&
    entity.builder !== null &&
    (isFull || (changedMask & ENTITY_CHANGED_ACTIONS) !== 0);
  const buildTargetId = hasBuildTarget ? entity.builder!.currentBuildTarget : NO_ENTITY_ID;
  const canSendBuildTarget = hasBuildTarget &&
    buildTargetId !== NO_ENTITY_ID &&
    canReferenceSnapshotEntityId(world, visibility, buildTargetId);
  const surfaceNormal = unit.surfaceNormal;
  const orientation = unit.orientation;
  const angularVelocity = unit.angularVelocity3;
  const buildable = entity.buildable;
  const combatModeChanged = isFull || (changedMask & ENTITY_CHANGED_COMBAT_MODE) !== 0;
  const trajectoryMode = entity.combat?.trajectoryMode ?? 'auto';
  const hasTrajectoryMode = entity.combat !== null &&
    combatModeChanged &&
    (trajectoryMode !== 'auto' || !isFull);
  const hasRepeatQueue = shouldEmitActions && (unit.repeatQueue === true || !isFull);
  const hasMoveState = shouldEmitActions && (unit.moveState !== 'maneuver' || !isFull);
  const hasHoldPosition = shouldEmitActions && (unit.moveState === 'holdPosition' || !isFull);
  const hasWantCloak = shouldEmitActions && (unit.wantCloak === true || !isFull);
  const hasCloaked = combatModeChanged && (unit.cloaked === true || !isFull);
  const hasCloakState = hasWantCloak || hasCloaked;

  values[base + 0] = entity.id;
  values[base + 1] = hasPos ? qPos(entity.transform.x) : 0;
  values[base + 2] = hasPos ? qPos(entity.transform.y) : 0;
  values[base + 3] = hasPos ? qPos(entity.transform.z) : 0;
  values[base + 4] = hasRot ? qRot(entity.transform.rotation) : 0;
  values[base + 5] = ownership !== null ? ownership.playerId : 1;
  values[base + 6] = isFull ? 0 : 1;
  values[base + 7] = changedFields ?? 0;
  values[base + 8] = hasHp ? unit.hp : 0;
  values[base + 9] = hasHp ? unit.maxHp : 0;
  values[base + 10] = hasVel ? qVel(unit.velocityX ?? 0) : 0;
  values[base + 11] = hasVel ? qVel(unit.velocityY ?? 0) : 0;
  values[base + 12] = hasVel ? qVel(unit.velocityZ ?? 0) : 0;
  values[base + 13] = isFull ? 1 : 0;
  values[base + 14] = isFull ? unitBlueprintIdToCode(unit.unitBlueprintId) : 0;
  values[base + 15] = 0;
  values[base + 16] = 0;
  values[base + 17] = 0;
  values[base + 18] = 0;
  values[base + 19] = 0;
  values[base + 20] = 0;
  values[base + 21] = 0;
  values[base + 22] = 0;
  values[base + 23] = hasNormal ? 1 : 0;
  values[base + 24] = hasNormal ? qNormal(surfaceNormal.nx) : 0;
  values[base + 25] = hasNormal ? qNormal(surfaceNormal.ny) : 0;
  values[base + 26] = hasNormal ? qNormal(surfaceNormal.nz) : 0;
  values[base + 27] = orientation !== null && hasRot ? 1 : 0;
  values[base + 28] = orientation !== null && hasRot ? orientation.x : 0;
  values[base + 29] = orientation !== null && hasRot ? orientation.y : 0;
  values[base + 30] = orientation !== null && hasRot ? orientation.z : 0;
  values[base + 31] = orientation !== null && hasRot ? orientation.w : 0;
  values[base + 32] = orientation !== null && hasVel && angularVelocity !== null && angularVelocity !== undefined ? 1 : 0;
  values[base + 33] = orientation !== null && hasVel && angularVelocity !== null && angularVelocity !== undefined ? angularVelocity.x : 0;
  values[base + 34] = orientation !== null && hasVel && angularVelocity !== null && angularVelocity !== undefined ? angularVelocity.y : 0;
  values[base + 35] = orientation !== null && hasVel && angularVelocity !== null && angularVelocity !== undefined ? angularVelocity.z : 0;
  const fireState = entity.combat?.fireState ??
    (entity.combat?.fireEnabled === false ? 'holdFire' : 'fireAtWill');
  values[base + 36] = combatModeChanged && fireState === 'holdFire'
    ? 1
    : 0;
  values[base + 37] = isFull && isCommander(entity) ? 1 : 0;
  values[base + 38] = hasBuildTarget ? 1 : 0;
  values[base + 39] = hasBuildTarget && !canSendBuildTarget ? 1 : 0;
  values[base + 40] = canSendBuildTarget ? buildTargetId : 0;
  values[base + 41] = shouldEmitActions ? 1 : 0;
  values[base + 42] = shouldEmitActions ? actionRows.count : 0;
  values[base + 43] = shouldEmitTurrets ? 1 : 0;
  values[base + 44] = shouldEmitTurrets ? turretRows.count : 0;
  values[base + 45] = hasBuild ? 1 : 0;
  values[base + 46] = hasBuild && buildable!.isComplete === true ? 1 : 0;
  values[base + 47] = hasBuild ? buildable!.paid.energy : 0;
  values[base + 48] = hasBuild ? buildable!.paid.metal : 0;
  values[base + 49] = turretRows.offset;
  values[base + 50] = actionRows.offset;
  values[base + 51] = combatModeChanged && entity.combat !== null && fireState !== 'fireAtWill' ? 1 : 0;
  values[base + 52] = fireStateToWireCode(fireState);
  values[base + 53] = hasRepeatQueue ? 1 : 0;
  values[base + 54] = unit.repeatQueue === true ? 1 : 0;
  values[base + 55] = hasHoldPosition ? 1 : 0;
  values[base + 56] = unit.moveState === 'holdPosition' ? 1 : 0;
  values[base + 57] = hasTrajectoryMode ? 1 : 0;
  values[base + 58] = trajectoryModeToWireCode(trajectoryMode);
  values[base + 59] = hasMoveState ? 1 : 0;
  values[base + 60] = moveStateToWireCode(unit.moveState);
  values[base + 61] = hasCloakState ? 1 : 0;
  values[base + 62] = unit.cloaked === true ? 2 : unit.wantCloak === true ? 1 : 0;
  values[base + 63] = hasBuild && buildable!.isInterrupted === true ? 1 : 0;
  appendEntitySnapshotWireSourceRow(
    entityWireSource,
    ENTITY_SNAPSHOT_WIRE_KIND_UNIT,
    rowIndex,
    typedPlaceholder,
    changedFields ?? 0,
  );
}

export function appendUnitMotionEntityWireRowDirectFromState(
  views: EntityStateViews,
  slot: number,
  changedFields: number = TYPED_PLACEHOLDER_UNIT_MOTION_FIELDS,
): boolean {
  if (slot < 0 || slot >= views.capacity) return false;
  if (views.kind[slot] !== ENTITY_STATE_KIND_UNIT) return false;
  const entityId = views.entityId[slot];
  if (entityId < 0) return false;
  if (changedFields === 0 || (changedFields & ~TYPED_PLACEHOLDER_UNIT_SLAB_FIELDS) !== 0) {
    return false;
  }
  const motionFlags = views.unitMotionFlags[slot];
  const changedMask = changedFields;
  const hasPos = (changedMask & ENTITY_CHANGED_POS) !== 0;
  const hasRot = (changedMask & ENTITY_CHANGED_ROT) !== 0;
  const hasVel = (changedMask & ENTITY_CHANGED_VEL) !== 0;
  const hasNormal = (changedMask & ENTITY_CHANGED_NORMAL) !== 0;
  const hasHp = (changedMask & ENTITY_CHANGED_HP) !== 0;
  const hasBuild = (changedMask & ENTITY_CHANGED_BUILDING) !== 0;
  if (hasNormal && (motionFlags & ENTITY_SLOT_UNIT_MOTION_HAS_SURFACE_NORMAL) === 0) {
    return false;
  }

  const rows = entityWireSource.unitRows;
  const rowIndex = reserveFloat64WireRows(rows, 1, ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE);
  const values = rows.values;
  const base = rowIndex * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
  values.fill(0, base + 13, base + 23);
  values.fill(0, base + 36, base + ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE);

  const hasOrientation =
    hasRot &&
    (motionFlags & ENTITY_SLOT_UNIT_MOTION_HAS_ORIENTATION) !== 0;
  const hasAngularVelocity =
    hasVel &&
    (motionFlags & ENTITY_SLOT_UNIT_MOTION_HAS_ANGULAR_VELOCITY) !== 0;
  const ownerPlayerId = views.ownerPlayerId[slot];
  const buildFlags = hasBuild ? views.buildFlags[slot] : 0;
  const hasBuildPayload = hasBuild &&
    (buildFlags & ENTITY_SLOT_BUILD_FLAG_HAS_BUILDABLE) !== 0;

  values[base + 0] = entityId;
  values[base + 1] = hasPos ? qPos(views.posX[slot]) : 0;
  values[base + 2] = hasPos ? qPos(views.posY[slot]) : 0;
  values[base + 3] = hasPos ? qPos(views.posZ[slot]) : 0;
  values[base + 4] = hasRot ? qRot(views.rotation[slot]) : 0;
  values[base + 5] = ownerPlayerId !== 0 ? ownerPlayerId : 1;
  values[base + 6] = 1;
  values[base + 7] = changedFields;
  values[base + 8] = hasHp ? views.hp[slot] : 0;
  values[base + 9] = hasHp ? views.maxHp[slot] : 0;
  values[base + 10] = hasVel ? qVel(views.velX[slot]) : 0;
  values[base + 11] = hasVel ? qVel(views.velY[slot]) : 0;
  values[base + 12] = hasVel ? qVel(views.velZ[slot]) : 0;
  values[base + 23] = hasNormal ? 1 : 0;
  values[base + 24] = hasNormal ? qNormal(views.surfaceNormalX[slot]) : 0;
  values[base + 25] = hasNormal ? qNormal(views.surfaceNormalY[slot]) : 0;
  values[base + 26] = hasNormal ? qNormal(views.surfaceNormalZ[slot]) : 0;
  values[base + 27] = hasOrientation ? 1 : 0;
  values[base + 28] = hasOrientation ? views.orientationX[slot] : 0;
  values[base + 29] = hasOrientation ? views.orientationY[slot] : 0;
  values[base + 30] = hasOrientation ? views.orientationZ[slot] : 0;
  values[base + 31] = hasOrientation ? views.orientationW[slot] : 0;
  values[base + 32] = hasAngularVelocity ? 1 : 0;
  values[base + 33] = hasAngularVelocity ? views.angularVelocityX[slot] : 0;
  values[base + 34] = hasAngularVelocity ? views.angularVelocityY[slot] : 0;
  values[base + 35] = hasAngularVelocity ? views.angularVelocityZ[slot] : 0;
  values[base + 45] = hasBuildPayload ? 1 : 0;
  values[base + 46] = hasBuildPayload && (buildFlags & ENTITY_SLOT_BUILD_FLAG_COMPLETE) !== 0 ? 1 : 0;
  values[base + 47] = hasBuildPayload ? views.buildPaidEnergy[slot] : 0;
  values[base + 48] = hasBuildPayload ? views.buildPaidMetal[slot] : 0;
  values[base + 63] = hasBuildPayload && (buildFlags & ENTITY_SLOT_BUILD_FLAG_INTERRUPTED) !== 0 ? 1 : 0;

  appendEntitySnapshotWireSourceRow(
    entityWireSource,
    ENTITY_SNAPSHOT_WIRE_KIND_UNIT,
    rowIndex,
    true,
    changedFields,
  );
  return true;
}

export function appendBasicEntityWireRowDirectFromState(
  views: EntityStateViews,
  slot: number,
  changedFields: number,
): boolean {
  if (slot < 0 || slot >= views.capacity) return false;
  if (
    changedFields === 0 ||
    (changedFields & ~(ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT)) !== 0
  ) {
    return false;
  }
  const kind = views.kind[slot];
  let typeCode = 0;
  if (kind === ENTITY_STATE_KIND_UNIT) typeCode = ENTITY_SNAPSHOT_WIRE_TYPE_UNIT;
  else if (kind === ENTITY_STATE_KIND_BUILDING || kind === ENTITY_STATE_KIND_TOWER) {
    typeCode = ENTITY_SNAPSHOT_WIRE_TYPE_BUILDING;
  } else {
    return false;
  }
  const entityId = views.entityId[slot];
  if (entityId < 0) return false;

  const rows = entityWireSource.basicRows;
  const rowIndex = reserveFloat64WireRows(rows, 1, ENTITY_SNAPSHOT_WIRE_BASIC_STRIDE);
  const values = rows.values;
  const base = rowIndex * ENTITY_SNAPSHOT_WIRE_BASIC_STRIDE;
  const hasPos = (changedFields & ENTITY_CHANGED_POS) !== 0;
  const hasRot = (changedFields & ENTITY_CHANGED_ROT) !== 0;
  const ownerPlayerId = views.ownerPlayerId[slot];

  values[base + 0] = entityId;
  values[base + 1] = typeCode;
  values[base + 2] = hasPos ? qPos(views.posX[slot]) : 0;
  values[base + 3] = hasPos ? qPos(views.posY[slot]) : 0;
  values[base + 4] = hasPos ? qPos(views.posZ[slot]) : 0;
  values[base + 5] = hasRot ? qRot(views.rotation[slot]) : 0;
  values[base + 6] = ownerPlayerId !== 0 ? ownerPlayerId : 1;
  values[base + 7] = 1;
  values[base + 8] = changedFields;

  appendEntitySnapshotWireSourceRow(
    entityWireSource,
    ENTITY_SNAPSHOT_WIRE_KIND_BASIC,
    rowIndex,
    true,
    changedFields,
  );
  return true;
}

export function appendBuildingHotEntityWireRowDirectFromState(
  views: EntityStateViews,
  slot: number,
  changedFields: number,
): boolean {
  if (slot < 0 || slot >= views.capacity) return false;
  const kind = views.kind[slot];
  if (kind !== ENTITY_STATE_KIND_BUILDING && kind !== ENTITY_STATE_KIND_TOWER) return false;
  const entityId = views.entityId[slot];
  if (entityId < 0) return false;
  if (
    changedFields === 0 ||
    (changedFields & ~TYPED_PLACEHOLDER_BUILDING_SLAB_FIELDS) !== 0
  ) {
    return false;
  }
  const hasBuild = (changedFields & ENTITY_CHANGED_BUILDING) !== 0;
  if (
    hasBuild &&
    BUILDING_ACTIVE_STATE_BLUEPRINT_CODES.has(views.buildingBlueprintCode[slot])
  ) {
    return false;
  }

  const rows = entityWireSource.buildingRows;
  const rowIndex = reserveFloat64WireRows(rows, 1, ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE);
  const values = rows.values;
  const base = rowIndex * ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE;
  values.fill(0, base + 8, base + 13);
  values.fill(0, base + 15, base + ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE);

  const hasPos = (changedFields & ENTITY_CHANGED_POS) !== 0;
  const hasRot = (changedFields & ENTITY_CHANGED_ROT) !== 0;
  const hasHp = (changedFields & ENTITY_CHANGED_HP) !== 0;
  const ownerPlayerId = views.ownerPlayerId[slot];
  const buildFlags = hasBuild ? views.buildFlags[slot] : 0;
  const hasBuildable = (buildFlags & ENTITY_SLOT_BUILD_FLAG_HAS_BUILDABLE) !== 0;

  values[base + 0] = entityId;
  values[base + 1] = hasPos ? qPos(views.posX[slot]) : 0;
  values[base + 2] = hasPos ? qPos(views.posY[slot]) : 0;
  values[base + 3] = hasPos ? qPos(views.posZ[slot]) : 0;
  values[base + 4] = hasRot ? qRot(views.rotation[slot]) : 0;
  values[base + 5] = ownerPlayerId !== 0 ? ownerPlayerId : 1;
  values[base + 6] = 1;
  values[base + 7] = changedFields;
  values[base + 13] = hasHp ? views.hp[slot] : 0;
  values[base + 14] = hasHp ? views.maxHp[slot] : 0;
  values[base + 15] = hasBuild && (buildFlags & ENTITY_SLOT_BUILD_FLAG_COMPLETE) !== 0 ? 1 : 0;
  values[base + 16] = hasBuild && hasBuildable ? views.buildPaidEnergy[slot] : 0;
  values[base + 17] = hasBuild && hasBuildable ? views.buildPaidMetal[slot] : 0;
  values[base + 34] = hasBuild && (buildFlags & ENTITY_SLOT_BUILD_FLAG_INTERRUPTED) !== 0 ? 1 : 0;

  appendEntitySnapshotWireSourceRow(
    entityWireSource,
    ENTITY_SNAPSHOT_WIRE_KIND_BUILDING,
    rowIndex,
    true,
    changedFields,
  );
  return true;
}

function appendDirectBuildingEntityWireRow(
  entity: Entity,
  changedFields: number | undefined,
  world: WorldState,
  visibility: SnapshotVisibility | undefined,
  typedPlaceholder = false,
): void {
  const building = entity.building!;
  const rows = entityWireSource.buildingRows;
  const rowIndex = reserveFloat64WireRows(rows, 1, ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE);
  const values = rows.values;
  const base = rowIndex * ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE;
  const isFull = changedFields === undefined;
  const changedMask = changedFields ?? 0;
  const ownership = entity.ownership;
  const canSeePrivateDetails = visibility !== undefined
    ? visibility.canSeePrivateEntityDetails(entity)
    : true;
  const shouldEmitTurrets = entity.combat !== null &&
    entity.combat.turrets.length > 0 &&
    (isFull || (changedMask & ENTITY_CHANGED_TURRETS) !== 0);
  const shouldEmitFactory = canSeePrivateDetails &&
    entity.factory !== null &&
    (isFull || (changedMask & ENTITY_CHANGED_FACTORY) !== 0);
  const turretRows = shouldEmitTurrets
    ? appendDirectTurretWireRows(entity, world, visibility, canSeePrivateDetails)
    : { offset: -1, count: 0 };
  const factorySelectedUnit = shouldEmitFactory
    ? appendDirectFactorySelectedUnitWireRow(entity)
    : { offset: -1, hasValue: 0 };
  const factoryRallyOffset = shouldEmitFactory ? appendDirectFactoryRallyWireRow(entity) : -1;
  const factoryQueue = shouldEmitFactory
    ? appendDirectFactoryQueueWireRows(entity)
    : { offset: -1, count: -1 };
  const factoryRoute = shouldEmitFactory
    ? appendDirectFactoryRouteWireRows(entity)
    : { offset: -1, count: -1 };
  const hasPos = isFull || (changedMask & ENTITY_CHANGED_POS) !== 0;
  const hasRot = isFull || (changedMask & ENTITY_CHANGED_ROT) !== 0;
  const hasHp = isFull || (changedMask & ENTITY_CHANGED_HP) !== 0;
  const hasBuild = isFull || (changedMask & ENTITY_CHANGED_BUILDING) !== 0;
  const buildable = entity.buildable;
  const activeState = building.activeState;
  const factory = entity.factory;
  let factoryProgress = 0;
  if (shouldEmitFactory && factory !== null) {
    if (factory.currentShellId != null) {
      const shell = world.getEntity(factory.currentShellId);
      factoryProgress = shell !== undefined && shell.buildable !== null
        ? getBuildFraction(shell.buildable)
        : factory.currentBuildProgress;
    } else {
      factoryProgress = 0;
    }
  }

  values[base + 0] = entity.id;
  values[base + 1] = hasPos ? qPos(entity.transform.x) : 0;
  values[base + 2] = hasPos ? qPos(entity.transform.y) : 0;
  values[base + 3] = hasPos ? qPos(entity.transform.z) : 0;
  values[base + 4] = hasRot ? qRot(entity.transform.rotation) : 0;
  values[base + 5] = ownership !== null ? ownership.playerId : 1;
  values[base + 6] = isFull ? 0 : 1;
  values[base + 7] = changedFields ?? 0;
  values[base + 8] = isFull && entity.buildingBlueprintId !== null ? 1 : 0;
  values[base + 9] = isFull && entity.buildingBlueprintId !== null
    ? buildingBlueprintIdToCode(entity.buildingBlueprintId)
    : 0;
  values[base + 10] = isFull ? 1 : 0;
  values[base + 11] = isFull ? building.width : 0;
  values[base + 12] = isFull ? building.height : 0;
  values[base + 13] = hasHp ? building.hp : 0;
  values[base + 14] = hasHp ? building.maxHp : 0;
  values[base + 15] = hasBuild && (buildable === null || buildable.isComplete) ? 1 : 0;
  values[base + 16] = hasBuild && buildable !== null ? buildable.paid.energy : 0;
  values[base + 17] = hasBuild && buildable !== null ? buildable.paid.metal : 0;
  values[base + 18] = (
    (isFull || (changedMask & ENTITY_CHANGED_BUILDING) !== 0) &&
    isMetalExtractorBlueprintId(entity.buildingBlueprintId)
  ) ? 1 : 0;
  values[base + 19] = values[base + 18] !== 0 ? entity.metalExtractionRate ?? 0 : 0;
  values[base + 20] = hasBuild && activeState !== null ? 1 : 0;
  values[base + 21] = hasBuild && activeState !== null && activeState.open === true ? 1 : 0;
  values[base + 22] = shouldEmitTurrets ? 1 : 0;
  values[base + 23] = shouldEmitTurrets ? turretRows.count : 0;
  values[base + 24] = shouldEmitFactory ? 1 : 0;
  values[base + 25] = shouldEmitFactory ? factorySelectedUnit.hasValue : 0;
  values[base + 26] = shouldEmitFactory ? factoryProgress : 0;
  values[base + 27] = shouldEmitFactory && factory!.isProducing === true ? 1 : 0;
  values[base + 28] = shouldEmitFactory ? factory!.energyRateFraction : 0;
  values[base + 29] = shouldEmitFactory ? factory!.metalRateFraction : 0;
  values[base + 30] = shouldEmitFactory ? 1 : 0;
  values[base + 31] = turretRows.offset;
  values[base + 32] = factorySelectedUnit.offset;
  values[base + 33] = factoryRallyOffset;
  values[base + 34] = hasBuild && buildable !== null && buildable.isInterrupted === true ? 1 : 0;
  values[base + 35] = shouldEmitFactory &&
    factory!.guardTargetId !== null &&
    factory!.guardTargetId !== undefined &&
    canReferenceSnapshotEntityId(world, visibility, factory!.guardTargetId)
    ? 1
    : 0;
  values[base + 36] = values[base + 35] !== 0 ? factory!.guardTargetId! : 0;
  values[base + 37] = shouldEmitFactory && factory!.repeatProduction === false ? 0 : 1;
  values[base + 38] = factoryQueue.offset;
  values[base + 39] = factoryQueue.count;
  values[base + 40] = factoryRoute.offset;
  values[base + 41] = factoryRoute.count;
  appendEntitySnapshotWireSourceRow(
    entityWireSource,
    ENTITY_SNAPSHOT_WIRE_KIND_BUILDING,
    rowIndex,
    typedPlaceholder,
    changedFields ?? 0,
  );
}

export function appendEntitySnapshotWireRowDirect(
  entity: Entity,
  changedFields: number | undefined,
  world: WorldState,
  visibility: SnapshotVisibility | undefined = undefined,
  typedPlaceholder = false,
): void {
  const isFull = changedFields === undefined;
  const changedMask = changedFields ?? 0;
  if (entity.type === 'unit' && entity.unit !== null) {
    const unitFieldMask = ENTITY_CHANGED_VEL | ENTITY_CHANGED_HP |
      ENTITY_CHANGED_ACTIONS | ENTITY_CHANGED_TURRETS |
      ENTITY_CHANGED_BUILDING;
    const hasSurfaceNormalFields = isFull || (changedMask & ENTITY_CHANGED_NORMAL) !== 0;
    const hasOrientationFields = entity.unit.orientation !== null &&
      (isFull || (changedMask & ENTITY_CHANGED_ROT) !== 0);
    const hasAngularVelocityFields = entity.unit.orientation !== null &&
      (isFull || (changedMask & ENTITY_CHANGED_VEL) !== 0);
    const hasUnitFields = isFull ||
      (changedMask & unitFieldMask) !== 0 ||
      hasSurfaceNormalFields ||
      hasOrientationFields ||
      hasAngularVelocityFields;
    if (hasUnitFields) {
      appendDirectUnitEntityWireRow(entity, changedFields, world, visibility, typedPlaceholder);
      return;
    }
  } else if ((entity.type === 'building' || entity.type === 'tower') && entity.building !== null) {
    const buildingFieldMask = ENTITY_CHANGED_HP | ENTITY_CHANGED_BUILDING |
      ENTITY_CHANGED_FACTORY | ENTITY_CHANGED_TURRETS;
    if (isFull || (changedMask & buildingFieldMask) !== 0) {
      appendDirectBuildingEntityWireRow(entity, changedFields, world, visibility, typedPlaceholder);
      return;
    }
  }

  appendDirectBasicEntityWireRow(entity, changedFields, typedPlaceholder);
}

export function serializeEntitySnapshot(
  entity: Entity,
  changedFields: number | undefined,
  world: WorldState,
  visibility: SnapshotVisibility | undefined = undefined,
): NetworkServerSnapshotEntity | null {
  const poolEntry = getPooledEntry();
  const ne = poolEntry.entity;
  const isFull = changedFields === undefined;
  const canSeePrivateDetails = visibility !== undefined
    ? visibility.canSeePrivateEntityDetails(entity)
    : true;
  const canReferenceEntityId = (id: number | undefined): boolean =>
    id === undefined || visibility === undefined || visibility.canReferenceEntityId(world, id);

  ne.id = entity.id;
  ne.type = entity.type;
  ne.playerId = entity.ownership !== null ? entity.ownership.playerId : 1 as PlayerId;
  ne.changedFields = isFull ? null : changedFields;
  ne.pos = null;
  ne.rotation = null;

  if (isFull || (changedFields & ENTITY_CHANGED_POS)) {
    const pos = poolEntry.entityPos;
    pos.x = qPos(entity.transform.x);
    pos.y = qPos(entity.transform.y);
    pos.z = qPos(entity.transform.z);
    ne.pos = pos;
  }
  if (isFull || (changedFields & ENTITY_CHANGED_ROT)) {
    ne.rotation = qRot(entity.transform.rotation);
  }

  ne.unit = null;
  ne.building = null;

  if (entity.type === 'unit' && entity.unit) {
    const unitFieldMask = ENTITY_CHANGED_VEL | ENTITY_CHANGED_HP |
      ENTITY_CHANGED_ACTIONS | ENTITY_CHANGED_TURRETS |
      ENTITY_CHANGED_BUILDING;
    const hasSurfaceNormalFields = isFull ||
      (changedFields! & ENTITY_CHANGED_NORMAL);
    const hasOrientationFields = entity.unit.orientation !== null &&
      (isFull || (changedFields! & ENTITY_CHANGED_ROT));
    const hasAngularVelocityFields = entity.unit.orientation !== null &&
      (isFull || (changedFields! & ENTITY_CHANGED_VEL));
    const hasUnitFields = isFull ||
      (changedFields! & unitFieldMask) ||
      hasSurfaceNormalFields ||
      hasOrientationFields ||
      hasAngularVelocityFields;

    if (hasUnitFields) {
      const u = poolEntry.unitSub;
      ne.unit = u;
      u.hp = null;
      u.velocity = null;
      u.fireState = null;
      u.trajectoryMode = null;
      u.repeatQueue = null;
      u.moveState = null;
      u.holdPosition = null;
      u.wantCloak = null;
      u.cloaked = null;

      if (isFull) {
        writeNetworkUnitStaticFields(
          u,
          entity.unit,
          isCommander(entity),
        );
      } else {
        clearNetworkUnitStaticFields(u);
      }

      if (isFull || (changedFields! & ENTITY_CHANGED_VEL)) {
        // Linear velocity is motion/render state, not private detail: any
        // unit the recipient can fully see is updated and rendered
        // identically regardless of owner (see "Visible units render and
        // update identically" in budget_design_philosophy.html). Fog/vision
        // tiers still decide whether the unit appears at all; once it does,
        // its velocity rides the wire like position and orientation so enemy
        // aircraft bank and dead-reckon under the same prediction channels
        // as our own. Ownership gates only commanded intent (orders, turret
        // target IDs, build target, rally) below, never physical motion.
        u.velocity = poolEntry.unitVelocity;
        writeNetworkUnitVelocity(u, entity.unit, qVel);
      }

      if (
        isFull ||
        (changedFields! & ENTITY_CHANGED_NORMAL)
      ) {
        writeNetworkUnitSurfaceNormal(u, entity.unit, qNormal);
      } else {
        clearNetworkUnitSurfaceNormal(u);
      }
      // Orientation + angular velocity for entities that have one —
      // currently hover units. Ground units have these undefined on
      // the entity and we omit them from the wire entirely (MessagePack
      // drops undefined fields), so this adds zero overhead for the
      // vast majority of snapshots. Angular acceleration is not
      // shipped: instantaneous second derivative is unstable to
      // integrate under arbitrary client dt, and the per-channel
      // rotation-velocity EMA on the client already smooths approach
      // to a freshly-arrived target.
      const orient = entity.unit.orientation;
      if (orient && (isFull || (changedFields! & ENTITY_CHANGED_ROT))) {
        u.orientation = orient;
      } else {
        u.orientation = null;
      }
      if (orient && (isFull || (changedFields! & ENTITY_CHANGED_VEL))) {
        u.angularVelocity3 = entity.unit.angularVelocity3 ?? null;
      } else {
        u.angularVelocity3 = null;
      }

      if (isFull || (changedFields! & ENTITY_CHANGED_COMBAT_MODE)) {
        writeNetworkUnitCombatMode(u, entity);
        u.cloaked = entity.unit.cloaked === true
          ? true
          : isFull
            ? null
            : false;
        if (!isFull && entity.combat?.trajectoryMode === 'auto') {
          u.trajectoryMode = 'auto';
        }
      } else {
        clearNetworkUnitCombatMode(u);
        u.cloaked = null;
      }

      if (isFull || (changedFields! & ENTITY_CHANGED_HP)) {
        const hp = poolEntry.unitHp;
        hp.curr = entity.unit.hp;
        hp.max = entity.unit.maxHp;
        u.hp = hp;
      }

      u.build = null;
      if ((isFull || (changedFields! & ENTITY_CHANGED_BUILDING)) && entity.buildable) {
        const build = poolEntry.unitBuild;
        build.complete = entity.buildable.isComplete;
        build.interrupted = entity.buildable.isInterrupted;
        build.paid.energy = entity.buildable.paid.energy;
        build.paid.metal = entity.buildable.paid.metal;
        u.build = build;
      }

      clearNetworkUnitActions(u);
      if (canSeePrivateDetails && (isFull || (changedFields! & ENTITY_CHANGED_ACTIONS))) {
        writeNetworkUnitActions(u, entity.unit, poolEntry.actions, canReferenceEntityId);
        u.repeatQueue = entity.unit.repeatQueue === true
          ? true
          : isFull
            ? null
            : false;
        u.moveState = entity.unit.moveState !== 'maneuver'
          ? entity.unit.moveState
          : isFull
            ? null
            : 'maneuver';
        u.holdPosition = entity.unit.moveState === 'holdPosition'
          ? true
          : isFull
            ? null
            : false;
        u.wantCloak = entity.unit.wantCloak === true
          ? true
          : isFull
            ? null
            : false;
      }

      u.turrets = null;
      const unitCombat = entity.combat;
      const weapons0 = unitCombat !== null ? unitCombat.turrets : undefined;
      if (weapons0 && weapons0.length > 0 && (isFull || (changedFields! & ENTITY_CHANGED_TURRETS))) {
        u.turrets = writeTurretsToPool(
          poolEntry,
          entity,
          weapons0,
          canSeePrivateDetails ? canReferenceEntityId : () => false,
        );
      }

      u.buildTargetId = null;
      u.buildTargetIdPresent = false;
      if (canSeePrivateDetails && entity.builder && (isFull || (changedFields! & ENTITY_CHANGED_ACTIONS))) {
        const targetId = entity.builder.currentBuildTarget;
        u.buildTargetId = targetId !== NO_ENTITY_ID && canReferenceEntityId(targetId)
          ? targetId
          : null;
        u.buildTargetIdPresent = true;
      }
    }
  }

  if ((entity.type === 'building' || entity.type === 'tower') && entity.building) {
    const buildingFieldMask = ENTITY_CHANGED_HP | ENTITY_CHANGED_BUILDING |
      ENTITY_CHANGED_FACTORY | ENTITY_CHANGED_TURRETS;
    const hasBuildingFields = isFull || (changedFields! & buildingFieldMask);

    if (hasBuildingFields) {
      const b = poolEntry.buildingSub;
      ne.building = b;
      b.hp = null;
      b.build = null;
      b.solar = null;
      b.metalExtractionRate = null;
      b.turrets = null;

      if (isFull) {
        b.dim = poolEntry.buildingDim;
        b.dim.x = entity.building.width;
        b.dim.y = entity.building.height;
        b.buildingBlueprintCode = entity.buildingBlueprintId !== null
          ? buildingBlueprintIdToCode(entity.buildingBlueprintId)
          : null;
        b.metalExtractionRate = isMetalExtractorBlueprintId(entity.buildingBlueprintId)
          ? entity.metalExtractionRate ?? 0
          : null;
      } else {
        b.dim = null;
        b.buildingBlueprintCode = null;
        b.metalExtractionRate = (changedFields! & ENTITY_CHANGED_BUILDING) !== 0 &&
          isMetalExtractorBlueprintId(entity.buildingBlueprintId)
          ? entity.metalExtractionRate ?? 0
          : null;
      }

      if (isFull || (changedFields! & ENTITY_CHANGED_HP)) {
        const hp = poolEntry.buildingHp;
        hp.curr = entity.building.hp;
        hp.max = entity.building.maxHp;
        b.hp = hp;
      }

      if (isFull || (changedFields! & ENTITY_CHANGED_BUILDING)) {
        const build = poolEntry.buildingBuild;
        if (entity.buildable) {
          const buildable = entity.buildable;
          build.complete = buildable.isComplete;
          build.interrupted = buildable.isInterrupted;
          build.paid.energy = buildable.paid.energy;
          build.paid.metal = buildable.paid.metal;
        } else {
          build.complete = true;
          build.interrupted = false;
          build.paid.energy = 0;
          build.paid.metal = 0;
        }
        b.build = build;
        if (entity.building.activeState) {
          // Wire field name is `solar` for legacy reasons; semantically
          // carries the shared BuildingActiveState open flag for every
          // producer building (solar / wind / extractor / radar /
          // resourceConverter).
          const s = poolEntry.solarSub;
          s.open = entity.building.activeState.open;
          b.solar = s;
        }
      }

      const buildingCombat = entity.combat;
      const weapons0 = buildingCombat !== null ? buildingCombat.turrets : undefined;
      if (weapons0 && weapons0.length > 0 && (isFull || (changedFields! & ENTITY_CHANGED_TURRETS))) {
        b.turrets = writeTurretsToPool(
          poolEntry,
          entity,
          weapons0,
          canSeePrivateDetails ? canReferenceEntityId : () => false,
        );
      }

      b.factory = null;
      if (canSeePrivateDetails && (isFull || (changedFields! & ENTITY_CHANGED_FACTORY))) {
        if (entity.factory) {
          const f = poolEntry.factorySub;
          b.factory = f;

          f.selectedUnitBlueprintCode = entity.factory.selectedUnitBlueprintId === null
            ? null
            : unitBlueprintIdToCode(entity.factory.selectedUnitBlueprintId);

          if (entity.factory.currentShellId != null) {
            const shell = world.getEntity(entity.factory.currentShellId);
            f.progress = shell !== undefined && shell.buildable !== null
              ? getBuildFraction(shell.buildable)
              : entity.factory.currentBuildProgress;
          } else {
            f.progress = 0;
          }
          f.producing = entity.factory.isProducing;
          f.repeat = entity.factory.repeatProduction;
          f.queue = encodeFactoryProductionQueue(entity.factory.productionQueue);
          f.energyRate = entity.factory.energyRateFraction;
          f.metalRate = entity.factory.metalRateFraction;
          f.guardTargetId = canReferenceEntityId(entity.factory.guardTargetId ?? undefined)
            ? entity.factory.guardTargetId
            : null;

          poolEntry.rally.pos.x = entity.factory.rallyX;
          poolEntry.rally.pos.y = entity.factory.rallyY;
          poolEntry.rally.posZ = entity.factory.rallyZ;
          poolEntry.rally.type = entity.factory.rallyType;
          f.rally = poolEntry.rally;

          // Multi-leg default route (demo fabricators: fight leg + patrol
          // loop). Only the VISUALIZATION needs it, so it rides the
          // snapshot solely when the factory has more than the single
          // rally point. `null` keeps the client drawing `rally` alone.
          const defaultWaypoints = entity.factory.defaultWaypoints;
          if (defaultWaypoints !== null && defaultWaypoints.length > 1) {
            const route = poolEntry.route;
            route.length = defaultWaypoints.length;
            for (let w = 0; w < defaultWaypoints.length; w++) {
              const src = defaultWaypoints[w];
              const dst = route[w] ?? (route[w] = createWaypointDto());
              dst.pos.x = src.x;
              dst.pos.y = src.y;
              dst.posZ = src.z;
              dst.type = src.type;
            }
            f.route = route;
          } else {
            f.route = null;
          }
        }
      }
    }
  }

  appendEntitySnapshotWireRowDirect(entity, changedFields, world, visibility);
  return ne;
}

export function canUseTypedDeltaPlaceholder(entity: Entity, changedFields: number | undefined): boolean {
  if (changedFields === undefined || changedFields === 0) return false;
  const hasBasicTransformFields = (changedFields & (ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT)) !== 0;
  if (entity.type === 'unit' && entity.unit !== null) {
    if ((changedFields & ~TYPED_PLACEHOLDER_UNIT_DELTA_FIELDS) !== 0) return false;
    const orientationTriggersTypedRow = entity.unit.orientation !== null &&
      (changedFields & (ENTITY_CHANGED_ROT | ENTITY_CHANGED_VEL)) !== 0;
    return (changedFields & TYPED_PLACEHOLDER_UNIT_TRIGGER_FIELDS) !== 0 ||
      orientationTriggersTypedRow ||
      hasBasicTransformFields;
  }
  if ((entity.type === 'building' || entity.type === 'tower') && entity.building !== null) {
    return (changedFields & ~TYPED_PLACEHOLDER_BUILDING_DELTA_FIELDS) === 0 &&
      ((changedFields & TYPED_PLACEHOLDER_BUILDING_TRIGGER_FIELDS) !== 0 ||
        hasBasicTransformFields);
  }
  return false;
}

function serializeTypedDeltaPlaceholder(
  entity: Entity,
  changedFields: number,
  world: WorldState,
  visibility: SnapshotVisibility | undefined,
): NetworkServerSnapshotEntity | undefined {
  appendEntitySnapshotWireRowDirect(entity, changedFields, world, visibility, true);
  return undefined;
}

export function serializeEntityDeltaSnapshot(
  entity: Entity,
  changedFields: number | undefined,
  world: WorldState,
  visibility: SnapshotVisibility | undefined = undefined,
): NetworkServerSnapshotEntity | undefined | null {
  if (
    changedFields !== undefined &&
    canUseTypedDeltaPlaceholder(entity, changedFields)
  ) {
    return serializeTypedDeltaPlaceholder(entity, changedFields, world, visibility);
  }
  return serializeEntitySnapshot(entity, changedFields, world, visibility);
}
