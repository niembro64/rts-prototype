import type { WorldState } from '../sim/WorldState';
import type { Entity, PlayerId } from '../sim/types';
import { getBuildFraction } from '../sim/buildableHelpers';
import { isCommander } from '../sim/combat/combatUtils';
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
  ENTITY_CHANGED_JUMP,
  ENTITY_CHANGED_NORMAL,
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_ROT,
  ENTITY_CHANGED_SUSPENSION,
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
  clearNetworkUnitJump,
  clearNetworkUnitStaticFields,
  clearNetworkUnitSurfaceNormal,
  clearNetworkUnitSuspension,
  createNetworkUnitSnapshot,
  writeNetworkUnitActions,
  writeNetworkUnitCombatMode,
  writeNetworkUnitJump,
  writeNetworkUnitStaticFields,
  writeNetworkUnitSurfaceNormal,
  writeNetworkUnitSuspension,
  writeNetworkUnitVelocity,
} from './unitSnapshotFields';
import type { SnapshotVisibility } from './stateSerializerVisibility';

const INITIAL_ENTITY_POOL = 200;
const MAX_WEAPONS_PER_ENTITY = 8;
const MAX_ACTIONS_PER_ENTITY = 16;
const MAX_WAYPOINTS_PER_ENTITY = 16;

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
// no longer shipped — client integrates from velocity only).
export const ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE = 64;
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
  unitSub: UnitSub;
  unitSuspension: NonNullable<UnitSub['suspension']>;
  unitJump: NonNullable<UnitSub['jump']>;
  unitRadius: { body: number; shot: number; push: number };
  buildingDim: { x: number; y: number };
  solarSub: { open: boolean };
  buildingSub: BuildingSub;
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

// Keep more precision than the delta threshold so snapshots don't
// round away the small separations produced by unit contact resolution.
const POSITION_WIRE_PRECISION = 100;

function qPos(n: number): number {
  return Math.round(n * POSITION_WIRE_PRECISION) / POSITION_WIRE_PRECISION;
}

function qVel(n: number): number {
  return Math.round(n * 10) / 10;
}

function qRot(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function qNormal(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function qSuspension(n: number): number {
  return Math.round(n * 100) / 100;
}

function writeTurretsToPool(
  pool: PooledEntry,
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
    t.angular.rot = qRot(src.rotation);
    t.angular.vel = qRot(src.angularVelocity);
    // Acceleration intentionally omitted from the wire: it's the
    // instantaneous damped-spring force at this tick (depends on
    // error-to-target), not a constant, and integrating it across an
    // arbitrary client-side dt overshoots. Clients predict turret
    // motion from velocity alone.
    t.angular.pitch = qRot(src.pitch);
    t.angular.pitchVel = qRot(src.pitchVelocity);
    dst.targetId = canReferenceEntityId?.(src.target ?? undefined) === false
      ? undefined
      : src.target ?? undefined;
    dst.state = turretStateToCode(src.state);
    dst.currentForceFieldRange = src.forceField?.range;
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
  return {
    entity: {
      id: 0,
      type: 'unit',
      pos: { x: 0, y: 0, z: 0 },
      rotation: 0,
      playerId: 1 as PlayerId,
      changedFields: undefined,
      unit: undefined,
      building: undefined,
    },
    unitSub: createNetworkUnitSnapshot(),
    unitSuspension: {
      offset: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    },
    unitJump: {},
    unitRadius: { body: 0, shot: 0, push: 0 },
    buildingDim: { x: 0, y: 0 },
    solarSub: { open: false },
    buildingSub: {
      type: undefined, dim: undefined, hp: { curr: 0, max: 0 },
      build: {
        complete: false,
        paid: { energy: 0, metal: 0 },
      },
      metalExtractionRate: undefined,
    },
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

function appendActionWireRows(actions: readonly NetworkServerSnapshotAction[] | undefined): number {
  if (actions === undefined || actions.length === 0) return -1;
  const rows = entityWireSource.actionRows;
  const offset = reserveFloat64WireRows(rows, actions.length, ENTITY_SNAPSHOT_WIRE_ACTION_STRIDE);
  const values = rows.values;
  const strings = entityWireSource.actionStrings;
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const base = (offset + i) * ENTITY_SNAPSHOT_WIRE_ACTION_STRIDE;
    values[base + 0] = action.type;
    values[base + 1] = action.pos !== undefined ? 1 : 0;
    values[base + 2] = action.pos?.x ?? 0;
    values[base + 3] = action.pos?.y ?? 0;
    values[base + 4] = action.posZ !== undefined ? 1 : 0;
    values[base + 5] = action.posZ ?? 0;
    values[base + 6] = action.pathExp === true ? 1 : 0;
    values[base + 7] = action.targetId !== undefined ? 1 : 0;
    values[base + 8] = action.targetId ?? 0;
    values[base + 9] = action.buildingType !== undefined ? 1 : 0;
    values[base + 10] = action.buildingType !== undefined ? strings.length : 0;
    if (action.buildingType !== undefined) strings.push(action.buildingType);
    values[base + 11] = action.grid !== undefined ? 1 : 0;
    values[base + 12] = action.grid?.x ?? 0;
    values[base + 13] = action.grid?.y ?? 0;
    values[base + 14] = action.buildingId !== undefined ? 1 : 0;
    values[base + 15] = action.buildingId ?? 0;
  }
  return offset;
}

function appendTurretWireRows(turrets: readonly NetworkServerSnapshotTurret[] | undefined): number {
  if (turrets === undefined || turrets.length === 0) return -1;
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
    values[base + 6] = src.targetId !== undefined ? 1 : 0;
    values[base + 7] = src.targetId ?? 0;
    values[base + 8] = src.currentForceFieldRange !== undefined ? 1 : 0;
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
    values[base + 2] = waypoint.posZ !== undefined ? 1 : 0;
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
  values[base + 0] = entity.id;
  values[base + 1] = entity.type === 'unit'
    ? ENTITY_SNAPSHOT_WIRE_TYPE_UNIT
    : ENTITY_SNAPSHOT_WIRE_TYPE_BUILDING;
  values[base + 2] = entity.pos.x;
  values[base + 3] = entity.pos.y;
  values[base + 4] = entity.pos.z;
  values[base + 5] = entity.rotation;
  values[base + 6] = entity.playerId;
  values[base + 7] = entity.changedFields !== undefined ? 1 : 0;
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
  const suspension = unit.suspension;
  const jump = unit.jump;
  const orientation = unit.orientation;
  const angularVelocity = unit.angularVelocity3;
  const build = unit.build;
  const radius = unit.radius;
  const buildTargetId = unit.buildTargetId;
  const actions = unit.actions;
  const turrets = unit.turrets;
  const actionOffset = appendActionWireRows(actions);
  const turretOffset = appendTurretWireRows(turrets);

  values[base + 0] = entity.id;
  values[base + 1] = entity.pos.x;
  values[base + 2] = entity.pos.y;
  values[base + 3] = entity.pos.z;
  values[base + 4] = entity.rotation;
  values[base + 5] = entity.playerId;
  values[base + 6] = entity.changedFields !== undefined ? 1 : 0;
  values[base + 7] = entity.changedFields ?? 0;
  values[base + 8] = unit.hp.curr;
  values[base + 9] = unit.hp.max;
  values[base + 10] = unit.velocity.x;
  values[base + 11] = unit.velocity.y;
  values[base + 12] = unit.velocity.z;
  values[base + 13] = unit.unitType !== undefined ? 1 : 0;
  values[base + 14] = unit.unitType ?? 0;
  values[base + 15] = radius !== undefined ? 1 : 0;
  values[base + 16] = radius !== undefined && radius.body !== undefined ? radius.body : 0;
  values[base + 17] = radius !== undefined && radius.shot !== undefined ? radius.shot : 0;
  values[base + 18] = radius !== undefined && radius.push !== undefined ? radius.push : 0;
  values[base + 19] = unit.bodyCenterHeight !== undefined ? 1 : 0;
  values[base + 20] = unit.bodyCenterHeight ?? 0;
  values[base + 21] = unit.mass !== undefined ? 1 : 0;
  values[base + 22] = unit.mass ?? 0;
  values[base + 23] = surfaceNormal !== undefined ? 1 : 0;
  values[base + 24] = surfaceNormal !== undefined ? surfaceNormal.nx : 0;
  values[base + 25] = surfaceNormal !== undefined ? surfaceNormal.ny : 0;
  values[base + 26] = surfaceNormal !== undefined ? surfaceNormal.nz : 0;
  values[base + 27] = suspension !== undefined ? 1 : 0;
  values[base + 28] = suspension !== undefined ? suspension.offset.x : 0;
  values[base + 29] = suspension !== undefined ? suspension.offset.y : 0;
  values[base + 30] = suspension !== undefined ? suspension.offset.z : 0;
  values[base + 31] = suspension !== undefined ? suspension.velocity.x : 0;
  values[base + 32] = suspension !== undefined ? suspension.velocity.y : 0;
  values[base + 33] = suspension !== undefined ? suspension.velocity.z : 0;
  values[base + 34] = suspension !== undefined && suspension.legContact === true ? 1 : 0;
  values[base + 35] = jump !== undefined ? 1 : 0;
  values[base + 36] = jump !== undefined && jump.enabled === true ? 1 : 0;
  values[base + 37] = jump !== undefined && jump.active === true ? 1 : 0;
  values[base + 38] = jump !== undefined && jump.launchSeq !== undefined ? 1 : 0;
  values[base + 39] = jump !== undefined && jump.launchSeq !== undefined ? jump.launchSeq : 0;
  values[base + 40] = orientation !== undefined ? 1 : 0;
  values[base + 41] = orientation !== undefined ? orientation.x : 0;
  values[base + 42] = orientation !== undefined ? orientation.y : 0;
  values[base + 43] = orientation !== undefined ? orientation.z : 0;
  values[base + 44] = orientation !== undefined ? orientation.w : 0;
  values[base + 45] = angularVelocity !== undefined ? 1 : 0;
  values[base + 46] = angularVelocity !== undefined ? angularVelocity.x : 0;
  values[base + 47] = angularVelocity !== undefined ? angularVelocity.y : 0;
  values[base + 48] = angularVelocity !== undefined ? angularVelocity.z : 0;
  values[base + 49] = unit.fireEnabled === false ? 1 : 0;
  values[base + 50] = unit.isCommander === true ? 1 : 0;
  values[base + 51] = buildTargetId !== undefined ? 1 : 0;
  values[base + 52] = buildTargetId === null ? 1 : 0;
  values[base + 53] = typeof buildTargetId === 'number' ? buildTargetId : 0;
  values[base + 54] = actions !== undefined ? 1 : 0;
  values[base + 55] = actions !== undefined ? actions.length : 0;
  values[base + 56] = turrets !== undefined ? 1 : 0;
  values[base + 57] = turrets !== undefined ? turrets.length : 0;
  values[base + 58] = build !== undefined ? 1 : 0;
  values[base + 59] = build !== undefined && build.complete === true ? 1 : 0;
  values[base + 60] = build !== undefined ? build.paid.energy : 0;
  values[base + 61] = build !== undefined ? build.paid.metal : 0;
  values[base + 62] = turretOffset;
  values[base + 63] = actionOffset;
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
  values[base + 0] = entity.id;
  values[base + 1] = entity.pos.x;
  values[base + 2] = entity.pos.y;
  values[base + 3] = entity.pos.z;
  values[base + 4] = entity.rotation;
  values[base + 5] = entity.playerId;
  values[base + 6] = entity.changedFields !== undefined ? 1 : 0;
  values[base + 7] = entity.changedFields ?? 0;
  values[base + 8] = building.type !== undefined ? 1 : 0;
  values[base + 9] = building.type ?? 0;
  values[base + 10] = dim !== undefined ? 1 : 0;
  values[base + 11] = dim !== undefined ? dim.x : 0;
  values[base + 12] = dim !== undefined ? dim.y : 0;
  values[base + 13] = building.hp.curr;
  values[base + 14] = building.hp.max;
  values[base + 15] = building.build.complete ? 1 : 0;
  values[base + 16] = building.build.paid.energy;
  values[base + 17] = building.build.paid.metal;
  values[base + 18] = building.metalExtractionRate !== undefined ? 1 : 0;
  values[base + 19] = building.metalExtractionRate ?? 0;
  values[base + 20] = solar !== undefined ? 1 : 0;
  values[base + 21] = solar !== undefined && solar.open === true ? 1 : 0;
  values[base + 22] = turrets !== undefined ? 1 : 0;
  values[base + 23] = turrets !== undefined ? turrets.length : 0;
  values[base + 24] = factory !== undefined ? 1 : 0;
  values[base + 25] = factory !== undefined ? factory.queue.length : 0;
  values[base + 26] = factory !== undefined ? factory.progress : 0;
  values[base + 27] = factory !== undefined && factory.producing === true ? 1 : 0;
  values[base + 28] = factory !== undefined ? factory.energyRate : 0;
  values[base + 29] = factory !== undefined ? factory.metalRate : 0;
  values[base + 30] = factory !== undefined ? factory.waypoints.length : 0;
  values[base + 31] = turretOffset;
  values[base + 32] = factoryQueueOffset;
  values[base + 33] = factoryWaypointOffset;
  entityWireSource.kinds.push(ENTITY_SNAPSHOT_WIRE_KIND_BUILDING);
  entityWireSource.rowIndices.push(rowIndex);
}

function appendEntitySnapshotWireRow(entity: NetworkServerSnapshotEntity): void {
  if (
    entity.type === 'unit' &&
    entity.unit !== undefined &&
    entity.building === undefined
  ) {
    appendUnitEntityWireRow(entity, entity.unit);
    return;
  }

  if (
    entity.type === 'building' &&
    entity.building !== undefined &&
    entity.unit === undefined
  ) {
    appendBuildingEntityWireRow(entity, entity.building);
    return;
  }

  if (entity.unit === undefined && entity.building === undefined) {
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
  ne.changedFields = isFull ? undefined : changedFields;

  if (isFull || (changedFields & ENTITY_CHANGED_POS)) {
    ne.pos.x = qPos(entity.transform.x);
    ne.pos.y = qPos(entity.transform.y);
    ne.pos.z = qPos(entity.transform.z);
  }
  if (isFull || (changedFields & ENTITY_CHANGED_ROT)) {
    ne.rotation = qRot(entity.transform.rotation);
  }

  ne.unit = undefined;
  ne.building = undefined;

  if (entity.type === 'unit' && entity.unit) {
    const unitFieldMask = ENTITY_CHANGED_VEL | ENTITY_CHANGED_HP |
      ENTITY_CHANGED_ACTIONS | ENTITY_CHANGED_TURRETS |
      ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT |
      ENTITY_CHANGED_BUILDING |
      ENTITY_CHANGED_NORMAL |
      ENTITY_CHANGED_SUSPENSION |
      ENTITY_CHANGED_JUMP;
    const hasUnitFields = isFull || (changedFields! & unitFieldMask);

    if (hasUnitFields) {
      const u = poolEntry.unitSub;
      ne.unit = u;

      if (isFull) {
        writeNetworkUnitStaticFields(
          u,
          entity.unit,
          poolEntry.unitRadius,
          isCommander(entity),
        );
      } else {
        clearNetworkUnitStaticFields(u);
      }

      if (isFull || (changedFields! & ENTITY_CHANGED_VEL)) {
        if (canSeePrivateDetails) {
          writeNetworkUnitVelocity(u, entity.unit, qVel);
        } else {
          u.velocity.x = 0;
          u.velocity.y = 0;
          u.velocity.z = 0;
        }
      }

      if (
        isFull ||
        (changedFields! & (ENTITY_CHANGED_POS | ENTITY_CHANGED_NORMAL))
      ) {
        writeNetworkUnitSurfaceNormal(u, entity.unit, qNormal);
      } else {
        clearNetworkUnitSurfaceNormal(u);
      }

      if (isFull || (changedFields! & ENTITY_CHANGED_SUSPENSION)) {
        writeNetworkUnitSuspension(u, entity.unit, poolEntry.unitSuspension, qSuspension, qVel);
      } else {
        clearNetworkUnitSuspension(u);
      }

      if (isFull || (changedFields! & ENTITY_CHANGED_JUMP)) {
        writeNetworkUnitJump(u, entity.unit, poolEntry.unitJump);
      } else {
        clearNetworkUnitJump(u);
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
      if (orient) {
        u.orientation = orient;
        u.angularVelocity3 = entity.unit.angularVelocity3 ?? undefined;
      } else {
        u.orientation = undefined;
        u.angularVelocity3 = undefined;
      }

      if (isFull || (changedFields! & ENTITY_CHANGED_COMBAT_MODE)) {
        writeNetworkUnitCombatMode(u, entity);
      } else {
        clearNetworkUnitCombatMode(u);
      }

      if (isFull || (changedFields! & ENTITY_CHANGED_HP)) {
        u.hp.curr = entity.unit.hp;
        u.hp.max = entity.unit.maxHp;
      }

      u.build = undefined;
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

      u.turrets = undefined;
      const weapons0 = entity.combat?.turrets;
      if (weapons0 && weapons0.length > 0 && (isFull || (changedFields! & ENTITY_CHANGED_TURRETS))) {
        u.turrets = writeTurretsToPool(
          poolEntry,
          weapons0,
          canSeePrivateDetails ? canReferenceEntityId : () => false,
        );
      }

      u.buildTargetId = undefined;
      if (canSeePrivateDetails && entity.builder) {
        const targetId = entity.builder.currentBuildTarget ?? undefined;
        u.buildTargetId = canReferenceEntityId(targetId) ? targetId ?? null : null;
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
      b.solar = undefined;
      b.metalExtractionRate = undefined;
      b.turrets = undefined;

      if (isFull) {
        b.dim = poolEntry.buildingDim;
        b.dim.x = entity.building.width;
        b.dim.y = entity.building.height;
        b.type = entity.buildingType !== undefined
          ? buildingTypeToCode(entity.buildingType)
          : undefined;
        b.metalExtractionRate = entity.buildingType === 'extractor'
          ? entity.metalExtractionRate ?? 0
          : undefined;
      } else {
        b.dim = undefined;
        b.type = undefined;
        b.metalExtractionRate = (changedFields! & ENTITY_CHANGED_BUILDING) !== 0 &&
          entity.buildingType === 'extractor'
          ? entity.metalExtractionRate ?? 0
          : undefined;
      }

      if (isFull || (changedFields! & ENTITY_CHANGED_HP)) {
        b.hp.curr = entity.building.hp;
        b.hp.max = entity.building.maxHp;
      }

      if (isFull || (changedFields! & ENTITY_CHANGED_BUILDING)) {
        if (entity.buildable) {
          const buildable = entity.buildable;
          b.build.complete = buildable.isComplete;
          b.build.paid.energy = buildable.paid.energy;
          b.build.paid.metal = buildable.paid.metal;
        } else {
          b.build.complete = true;
          b.build.paid.energy = 0;
          b.build.paid.metal = 0;
        }
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
          weapons0,
          canSeePrivateDetails ? canReferenceEntityId : () => false,
        );
      }

      b.factory = undefined;
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
          poolEntry.waypoints[0].posZ = undefined;
          poolEntry.waypoints[0].type = 'move';
          for (let i = 0; i < wps.length; i++) {
            poolEntry.waypoints[i + 1].pos.x = wps[i].x;
            poolEntry.waypoints[i + 1].pos.y = wps[i].y;
            poolEntry.waypoints[i + 1].posZ = wps[i].z;
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
