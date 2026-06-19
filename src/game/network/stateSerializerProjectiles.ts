import type { WorldState } from '../sim/WorldState';
import type { Entity, Projectile, BeamPoint } from '../../types/sim';
import type { EntityId, PlayerId } from '../sim/types';
import { NO_ENTITY_ID } from '../sim/types';
import type {
  ProjectileDespawnEvent,
  ProjectileSpawnEvent,
  ProjectileVelocityUpdateEvent,
} from '../sim/combat';
import type { Vec3 } from '../../types/vec2';
import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotBeamPoint,
  NetworkServerSnapshotBeamUpdate,
  NetworkServerSnapshotProjectileDespawn,
  NetworkServerSnapshotProjectileSpawn,
  NetworkServerSnapshotVelocityUpdate,
} from './NetworkManager';
import type { SnapshotVisibility } from './stateSerializerVisibility';
import { BEAM_MAX_SEGMENTS } from '../../config';
import {
  PROJECTILE_TYPE_UNKNOWN,
  TURRET_BLUEPRINT_CODE_UNKNOWN,
  projectileTypeToCode,
  shotBlueprintIdToCode,
  turretBlueprintIdToCode,
} from '../../types/network';
import { definePooledScratchProperty } from './snapshotPooledScratch';
import {
  createFloat64WireRows,
  createUint32WireRows,
  reserveFloat64WireRows,
  reserveUint32WireRows,
  type Float64WireRows,
  type Uint32WireRows,
} from './snapshotWireRows';
import {
  quantizeNormal as qNormal,
  quantizeProjectilePosition as qPos,
  quantizeRotation as qRot,
  quantizeVelocity as qVel,
} from './snapshotQuantization';

type ProjectileSnapshot = NonNullable<NetworkServerSnapshot['projectiles']>;

export const PROJECTILE_SPAWN_WIRE_STRIDE = 32;
const PROJECTILE_DESPAWN_WIRE_STRIDE = 1;
export const PROJECTILE_VELOCITY_WIRE_STRIDE = 9;
export const PROJECTILE_BEAM_UPDATE_WIRE_STRIDE = 4;
export const PROJECTILE_BEAM_POINT_WIRE_STRIDE = 12;
// Wire polyline capacity matches the sim trace exactly: BEAM_MAX_SEGMENTS
// allows up to maxSegments - 1 reflection vertices plus start and end.
// A smaller cap would silently drop a reflection vertex and draw the
// beam straight through the reflector on clients.
const PROJECTILE_BEAM_POINT_CAP = BEAM_MAX_SEGMENTS + 1;

export const PROJECTILE_SPAWN_FLAG_MAX_LIFESPAN = 0x001;
export const PROJECTILE_SPAWN_FLAG_SHOT_BLUEPRINT_CODE = 0x002;
export const PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_BLUEPRINT_CODE = 0x004;
export const PROJECTILE_SPAWN_FLAG_IS_DGUN_TRUE = 0x008;
export const PROJECTILE_SPAWN_FLAG_FROM_PARENT_TRUE = 0x010;
export const PROJECTILE_SPAWN_FLAG_BEAM = 0x020;
export const PROJECTILE_SPAWN_FLAG_TARGET_ENTITY_ID = 0x040;
export const PROJECTILE_SPAWN_FLAG_HOMING_TURN_RATE = 0x080;
export const PROJECTILE_SPAWN_FLAG_IS_DGUN_FALSE = 0x100;
export const PROJECTILE_SPAWN_FLAG_FROM_PARENT_FALSE = 0x200;
export const PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_ENTITY_ID = 0x400;
export const PROJECTILE_SPAWN_FLAG_PARENT_SHOT_ENTITY_ID = 0x800;

export const PROJECTILE_BEAM_UPDATE_FLAG_OBSTRUCTION_T = 0x01;
export const PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_FALSE = 0x02;
export const PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_TRUE = 0x04;

export const PROJECTILE_BEAM_POINT_FLAG_MIRROR_ENTITY_ID = 0x01;
export const PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_KIND = 0x02;
export const PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_PLAYER_ID = 0x08;
export const PROJECTILE_BEAM_POINT_FLAG_NORMAL_X = 0x10;
export const PROJECTILE_BEAM_POINT_FLAG_NORMAL_Y = 0x20;
export const PROJECTILE_BEAM_POINT_FLAG_NORMAL_Z = 0x40;

export type ProjectileSnapshotWireSource = {
  spawns: Float64WireRows;
  despawns: Uint32WireRows;
  velocityUpdates: Float64WireRows;
  beamUpdates: Float64WireRows;
  beamPoints: Float64WireRows;
};

type MutableNumberRow = Float64Array | number[];

type PooledProjectileSpawn = NetworkServerSnapshotProjectileSpawn & {
  _pos: Vec3;
  _velocity: Vec3;
  _beamStart: Vec3;
  _beamEnd: Vec3;
  _beam: { start: Vec3; end: Vec3 };
};

type PooledVelocityUpdate = NetworkServerSnapshotVelocityUpdate & {
  _pos: Vec3;
  _velocity: Vec3;
};

type SerializeProjectileSnapshotOptions = {
  world: WorldState;
  fullStateResync: boolean;
  visibility: SnapshotVisibility | undefined;
  emitBeamUpdates: boolean;
  projectileSpawns: ProjectileSpawnEvent[] | undefined;
  projectileDespawns: ProjectileDespawnEvent[] | undefined;
  projectileVelocityUpdates: ProjectileVelocityUpdateEvent[] | undefined;
};

const _spawnBuf: NetworkServerSnapshotProjectileSpawn[] = [];
const _despawnBuf: NetworkServerSnapshotProjectileDespawn[] = [];
const _velUpdateBuf: NetworkServerSnapshotVelocityUpdate[] = [];
const _beamUpdateBuf: NetworkServerSnapshotBeamUpdate[] = [];
const _spawnPool: NetworkServerSnapshotProjectileSpawn[] = [];
const _despawnPool: NetworkServerSnapshotProjectileDespawn[] = [];
const _velUpdatePool: NetworkServerSnapshotVelocityUpdate[] = [];
const _beamUpdatePool: NetworkServerSnapshotBeamUpdate[] = [];
const _beamPointPool: NetworkServerSnapshotBeamPoint[] = [];
let _spawnPoolIndex = 0;
let _despawnPoolIndex = 0;
let _velUpdatePoolIndex = 0;
let _beamUpdatePoolIndex = 0;
let _beamPointPoolIndex = 0;
const _resyncSeenIds = new Set<number>();

const _projectilesBuf: ProjectileSnapshot = {
  spawns: undefined,
  despawns: undefined,
  velocityUpdates: undefined,
  beamUpdates: undefined,
};
const _directProjectileSpawnPlaceholders: NetworkServerSnapshotProjectileSpawn[] = [];
const _directProjectileDespawnPlaceholders: NetworkServerSnapshotProjectileDespawn[] = [];
const _directProjectileVelocityPlaceholders: NetworkServerSnapshotVelocityUpdate[] = [];
const _directProjectileBeamUpdatePlaceholders: NetworkServerSnapshotBeamUpdate[] = [];
const _directProjectilesBuf: ProjectileSnapshot = {
  spawns: undefined,
  despawns: undefined,
  velocityUpdates: undefined,
  beamUpdates: undefined,
};
const projectileWireSource: ProjectileSnapshotWireSource = {
  spawns: createFloat64WireRows(),
  despawns: createUint32WireRows(),
  velocityUpdates: createFloat64WireRows(),
  beamUpdates: createFloat64WireRows(),
  beamPoints: createFloat64WireRows(),
};
const projectileWireSources = new WeakMap<object, ProjectileSnapshotWireSource>([
  [_projectilesBuf, projectileWireSource],
  [_directProjectilesBuf, projectileWireSource],
]);

function createPooledBeamUpdate(): NetworkServerSnapshotBeamUpdate {
  return {
    id: 0,
    points: [],
    obstructionT: null,
    endpointDamageable: null,
  };
}

function createPooledBeamPoint(): NetworkServerSnapshotBeamPoint {
  return {
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    reflectorEntityId: null,
    reflectorKind: null,
    reflectorPlayerId: null,
    normalX: null,
    normalY: null,
    normalZ: null,
  };
}

function createPooledProjectileSpawn(): NetworkServerSnapshotProjectileSpawn {
  const spawn: PooledProjectileSpawn = {
    id: 0,
    pos: { x: 0, y: 0, z: 0 },
    rotation: 0,
    velocity: { x: 0, y: 0, z: 0 },
    projectileType: PROJECTILE_TYPE_UNKNOWN,
    maxLifespan: null,
    turretBlueprintCode: TURRET_BLUEPRINT_CODE_UNKNOWN,
    shotBlueprintCode: null,
    sourceTurretBlueprintCode: null,
    sourceTurretEntityId: null,
    playerId: 1,
    sourceEntityId: 0,
    sourceHostEntityId: 0,
    sourceRootEntityId: 0,
    sourceTeamId: 1,
    spawnTick: 0,
    parentShotEntityId: null,
    turretIndex: 0,
    barrelIndex: 0,
    isDGun: null,
    fromParentDetonation: null,
    beam: null,
    targetEntityId: null,
    homingTurnRate: null,
  } as PooledProjectileSpawn;
  definePooledScratchProperty(spawn, '_pos', { x: 0, y: 0, z: 0 });
  definePooledScratchProperty(spawn, '_velocity', { x: 0, y: 0, z: 0 });
  definePooledScratchProperty(spawn, '_beamStart', { x: 0, y: 0, z: 0 });
  definePooledScratchProperty(spawn, '_beamEnd', { x: 0, y: 0, z: 0 });
  definePooledScratchProperty(spawn, '_beam', {
    start: { x: 0, y: 0, z: 0 },
    end: { x: 0, y: 0, z: 0 },
  });
  spawn.pos = spawn._pos;
  spawn.velocity = spawn._velocity;
  spawn._beam.start = spawn._beamStart;
  spawn._beam.end = spawn._beamEnd;
  return spawn;
}

function createPooledProjectileDespawn(): NetworkServerSnapshotProjectileDespawn {
  return { id: 0 };
}

function createPooledVelocityUpdate(): NetworkServerSnapshotVelocityUpdate {
  const update: PooledVelocityUpdate = {
    id: 0,
    pos: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    targetEntityId: null,
    clearHomingTarget: null,
  } as PooledVelocityUpdate;
  definePooledScratchProperty(update, '_pos', { x: 0, y: 0, z: 0 });
  definePooledScratchProperty(update, '_velocity', { x: 0, y: 0, z: 0 });
  update.pos = update._pos;
  update.velocity = update._velocity;
  return update;
}

const _directProjectileSpawnScratch = createPooledProjectileSpawn() as PooledProjectileSpawn;
const _directProjectileVelocityScratch = createPooledVelocityUpdate() as PooledVelocityUpdate;
const _directBeamUpdateScratch = createPooledBeamUpdate();
const _directBeamPointScratch = createPooledBeamPoint();

function getPooledBeamUpdate(): NetworkServerSnapshotBeamUpdate {
  let update = _beamUpdatePool[_beamUpdatePoolIndex];
  if (!update) {
    update = createPooledBeamUpdate();
    _beamUpdatePool[_beamUpdatePoolIndex] = update;
  }
  _beamUpdatePoolIndex++;
  update.points.length = 0;
  update.obstructionT = null;
  update.endpointDamageable = null;
  return update;
}

function getPooledBeamPoint(): NetworkServerSnapshotBeamPoint {
  let point = _beamPointPool[_beamPointPoolIndex];
  if (!point) {
    point = createPooledBeamPoint();
    _beamPointPool[_beamPointPoolIndex] = point;
  }
  _beamPointPoolIndex++;
  point.reflectorEntityId = null;
  point.reflectorKind = null;
  point.reflectorPlayerId = null;
  point.normalX = null;
  point.normalY = null;
  point.normalZ = null;
  return point;
}

function getPooledProjectileSpawn(): PooledProjectileSpawn {
  let spawn = _spawnPool[_spawnPoolIndex] as PooledProjectileSpawn | undefined;
  if (!spawn) {
    spawn = createPooledProjectileSpawn() as PooledProjectileSpawn;
    _spawnPool[_spawnPoolIndex] = spawn;
  }
  _spawnPoolIndex++;
  return spawn;
}

function getPooledProjectileDespawn(): NetworkServerSnapshotProjectileDespawn {
  let despawn = _despawnPool[_despawnPoolIndex];
  if (!despawn) {
    despawn = createPooledProjectileDespawn();
    _despawnPool[_despawnPoolIndex] = despawn;
  }
  _despawnPoolIndex++;
  return despawn;
}

function getPooledVelocityUpdate(): PooledVelocityUpdate {
  let update = _velUpdatePool[_velUpdatePoolIndex] as PooledVelocityUpdate | undefined;
  if (!update) {
    update = createPooledVelocityUpdate() as PooledVelocityUpdate;
    _velUpdatePool[_velUpdatePoolIndex] = update;
  }
  _velUpdatePoolIndex++;
  return update;
}

function resetProjectileWireSource(): void {
  projectileWireSource.spawns.count = 0;
  projectileWireSource.despawns.count = 0;
  projectileWireSource.velocityUpdates.count = 0;
  projectileWireSource.beamUpdates.count = 0;
  projectileWireSource.beamPoints.count = 0;
}

export function writeProjectileSpawnWireRow(
  values: MutableNumberRow,
  base: number,
  spawn: NetworkServerSnapshotProjectileSpawn,
): void {
  values[base + 0] = spawn.id;
  values[base + 1] = spawn.pos.x;
  values[base + 2] = spawn.pos.y;
  values[base + 3] = spawn.pos.z;
  values[base + 4] = spawn.rotation;
  values[base + 5] = spawn.velocity.x;
  values[base + 6] = spawn.velocity.y;
  values[base + 7] = spawn.velocity.z;
  values[base + 8] = spawn.projectileType;
  values[base + 9] = spawn.maxLifespan ?? 0;
  values[base + 10] = spawn.turretBlueprintCode;
  values[base + 11] = spawn.shotBlueprintCode ?? 0;
  values[base + 12] = spawn.sourceTurretBlueprintCode ?? 0;
  values[base + 13] = spawn.playerId;
  values[base + 14] = spawn.sourceEntityId;
  values[base + 15] = spawn.turretIndex;
  values[base + 16] = spawn.barrelIndex;
  const beam = spawn.beam;
  values[base + 17] = beam !== null ? beam.start.x : 0;
  values[base + 18] = beam !== null ? beam.start.y : 0;
  values[base + 19] = beam !== null ? beam.start.z : 0;
  values[base + 20] = beam !== null ? beam.end.x : 0;
  values[base + 21] = beam !== null ? beam.end.y : 0;
  values[base + 22] = beam !== null ? beam.end.z : 0;
  values[base + 23] = spawn.targetEntityId ?? 0;
  values[base + 24] = spawn.homingTurnRate ?? 0;
  values[base + 25] = spawn.sourceTurretEntityId ?? 0;
  values[base + 26] = spawn.sourceHostEntityId;
  values[base + 27] = spawn.sourceRootEntityId;
  values[base + 28] = spawn.sourceTeamId;
  values[base + 29] = spawn.spawnTick;
  values[base + 30] = spawn.parentShotEntityId ?? 0;
  let flags = 0;
  if (spawn.maxLifespan !== null) flags |= PROJECTILE_SPAWN_FLAG_MAX_LIFESPAN;
  if (spawn.shotBlueprintCode !== null) flags |= PROJECTILE_SPAWN_FLAG_SHOT_BLUEPRINT_CODE;
  if (spawn.sourceTurretBlueprintCode !== null) flags |= PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_BLUEPRINT_CODE;
  if (spawn.sourceTurretEntityId !== null) {
    flags |= PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_ENTITY_ID;
  }
  if (spawn.parentShotEntityId !== null) flags |= PROJECTILE_SPAWN_FLAG_PARENT_SHOT_ENTITY_ID;
  if (spawn.isDGun !== null) {
    flags |= spawn.isDGun
      ? PROJECTILE_SPAWN_FLAG_IS_DGUN_TRUE
      : PROJECTILE_SPAWN_FLAG_IS_DGUN_FALSE;
  }
  if (spawn.fromParentDetonation !== null) {
    flags |= spawn.fromParentDetonation
      ? PROJECTILE_SPAWN_FLAG_FROM_PARENT_TRUE
      : PROJECTILE_SPAWN_FLAG_FROM_PARENT_FALSE;
  }
  if (spawn.beam !== null) flags |= PROJECTILE_SPAWN_FLAG_BEAM;
  if (spawn.targetEntityId !== null) flags |= PROJECTILE_SPAWN_FLAG_TARGET_ENTITY_ID;
  if (spawn.homingTurnRate !== null) flags |= PROJECTILE_SPAWN_FLAG_HOMING_TURN_RATE;
  values[base + 31] = flags;
}

function copyProjectileSpawnIntoWireRow(spawn: NetworkServerSnapshotProjectileSpawn): void {
  const rows = projectileWireSource.spawns;
  const rowIndex = reserveFloat64WireRows(rows, 1, PROJECTILE_SPAWN_WIRE_STRIDE);
  writeProjectileSpawnWireRow(
    rows.values,
    rowIndex * PROJECTILE_SPAWN_WIRE_STRIDE,
    spawn,
  );
}

function copyProjectileDespawnIntoWireRow(despawn: NetworkServerSnapshotProjectileDespawn): void {
  const rows = projectileWireSource.despawns;
  const rowIndex = reserveUint32WireRows(rows, 1, PROJECTILE_DESPAWN_WIRE_STRIDE);
  rows.values[rowIndex] = despawn.id;
}

export function writeProjectileVelocityUpdateWireRow(
  values: MutableNumberRow,
  base: number,
  update: NetworkServerSnapshotVelocityUpdate,
): void {
  values[base + 0] = update.id;
  values[base + 1] = update.pos.x;
  values[base + 2] = update.pos.y;
  values[base + 3] = update.pos.z;
  values[base + 4] = update.velocity.x;
  values[base + 5] = update.velocity.y;
  values[base + 6] = update.velocity.z;
  values[base + 7] = update.clearHomingTarget === true ? 1 : 0;
  values[base + 8] = update.targetEntityId ?? 0;
}

function copyProjectileVelocityUpdateIntoWireRow(update: NetworkServerSnapshotVelocityUpdate): void {
  const rows = projectileWireSource.velocityUpdates;
  const rowIndex = reserveFloat64WireRows(rows, 1, PROJECTILE_VELOCITY_WIRE_STRIDE);
  writeProjectileVelocityUpdateWireRow(
    rows.values,
    rowIndex * PROJECTILE_VELOCITY_WIRE_STRIDE,
    update,
  );
}

export function writeBeamPointWireRow(
  values: MutableNumberRow,
  base: number,
  point: NetworkServerSnapshotBeamPoint,
): void {
  values[base + 0] = point.x;
  values[base + 1] = point.y;
  values[base + 2] = point.z;
  values[base + 3] = point.vx;
  values[base + 4] = point.vy;
  values[base + 5] = point.vz;
  let flags = 0;
  if (point.reflectorEntityId !== null) flags |= PROJECTILE_BEAM_POINT_FLAG_MIRROR_ENTITY_ID;
  if (point.reflectorKind !== null) {
    flags |= PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_KIND;
  }
  if (point.reflectorPlayerId !== null) flags |= PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_PLAYER_ID;
  if (point.normalX !== null) flags |= PROJECTILE_BEAM_POINT_FLAG_NORMAL_X;
  if (point.normalY !== null) flags |= PROJECTILE_BEAM_POINT_FLAG_NORMAL_Y;
  if (point.normalZ !== null) flags |= PROJECTILE_BEAM_POINT_FLAG_NORMAL_Z;
  values[base + 6] = flags;
  values[base + 7] = point.reflectorEntityId ?? 0;
  values[base + 8] = point.reflectorPlayerId ?? 0;
  values[base + 9] = point.normalX ?? 0;
  values[base + 10] = point.normalY ?? 0;
  values[base + 11] = point.normalZ ?? 0;
}

function copyBeamPointIntoWireRow(point: NetworkServerSnapshotBeamPoint): void {
  const rows = projectileWireSource.beamPoints;
  const rowIndex = reserveFloat64WireRows(rows, 1, PROJECTILE_BEAM_POINT_WIRE_STRIDE);
  writeBeamPointWireRow(
    rows.values,
    rowIndex * PROJECTILE_BEAM_POINT_WIRE_STRIDE,
    point,
  );
}

export function writeBeamUpdateWireRow(
  values: MutableNumberRow,
  base: number,
  update: NetworkServerSnapshotBeamUpdate,
): void {
  values[base + 0] = update.id;
  let flags = 0;
  if (update.obstructionT !== null) flags |= PROJECTILE_BEAM_UPDATE_FLAG_OBSTRUCTION_T;
  if (update.endpointDamageable !== null) {
    flags |= update.endpointDamageable
      ? PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_TRUE
      : PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_FALSE;
  }
  values[base + 1] = flags;
  values[base + 2] = update.obstructionT ?? 0;
  values[base + 3] = update.points.length;
}

function copyBeamUpdateIntoWireRow(update: NetworkServerSnapshotBeamUpdate): void {
  const rows = projectileWireSource.beamUpdates;
  const rowIndex = reserveFloat64WireRows(rows, 1, PROJECTILE_BEAM_UPDATE_WIRE_STRIDE);
  writeBeamUpdateWireRow(
    rows.values,
    rowIndex * PROJECTILE_BEAM_UPDATE_WIRE_STRIDE,
    update,
  );
}

export function getProjectileSnapshotWireSource(
  projectiles: ProjectileSnapshot,
): ProjectileSnapshotWireSource | undefined {
  return projectileWireSources.get(projectiles);
}

function shouldSendProjectileAtPoint(
  ownerId: PlayerId | undefined,
  visibility: SnapshotVisibility | undefined,
  x: number,
  y: number,
  homingTargetId: number | undefined = undefined,
  world: WorldState | undefined = undefined,
): boolean {
  if (visibility === undefined || !visibility.isFiltered) return true;
  if (visibility.isOwnedByRecipientOrAlly(ownerId)) return true;
  if (visibility.isPointVisible(x, y)) return true;
  // FOW-08-followup: forward in-flight updates when the projectile is
  // homing on one of the recipient's (or their allies') entities, so
  // the player at least sees the missile veering toward their unit
  // instead of taking a silent HP drop from an attacker still hidden
  // in fog. FOW-06 broadens the target check from recipient-only to
  // team-aware via isOwnedByRecipientOrAlly.
  if (homingTargetId !== undefined && homingTargetId !== NO_ENTITY_ID && world !== undefined) {
    const target = world.getEntity(homingTargetId);
    const targetOwnerId = target !== undefined && target.ownership !== null
      ? target.ownership.playerId
      : undefined;
    if (visibility.isOwnedByRecipientOrAlly(targetOwnerId)) return true;
  }
  return false;
}

function shouldSendBeamPath(
  ownerId: PlayerId | undefined,
  visibility: SnapshotVisibility | undefined,
  points: ReadonlyArray<{ x: number; y: number }>,
): boolean {
  if (visibility === undefined || !visibility.isFiltered) return true;
  if (visibility.isOwnedByRecipientOrAlly(ownerId)) return true;
  // FOW-08-followup: forward the beam if EITHER end is visible. A
  // laser fired from fog that lands on the recipient's unit now
  // flashes for them — the source still falls outside vision, but
  // the beam line is drawn from the still-hidden attacker toward
  // the visible endpoint, so the player can see the direction of
  // fire rather than HP melting from nothing.
  const sourcePoint = points[0];
  if (visibility.isPointVisible(sourcePoint.x, sourcePoint.y)) return true;
  const endPoint = points[points.length - 1];
  return visibility.isPointVisible(endPoint.x, endPoint.y);
}

function shouldSendProjectileSpawnEvent(
  spawn: ProjectileSpawnEvent,
  visibility: SnapshotVisibility | undefined,
  world: WorldState,
): boolean {
  if (visibility === undefined || !visibility.isFiltered) return true;
  if (visibility.isOwnedByRecipientOrAlly(spawn.playerId)) return true;
  if (visibility.isPointVisible(spawn.pos.x, spawn.pos.y)) return true;
  // FOW-08: forward the spawn when the shot is targeting one of the
  // recipient's (or their allies') entities. Without this, an attacker
  // hidden in fog can land a kill on the player without the player
  // ever seeing a projectile in flight — the unit just takes a silent
  // HP drop. FOW-06 broadens the target check from recipient-only to
  // team-aware via isOwnedByRecipientOrAlly so allied units get the
  // same incoming-arc reveal.
  if (spawn.targetEntityId !== undefined) {
    const target = world.getEntity(spawn.targetEntityId);
    const targetOwnerId = target !== undefined && target.ownership !== null
      ? target.ownership.playerId
      : undefined;
    if (visibility.isOwnedByRecipientOrAlly(targetOwnerId)) return true;
  }
  return false;
}

function canReferenceEntityId(
  world: WorldState,
  visibility: SnapshotVisibility | undefined,
  entityId: number | undefined,
): boolean {
  if (entityId === undefined || entityId <= 0 || entityId === NO_ENTITY_ID) return false;
  return visibility === undefined ? true : visibility.canReferenceEntityId(world, entityId);
}

function copyProjectileSourceProvenance(
  out: NetworkServerSnapshotProjectileSpawn,
  world: WorldState,
  visibility: SnapshotVisibility | undefined,
  source: {
    playerId: PlayerId;
    sourceEntityId: EntityId;
    sourceTurretEntityId?: EntityId | null;
    sourceHostEntityId?: EntityId | null;
    sourceRootEntityId?: EntityId | null;
    sourceTeamId?: number | null;
    spawnTick?: number | null;
    parentShotEntityId?: EntityId | null;
  },
): void {
  const sourceHostEntityId = source.sourceHostEntityId ?? source.sourceEntityId;
  const sourceRootEntityId = source.sourceRootEntityId ?? sourceHostEntityId;
  const canReferenceSourceHost = canReferenceEntityId(world, visibility, sourceHostEntityId);
  const canReferenceSourceRoot = canReferenceEntityId(world, visibility, sourceRootEntityId);
  out.sourceEntityId = canReferenceEntityId(world, visibility, source.sourceEntityId)
    ? source.sourceEntityId
    : 0;
  out.sourceTurretEntityId = canReferenceSourceHost
    ? source.sourceTurretEntityId ?? null
    : null;
  out.sourceHostEntityId = canReferenceSourceHost ? sourceHostEntityId : 0;
  out.sourceRootEntityId = canReferenceSourceRoot ? sourceRootEntityId : 0;
  out.sourceTeamId = source.sourceTeamId ?? world.getTeamId(source.playerId);
  out.spawnTick = source.spawnTick ?? world.getTick();
  out.parentShotEntityId = source.parentShotEntityId ?? null;
}

function resetProjectilePools(): void {
  _spawnPoolIndex = 0;
  _despawnPoolIndex = 0;
  _velUpdatePoolIndex = 0;
  _beamUpdatePoolIndex = 0;
  _beamPointPoolIndex = 0;
}

function getBeamWirePointCount(sourceCount: number): number {
  return Math.min(sourceCount, PROJECTILE_BEAM_POINT_CAP);
}

// Shared per-item field-fill helpers. The pooled snapshot path
// (serializeProjectileSnapshot) and the direct wire-row path
// (writeProjectileSnapshotWireRowsDirect) fill identical fields; only the
// target object (pooled vs scratch) and what they do afterward (push+copy
// vs copy) differ. Keeping the fill logic in one place guarantees the two
// wire paths stay byte-identical.
function fillProjectileSpawnFromEvent(
  out: PooledProjectileSpawn,
  ps: ProjectileSpawnEvent,
  world: WorldState,
  visibility: SnapshotVisibility | undefined,
): void {
  out.id = ps.id;
  out._pos.x = qPos(ps.pos.x);
  out._pos.y = qPos(ps.pos.y);
  out._pos.z = qPos(ps.pos.z);
  out.rotation = qRot(ps.rotation);
  out._velocity.x = qVel(ps.velocity.x);
  out._velocity.y = qVel(ps.velocity.y);
  out._velocity.z = qVel(ps.velocity.z);
  out.projectileType = projectileTypeToCode(ps.projectileType);
  out.maxLifespan = typeof ps.maxLifespan === 'number' && Number.isFinite(ps.maxLifespan)
    ? ps.maxLifespan
    : null;
  out.turretBlueprintCode = turretBlueprintIdToCode(ps.turretBlueprintId);
  out.shotBlueprintCode = shotBlueprintIdToCode(ps.shotBlueprintId);
  out.sourceTurretBlueprintCode = ps.sourceTurretBlueprintId !== undefined
    ? turretBlueprintIdToCode(ps.sourceTurretBlueprintId)
    : null;
  out.playerId = ps.playerId;
  copyProjectileSourceProvenance(out, world, visibility, ps);
  out.turretIndex = ps.turretIndex;
  out.barrelIndex = ps.barrelIndex;
  out.isDGun = ps.isDGun === true ? true : null;
  out.fromParentDetonation = ps.fromParentDetonation === true ? true : null;
  if (ps.beam) {
    out._beamStart.x = qPos(ps.beam.start.x);
    out._beamStart.y = qPos(ps.beam.start.y);
    out._beamStart.z = qPos(ps.beam.start.z);
    out._beamEnd.x = qPos(ps.beam.end.x);
    out._beamEnd.y = qPos(ps.beam.end.y);
    out._beamEnd.z = qPos(ps.beam.end.z);
    out.beam = out._beam;
  } else {
    out.beam = null;
  }
  out.targetEntityId = canReferenceEntityId(world, visibility, ps.targetEntityId)
    ? ps.targetEntityId ?? null
    : null;
  out.homingTurnRate = ps.homingTurnRate ?? null;
}

function fillProjectileSpawnFromEntity(
  out: PooledProjectileSpawn,
  entity: Entity,
  proj: Projectile,
  world: WorldState,
  visibility: SnapshotVisibility | undefined,
): void {
  out.id = entity.id;
  out._pos.x = qPos(entity.transform.x);
  out._pos.y = qPos(entity.transform.y);
  out._pos.z = qPos(entity.transform.z);
  out.rotation = qRot(entity.transform.rotation);
  out._velocity.x = qVel(proj.velocityX);
  out._velocity.y = qVel(proj.velocityY);
  out._velocity.z = qVel(proj.velocityZ);
  out.projectileType = projectileTypeToCode(proj.projectileType);
  out.maxLifespan = Number.isFinite(proj.maxLifespan)
    ? proj.maxLifespan
    : null;
  out.turretBlueprintCode = proj.sourceTurretBlueprintId !== null
    ? turretBlueprintIdToCode(proj.sourceTurretBlueprintId)
    : TURRET_BLUEPRINT_CODE_UNKNOWN;
  out.shotBlueprintCode = shotBlueprintIdToCode(proj.shotBlueprintId);
  out.sourceTurretBlueprintCode = proj.sourceTurretBlueprintId !== null
    ? turretBlueprintIdToCode(proj.sourceTurretBlueprintId)
    : null;
  out.playerId = proj.ownerId;
  copyProjectileSourceProvenance(out, world, visibility, {
    playerId: proj.ownerId,
    sourceEntityId: proj.sourceEntityId,
    sourceTurretEntityId: proj.shotSource.sourceTurretEntityId,
    sourceHostEntityId: proj.shotSource.sourceHostEntityId,
    sourceRootEntityId: proj.shotSource.sourceRootEntityId,
    sourceTeamId: proj.shotSource.sourceTeamId,
    spawnTick: proj.shotSource.spawnTick,
    parentShotEntityId: proj.shotSource.parentShotEntityId,
  });
  out.turretIndex = proj.config.turretIndex ?? 0;
  out.barrelIndex = proj.sourceBarrelIndex ?? 0;
  const dgunProjectile = entity.dgunProjectile;
  out.isDGun = dgunProjectile !== null && dgunProjectile.isDGun ? true : null;
  // Re-sync spawns carry the projectile's current pos; mark it
  // as authoritative rather than a fresh turret launch.
  out.fromParentDetonation = true;
  const pts = proj.points;
  if (pts && pts.length >= 2) {
    const start = pts[0];
    const end = pts[pts.length - 1];
    out._beamStart.x = qPos(start.x);
    out._beamStart.y = qPos(start.y);
    out._beamStart.z = qPos(start.z);
    out._beamEnd.x = qPos(end.x);
    out._beamEnd.y = qPos(end.y);
    out._beamEnd.z = qPos(end.z);
    out.beam = out._beam;
  } else {
    out.beam = null;
  }
  out.targetEntityId = canReferenceEntityId(world, visibility, proj.homingTargetId)
    ? proj.homingTargetId ?? null
    : null;
  out.homingTurnRate = proj.homingTurnRate ?? null;
}

function fillProjectileVelocityUpdate(
  out: PooledVelocityUpdate,
  vu: ProjectileVelocityUpdateEvent,
  world: WorldState,
  visibility: SnapshotVisibility | undefined,
): void {
  out.id = vu.id;
  out._pos.x = qPos(vu.pos.x);
  out._pos.y = qPos(vu.pos.y);
  out._pos.z = qPos(vu.pos.z);
  out._velocity.x = qVel(vu.velocity.x);
  out._velocity.y = qVel(vu.velocity.y);
  out._velocity.z = qVel(vu.velocity.z);
  const targetEntityId = vu.targetEntityId;
  const canSendTarget = targetEntityId !== undefined &&
    canReferenceEntityId(world, visibility, targetEntityId);
  out.targetEntityId = canSendTarget && targetEntityId !== undefined ? targetEntityId : null;
  out.clearHomingTarget =
    vu.clearHomingTarget === true ||
    (targetEntityId !== undefined && !canSendTarget)
      ? true
      : null;
}

function fillBeamPoint(
  out: NetworkServerSnapshotBeamPoint,
  sp: BeamPoint,
  world: WorldState,
  visibility: SnapshotVisibility | undefined,
): void {
  out.x = qPos(sp.x);
  out.y = qPos(sp.y);
  out.z = qPos(sp.z);
  if (sp.vx === 0 && sp.vy === 0 && sp.vz === 0) {
    out.vx = 0;
    out.vy = 0;
    out.vz = 0;
  } else {
    out.vx = qVel(sp.vx);
    out.vy = qVel(sp.vy);
    out.vz = qVel(sp.vz);
  }
  const canReferenceReflector = sp.reflectorEntityId !== null
    && canReferenceEntityId(world, visibility, sp.reflectorEntityId);
  out.reflectorEntityId = canReferenceReflector ? sp.reflectorEntityId : null;
  out.reflectorKind = canReferenceReflector ? sp.reflectorKind ?? null : null;
  out.reflectorPlayerId = canReferenceReflector ? sp.reflectorPlayerId ?? null : null;
  out.normalX = canReferenceReflector && sp.normalX !== null ? qNormal(sp.normalX) : null;
  out.normalY = canReferenceReflector && sp.normalY !== null ? qNormal(sp.normalY) : null;
  out.normalZ = canReferenceReflector && sp.normalZ !== null ? qNormal(sp.normalZ) : null;
}

export function serializeProjectileSnapshot({
  world,
  fullStateResync,
  visibility,
  emitBeamUpdates,
  projectileSpawns,
  projectileDespawns,
  projectileVelocityUpdates,
}: SerializeProjectileSnapshotOptions): ProjectileSnapshot | undefined {
  resetProjectilePools();
  resetProjectileWireSource();

  // Full-state snapshots synthesize spawns for every live projectile entity so a
  // client that missed the original spawn event can still recover it.
  let netProjectileSpawns: NetworkServerSnapshotProjectileSpawn[] | undefined;
  const wantProjectileResync = fullStateResync;
  const tickSpawnCount = projectileSpawns === undefined ? 0 : projectileSpawns.length;
  if (tickSpawnCount > 0 || wantProjectileResync) {
    _spawnBuf.length = 0;
    if (wantProjectileResync) _resyncSeenIds.clear();
    if (projectileSpawns) {
      for (let i = 0; i < tickSpawnCount; i++) {
        const ps = projectileSpawns[i];
        if (!shouldSendProjectileSpawnEvent(ps, visibility, world)) continue;
        const out = getPooledProjectileSpawn();
        fillProjectileSpawnFromEvent(out, ps, world, visibility);
        _spawnBuf.push(out);
        copyProjectileSpawnIntoWireRow(out);
        if (wantProjectileResync) _resyncSeenIds.add(ps.id);
      }
    }
    if (wantProjectileResync) {
      const liveProjectiles = world.getProjectiles();
      for (let i = 0; i < liveProjectiles.length; i++) {
        const entity = liveProjectiles[i];
        if (_resyncSeenIds.has(entity.id)) continue;
        const proj = entity.projectile;
        if (!proj) continue;
        if (
          !shouldSendProjectileAtPoint(
            proj.ownerId,
            visibility,
            entity.transform.x,
            entity.transform.y,
            proj.homingTargetId,
            world,
          )
        ) {
          continue;
        }
        const out = getPooledProjectileSpawn();
        fillProjectileSpawnFromEntity(out, entity, proj, world, visibility);
        _spawnBuf.push(out);
        copyProjectileSpawnIntoWireRow(out);
      }
    }
    if (_spawnBuf.length > 0) netProjectileSpawns = _spawnBuf;
  }

  let netProjectileDespawns: NetworkServerSnapshotProjectileDespawn[] | undefined;
  if (projectileDespawns && projectileDespawns.length > 0) {
    _despawnBuf.length = 0;
    for (let i = 0; i < projectileDespawns.length; i++) {
      const out = getPooledProjectileDespawn();
      out.id = projectileDespawns[i].id;
      _despawnBuf.push(out);
      copyProjectileDespawnIntoWireRow(out);
    }
    netProjectileDespawns = _despawnBuf;
  }

  let netVelocityUpdates: NetworkServerSnapshotVelocityUpdate[] | undefined;
  if (projectileVelocityUpdates && projectileVelocityUpdates.length > 0) {
    _velUpdateBuf.length = 0;
    for (let i = 0; i < projectileVelocityUpdates.length; i++) {
      const vu = projectileVelocityUpdates[i];
      const projectileEntity = world.getEntity(vu.id);
      const projectile = projectileEntity === undefined ? undefined : projectileEntity.projectile;
      const ownerId = projectile !== null && projectile !== undefined ? projectile.ownerId : undefined;
      if (
        !shouldSendProjectileAtPoint(
          ownerId,
          visibility,
          vu.pos.x,
          vu.pos.y,
          projectile !== null && projectile !== undefined && projectile.homingTargetId !== NO_ENTITY_ID
            ? projectile.homingTargetId
            : vu.visibilityHomingTargetId,
          world,
        )
      ) {
        continue;
      }
      const out = getPooledVelocityUpdate();
      fillProjectileVelocityUpdate(out, vu, world, visibility);
      _velUpdateBuf.push(out);
      copyProjectileVelocityUpdateIntoWireRow(out);
    }
    if (_velUpdateBuf.length > 0) netVelocityUpdates = _velUpdateBuf;
  }

  let netBeamUpdates: NetworkServerSnapshotBeamUpdate[] | undefined;
  const lineProjectiles = world.getLineProjectiles();
  if (emitBeamUpdates && lineProjectiles.length > 0) {
    _beamUpdateBuf.length = 0;
    for (let i = 0; i < lineProjectiles.length; i++) {
      const entity = lineProjectiles[i];
      const proj = entity.projectile;
      if (!proj) continue;
      const srcPts = proj.points;
      if (!srcPts || srcPts.length < 2) continue;
      if (!shouldSendBeamPath(proj.ownerId, visibility, srcPts)) continue;

      const update = getPooledBeamUpdate();
      update.id = entity.id;
      update.obstructionT = proj.obstructionT === null ? null : qRot(proj.obstructionT);
      update.endpointDamageable = proj.endpointDamageable === false ? false : null;
      const dstPts = update.points;
      const wirePointCount = getBeamWirePointCount(srcPts.length);
      dstPts.length = wirePointCount;
      for (let p = 0; p < wirePointCount; p++) {
        const sp = srcPts[p];
        const out = getPooledBeamPoint();
        fillBeamPoint(out, sp, world, visibility);
        dstPts[p] = out;
        copyBeamPointIntoWireRow(out);
      }

      _beamUpdateBuf.push(update);
      copyBeamUpdateIntoWireRow(update);
    }
    if (_beamUpdateBuf.length > 0) netBeamUpdates = _beamUpdateBuf;
  }

  if (!netProjectileSpawns && !netProjectileDespawns && !netVelocityUpdates && !netBeamUpdates) {
    return undefined;
  }

  _projectilesBuf.spawns = netProjectileSpawns;
  _projectilesBuf.despawns = netProjectileDespawns;
  _projectilesBuf.velocityUpdates = netVelocityUpdates;
  _projectilesBuf.beamUpdates = netBeamUpdates;
  return _projectilesBuf;
}

export function writeProjectileSnapshotWireRowsDirect({
  world,
  fullStateResync,
  visibility,
  emitBeamUpdates,
  projectileSpawns,
  projectileDespawns,
  projectileVelocityUpdates,
}: SerializeProjectileSnapshotOptions): ProjectileSnapshot | undefined {
  resetProjectileWireSource();
  _directProjectileSpawnPlaceholders.length = 0;
  _directProjectileDespawnPlaceholders.length = 0;
  _directProjectileVelocityPlaceholders.length = 0;
  _directProjectileBeamUpdatePlaceholders.length = 0;
  _directProjectilesBuf.spawns = undefined;
  _directProjectilesBuf.despawns = undefined;
  _directProjectilesBuf.velocityUpdates = undefined;
  _directProjectilesBuf.beamUpdates = undefined;

  const wantProjectileResync = fullStateResync;
  const tickSpawnCount = projectileSpawns === undefined ? 0 : projectileSpawns.length;
  if (tickSpawnCount > 0 || wantProjectileResync) {
    if (wantProjectileResync) _resyncSeenIds.clear();
    if (projectileSpawns) {
      for (let i = 0; i < tickSpawnCount; i++) {
        const ps = projectileSpawns[i];
        if (!shouldSendProjectileSpawnEvent(ps, visibility, world)) continue;
        const out = _directProjectileSpawnScratch;
        fillProjectileSpawnFromEvent(out, ps, world, visibility);
        copyProjectileSpawnIntoWireRow(out);
        if (wantProjectileResync) _resyncSeenIds.add(ps.id);
      }
    }

    if (wantProjectileResync) {
      const liveProjectiles = world.getProjectiles();
      for (let i = 0; i < liveProjectiles.length; i++) {
        const entity = liveProjectiles[i];
        if (_resyncSeenIds.has(entity.id)) continue;
        const proj = entity.projectile;
        if (!proj) continue;
        if (
          !shouldSendProjectileAtPoint(
            proj.ownerId,
            visibility,
            entity.transform.x,
            entity.transform.y,
            proj.homingTargetId,
            world,
          )
        ) {
          continue;
        }
        const out = _directProjectileSpawnScratch;
        fillProjectileSpawnFromEntity(out, entity, proj, world, visibility);
        copyProjectileSpawnIntoWireRow(out);
      }
    }
  }

  if (projectileDespawns && projectileDespawns.length > 0) {
    for (let i = 0; i < projectileDespawns.length; i++) {
      const rows = projectileWireSource.despawns;
      const rowIndex = reserveUint32WireRows(rows, 1, PROJECTILE_DESPAWN_WIRE_STRIDE);
      rows.values[rowIndex] = projectileDespawns[i].id;
    }
  }

  if (projectileVelocityUpdates && projectileVelocityUpdates.length > 0) {
    for (let i = 0; i < projectileVelocityUpdates.length; i++) {
      const vu = projectileVelocityUpdates[i];
      const projectileEntity = world.getEntity(vu.id);
      const projectile = projectileEntity === undefined ? undefined : projectileEntity.projectile;
      const ownerId = projectile !== null && projectile !== undefined ? projectile.ownerId : undefined;
      if (
        !shouldSendProjectileAtPoint(
          ownerId,
          visibility,
          vu.pos.x,
          vu.pos.y,
          projectile !== null && projectile !== undefined && projectile.homingTargetId !== NO_ENTITY_ID
            ? projectile.homingTargetId
            : vu.visibilityHomingTargetId,
          world,
        )
      ) {
        continue;
      }
      const out = _directProjectileVelocityScratch;
      fillProjectileVelocityUpdate(out, vu, world, visibility);
      copyProjectileVelocityUpdateIntoWireRow(out);
    }
  }

  const lineProjectiles = world.getLineProjectiles();
  if (emitBeamUpdates && lineProjectiles.length > 0) {
    for (let i = 0; i < lineProjectiles.length; i++) {
      const entity = lineProjectiles[i];
      const proj = entity.projectile;
      if (!proj) continue;
      const srcPts = proj.points;
      if (!srcPts || srcPts.length < 2) continue;
      if (!shouldSendBeamPath(proj.ownerId, visibility, srcPts)) continue;

      const update = _directBeamUpdateScratch;
      update.id = entity.id;
      update.obstructionT = proj.obstructionT === null ? null : qRot(proj.obstructionT);
      update.endpointDamageable = proj.endpointDamageable === false ? false : null;
      const wirePointCount = getBeamWirePointCount(srcPts.length);
      update.points.length = wirePointCount;
      for (let p = 0; p < wirePointCount; p++) {
        const sp = srcPts[p];
        const out = _directBeamPointScratch;
        fillBeamPoint(out, sp, world, visibility);
        copyBeamPointIntoWireRow(out);
      }

      copyBeamUpdateIntoWireRow(update);
    }
  }

  const spawnCount = projectileWireSource.spawns.count;
  const despawnCount = projectileWireSource.despawns.count;
  const velocityCount = projectileWireSource.velocityUpdates.count;
  const beamUpdateCount = projectileWireSource.beamUpdates.count;
  if (spawnCount === 0 && despawnCount === 0 && velocityCount === 0 && beamUpdateCount === 0) {
    return undefined;
  }

  if (spawnCount > 0) {
    _directProjectileSpawnPlaceholders.length = spawnCount;
    _directProjectilesBuf.spawns = _directProjectileSpawnPlaceholders;
  }
  if (despawnCount > 0) {
    _directProjectileDespawnPlaceholders.length = despawnCount;
    _directProjectilesBuf.despawns = _directProjectileDespawnPlaceholders;
  }
  if (velocityCount > 0) {
    _directProjectileVelocityPlaceholders.length = velocityCount;
    _directProjectilesBuf.velocityUpdates = _directProjectileVelocityPlaceholders;
  }
  if (beamUpdateCount > 0) {
    _directProjectileBeamUpdatePlaceholders.length = beamUpdateCount;
    _directProjectilesBuf.beamUpdates = _directProjectileBeamUpdatePlaceholders;
  }
  return _directProjectilesBuf;
}
