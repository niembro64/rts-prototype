import type { WorldState } from '../sim/WorldState';
import type { Entity, Projectile, BeamPoint } from '../../types/sim';
import type { EntityId, PlayerId } from '../sim/types';
import { NO_ENTITY_ID } from '../sim/types';
import type {
  ProjectileDespawnEvent,
  ProjectileSpawnEvent,
  ProjectileMotionUpdateEvent,
} from '../sim/combat';
import type { Vec3 } from '../../types/vec2';
import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotBeamPoint,
  NetworkServerSnapshotBeamUpdate,
  NetworkServerSnapshotProjectileDespawn,
  NetworkServerSnapshotProjectileSpawn,
  NetworkServerSnapshotMotionUpdate,
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
import {
  PROJECTILE_BEAM_POINT_FLAG_MIRROR_ENTITY_ID,
  PROJECTILE_BEAM_POINT_FLAG_NORMAL_X,
  PROJECTILE_BEAM_POINT_FLAG_NORMAL_Y,
  PROJECTILE_BEAM_POINT_FLAG_NORMAL_Z,
  PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_KIND,
  PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_PLAYER_ID,
  PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_FALSE,
  PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_TRUE,
  PROJECTILE_BEAM_UPDATE_FLAG_OBSTRUCTION_T,
  PROJECTILE_SPAWN_FLAG_BEAM,
  PROJECTILE_SPAWN_FLAG_FROM_PARENT_FALSE,
  PROJECTILE_SPAWN_FLAG_FROM_PARENT_TRUE,
  PROJECTILE_SPAWN_FLAG_HOMING_TURN_RATE,
  PROJECTILE_SPAWN_FLAG_IS_DGUN_FALSE,
  PROJECTILE_SPAWN_FLAG_IS_DGUN_TRUE,
  PROJECTILE_SPAWN_FLAG_MAX_LIFESPAN,
  PROJECTILE_SPAWN_FLAG_PARENT_SHOT_ENTITY_ID,
  PROJECTILE_SPAWN_FLAG_SHOT_BLUEPRINT_CODE,
  PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_BLUEPRINT_CODE,
  PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_ENTITY_ID,
  PROJECTILE_SPAWN_FLAG_TARGET_ENTITY_ID,
  getProjectileBeamPointWireFlags,
  getProjectileSpawnWireFlags,
  projectileBeamEndpointDamageableFromFlags,
} from './projectileWireFlags';
export {
  PROJECTILE_BEAM_POINT_FLAG_MIRROR_ENTITY_ID,
  PROJECTILE_BEAM_POINT_FLAG_NORMAL_X,
  PROJECTILE_BEAM_POINT_FLAG_NORMAL_Y,
  PROJECTILE_BEAM_POINT_FLAG_NORMAL_Z,
  PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_KIND,
  PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_PLAYER_ID,
  PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_FALSE,
  PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_TRUE,
  PROJECTILE_BEAM_UPDATE_FLAG_OBSTRUCTION_T,
  PROJECTILE_SPAWN_FLAG_BEAM,
  PROJECTILE_SPAWN_FLAG_FROM_PARENT_FALSE,
  PROJECTILE_SPAWN_FLAG_FROM_PARENT_TRUE,
  PROJECTILE_SPAWN_FLAG_HOMING_TURN_RATE,
  PROJECTILE_SPAWN_FLAG_IS_DGUN_FALSE,
  PROJECTILE_SPAWN_FLAG_IS_DGUN_TRUE,
  PROJECTILE_SPAWN_FLAG_MAX_LIFESPAN,
  PROJECTILE_SPAWN_FLAG_PARENT_SHOT_ENTITY_ID,
  PROJECTILE_SPAWN_FLAG_SHOT_BLUEPRINT_CODE,
  PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_BLUEPRINT_CODE,
  PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_ENTITY_ID,
  PROJECTILE_SPAWN_FLAG_TARGET_ENTITY_ID,
};

type ProjectileSnapshot = NonNullable<NetworkServerSnapshot['projectiles']>;

export const PROJECTILE_SPAWN_WIRE_STRIDE = 32;
const PROJECTILE_DESPAWN_WIRE_STRIDE = 1;
export const PROJECTILE_MOTION_WIRE_STRIDE = 9;
export const PROJECTILE_BEAM_UPDATE_WIRE_STRIDE = 4;
export const PROJECTILE_BEAM_POINT_WIRE_STRIDE = 12;
// Wire polyline capacity matches the sim trace exactly: BEAM_MAX_SEGMENTS
// allows up to maxSegments - 1 reflection vertices plus start and end.
// A smaller cap would silently drop a reflection vertex and draw the
// beam straight through the reflector on clients.
const PROJECTILE_BEAM_POINT_CAP = BEAM_MAX_SEGMENTS + 1;

export type ProjectileSnapshotWireSource = {
  spawns: Float64WireRows;
  despawns: Uint32WireRows;
  motionUpdates: Float64WireRows;
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

type PooledMotionUpdate = NetworkServerSnapshotMotionUpdate & {
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
  projectileMotionUpdates: ProjectileMotionUpdateEvent[] | undefined;
};

const _spawnBuf: NetworkServerSnapshotProjectileSpawn[] = [];
const _despawnBuf: NetworkServerSnapshotProjectileDespawn[] = [];
const _motionUpdateBuf: NetworkServerSnapshotMotionUpdate[] = [];
const _beamUpdateBuf: NetworkServerSnapshotBeamUpdate[] = [];
const _spawnPool: NetworkServerSnapshotProjectileSpawn[] = [];
const _despawnPool: NetworkServerSnapshotProjectileDespawn[] = [];
const _motionUpdatePool: NetworkServerSnapshotMotionUpdate[] = [];
const _beamUpdatePool: NetworkServerSnapshotBeamUpdate[] = [];
const _beamPointPool: NetworkServerSnapshotBeamPoint[] = [];
let _spawnPoolIndex = 0;
let _despawnPoolIndex = 0;
let _motionUpdatePoolIndex = 0;
let _beamUpdatePoolIndex = 0;
let _beamPointPoolIndex = 0;
const _resyncSeenIds = new Set<number>();

const _projectilesBuf: ProjectileSnapshot = {
  spawns: undefined,
  despawns: undefined,
  motionUpdates: undefined,
  beamUpdates: undefined,
};
const _directProjectileSpawnPlaceholders: NetworkServerSnapshotProjectileSpawn[] = [];
const _directProjectileDespawnPlaceholders: NetworkServerSnapshotProjectileDespawn[] = [];
const _directProjectileMotionPlaceholders: NetworkServerSnapshotMotionUpdate[] = [];
const _directProjectileBeamUpdatePlaceholders: NetworkServerSnapshotBeamUpdate[] = [];
const _directProjectilesBuf: ProjectileSnapshot = {
  spawns: undefined,
  despawns: undefined,
  motionUpdates: undefined,
  beamUpdates: undefined,
};
const projectileWireSource: ProjectileSnapshotWireSource = {
  spawns: createFloat64WireRows(),
  despawns: createUint32WireRows(),
  motionUpdates: createFloat64WireRows(),
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

function createPooledMotionUpdate(): NetworkServerSnapshotMotionUpdate {
  const update: PooledMotionUpdate = {
    id: 0,
    pos: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    rotation: 0,
    angularVelocity: 0,
  } as PooledMotionUpdate;
  definePooledScratchProperty(update, '_pos', { x: 0, y: 0, z: 0 });
  definePooledScratchProperty(update, '_velocity', { x: 0, y: 0, z: 0 });
  update.pos = update._pos;
  update.velocity = update._velocity;
  return update;
}

export function createProjectileSnapshotWireSource(): ProjectileSnapshotWireSource {
  return {
    spawns: createFloat64WireRows(),
    despawns: createUint32WireRows(),
    motionUpdates: createFloat64WireRows(),
    beamUpdates: createFloat64WireRows(),
    beamPoints: createFloat64WireRows(),
  };
}

export function registerProjectileSnapshotWireSource(
  projectiles: ProjectileSnapshot,
  source: ProjectileSnapshotWireSource,
): void {
  projectileWireSources.set(projectiles, source);
}

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

function getPooledMotionUpdate(): PooledMotionUpdate {
  let update = _motionUpdatePool[_motionUpdatePoolIndex] as PooledMotionUpdate | undefined;
  if (!update) {
    update = createPooledMotionUpdate() as PooledMotionUpdate;
    _motionUpdatePool[_motionUpdatePoolIndex] = update;
  }
  _motionUpdatePoolIndex++;
  return update;
}

function resetProjectileWireSource(): void {
  projectileWireSource.spawns.count = 0;
  projectileWireSource.despawns.count = 0;
  projectileWireSource.motionUpdates.count = 0;
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
  values[base + 31] = getProjectileSpawnWireFlags(spawn);
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

function writeProjectileSpawnSourceProvenanceWireFields(
  values: Float64Array,
  base: number,
  world: WorldState,
  visibility: SnapshotVisibility | undefined,
  playerId: PlayerId,
  sourceEntityId: EntityId,
  sourceTurretEntityId: EntityId | null | undefined,
  sourceHostEntityId: EntityId | null | undefined,
  sourceRootEntityId: EntityId | null | undefined,
  sourceTeamId: number | null | undefined,
  spawnTick: number | null | undefined,
  parentShotEntityId: EntityId | null | undefined,
): number {
  const sourceHostId = sourceHostEntityId ?? sourceEntityId;
  const sourceRootId = sourceRootEntityId ?? sourceHostId;
  const canReferenceSource = canReferenceEntityId(world, visibility, sourceEntityId);
  const canReferenceSourceHost = canReferenceEntityId(world, visibility, sourceHostId);
  const canReferenceSourceRoot = canReferenceEntityId(world, visibility, sourceRootId);
  const wireSourceTurretEntityId = canReferenceSourceHost
    ? sourceTurretEntityId ?? null
    : null;
  const wireParentShotEntityId = parentShotEntityId ?? null;
  values[base + 14] = canReferenceSource ? sourceEntityId : 0;
  values[base + 25] = wireSourceTurretEntityId ?? 0;
  values[base + 26] = canReferenceSourceHost ? sourceHostId : 0;
  values[base + 27] = canReferenceSourceRoot ? sourceRootId : 0;
  values[base + 28] = sourceTeamId ?? world.getTeamId(playerId);
  values[base + 29] = spawnTick ?? world.getTick();
  values[base + 30] = wireParentShotEntityId ?? 0;
  let flags = 0;
  if (wireSourceTurretEntityId !== null) flags |= PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_ENTITY_ID;
  if (wireParentShotEntityId !== null) flags |= PROJECTILE_SPAWN_FLAG_PARENT_SHOT_ENTITY_ID;
  return flags;
}

function reserveProjectileSpawnWireRow(): { values: Float64Array; base: number } {
  const rows = projectileWireSource.spawns;
  const rowIndex = reserveFloat64WireRows(rows, 1, PROJECTILE_SPAWN_WIRE_STRIDE);
  return {
    values: rows.values,
    base: rowIndex * PROJECTILE_SPAWN_WIRE_STRIDE,
  };
}

function copyProjectileSpawnEventIntoWireRowDirect(
  spawn: ProjectileSpawnEvent,
  world: WorldState,
  visibility: SnapshotVisibility | undefined,
): void {
  const { values, base } = reserveProjectileSpawnWireRow();
  const maxLifespan = typeof spawn.maxLifespan === 'number' && Number.isFinite(spawn.maxLifespan)
    ? spawn.maxLifespan
    : null;
  const sourceTurretBlueprintCode = spawn.sourceTurretBlueprintId !== undefined
    ? turretBlueprintIdToCode(spawn.sourceTurretBlueprintId)
    : null;
  const targetEntityId = canReferenceEntityId(world, visibility, spawn.targetEntityId)
    ? spawn.targetEntityId ?? null
    : null;
  const homingTurnRate = spawn.homingTurnRate ?? null;
  const beam = spawn.beam;

  values[base + 0] = spawn.id;
  values[base + 1] = qPos(spawn.pos.x);
  values[base + 2] = qPos(spawn.pos.y);
  values[base + 3] = qPos(spawn.pos.z);
  values[base + 4] = qRot(spawn.rotation);
  values[base + 5] = qVel(spawn.velocity.x);
  values[base + 6] = qVel(spawn.velocity.y);
  values[base + 7] = qVel(spawn.velocity.z);
  values[base + 8] = projectileTypeToCode(spawn.projectileType);
  values[base + 9] = maxLifespan ?? 0;
  values[base + 10] = turretBlueprintIdToCode(spawn.turretBlueprintId);
  values[base + 11] = shotBlueprintIdToCode(spawn.shotBlueprintId);
  values[base + 12] = sourceTurretBlueprintCode ?? 0;
  values[base + 13] = spawn.playerId;
  values[base + 15] = spawn.turretIndex;
  values[base + 16] = spawn.barrelIndex;
  values[base + 17] = beam !== undefined ? qPos(beam.start.x) : 0;
  values[base + 18] = beam !== undefined ? qPos(beam.start.y) : 0;
  values[base + 19] = beam !== undefined ? qPos(beam.start.z) : 0;
  values[base + 20] = beam !== undefined ? qPos(beam.end.x) : 0;
  values[base + 21] = beam !== undefined ? qPos(beam.end.y) : 0;
  values[base + 22] = beam !== undefined ? qPos(beam.end.z) : 0;
  values[base + 23] = targetEntityId ?? 0;
  values[base + 24] = homingTurnRate ?? 0;

  let flags = writeProjectileSpawnSourceProvenanceWireFields(
    values,
    base,
    world,
    visibility,
    spawn.playerId,
    spawn.sourceEntityId,
    spawn.sourceTurretEntityId,
    spawn.sourceHostEntityId,
    spawn.sourceRootEntityId,
    spawn.sourceTeamId,
    spawn.spawnTick,
    spawn.parentShotEntityId,
  );
  if (maxLifespan !== null) flags |= PROJECTILE_SPAWN_FLAG_MAX_LIFESPAN;
  flags |= PROJECTILE_SPAWN_FLAG_SHOT_BLUEPRINT_CODE;
  if (sourceTurretBlueprintCode !== null) flags |= PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_BLUEPRINT_CODE;
  if (spawn.isDGun === true) flags |= PROJECTILE_SPAWN_FLAG_IS_DGUN_TRUE;
  if (spawn.fromParentDetonation === true) flags |= PROJECTILE_SPAWN_FLAG_FROM_PARENT_TRUE;
  if (beam !== undefined) flags |= PROJECTILE_SPAWN_FLAG_BEAM;
  if (targetEntityId !== null) flags |= PROJECTILE_SPAWN_FLAG_TARGET_ENTITY_ID;
  if (homingTurnRate !== null) flags |= PROJECTILE_SPAWN_FLAG_HOMING_TURN_RATE;
  values[base + 31] = flags;
}

function copyProjectileEntitySpawnIntoWireRowDirect(
  entity: Entity,
  projectile: Projectile,
  world: WorldState,
  visibility: SnapshotVisibility | undefined,
): void {
  const { values, base } = reserveProjectileSpawnWireRow();
  const sourceTurretBlueprintId = projectile.sourceTurretBlueprintId;
  const maxLifespan = Number.isFinite(projectile.maxLifespan)
    ? projectile.maxLifespan
    : null;
  const sourceTurretBlueprintCode = sourceTurretBlueprintId !== null
    ? turretBlueprintIdToCode(sourceTurretBlueprintId)
    : null;
  const targetEntityId = canReferenceEntityId(world, visibility, projectile.homingTargetId)
    ? projectile.homingTargetId ?? null
    : null;
  const homingTurnRate = projectile.homingTurnRate ?? null;
  const points = projectile.points;
  const hasBeam = points !== null && points.length >= 2;

  values[base + 0] = entity.id;
  values[base + 1] = qPos(entity.transform.x);
  values[base + 2] = qPos(entity.transform.y);
  values[base + 3] = qPos(entity.transform.z);
  values[base + 4] = qRot(entity.transform.rotation);
  values[base + 5] = qVel(projectile.velocityX);
  values[base + 6] = qVel(projectile.velocityY);
  values[base + 7] = qVel(projectile.velocityZ);
  values[base + 8] = projectileTypeToCode(projectile.projectileType);
  values[base + 9] = maxLifespan ?? 0;
  values[base + 10] = sourceTurretBlueprintCode ?? TURRET_BLUEPRINT_CODE_UNKNOWN;
  values[base + 11] = shotBlueprintIdToCode(projectile.shotBlueprintId);
  values[base + 12] = sourceTurretBlueprintCode ?? 0;
  values[base + 13] = projectile.ownerId;
  values[base + 15] = projectile.config.turretIndex ?? 0;
  values[base + 16] = projectile.sourceBarrelIndex ?? 0;
  if (hasBeam) {
    const start = points[0];
    const end = points[points.length - 1];
    values[base + 17] = qPos(start.x);
    values[base + 18] = qPos(start.y);
    values[base + 19] = qPos(start.z);
    values[base + 20] = qPos(end.x);
    values[base + 21] = qPos(end.y);
    values[base + 22] = qPos(end.z);
  } else {
    values[base + 17] = 0;
    values[base + 18] = 0;
    values[base + 19] = 0;
    values[base + 20] = 0;
    values[base + 21] = 0;
    values[base + 22] = 0;
  }
  values[base + 23] = targetEntityId ?? 0;
  values[base + 24] = homingTurnRate ?? 0;

  let flags = writeProjectileSpawnSourceProvenanceWireFields(
    values,
    base,
    world,
    visibility,
    projectile.ownerId,
    projectile.sourceEntityId,
    projectile.shotSource.sourceTurretEntityId,
    projectile.shotSource.sourceHostEntityId,
    projectile.shotSource.sourceRootEntityId,
    projectile.shotSource.sourceTeamId,
    projectile.shotSource.spawnTick,
    projectile.shotSource.parentShotEntityId,
  );
  if (maxLifespan !== null) flags |= PROJECTILE_SPAWN_FLAG_MAX_LIFESPAN;
  flags |= PROJECTILE_SPAWN_FLAG_SHOT_BLUEPRINT_CODE;
  if (sourceTurretBlueprintCode !== null) flags |= PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_BLUEPRINT_CODE;
  const dgunProjectile = entity.dgunProjectile;
  if (dgunProjectile !== null && dgunProjectile.isDGun) flags |= PROJECTILE_SPAWN_FLAG_IS_DGUN_TRUE;
  flags |= PROJECTILE_SPAWN_FLAG_FROM_PARENT_TRUE;
  if (hasBeam) flags |= PROJECTILE_SPAWN_FLAG_BEAM;
  if (targetEntityId !== null) flags |= PROJECTILE_SPAWN_FLAG_TARGET_ENTITY_ID;
  if (homingTurnRate !== null) flags |= PROJECTILE_SPAWN_FLAG_HOMING_TURN_RATE;
  values[base + 31] = flags;
}

function copyProjectileDespawnIntoWireRow(despawn: NetworkServerSnapshotProjectileDespawn): void {
  const rows = projectileWireSource.despawns;
  const rowIndex = reserveUint32WireRows(rows, 1, PROJECTILE_DESPAWN_WIRE_STRIDE);
  rows.values[rowIndex] = despawn.id;
}

export function writeProjectileMotionUpdateWireRow(
  values: MutableNumberRow,
  base: number,
  update: NetworkServerSnapshotMotionUpdate,
): void {
  values[base + 0] = update.id;
  values[base + 1] = update.pos.x;
  values[base + 2] = update.pos.y;
  values[base + 3] = update.pos.z;
  values[base + 4] = update.velocity.x;
  values[base + 5] = update.velocity.y;
  values[base + 6] = update.velocity.z;
  values[base + 7] = update.rotation;
  values[base + 8] = update.angularVelocity;
}

function copyProjectileMotionUpdateIntoWireRow(update: NetworkServerSnapshotMotionUpdate): void {
  const rows = projectileWireSource.motionUpdates;
  const rowIndex = reserveFloat64WireRows(rows, 1, PROJECTILE_MOTION_WIRE_STRIDE);
  writeProjectileMotionUpdateWireRow(
    rows.values,
    rowIndex * PROJECTILE_MOTION_WIRE_STRIDE,
    update,
  );
}

function copyProjectileMotionUpdateEventIntoWireRowDirect(
  update: ProjectileMotionUpdateEvent,
): void {
  const rows = projectileWireSource.motionUpdates;
  const rowIndex = reserveFloat64WireRows(rows, 1, PROJECTILE_MOTION_WIRE_STRIDE);
  const values = rows.values;
  const base = rowIndex * PROJECTILE_MOTION_WIRE_STRIDE;
  values[base + 0] = update.id;
  values[base + 1] = qPos(update.pos.x);
  values[base + 2] = qPos(update.pos.y);
  values[base + 3] = qPos(update.pos.z);
  values[base + 4] = qVel(update.velocity.x);
  values[base + 5] = qVel(update.velocity.y);
  values[base + 6] = qVel(update.velocity.z);
  values[base + 7] = qRot(update.rotation);
  values[base + 8] = qRot(update.angularVelocity);
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
  values[base + 6] = getProjectileBeamPointWireFlags(point);
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

function copyBeamPointSourceIntoWireRow(
  sp: BeamPoint,
  world: WorldState,
  visibility: SnapshotVisibility | undefined,
): void {
  const rows = projectileWireSource.beamPoints;
  const rowIndex = reserveFloat64WireRows(rows, 1, PROJECTILE_BEAM_POINT_WIRE_STRIDE);
  const values = rows.values;
  const base = rowIndex * PROJECTILE_BEAM_POINT_WIRE_STRIDE;
  values[base + 0] = qPos(sp.x);
  values[base + 1] = qPos(sp.y);
  values[base + 2] = qPos(sp.z);
  if (sp.vx === 0 && sp.vy === 0 && sp.vz === 0) {
    values[base + 3] = 0;
    values[base + 4] = 0;
    values[base + 5] = 0;
  } else {
    values[base + 3] = qVel(sp.vx);
    values[base + 4] = qVel(sp.vy);
    values[base + 5] = qVel(sp.vz);
  }
  const canReferenceReflector = sp.reflectorEntityId !== null &&
    canReferenceEntityId(world, visibility, sp.reflectorEntityId);
  let flags = 0;
  if (canReferenceReflector) {
    flags |= PROJECTILE_BEAM_POINT_FLAG_MIRROR_ENTITY_ID;
    if (sp.reflectorKind !== null) flags |= PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_KIND;
    if (sp.reflectorPlayerId !== null) flags |= PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_PLAYER_ID;
    if (sp.normalX !== null) flags |= PROJECTILE_BEAM_POINT_FLAG_NORMAL_X;
    if (sp.normalY !== null) flags |= PROJECTILE_BEAM_POINT_FLAG_NORMAL_Y;
    if (sp.normalZ !== null) flags |= PROJECTILE_BEAM_POINT_FLAG_NORMAL_Z;
    values[base + 7] = sp.reflectorEntityId as EntityId;
    values[base + 8] = sp.reflectorPlayerId ?? 0;
    values[base + 9] = sp.normalX !== null ? qNormal(sp.normalX) : 0;
    values[base + 10] = sp.normalY !== null ? qNormal(sp.normalY) : 0;
    values[base + 11] = sp.normalZ !== null ? qNormal(sp.normalZ) : 0;
  } else {
    values[base + 7] = 0;
    values[base + 8] = 0;
    values[base + 9] = 0;
    values[base + 10] = 0;
    values[base + 11] = 0;
  }
  values[base + 6] = flags;
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

function copyBeamUpdateFieldsIntoWireRow(
  id: EntityId,
  obstructionT: number | null,
  endpointDamageable: boolean | null,
  pointCount: number,
): void {
  const rows = projectileWireSource.beamUpdates;
  const rowIndex = reserveFloat64WireRows(rows, 1, PROJECTILE_BEAM_UPDATE_WIRE_STRIDE);
  const values = rows.values;
  const base = rowIndex * PROJECTILE_BEAM_UPDATE_WIRE_STRIDE;
  values[base + 0] = id;
  let flags = 0;
  if (obstructionT !== null) flags |= PROJECTILE_BEAM_UPDATE_FLAG_OBSTRUCTION_T;
  if (endpointDamageable !== null) {
    flags |= endpointDamageable
      ? PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_TRUE
      : PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_FALSE;
  }
  values[base + 1] = flags;
  values[base + 2] = obstructionT ?? 0;
  values[base + 3] = pointCount;
}

export function getProjectileSnapshotWireSource(
  projectiles: ProjectileSnapshot,
): ProjectileSnapshotWireSource | undefined {
  return projectileWireSources.get(projectiles);
}

export function getActiveProjectileSnapshotWireSource(
  projectiles: ProjectileSnapshot,
): ProjectileSnapshotWireSource | undefined {
  const source = getProjectileSnapshotWireSource(projectiles);
  if (source === undefined) return undefined;
  const spawnCount = projectiles.spawns !== undefined
    ? projectiles.spawns.length
    : source.spawns.count;
  const despawnCount = projectiles.despawns !== undefined
    ? projectiles.despawns.length
    : source.despawns.count;
  const motionCount = projectiles.motionUpdates !== undefined
    ? projectiles.motionUpdates.length
    : source.motionUpdates.count;
  const beamCount = projectiles.beamUpdates !== undefined
    ? projectiles.beamUpdates.length
    : source.beamUpdates.count;
  return (
    source.spawns.count === spawnCount &&
    source.despawns.count === despawnCount &&
    source.motionUpdates.count === motionCount &&
    source.beamUpdates.count === beamCount
  )
    ? source
    : undefined;
}

export function projectileSnapshotWireSourceHasDirectlyConsumableRows(
  projectiles: ProjectileSnapshot,
): boolean {
  const source = getActiveProjectileSnapshotWireSource(projectiles);
  return projectileWireSourceHasDirectlyConsumableRows(source);
}

export function projectileWireSourceHasDirectlyConsumableRows(
  source: ProjectileSnapshotWireSource | undefined,
): source is ProjectileSnapshotWireSource {
  return (
    source !== undefined &&
    (
      source.spawns.count > 0 ||
      source.despawns.count > 0 ||
      source.motionUpdates.count > 0 ||
      source.beamUpdates.count > 0
    )
  );
}

export function copyProjectileWireSourceSpawnRowFromSourceInto(
  source: ProjectileSnapshotWireSource,
  rowIndex: number,
  out: NetworkServerSnapshotProjectileSpawn,
): boolean {
  if (rowIndex < 0 || rowIndex >= source.spawns.count) return false;
  const values = source.spawns.values;
  const base = rowIndex * PROJECTILE_SPAWN_WIRE_STRIDE;
  const flags = values[base + 31] | 0;
  out.id = values[base + 0] | 0;
  out.pos.x = values[base + 1];
  out.pos.y = values[base + 2];
  out.pos.z = values[base + 3];
  out.rotation = values[base + 4];
  out.velocity.x = values[base + 5];
  out.velocity.y = values[base + 6];
  out.velocity.z = values[base + 7];
  out.projectileType = values[base + 8] as NetworkServerSnapshotProjectileSpawn['projectileType'];
  out.maxLifespan = (flags & PROJECTILE_SPAWN_FLAG_MAX_LIFESPAN) !== 0
    ? values[base + 9]
    : null;
  out.turretBlueprintCode = values[base + 10] as NetworkServerSnapshotProjectileSpawn['turretBlueprintCode'];
  out.shotBlueprintCode = (flags & PROJECTILE_SPAWN_FLAG_SHOT_BLUEPRINT_CODE) !== 0
    ? values[base + 11] as NetworkServerSnapshotProjectileSpawn['shotBlueprintCode']
    : null;
  out.sourceTurretBlueprintCode = (flags & PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_BLUEPRINT_CODE) !== 0
    ? values[base + 12] as NetworkServerSnapshotProjectileSpawn['sourceTurretBlueprintCode']
    : null;
  out.playerId = values[base + 13];
  out.sourceEntityId = values[base + 14];
  out.turretIndex = values[base + 15];
  out.barrelIndex = values[base + 16];
  out.targetEntityId = (flags & PROJECTILE_SPAWN_FLAG_TARGET_ENTITY_ID) !== 0
    ? values[base + 23]
    : null;
  out.homingTurnRate = (flags & PROJECTILE_SPAWN_FLAG_HOMING_TURN_RATE) !== 0
    ? values[base + 24]
    : null;
  out.sourceTurretEntityId = (flags & PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_ENTITY_ID) !== 0
    ? values[base + 25]
    : null;
  out.sourceHostEntityId = values[base + 26];
  out.sourceRootEntityId = values[base + 27];
  out.sourceTeamId = values[base + 28];
  out.spawnTick = values[base + 29];
  out.parentShotEntityId = (flags & PROJECTILE_SPAWN_FLAG_PARENT_SHOT_ENTITY_ID) !== 0
    ? values[base + 30]
    : null;
  if ((flags & PROJECTILE_SPAWN_FLAG_IS_DGUN_TRUE) !== 0) {
    out.isDGun = true;
  } else if ((flags & PROJECTILE_SPAWN_FLAG_IS_DGUN_FALSE) !== 0) {
    out.isDGun = false;
  } else {
    out.isDGun = null;
  }
  if ((flags & PROJECTILE_SPAWN_FLAG_FROM_PARENT_TRUE) !== 0) {
    out.fromParentDetonation = true;
  } else if ((flags & PROJECTILE_SPAWN_FLAG_FROM_PARENT_FALSE) !== 0) {
    out.fromParentDetonation = false;
  } else {
    out.fromParentDetonation = null;
  }
  if ((flags & PROJECTILE_SPAWN_FLAG_BEAM) !== 0) {
    if (out.beam === null) {
      out.beam = { start: { x: 0, y: 0, z: 0 }, end: { x: 0, y: 0, z: 0 } };
    }
    out.beam.start.x = values[base + 17];
    out.beam.start.y = values[base + 18];
    out.beam.start.z = values[base + 19];
    out.beam.end.x = values[base + 20];
    out.beam.end.y = values[base + 21];
    out.beam.end.z = values[base + 22];
  } else {
    out.beam = null;
  }
  return true;
}

export function forEachProjectileWireSourceSpawn(
  projectiles: ProjectileSnapshot,
  scratch: NetworkServerSnapshotProjectileSpawn,
  visitor: (spawn: NetworkServerSnapshotProjectileSpawn) => void,
): boolean {
  const source = getActiveProjectileSnapshotWireSource(projectiles);
  return forEachProjectileWireSourceSpawnFromSource(source, scratch, visitor);
}

export function forEachProjectileWireSourceSpawnFromSource(
  source: ProjectileSnapshotWireSource | undefined,
  scratch: NetworkServerSnapshotProjectileSpawn,
  visitor: (spawn: NetworkServerSnapshotProjectileSpawn) => void,
): boolean {
  if (source === undefined) return false;
  const rows = source.spawns;
  if (rows.count === 0) return false;
  for (let i = 0; i < rows.count; i++) {
    if (copyProjectileWireSourceSpawnRowFromSourceInto(source, i, scratch)) visitor(scratch);
  }
  return true;
}

export function forEachProjectileWireSourceDespawn(
  projectiles: ProjectileSnapshot,
  visitor: (id: number) => void,
): boolean {
  const source = getActiveProjectileSnapshotWireSource(projectiles);
  return forEachProjectileWireSourceDespawnFromSource(source, visitor);
}

export function forEachProjectileWireSourceDespawnFromSource(
  source: ProjectileSnapshotWireSource | undefined,
  visitor: (id: number) => void,
): boolean {
  if (source === undefined) return false;
  const rows = source.despawns;
  if (rows.count === 0) return false;
  for (let i = 0; i < rows.count; i++) {
    visitor(rows.values[i]);
  }
  return true;
}

export type ProjectileWireSourceMotionUpdateVisitor = (
  id: number,
  qposX: number,
  qposY: number,
  qposZ: number,
  qvelX: number,
  qvelY: number,
  qvelZ: number,
  qrotation: number,
  qangularVelocity: number,
) => void;

export function forEachProjectileWireSourceMotionUpdate(
  projectiles: ProjectileSnapshot,
  visitor: ProjectileWireSourceMotionUpdateVisitor,
): boolean {
  const source = getActiveProjectileSnapshotWireSource(projectiles);
  return forEachProjectileWireSourceMotionUpdateFromSource(source, visitor);
}

export function forEachProjectileWireSourceMotionUpdateFromSource(
  source: ProjectileSnapshotWireSource | undefined,
  visitor: ProjectileWireSourceMotionUpdateVisitor,
): boolean {
  if (source === undefined) return false;
  const rows = source.motionUpdates;
  if (rows.count === 0) return false;
  const values = rows.values;
  for (let i = 0; i < rows.count; i++) {
    const base = i * PROJECTILE_MOTION_WIRE_STRIDE;
    visitor(
      values[base + 0],
      values[base + 1],
      values[base + 2],
      values[base + 3],
      values[base + 4],
      values[base + 5],
      values[base + 6],
      values[base + 7],
      values[base + 8],
    );
  }
  return true;
}

function copyProjectileWireSourceBeamPointRowFromSourceInto(
  source: ProjectileSnapshotWireSource,
  rowIndex: number,
  out: NetworkServerSnapshotBeamPoint,
): boolean {
  if (rowIndex < 0 || rowIndex >= source.beamPoints.count) return false;
  const values = source.beamPoints.values;
  const base = rowIndex * PROJECTILE_BEAM_POINT_WIRE_STRIDE;
  const flags = values[base + 6] ?? 0;
  out.x = values[base + 0] ?? 0;
  out.y = values[base + 1] ?? 0;
  out.z = values[base + 2] ?? 0;
  out.vx = values[base + 3] ?? 0;
  out.vy = values[base + 4] ?? 0;
  out.vz = values[base + 5] ?? 0;
  out.reflectorEntityId = (flags & PROJECTILE_BEAM_POINT_FLAG_MIRROR_ENTITY_ID) !== 0
    ? values[base + 7]
    : null;
  out.reflectorKind = (flags & PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_KIND) !== 0
    ? 'shield'
    : null;
  out.reflectorPlayerId = (flags & PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_PLAYER_ID) !== 0
    ? values[base + 8] as PlayerId
    : null;
  out.normalX = (flags & PROJECTILE_BEAM_POINT_FLAG_NORMAL_X) !== 0
    ? values[base + 9]
    : null;
  out.normalY = (flags & PROJECTILE_BEAM_POINT_FLAG_NORMAL_Y) !== 0
    ? values[base + 10]
    : null;
  out.normalZ = (flags & PROJECTILE_BEAM_POINT_FLAG_NORMAL_Z) !== 0
    ? values[base + 11]
    : null;
  return true;
}

function ensureBeamUpdateScratchPoint(
  points: NetworkServerSnapshotBeamPoint[],
  index: number,
): NetworkServerSnapshotBeamPoint {
  let point = points[index];
  if (point === undefined) {
    point = createPooledBeamPoint();
    points[index] = point;
  }
  return point;
}

export function forEachProjectileWireSourceBeamUpdate(
  projectiles: ProjectileSnapshot,
  scratch: NetworkServerSnapshotBeamUpdate,
  visitor: (update: NetworkServerSnapshotBeamUpdate) => void,
): boolean {
  const source = getActiveProjectileSnapshotWireSource(projectiles);
  if (source === undefined) return false;
  const rows = source.beamUpdates;
  if (rows.count === 0) return false;
  const headers = rows.values;
  let pointOffset = 0;
  for (let i = 0; i < rows.count; i++) {
    const base = i * PROJECTILE_BEAM_UPDATE_WIRE_STRIDE;
    const flags = headers[base + 1] ?? 0;
    const pointCount = Math.max(0, headers[base + 3] ?? 0) | 0;
    if (pointOffset + pointCount > source.beamPoints.count) return i > 0;
    scratch.id = headers[base + 0] ?? 0;
    scratch.obstructionT = (flags & PROJECTILE_BEAM_UPDATE_FLAG_OBSTRUCTION_T) !== 0
      ? headers[base + 2]
      : null;
    scratch.endpointDamageable = projectileBeamEndpointDamageableFromFlags(flags);
    scratch.points.length = pointCount;
    for (let p = 0; p < pointCount; p++) {
      copyProjectileWireSourceBeamPointRowFromSourceInto(
        source,
        pointOffset + p,
        ensureBeamUpdateScratchPoint(scratch.points, p),
      );
    }
    pointOffset += pointCount;
    visitor(scratch);
  }
  return true;
}

export type ProjectileWireSourceBeamUpdateFieldsVisitor = (
  id: number,
  obstructionT: number | null,
  endpointDamageable: boolean | null,
  pointValues: Float64Array,
  pointOffset: number,
  pointCount: number,
) => void;

export function forEachProjectileWireSourceBeamUpdateFieldsFromSource(
  source: ProjectileSnapshotWireSource | undefined,
  visitor: ProjectileWireSourceBeamUpdateFieldsVisitor,
): boolean {
  if (source === undefined) return false;
  const rows = source.beamUpdates;
  if (rows.count === 0) return false;
  const headers = rows.values;
  const pointValues = source.beamPoints.values;
  let pointOffset = 0;
  for (let i = 0; i < rows.count; i++) {
    const base = i * PROJECTILE_BEAM_UPDATE_WIRE_STRIDE;
    const flags = headers[base + 1];
    const pointCount = Math.max(0, headers[base + 3]) | 0;
    if (pointOffset + pointCount > source.beamPoints.count) return i > 0;
    const endpointDamageable = projectileBeamEndpointDamageableFromFlags(flags);
    visitor(
      headers[base + 0],
      (flags & PROJECTILE_BEAM_UPDATE_FLAG_OBSTRUCTION_T) !== 0
        ? headers[base + 2]
        : null,
      endpointDamageable,
      pointValues,
      pointOffset,
      pointCount,
    );
    pointOffset += pointCount;
  }
  return true;
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

function isRecipientOwnedProjectileTarget(
  targetId: EntityId | number | undefined,
  visibility: SnapshotVisibility,
  world: WorldState,
): boolean {
  if (targetId === undefined || targetId <= 0 || targetId === NO_ENTITY_ID) return false;
  const target = world.getEntity(targetId as EntityId);
  const targetOwnerId = target !== undefined && target.ownership !== null
    ? target.ownership.playerId
    : undefined;
  return visibility.isOwnedByRecipientOrAlly(targetOwnerId);
}

function shouldSendProjectileMotionUpdate(
  vu: ProjectileMotionUpdateEvent,
  visibility: SnapshotVisibility | undefined,
  world: WorldState,
): boolean {
  if (visibility === undefined || !visibility.isFiltered) return true;
  if (visibility.isOwnedByRecipientOrAlly(vu.ownerId)) return true;
  if (visibility.isPointVisible(vu.pos.x, vu.pos.y)) return true;
  if (vu.ownerId !== undefined) return false;

  const projectileEntity = world.getEntity(vu.id);
  const projectile = projectileEntity === undefined ? undefined : projectileEntity.projectile;
  if (projectile === undefined || projectile === null) return false;
  if (visibility.isOwnedByRecipientOrAlly(projectile.ownerId)) return true;
  return isRecipientOwnedProjectileTarget(
    projectile.homingTargetId !== NO_ENTITY_ID
      ? projectile.homingTargetId
      : undefined,
    visibility,
    world,
  );
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
  _motionUpdatePoolIndex = 0;
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

function fillProjectileMotionUpdate(
  out: PooledMotionUpdate,
  vu: ProjectileMotionUpdateEvent,
): void {
  out.id = vu.id;
  out._pos.x = qPos(vu.pos.x);
  out._pos.y = qPos(vu.pos.y);
  out._pos.z = qPos(vu.pos.z);
  out._velocity.x = qVel(vu.velocity.x);
  out._velocity.y = qVel(vu.velocity.y);
  out._velocity.z = qVel(vu.velocity.z);
  out.rotation = qRot(vu.rotation);
  out.angularVelocity = qRot(vu.angularVelocity);
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
  projectileMotionUpdates,
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

  let netMotionUpdates: NetworkServerSnapshotMotionUpdate[] | undefined;
  if (projectileMotionUpdates && projectileMotionUpdates.length > 0) {
    _motionUpdateBuf.length = 0;
    for (let i = 0; i < projectileMotionUpdates.length; i++) {
      const vu = projectileMotionUpdates[i];
      if (!shouldSendProjectileMotionUpdate(vu, visibility, world)) continue;
      const out = getPooledMotionUpdate();
      fillProjectileMotionUpdate(out, vu);
      _motionUpdateBuf.push(out);
      copyProjectileMotionUpdateIntoWireRow(out);
    }
    if (_motionUpdateBuf.length > 0) netMotionUpdates = _motionUpdateBuf;
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

  if (!netProjectileSpawns && !netProjectileDespawns && !netMotionUpdates && !netBeamUpdates) {
    return undefined;
  }

  _projectilesBuf.spawns = netProjectileSpawns;
  _projectilesBuf.despawns = netProjectileDespawns;
  _projectilesBuf.motionUpdates = netMotionUpdates;
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
  projectileMotionUpdates,
}: SerializeProjectileSnapshotOptions): ProjectileSnapshot | undefined {
  resetProjectileWireSource();
  _directProjectileSpawnPlaceholders.length = 0;
  _directProjectileDespawnPlaceholders.length = 0;
  _directProjectileMotionPlaceholders.length = 0;
  _directProjectileBeamUpdatePlaceholders.length = 0;
  _directProjectilesBuf.spawns = undefined;
  _directProjectilesBuf.despawns = undefined;
  _directProjectilesBuf.motionUpdates = undefined;
  _directProjectilesBuf.beamUpdates = undefined;

  const wantProjectileResync = fullStateResync;
  const tickSpawnCount = projectileSpawns === undefined ? 0 : projectileSpawns.length;
  if (tickSpawnCount > 0 || wantProjectileResync) {
    if (wantProjectileResync) _resyncSeenIds.clear();
    if (projectileSpawns) {
      for (let i = 0; i < tickSpawnCount; i++) {
        const ps = projectileSpawns[i];
        if (!shouldSendProjectileSpawnEvent(ps, visibility, world)) continue;
        copyProjectileSpawnEventIntoWireRowDirect(ps, world, visibility);
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
        copyProjectileEntitySpawnIntoWireRowDirect(entity, proj, world, visibility);
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

  if (projectileMotionUpdates && projectileMotionUpdates.length > 0) {
    for (let i = 0; i < projectileMotionUpdates.length; i++) {
      const vu = projectileMotionUpdates[i];
      if (!shouldSendProjectileMotionUpdate(vu, visibility, world)) continue;
      copyProjectileMotionUpdateEventIntoWireRowDirect(vu);
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

      const wirePointCount = getBeamWirePointCount(srcPts.length);
      const obstructionT = proj.obstructionT === null ? null : qRot(proj.obstructionT);
      const endpointDamageable = proj.endpointDamageable === false ? false : null;
      for (let p = 0; p < wirePointCount; p++) {
        copyBeamPointSourceIntoWireRow(srcPts[p], world, visibility);
      }
      copyBeamUpdateFieldsIntoWireRow(entity.id, obstructionT, endpointDamageable, wirePointCount);
    }
  }

  const spawnCount = projectileWireSource.spawns.count;
  const despawnCount = projectileWireSource.despawns.count;
  const motionCount = projectileWireSource.motionUpdates.count;
  const beamUpdateCount = projectileWireSource.beamUpdates.count;
  if (spawnCount === 0 && despawnCount === 0 && motionCount === 0 && beamUpdateCount === 0) {
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
  if (motionCount > 0) {
    _directProjectileMotionPlaceholders.length = motionCount;
    _directProjectilesBuf.motionUpdates = _directProjectileMotionPlaceholders;
  }
  if (beamUpdateCount > 0) {
    _directProjectileBeamUpdatePlaceholders.length = beamUpdateCount;
    _directProjectilesBuf.beamUpdates = _directProjectileBeamUpdatePlaceholders;
  }
  return _directProjectilesBuf;
}
