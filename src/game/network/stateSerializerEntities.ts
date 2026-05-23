import type { WorldState } from '../sim/WorldState';
import type { Entity, PlayerId } from '../sim/types';
import { NO_ENTITY_ID } from '../sim/types';
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
  buildingTypeToCode,
  turretIdToCode,
  turretStateToCode,
  unitTypeToCode,
} from '../../types/network';
import {
  createActionDto,
  createTurretDto,
  createWaypointDto,
  type WaypointDto,
} from './snapshotDtoCopy';
import { turretAimMotionIsSnapshotVisible } from './turretSnapshotFields';
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

const INITIAL_ENTITY_POOL = 200;
const MAX_WEAPONS_PER_ENTITY = 8;
const MAX_ACTIONS_PER_ENTITY = 16;
const MAX_WAYPOINTS_PER_ENTITY = 16;
const _snapshotTurretFsm: CombatTargetingTurretFsmOut = {
  stateCode: 0,
  targetId: -1,
};

export const ENTITY_SNAPSHOT_WIRE_KIND_RAW = 0;
export const ENTITY_SNAPSHOT_WIRE_KIND_BASIC = 1;
export const ENTITY_SNAPSHOT_WIRE_KIND_UNIT = 2;
export const ENTITY_SNAPSHOT_WIRE_KIND_BUILDING = 3;
export const ENTITY_SNAPSHOT_WIRE_TYPE_UNIT = 1;
export const ENTITY_SNAPSHOT_WIRE_TYPE_BUILDING = 2;
export const ENTITY_SNAPSHOT_WIRE_BASIC_STRIDE = 9;
// Unit row layout: see appendUnitEntityWireRow for the exact slot order.
// Stride shrank from 72 → 64 when the 4 movementAccel slots and 4
// angularAcceleration slots were removed from the wire (acceleration is
// no longer shipped — client integrates from velocity only). Stride
// shrank from 64 → 59 when 5 retired actuator-state slots were dropped.
// shrank from 59 → 51 when 8 retired visual-suspension slots were
// dropped from the JS→WASM entity row.
export const ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE = 51;
export const ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE = 34;
export const ENTITY_SNAPSHOT_WIRE_ACTION_STRIDE = 16;
// Turret row layout: rot, vel, pitch, pitchVel, id, state, hasTarget,
// targetId, hasForceFieldRange, forceFieldRange. Stride shrank from
// 12 → 10 when the 2 angular acceleration slots (acc, pitchAcc) were
// removed alongside movementAccel.
export const ENTITY_SNAPSHOT_WIRE_TURRET_STRIDE = 10;
export const ENTITY_SNAPSHOT_WIRE_WAYPOINT_STRIDE = 5;

export type EntitySnapshotWireSource = {
  kinds: number[];
  rowIndices: number[];
  basicRows: Float64WireRows;
  unitRows: Float64WireRows;
  buildingRows: Float64WireRows;
  actionRows: Float64WireRows;
  actionStrings: string[];
  turretRows: Float64WireRows;
  factoryQueueRows: Uint32WireRows;
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
  buildingDim: { x: number; y: number };
  solarSub: { open: boolean };
  buildingSub: BuildingSub;
  buildingHp: NonNullable<BuildingSub['hp']>;
  buildingBuild: NonNullable<BuildingSub['build']>;
  factorySub: FactorySub;
  turrets: NetworkServerSnapshotTurret[];
  actions: NetworkServerSnapshotAction[];
  waypoints: WaypointDto[];
  buildQueue: number[];
};

const entityWireSource: EntitySnapshotWireSource = {
  kinds: [],
  rowIndices: [],
  basicRows: createFloat64WireRows(),
  unitRows: createFloat64WireRows(),
  buildingRows: createFloat64WireRows(),
  actionRows: createFloat64WireRows(),
  actionStrings: [],
  turretRows: createFloat64WireRows(),
  factoryQueueRows: createUint32WireRows(),
  waypointRows: createFloat64WireRows(),
  waypointStrings: [],
};
const entityWireSources = new WeakMap<object, EntitySnapshotWireSource>();

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
    t.id = turretIdToCode(src.config.id);
    // Plain headOnly turrets (beam/rocket) render a head sphere only,
    // so the client doesn't orient anything from these values. Mirror
    // panel hosts are different: the panel slab is posed from this
    // passive turret even though the head/barrel art is hidden.
    if (!turretAimMotionIsSnapshotVisible(entity, src)) {
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
    dst.targetId = wireTargetId !== null && canReferenceEntityId?.(wireTargetId) === false
      ? null
      : wireTargetId;
    dst.state = hasTargetingFsm ? _snapshotTurretFsm.stateCode : turretStateToCode(src.state);
    dst.currentForceFieldRange = src.forceField?.range ?? null;
  }
  return pool.turrets;
}

function createPooledEntry(): PooledEntry {
  const turrets: NetworkServerSnapshotTurret[] = [];
  for (let i = 0; i < MAX_WEAPONS_PER_ENTITY; i++) turrets.push(createTurretDto());
  const actions: NetworkServerSnapshotAction[] = [];
  for (let i = 0; i < MAX_ACTIONS_PER_ENTITY; i++) actions.push(createActionDto());
  const waypoints: WaypointDto[] = [];
  for (let i = 0; i < MAX_WAYPOINTS_PER_ENTITY; i++) waypoints.push(createWaypointDto());
  const entityPos = { x: 0, y: 0, z: 0 };
  const unitSub = createNetworkUnitSnapshot();
  const unitHp = unitSub.hp ?? (unitSub.hp = { curr: 0, max: 0 });
  const unitVelocity = unitSub.velocity ?? (unitSub.velocity = { x: 0, y: 0, z: 0 });
  const buildingHp = { curr: 0, max: 0 };
  const buildingBuild = {
    complete: false,
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
    buildingDim: { x: 0, y: 0 },
    solarSub: { open: false },
    buildingSub: {
      type: null, dim: null, hp: buildingHp,
      build: buildingBuild,
      metalExtractionRate: null,
      solar: null,
      turrets: null,
      factory: null,
    },
    buildingHp,
    buildingBuild,
    factorySub: {
      queue: [], progress: 0, producing: false,
      energyRate: 0, metalRate: 0,
      waypoints: [],
    },
    turrets,
    actions,
    waypoints,
    buildQueue: [],
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

export function registerEntitySnapshotWireSource(
  entities: NetworkServerSnapshotEntity[],
): void {
  entityWireSources.set(entities, entityWireSource);
}

export function getEntitySnapshotWireSource(
  entities: readonly NetworkServerSnapshotEntity[],
): EntitySnapshotWireSource | undefined {
  return entityWireSources.get(entities);
}

function resetEntitySnapshotWireSource(): void {
  entityWireSource.kinds.length = 0;
  entityWireSource.rowIndices.length = 0;
  entityWireSource.basicRows.count = 0;
  entityWireSource.unitRows.count = 0;
  entityWireSource.buildingRows.count = 0;
  entityWireSource.actionRows.count = 0;
  entityWireSource.actionStrings.length = 0;
  entityWireSource.turretRows.count = 0;
  entityWireSource.factoryQueueRows.count = 0;
  entityWireSource.waypointRows.count = 0;
  entityWireSource.waypointStrings.length = 0;
}

function appendRawEntityWireRow(): void {
  entityWireSource.kinds.push(ENTITY_SNAPSHOT_WIRE_KIND_RAW);
  entityWireSource.rowIndices.push(-1);
}

function appendActionWireRows(actions: readonly NetworkServerSnapshotAction[] | null): number {
  if (actions === null || actions.length === 0) return -1;
  const rows = entityWireSource.actionRows;
  const offset = reserveFloat64WireRows(rows, actions.length, ENTITY_SNAPSHOT_WIRE_ACTION_STRIDE);
  const values = rows.values;
  const strings = entityWireSource.actionStrings;
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const base = (offset + i) * ENTITY_SNAPSHOT_WIRE_ACTION_STRIDE;
    values[base + 0] = action.type;
    values[base + 1] = action.pos !== null ? 1 : 0;
    values[base + 2] = action.pos?.x ?? 0;
    values[base + 3] = action.pos?.y ?? 0;
    values[base + 4] = action.posZ !== null ? 1 : 0;
    values[base + 5] = action.posZ ?? 0;
    values[base + 6] = action.pathExp === true ? 1 : 0;
    values[base + 7] = action.targetId !== null ? 1 : 0;
    values[base + 8] = action.targetId ?? 0;
    values[base + 9] = action.buildingType !== null ? 1 : 0;
    values[base + 10] = action.buildingType !== null ? strings.length : 0;
    if (action.buildingType !== null) strings.push(action.buildingType);
    values[base + 11] = action.grid !== null ? 1 : 0;
    values[base + 12] = action.grid?.x ?? 0;
    values[base + 13] = action.grid?.y ?? 0;
    values[base + 14] = action.buildingId !== null ? 1 : 0;
    values[base + 15] = action.buildingId ?? 0;
  }
  return offset;
}

function appendTurretWireRows(turrets: readonly NetworkServerSnapshotTurret[] | null): number {
  if (turrets === null || turrets.length === 0) return -1;
  const rows = entityWireSource.turretRows;
  const offset = reserveFloat64WireRows(rows, turrets.length, ENTITY_SNAPSHOT_WIRE_TURRET_STRIDE);
  const values = rows.values;
  for (let i = 0; i < turrets.length; i++) {
    const src = turrets[i];
    const angular = src.turret.angular;
    const base = (offset + i) * ENTITY_SNAPSHOT_WIRE_TURRET_STRIDE;
    values[base + 0] = angular.rot;
    values[base + 1] = angular.vel;
    values[base + 2] = angular.pitch;
    values[base + 3] = angular.pitchVel;
    values[base + 4] = src.turret.id;
    values[base + 5] = src.state;
    values[base + 6] = src.targetId !== null ? 1 : 0;
    values[base + 7] = src.targetId ?? 0;
    values[base + 8] = src.currentForceFieldRange !== null ? 1 : 0;
    values[base + 9] = src.currentForceFieldRange ?? 0;
  }
  return offset;
}

function appendFactoryQueueWireRows(queue: readonly number[] | undefined): number {
  if (queue === undefined || queue.length === 0) return -1;
  const rows = entityWireSource.factoryQueueRows;
  const offset = reserveUint32WireRows(rows, queue.length, 1);
  const values = rows.values;
  for (let i = 0; i < queue.length; i++) {
    values[offset + i] = queue[i];
  }
  return offset;
}

function appendWaypointWireRows(waypoints: readonly FactorySub['waypoints'][number][] | undefined): number {
  if (waypoints === undefined || waypoints.length === 0) return -1;
  const rows = entityWireSource.waypointRows;
  const offset = reserveFloat64WireRows(rows, waypoints.length, ENTITY_SNAPSHOT_WIRE_WAYPOINT_STRIDE);
  const values = rows.values;
  const strings = entityWireSource.waypointStrings;
  for (let i = 0; i < waypoints.length; i++) {
    const waypoint = waypoints[i];
    const base = (offset + i) * ENTITY_SNAPSHOT_WIRE_WAYPOINT_STRIDE;
    values[base + 0] = waypoint.pos.x;
    values[base + 1] = waypoint.pos.y;
    values[base + 2] = waypoint.posZ !== null ? 1 : 0;
    values[base + 3] = waypoint.posZ ?? 0;
    values[base + 4] = strings.length;
    strings.push(waypoint.type);
  }
  return offset;
}

function appendBasicEntityWireRow(entity: NetworkServerSnapshotEntity): void {
  const rows = entityWireSource.basicRows;
  const rowIndex = reserveFloat64WireRows(rows, 1, ENTITY_SNAPSHOT_WIRE_BASIC_STRIDE);
  const values = rows.values;
  const base = rowIndex * ENTITY_SNAPSHOT_WIRE_BASIC_STRIDE;
  const pos = entity.pos;
  values[base + 0] = entity.id;
  values[base + 1] = entity.type === 'unit'
    ? ENTITY_SNAPSHOT_WIRE_TYPE_UNIT
    : ENTITY_SNAPSHOT_WIRE_TYPE_BUILDING;
  values[base + 2] = pos?.x ?? 0;
  values[base + 3] = pos?.y ?? 0;
  values[base + 4] = pos?.z ?? 0;
  values[base + 5] = entity.rotation ?? 0;
  values[base + 6] = entity.playerId;
  values[base + 7] = entity.changedFields !== null ? 1 : 0;
  values[base + 8] = entity.changedFields ?? 0;
  entityWireSource.kinds.push(ENTITY_SNAPSHOT_WIRE_KIND_BASIC);
  entityWireSource.rowIndices.push(rowIndex);
}

function appendUnitEntityWireRow(
  entity: NetworkServerSnapshotEntity,
  unit: UnitSub,
): void {
  const rows = entityWireSource.unitRows;
  const rowIndex = reserveFloat64WireRows(rows, 1, ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE);
  const values = rows.values;
  const base = rowIndex * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
  const surfaceNormal = unit.surfaceNormal;
  const orientation = unit.orientation;
  const angularVelocity = unit.angularVelocity3;
  const build = unit.build;
  const radius = unit.radius;
  const buildTargetId = unit.buildTargetId;
  const actions = unit.actions;
  const turrets = unit.turrets;
  const actionOffset = appendActionWireRows(actions);
  const turretOffset = appendTurretWireRows(turrets);
  const pos = entity.pos;

  values[base + 0] = entity.id;
  values[base + 1] = pos?.x ?? 0;
  values[base + 2] = pos?.y ?? 0;
  values[base + 3] = pos?.z ?? 0;
  values[base + 4] = entity.rotation ?? 0;
  values[base + 5] = entity.playerId;
  values[base + 6] = entity.changedFields !== null ? 1 : 0;
  values[base + 7] = entity.changedFields ?? 0;
  values[base + 8] = unit.hp?.curr ?? 0;
  values[base + 9] = unit.hp?.max ?? 0;
  values[base + 10] = unit.velocity?.x ?? 0;
  values[base + 11] = unit.velocity?.y ?? 0;
  values[base + 12] = unit.velocity?.z ?? 0;
  values[base + 13] = unit.unitType !== null ? 1 : 0;
  values[base + 14] = unit.unitType ?? 0;
  values[base + 15] = radius !== null ? 1 : 0;
  values[base + 16] = radius !== null && radius.body !== null ? radius.body : 0;
  values[base + 17] = radius !== null && radius.shot !== null ? radius.shot : 0;
  values[base + 18] = radius !== null && radius.push !== null ? radius.push : 0;
  values[base + 19] = unit.bodyCenterHeight !== null ? 1 : 0;
  values[base + 20] = unit.bodyCenterHeight ?? 0;
  values[base + 21] = unit.mass !== null ? 1 : 0;
  values[base + 22] = unit.mass ?? 0;
  values[base + 23] = surfaceNormal !== null ? 1 : 0;
  values[base + 24] = surfaceNormal !== null ? surfaceNormal.nx : 0;
  values[base + 25] = surfaceNormal !== null ? surfaceNormal.ny : 0;
  values[base + 26] = surfaceNormal !== null ? surfaceNormal.nz : 0;
  values[base + 27] = orientation !== null ? 1 : 0;
  values[base + 28] = orientation !== null ? orientation.x : 0;
  values[base + 29] = orientation !== null ? orientation.y : 0;
  values[base + 30] = orientation !== null ? orientation.z : 0;
  values[base + 31] = orientation !== null ? orientation.w : 0;
  values[base + 32] = angularVelocity !== null ? 1 : 0;
  values[base + 33] = angularVelocity !== null ? angularVelocity.x : 0;
  values[base + 34] = angularVelocity !== null ? angularVelocity.y : 0;
  values[base + 35] = angularVelocity !== null ? angularVelocity.z : 0;
  values[base + 36] = unit.fireEnabled === false ? 1 : 0;
  values[base + 37] = unit.isCommander === true ? 1 : 0;
  values[base + 38] = unit.buildTargetIdPresent ? 1 : 0;
  values[base + 39] = buildTargetId === null ? 1 : 0;
  values[base + 40] = typeof buildTargetId === 'number' ? buildTargetId : 0;
  values[base + 41] = actions !== null ? 1 : 0;
  values[base + 42] = actions !== null ? actions.length : 0;
  values[base + 43] = turrets !== null ? 1 : 0;
  values[base + 44] = turrets !== null ? turrets.length : 0;
  values[base + 45] = build !== null ? 1 : 0;
  values[base + 46] = build !== null && build.complete === true ? 1 : 0;
  values[base + 47] = build !== null ? build.paid.energy : 0;
  values[base + 48] = build !== null ? build.paid.metal : 0;
  values[base + 49] = turretOffset;
  values[base + 50] = actionOffset;
  entityWireSource.kinds.push(ENTITY_SNAPSHOT_WIRE_KIND_UNIT);
  entityWireSource.rowIndices.push(rowIndex);
}

function appendBuildingEntityWireRow(
  entity: NetworkServerSnapshotEntity,
  building: BuildingSub,
): void {
  const rows = entityWireSource.buildingRows;
  const rowIndex = reserveFloat64WireRows(rows, 1, ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE);
  const values = rows.values;
  const base = rowIndex * ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE;
  const factory = building.factory;
  const dim = building.dim;
  const solar = building.solar;
  const turrets = building.turrets;
  const turretOffset = appendTurretWireRows(turrets);
  const factoryQueueOffset = appendFactoryQueueWireRows(factory?.queue);
  const factoryWaypointOffset = appendWaypointWireRows(factory?.waypoints);
  const pos = entity.pos;
  values[base + 0] = entity.id;
  values[base + 1] = pos?.x ?? 0;
  values[base + 2] = pos?.y ?? 0;
  values[base + 3] = pos?.z ?? 0;
  values[base + 4] = entity.rotation ?? 0;
  values[base + 5] = entity.playerId;
  values[base + 6] = entity.changedFields !== null ? 1 : 0;
  values[base + 7] = entity.changedFields ?? 0;
  values[base + 8] = building.type !== null ? 1 : 0;
  values[base + 9] = building.type ?? 0;
  values[base + 10] = dim !== null ? 1 : 0;
  values[base + 11] = dim !== null ? dim.x : 0;
  values[base + 12] = dim !== null ? dim.y : 0;
  values[base + 13] = building.hp?.curr ?? 0;
  values[base + 14] = building.hp?.max ?? 0;
  values[base + 15] = building.build?.complete ? 1 : 0;
  values[base + 16] = building.build?.paid.energy ?? 0;
  values[base + 17] = building.build?.paid.metal ?? 0;
  values[base + 18] = building.metalExtractionRate !== null ? 1 : 0;
  values[base + 19] = building.metalExtractionRate ?? 0;
  values[base + 20] = solar !== null ? 1 : 0;
  values[base + 21] = solar !== null && solar.open === true ? 1 : 0;
  values[base + 22] = turrets !== null ? 1 : 0;
  values[base + 23] = turrets !== null ? turrets.length : 0;
  values[base + 24] = factory !== null ? 1 : 0;
  values[base + 25] = factory !== null ? factory.queue.length : 0;
  values[base + 26] = factory !== null ? factory.progress : 0;
  values[base + 27] = factory !== null && factory.producing === true ? 1 : 0;
  values[base + 28] = factory !== null ? factory.energyRate : 0;
  values[base + 29] = factory !== null ? factory.metalRate : 0;
  values[base + 30] = factory !== null ? factory.waypoints.length : 0;
  values[base + 31] = turretOffset;
  values[base + 32] = factoryQueueOffset;
  values[base + 33] = factoryWaypointOffset;
  entityWireSource.kinds.push(ENTITY_SNAPSHOT_WIRE_KIND_BUILDING);
  entityWireSource.rowIndices.push(rowIndex);
}

function appendEntitySnapshotWireRow(entity: NetworkServerSnapshotEntity): void {
  if (
    entity.type === 'unit' &&
    entity.unit !== null &&
    entity.building === null
  ) {
    appendUnitEntityWireRow(entity, entity.unit);
    return;
  }

  if (
    entity.type === 'building' &&
    entity.building !== null &&
    entity.unit === null
  ) {
    appendBuildingEntityWireRow(entity, entity.building);
    return;
  }

  if (entity.unit === null && entity.building === null) {
    appendBasicEntityWireRow(entity);
    return;
  }

  appendRawEntityWireRow();
}

export function serializeEntitySnapshot(
  entity: Entity,
  changedFields: number | undefined,
  world: WorldState,
  visibility?: SnapshotVisibility,
): NetworkServerSnapshotEntity | null {
  const poolEntry = getPooledEntry();
  const ne = poolEntry.entity;
  const isFull = changedFields === undefined;
  const canSeePrivateDetails = visibility?.canSeePrivateEntityDetails(entity) ?? true;
  const canReferenceEntityId = (id: number | undefined): boolean =>
    id === undefined || (visibility?.canReferenceEntityId(world, id) ?? true);

  ne.id = entity.id;
  ne.type = entity.type;
  ne.playerId = entity.ownership?.playerId ?? 1 as PlayerId;
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
        u.velocity = poolEntry.unitVelocity;
        if (canSeePrivateDetails) {
          writeNetworkUnitVelocity(u, entity.unit, qVel);
        } else {
          poolEntry.unitVelocity.x = 0;
          poolEntry.unitVelocity.y = 0;
          poolEntry.unitVelocity.z = 0;
        }
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
      } else {
        clearNetworkUnitCombatMode(u);
      }

      if (isFull || (changedFields! & ENTITY_CHANGED_HP)) {
        const hp = poolEntry.unitHp;
        hp.curr = entity.unit.hp;
        hp.max = entity.unit.maxHp;
        u.hp = hp;
      }

      u.build = null;
      if ((isFull || (changedFields! & ENTITY_CHANGED_BUILDING)) && entity.buildable) {
        u.build = {
          complete: entity.buildable.isComplete,
          paid: {
            energy: entity.buildable.paid.energy,
            metal: entity.buildable.paid.metal,
          },
        };
      }

      clearNetworkUnitActions(u);
      if (canSeePrivateDetails && (isFull || (changedFields! & ENTITY_CHANGED_ACTIONS))) {
        writeNetworkUnitActions(u, entity.unit, poolEntry.actions, canReferenceEntityId);
      }

      u.turrets = null;
      const weapons0 = entity.combat?.turrets;
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

  if (entity.type === 'building' && entity.building) {
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
        b.type = entity.buildingType !== undefined
          ? buildingTypeToCode(entity.buildingType)
          : null;
        b.metalExtractionRate = entity.buildingType === 'extractor'
          ? entity.metalExtractionRate ?? 0
          : null;
      } else {
        b.dim = null;
        b.type = null;
        b.metalExtractionRate = (changedFields! & ENTITY_CHANGED_BUILDING) !== 0 &&
          entity.buildingType === 'extractor'
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
          build.paid.energy = buildable.paid.energy;
          build.paid.metal = buildable.paid.metal;
        } else {
          build.complete = true;
          build.paid.energy = 0;
          build.paid.metal = 0;
        }
        b.build = build;
        if (entity.building.activeState) {
          // Wire field name is `solar` for legacy reasons; semantically
          // carries the shared BuildingActiveState open flag for solar,
          // wind, and extractor.
          const s = poolEntry.solarSub;
          s.open = entity.building.activeState.open;
          b.solar = s;
        }
      }

      const weapons0 = entity.combat?.turrets;
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

          const srcQueue = entity.factory.buildQueue;
          poolEntry.buildQueue.length = srcQueue.length;
          for (let i = 0; i < srcQueue.length; i++) {
            poolEntry.buildQueue[i] = unitTypeToCode(srcQueue[i]);
          }
          f.queue = poolEntry.buildQueue;

          if (entity.factory.currentShellId != null) {
            const shell = world.getEntity(entity.factory.currentShellId);
            f.progress = shell?.buildable
              ? getBuildFraction(shell.buildable)
              : entity.factory.currentBuildProgress;
          } else {
            f.progress = 0;
          }
          f.producing = entity.factory.isProducing;
          f.energyRate = entity.factory.energyRateFraction;
          f.metalRate = entity.factory.metalRateFraction;

          const wps = entity.factory.waypoints;
          const wpCount = 1 + wps.length;
          while (poolEntry.waypoints.length < wpCount) poolEntry.waypoints.push(createWaypointDto());
          poolEntry.waypoints.length = wpCount;
          poolEntry.waypoints[0].pos.x = entity.factory.rallyX;
          poolEntry.waypoints[0].pos.y = entity.factory.rallyY;
          poolEntry.waypoints[0].posZ = null;
          poolEntry.waypoints[0].type = 'move';
          for (let i = 0; i < wps.length; i++) {
            poolEntry.waypoints[i + 1].pos.x = wps[i].x;
            poolEntry.waypoints[i + 1].pos.y = wps[i].y;
            poolEntry.waypoints[i + 1].posZ = wps[i].z ?? null;
            poolEntry.waypoints[i + 1].type = wps[i].type;
          }
          f.waypoints = poolEntry.waypoints;
        }
      }
    }
  }

  appendEntitySnapshotWireRow(ne);
  return ne;
}
