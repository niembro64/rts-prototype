import type { PlayerId } from '../../types/sim';
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

const PACKED_ENTITIES_VERSION = 1;

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
// Encoding stays in msgpack-friendly primitives (numbers, strings,
// nested arrays) so neither the JS encoder nor the Rust raw-msgpack
// fallback need a custom extension type.
export type PackedEntityRow = unknown[];

export type PackedEntitySnapshotWire = {
  v: typeof PACKED_ENTITIES_VERSION;
  e: PackedEntityRow[];
};

export function packEntitiesForWire(
  entities: readonly NetworkServerSnapshotEntity[] | undefined,
): PackedEntitySnapshotWire | undefined {
  if (entities === undefined) return undefined;
  const rows: PackedEntityRow[] = new Array(entities.length);
  for (let i = 0; i < entities.length; i++) {
    rows[i] = packEntityRow(entities[i]);
  }
  return { v: PACKED_ENTITIES_VERSION, e: rows };
}

export function unpackEntitiesFromWire(
  packed: PackedEntitySnapshotWire,
): NetworkServerSnapshotEntity[] {
  const rows = packed.e;
  const out: NetworkServerSnapshotEntity[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    out[i] = unpackEntityRow(rows[i]);
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
  return (
    candidate.v === PACKED_ENTITIES_VERSION && Array.isArray(candidate.e)
  );
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
