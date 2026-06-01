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
// dropped from the JS→WASM entity row. Grew 51 → 52 when locomotion
// Slot 51 remains reserved for a legacy compatibility value.
export const ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE = 51;
export const ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE = 34;
export const ENTITY_SNAPSHOT_WIRE_ACTION_STRIDE = 16;
// Turret row layout: rot, vel, pitch, pitchVel, id, state, hasTarget,
// targetId, hasShieldRange, shieldRange, hpCurr. Stride shrank from
// 12 → 10 when the 2 angular acceleration slots (acc, pitchAcc) were
// removed alongside movementAccel, then grew 10 → 11 for the legacy
// turret hpCurr compatibility slot (slot 10, unconditional).
export const ENTITY_SNAPSHOT_WIRE_TURRET_STRIDE = 11;
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
  buildingDim: { x: number; y: number };
  solarSub: { open: boolean };
  buildingSub: BuildingSub;
  buildingHp: NonNullable<BuildingSub['hp']>;
  buildingBuild: NonNullable<BuildingSub['build']>;
  factorySub: FactorySub;
  turrets: NetworkServerSnapshotTurret[];
  actions: NetworkServerSnapshotAction[];
  rally: WaypointDto;
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
  factorySelectedUnitRows: createUint32WireRows(),
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
    dst.active = src.id === NO_ENTITY_ID ? false : null;
    dst.hpCurr = src.hp;
    const shield = src.shield;
    dst.currentShieldRange = shield !== undefined ? shield.range : null;
  }
  return pool.turrets;
}

function createPooledEntry(): PooledEntry {
  const turrets: NetworkServerSnapshotTurret[] = [];
  for (let i = 0; i < MAX_WEAPONS_PER_ENTITY; i++) turrets.push(createTurretDto());
  const actions: NetworkServerSnapshotAction[] = [];
  for (let i = 0; i < MAX_ACTIONS_PER_ENTITY; i++) actions.push(createActionDto());
  const rally = createWaypointDto();
  const entityPos = { x: 0, y: 0, z: 0 };
  const unitSub = createNetworkUnitSnapshot();
  const unitHp = unitSub.hp ?? (unitSub.hp = { curr: 0, max: 0 });
  const unitVelocity = unitSub.velocity ?? (unitSub.velocity = { x: 0, y: 0, z: 0 });
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
      energyRate: 0, metalRate: 0,
      rally,
    },
    turrets,
    actions,
    rally,
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
  entityWireSource.factorySelectedUnitRows.count = 0;
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
    values[base + 4] = src.turret.turretBlueprintCode;
    values[base + 5] = src.state;
    values[base + 6] = src.targetId !== null ? 1 : 0;
    values[base + 7] = src.targetId ?? 0;
    values[base + 8] = src.currentShieldRange !== null ? 1 : 0;
    values[base + 9] = src.currentShieldRange ?? 0;
    values[base + 10] = src.hpCurr ?? 0;
  }
  return offset;
}

function appendFactorySelectedUnitWireRow(selectedUnitBlueprintCode: number | null | undefined): number {
  if (selectedUnitBlueprintCode === undefined || selectedUnitBlueprintCode === null) return -1;
  const rows = entityWireSource.factorySelectedUnitRows;
  const offset = reserveUint32WireRows(rows, 1, 1);
  rows.values[offset] = selectedUnitBlueprintCode;
  return offset;
}

function appendFactoryRallyWireRow(rally: FactorySub['rally'] | undefined): number {
  if (rally === undefined) return -1;
  const rows = entityWireSource.waypointRows;
  const offset = reserveFloat64WireRows(rows, 1, ENTITY_SNAPSHOT_WIRE_WAYPOINT_STRIDE);
  const values = rows.values;
  const strings = entityWireSource.waypointStrings;
  const base = offset * ENTITY_SNAPSHOT_WIRE_WAYPOINT_STRIDE;
  values[base + 0] = rally.pos.x;
  values[base + 1] = rally.pos.y;
  values[base + 2] = rally.posZ !== null ? 1 : 0;
  values[base + 3] = rally.posZ ?? 0;
  values[base + 4] = strings.length;
  strings.push(rally.type);
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
  values[base + 2] = pos !== null ? pos.x : 0;
  values[base + 3] = pos !== null ? pos.y : 0;
  values[base + 4] = pos !== null ? pos.z : 0;
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
  const hp = unit.hp;
  const velocity = unit.velocity;
  const actionOffset = appendActionWireRows(actions);
  const turretOffset = appendTurretWireRows(turrets);
  const pos = entity.pos;

  values[base + 0] = entity.id;
  values[base + 1] = pos !== null ? pos.x : 0;
  values[base + 2] = pos !== null ? pos.y : 0;
  values[base + 3] = pos !== null ? pos.z : 0;
  values[base + 4] = entity.rotation ?? 0;
  values[base + 5] = entity.playerId;
  values[base + 6] = entity.changedFields !== null ? 1 : 0;
  values[base + 7] = entity.changedFields ?? 0;
  values[base + 8] = hp !== null ? hp.curr : 0;
  values[base + 9] = hp !== null ? hp.max : 0;
  values[base + 10] = velocity !== null ? velocity.x : 0;
  values[base + 11] = velocity !== null ? velocity.y : 0;
  values[base + 12] = velocity !== null ? velocity.z : 0;
  values[base + 13] = unit.unitBlueprintCode !== null ? 1 : 0;
  values[base + 14] = unit.unitBlueprintCode ?? 0;
  values[base + 15] = radius !== null ? 1 : 0;
  values[base + 16] = radius !== null && radius.visual !== null ? radius.visual : 0;
  values[base + 17] = radius !== null && radius.hitbox !== null ? radius.hitbox : 0;
  values[base + 18] = radius !== null && radius.collision !== null ? radius.collision : 0;
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
  const hp = building.hp;
  const build = building.build;
  const turretOffset = appendTurretWireRows(turrets);
  const factorySelectedUnitOffset = appendFactorySelectedUnitWireRow(
    factory !== null ? factory.selectedUnitBlueprintCode : undefined,
  );
  const factoryRallyOffset = appendFactoryRallyWireRow(factory !== null ? factory.rally : undefined);
  const pos = entity.pos;
  values[base + 0] = entity.id;
  values[base + 1] = pos !== null ? pos.x : 0;
  values[base + 2] = pos !== null ? pos.y : 0;
  values[base + 3] = pos !== null ? pos.z : 0;
  values[base + 4] = entity.rotation ?? 0;
  values[base + 5] = entity.playerId;
  values[base + 6] = entity.changedFields !== null ? 1 : 0;
  values[base + 7] = entity.changedFields ?? 0;
  values[base + 8] = building.buildingBlueprintCode !== null ? 1 : 0;
  values[base + 9] = building.buildingBlueprintCode ?? 0;
  values[base + 10] = dim !== null ? 1 : 0;
  values[base + 11] = dim !== null ? dim.x : 0;
  values[base + 12] = dim !== null ? dim.y : 0;
  values[base + 13] = hp !== null ? hp.curr : 0;
  values[base + 14] = hp !== null ? hp.max : 0;
  values[base + 15] = build !== null && build.complete ? 1 : 0;
  values[base + 16] = build !== null ? build.paid.energy : 0;
  values[base + 17] = build !== null ? build.paid.metal : 0;
  values[base + 18] = building.metalExtractionRate !== null ? 1 : 0;
  values[base + 19] = building.metalExtractionRate ?? 0;
  values[base + 20] = solar !== null ? 1 : 0;
  values[base + 21] = solar !== null && solar.open === true ? 1 : 0;
  values[base + 22] = turrets !== null ? 1 : 0;
  values[base + 23] = turrets !== null ? turrets.length : 0;
  values[base + 24] = factory !== null ? 1 : 0;
  values[base + 25] = factory !== null && factory.selectedUnitBlueprintCode !== null ? 1 : 0;
  values[base + 26] = factory !== null ? factory.progress : 0;
  values[base + 27] = factory !== null && factory.producing === true ? 1 : 0;
  values[base + 28] = factory !== null ? factory.energyRate : 0;
  values[base + 29] = factory !== null ? factory.metalRate : 0;
  values[base + 30] = factory !== null ? 1 : 0;
  values[base + 31] = turretOffset;
  values[base + 32] = factorySelectedUnitOffset;
  values[base + 33] = factoryRallyOffset;
  entityWireSource.kinds.push(ENTITY_SNAPSHOT_WIRE_KIND_BUILDING);
  entityWireSource.rowIndices.push(rowIndex);
}

function hasInactiveTurretWire(turrets: readonly NetworkServerSnapshotTurret[] | null): boolean {
  if (turrets === null) return false;
  for (let i = 0; i < turrets.length; i++) {
    if (turrets[i].active === false) return true;
  }
  return false;
}

function appendEntitySnapshotWireRow(entity: NetworkServerSnapshotEntity): void {
  if (
    entity.type === 'unit' &&
    entity.unit !== null &&
    entity.building === null
  ) {
    if (
      entity.unit.build?.interrupted === true ||
      hasInactiveTurretWire(entity.unit.turrets)
    ) {
      appendRawEntityWireRow();
      return;
    }
    appendUnitEntityWireRow(entity, entity.unit);
    return;
  }

  if (
    (entity.type === 'building' || entity.type === 'tower') &&
    entity.building !== null &&
    entity.unit === null
  ) {
    // Towers and buildings share the static wire row (same HP /
    // optional combat / optional factory shape). The TOWER vs
    // BUILDING discriminator is reconstructed on the receive side
    // via isTowerBuildingBlueprintId so the renderer + UI dispatch on the
    // peer entity-type tag.
    if (
      entity.building.build?.interrupted === true ||
      hasInactiveTurretWire(entity.building.turrets)
    ) {
      appendRawEntityWireRow();
      return;
    }
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
          interrupted: entity.buildable.isInterrupted,
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
        b.metalExtractionRate = entity.buildingBlueprintId === 'buildingExtractor'
          ? entity.metalExtractionRate ?? 0
          : null;
      } else {
        b.dim = null;
        b.buildingBlueprintCode = null;
        b.metalExtractionRate = (changedFields! & ENTITY_CHANGED_BUILDING) !== 0 &&
          entity.buildingBlueprintId === 'buildingExtractor'
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
          f.energyRate = entity.factory.energyRateFraction;
          f.metalRate = entity.factory.metalRateFraction;

          poolEntry.rally.pos.x = entity.factory.rallyX;
          poolEntry.rally.pos.y = entity.factory.rallyY;
          poolEntry.rally.posZ = entity.factory.rallyZ;
          poolEntry.rally.type = entity.factory.rallyType;
          f.rally = poolEntry.rally;
        }
      }
    }
  }

  appendEntitySnapshotWireRow(ne);
  return ne;
}
