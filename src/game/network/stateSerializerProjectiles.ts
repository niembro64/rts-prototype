import type { WorldState } from '../sim/WorldState';
import type { PlayerId } from '../sim/types';
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
import {
  PROJECTILE_TYPE_UNKNOWN,
  TURRET_ID_UNKNOWN,
  projectileTypeToCode,
  shotIdToCode,
  turretIdToCode,
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

export const PROJECTILE_SPAWN_WIRE_STRIDE = 27;
export const PROJECTILE_DESPAWN_WIRE_STRIDE = 1;
export const PROJECTILE_VELOCITY_WIRE_STRIDE = 8;
export const PROJECTILE_BEAM_UPDATE_WIRE_STRIDE = 4;
export const PROJECTILE_BEAM_POINT_WIRE_STRIDE = 12;
const PROJECTILE_BEAM_POINT_CAP = 6;

export const PROJECTILE_SPAWN_FLAG_MAX_LIFESPAN = 0x001;
export const PROJECTILE_SPAWN_FLAG_SHOT_ID = 0x002;
export const PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_ID = 0x004;
export const PROJECTILE_SPAWN_FLAG_IS_DGUN_TRUE = 0x008;
export const PROJECTILE_SPAWN_FLAG_FROM_PARENT_TRUE = 0x010;
export const PROJECTILE_SPAWN_FLAG_BEAM = 0x020;
export const PROJECTILE_SPAWN_FLAG_TARGET_ENTITY_ID = 0x040;
export const PROJECTILE_SPAWN_FLAG_HOMING_TURN_RATE = 0x080;
export const PROJECTILE_SPAWN_FLAG_IS_DGUN_FALSE = 0x100;
export const PROJECTILE_SPAWN_FLAG_FROM_PARENT_FALSE = 0x200;

export const PROJECTILE_BEAM_UPDATE_FLAG_OBSTRUCTION_T = 0x01;
export const PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_FALSE = 0x02;
export const PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_TRUE = 0x04;

export const PROJECTILE_BEAM_POINT_FLAG_MIRROR_ENTITY_ID = 0x01;
export const PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_KIND = 0x02;
export const PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_KIND_FORCE_FIELD = 0x04;
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

export type SerializeProjectileSnapshotOptions = {
  world: WorldState;
  deltaEnabled: boolean;
  visibility?: SnapshotVisibility;
  emitBeamUpdates?: boolean;
  projectileSpawns?: ProjectileSpawnEvent[];
  projectileDespawns?: ProjectileDespawnEvent[];
  projectileVelocityUpdates?: ProjectileVelocityUpdateEvent[];
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
const projectileWireSource: ProjectileSnapshotWireSource = {
  spawns: createFloat64WireRows(),
  despawns: createUint32WireRows(),
  velocityUpdates: createFloat64WireRows(),
  beamUpdates: createFloat64WireRows(),
  beamPoints: createFloat64WireRows(),
};
const projectileWireSources = new WeakMap<object, ProjectileSnapshotWireSource>([
  [_projectilesBuf, projectileWireSource],
]);

function createPooledBeamUpdate(): NetworkServerSnapshotBeamUpdate {
  return {
    id: 0,
    points: [],
    obstructionT: undefined,
    endpointDamageable: undefined,
  };
}

function createPooledBeamPoint(): NetworkServerSnapshotBeamPoint {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
}

function createPooledProjectileSpawn(): NetworkServerSnapshotProjectileSpawn {
  const spawn: PooledProjectileSpawn = {
    id: 0,
    pos: { x: 0, y: 0, z: 0 },
    rotation: 0,
    velocity: { x: 0, y: 0, z: 0 },
    projectileType: PROJECTILE_TYPE_UNKNOWN,
    maxLifespan: undefined,
    turretId: TURRET_ID_UNKNOWN,
    shotId: undefined,
    sourceTurretId: undefined,
    playerId: 1,
    sourceEntityId: 0,
    turretIndex: 0,
    barrelIndex: 0,
    isDGun: undefined,
    fromParentDetonation: undefined,
    beam: undefined,
    targetEntityId: undefined,
    homingTurnRate: undefined,
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
  } as PooledVelocityUpdate;
  definePooledScratchProperty(update, '_pos', { x: 0, y: 0, z: 0 });
  definePooledScratchProperty(update, '_velocity', { x: 0, y: 0, z: 0 });
  update.pos = update._pos;
  update.velocity = update._velocity;
  return update;
}

function getPooledBeamUpdate(): NetworkServerSnapshotBeamUpdate {
  let update = _beamUpdatePool[_beamUpdatePoolIndex];
  if (!update) {
    update = createPooledBeamUpdate();
    _beamUpdatePool[_beamUpdatePoolIndex] = update;
  }
  _beamUpdatePoolIndex++;
  update.points.length = 0;
  update.obstructionT = undefined;
  update.endpointDamageable = undefined;
  return update;
}

function getPooledBeamPoint(): NetworkServerSnapshotBeamPoint {
  let point = _beamPointPool[_beamPointPoolIndex];
  if (!point) {
    point = createPooledBeamPoint();
    _beamPointPool[_beamPointPoolIndex] = point;
  }
  _beamPointPoolIndex++;
  point.mirrorEntityId = undefined;
  point.reflectorKind = undefined;
  point.reflectorPlayerId = undefined;
  point.normalX = undefined;
  point.normalY = undefined;
  point.normalZ = undefined;
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
  values[base + 10] = spawn.turretId;
  values[base + 11] = spawn.shotId ?? 0;
  values[base + 12] = spawn.sourceTurretId ?? 0;
  values[base + 13] = spawn.playerId;
  values[base + 14] = spawn.sourceEntityId;
  values[base + 15] = spawn.turretIndex;
  values[base + 16] = spawn.barrelIndex;
  const beam = spawn.beam;
  values[base + 17] = beam !== undefined ? beam.start.x : 0;
  values[base + 18] = beam !== undefined ? beam.start.y : 0;
  values[base + 19] = beam !== undefined ? beam.start.z : 0;
  values[base + 20] = beam !== undefined ? beam.end.x : 0;
  values[base + 21] = beam !== undefined ? beam.end.y : 0;
  values[base + 22] = beam !== undefined ? beam.end.z : 0;
  values[base + 23] = spawn.targetEntityId ?? 0;
  values[base + 24] = spawn.homingTurnRate ?? 0;
  values[base + 25] = 0;
  let flags = 0;
  if (spawn.maxLifespan !== undefined) flags |= PROJECTILE_SPAWN_FLAG_MAX_LIFESPAN;
  if (spawn.shotId !== undefined) flags |= PROJECTILE_SPAWN_FLAG_SHOT_ID;
  if (spawn.sourceTurretId !== undefined) flags |= PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_ID;
  if (spawn.isDGun !== undefined) {
    flags |= spawn.isDGun
      ? PROJECTILE_SPAWN_FLAG_IS_DGUN_TRUE
      : PROJECTILE_SPAWN_FLAG_IS_DGUN_FALSE;
  }
  if (spawn.fromParentDetonation !== undefined) {
    flags |= spawn.fromParentDetonation
      ? PROJECTILE_SPAWN_FLAG_FROM_PARENT_TRUE
      : PROJECTILE_SPAWN_FLAG_FROM_PARENT_FALSE;
  }
  if (spawn.beam !== undefined) flags |= PROJECTILE_SPAWN_FLAG_BEAM;
  if (spawn.targetEntityId !== undefined) flags |= PROJECTILE_SPAWN_FLAG_TARGET_ENTITY_ID;
  if (spawn.homingTurnRate !== undefined) flags |= PROJECTILE_SPAWN_FLAG_HOMING_TURN_RATE;
  values[base + 26] = flags;
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
  if (point.mirrorEntityId !== undefined) flags |= PROJECTILE_BEAM_POINT_FLAG_MIRROR_ENTITY_ID;
  if (point.reflectorKind !== undefined) {
    flags |= PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_KIND;
    if (point.reflectorKind === 'forceField') {
      flags |= PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_KIND_FORCE_FIELD;
    }
  }
  if (point.reflectorPlayerId !== undefined) flags |= PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_PLAYER_ID;
  if (point.normalX !== undefined) flags |= PROJECTILE_BEAM_POINT_FLAG_NORMAL_X;
  if (point.normalY !== undefined) flags |= PROJECTILE_BEAM_POINT_FLAG_NORMAL_Y;
  if (point.normalZ !== undefined) flags |= PROJECTILE_BEAM_POINT_FLAG_NORMAL_Z;
  values[base + 6] = flags;
  values[base + 7] = point.mirrorEntityId ?? 0;
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
  if (update.obstructionT !== undefined) flags |= PROJECTILE_BEAM_UPDATE_FLAG_OBSTRUCTION_T;
  if (update.endpointDamageable !== undefined) {
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
  homingTargetId?: number,
  world?: WorldState,
): boolean {
  if (!visibility || !visibility.isFiltered) return true;
  if (visibility.isOwnedByRecipientOrAlly(ownerId)) return true;
  if (visibility.isPointVisible(x, y)) return true;
  // FOW-08-followup: forward in-flight updates when the projectile is
  // homing on one of the recipient's (or their allies') entities, so
  // the player at least sees the missile veering toward their unit
  // instead of taking a silent HP drop from an attacker still hidden
  // in fog. FOW-06 broadens the target check from recipient-only to
  // team-aware via isOwnedByRecipientOrAlly.
  if (homingTargetId !== undefined && homingTargetId !== NO_ENTITY_ID && world) {
    const target = world.getEntity(homingTargetId);
    if (visibility.isOwnedByRecipientOrAlly(target?.ownership?.playerId)) return true;
  }
  return false;
}

function shouldSendBeamPath(
  ownerId: PlayerId | undefined,
  visibility: SnapshotVisibility | undefined,
  points: ReadonlyArray<{ x: number; y: number }>,
): boolean {
  if (!visibility || !visibility.isFiltered) return true;
  if (visibility.isOwnedByRecipientOrAlly(ownerId)) return true;
  // FOW-08-followup: forward the beam if EITHER end is visible. A
  // laser fired from fog that lands on the recipient's unit now
  // flashes for them — the source still falls inside the shroud, but
  // the beam line is drawn from the (still-shrouded) attacker toward
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
  if (!visibility || !visibility.isFiltered) return true;
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
    if (visibility.isOwnedByRecipientOrAlly(target?.ownership?.playerId)) return true;
  }
  return false;
}

function canReferenceEntityId(
  world: WorldState,
  visibility: SnapshotVisibility | undefined,
  entityId: number | undefined,
): boolean {
  if (entityId === undefined || entityId === NO_ENTITY_ID) return false;
  return visibility?.canReferenceEntityId(world, entityId) ?? true;
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

function getBeamWireSourcePointIndex(
  wireIndex: number,
  sourceCount: number,
  wireCount: number,
): number {
  if (sourceCount <= wireCount) return wireIndex;
  if (wireIndex === 0) return 0;
  if (wireIndex === wireCount - 1) return sourceCount - 1;
  return wireIndex;
}

export function serializeProjectileSnapshot({
  world,
  deltaEnabled,
  visibility,
  emitBeamUpdates = true,
  projectileSpawns,
  projectileDespawns,
  projectileVelocityUpdates,
}: SerializeProjectileSnapshotOptions): ProjectileSnapshot | undefined {
  resetProjectilePools();
  resetProjectileWireSource();

  // Full keyframes synthesize spawns for every live projectile entity so a
  // client that missed the original spawn event can still recover it.
  let netProjectileSpawns: NetworkServerSnapshotProjectileSpawn[] | undefined;
  const wantKeyframeProjectileResync = !deltaEnabled;
  const tickSpawnCount = projectileSpawns?.length ?? 0;
  if (tickSpawnCount > 0 || wantKeyframeProjectileResync) {
    _spawnBuf.length = 0;
    if (wantKeyframeProjectileResync) _resyncSeenIds.clear();
    if (projectileSpawns) {
      for (let i = 0; i < tickSpawnCount; i++) {
        const ps = projectileSpawns[i];
        if (!shouldSendProjectileSpawnEvent(ps, visibility, world)) continue;
        const out = getPooledProjectileSpawn();
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
          : undefined;
        out.turretId = turretIdToCode(ps.turretId);
        out.shotId = shotIdToCode(ps.shotId);
        out.sourceTurretId = ps.sourceTurretId !== undefined
          ? turretIdToCode(ps.sourceTurretId)
          : undefined;
        out.playerId = ps.playerId;
        out.sourceEntityId = canReferenceEntityId(world, visibility, ps.sourceEntityId)
          ? ps.sourceEntityId
          : 0;
        out.turretIndex = ps.turretIndex;
        out.barrelIndex = ps.barrelIndex;
        out.isDGun = ps.isDGun === true ? true : undefined;
        out.fromParentDetonation = ps.fromParentDetonation === true ? true : undefined;
        if (ps.beam) {
          out._beamStart.x = qPos(ps.beam.start.x);
          out._beamStart.y = qPos(ps.beam.start.y);
          out._beamStart.z = qPos(ps.beam.start.z);
          out._beamEnd.x = qPos(ps.beam.end.x);
          out._beamEnd.y = qPos(ps.beam.end.y);
          out._beamEnd.z = qPos(ps.beam.end.z);
          out.beam = out._beam;
        } else {
          out.beam = undefined;
        }
        out.targetEntityId = canReferenceEntityId(world, visibility, ps.targetEntityId)
          ? ps.targetEntityId
          : undefined;
        out.homingTurnRate = ps.homingTurnRate;
        _spawnBuf.push(out);
        copyProjectileSpawnIntoWireRow(out);
        if (wantKeyframeProjectileResync) _resyncSeenIds.add(ps.id);
      }
    }
    if (wantKeyframeProjectileResync) {
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
          : undefined;
        out.turretId = proj.sourceTurretId !== undefined
          ? turretIdToCode(proj.sourceTurretId)
          : TURRET_ID_UNKNOWN;
        out.shotId = shotIdToCode(proj.shotId);
        out.sourceTurretId = proj.sourceTurretId !== undefined
          ? turretIdToCode(proj.sourceTurretId)
          : undefined;
        out.playerId = proj.ownerId;
        out.sourceEntityId = canReferenceEntityId(world, visibility, proj.sourceEntityId)
          ? proj.sourceEntityId
          : 0;
        out.turretIndex = proj.config.turretIndex ?? 0;
        out.barrelIndex = proj.sourceBarrelIndex ?? 0;
        out.isDGun = entity.dgunProjectile?.isDGun ? true : undefined;
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
          out.beam = undefined;
        }
        out.targetEntityId = canReferenceEntityId(world, visibility, proj.homingTargetId)
          ? proj.homingTargetId
          : undefined;
        out.homingTurnRate = proj.homingTurnRate;
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
      const projectile = world.getEntity(vu.id)?.projectile;
      if (
        !shouldSendProjectileAtPoint(
          projectile?.ownerId,
          visibility,
          vu.pos.x,
          vu.pos.y,
          projectile !== undefined && projectile.homingTargetId !== NO_ENTITY_ID
            ? projectile.homingTargetId
            : vu.visibilityHomingTargetId,
          world,
        )
      ) {
        continue;
      }
      const out = getPooledVelocityUpdate();
      out.id = vu.id;
      out._pos.x = qPos(vu.pos.x);
      out._pos.y = qPos(vu.pos.y);
      out._pos.z = qPos(vu.pos.z);
      out._velocity.x = qVel(vu.velocity.x);
      out._velocity.y = qVel(vu.velocity.y);
      out._velocity.z = qVel(vu.velocity.z);
      out.clearHomingTarget = vu.clearHomingTarget === true ? true : undefined;
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
      update.obstructionT = proj.obstructionT === undefined ? undefined : qRot(proj.obstructionT);
      update.endpointDamageable = proj.endpointDamageable === false ? false : undefined;
      const dstPts = update.points;
      const wirePointCount = getBeamWirePointCount(srcPts.length);
      dstPts.length = wirePointCount;
      for (let p = 0; p < wirePointCount; p++) {
        const sp = srcPts[getBeamWireSourcePointIndex(p, srcPts.length, wirePointCount)];
        const out = getPooledBeamPoint();
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
        const canReferenceReflector = canReferenceEntityId(world, visibility, sp.mirrorEntityId);
        out.mirrorEntityId = canReferenceReflector ? sp.mirrorEntityId : undefined;
        out.reflectorKind = canReferenceReflector ? sp.reflectorKind : undefined;
        out.reflectorPlayerId = canReferenceReflector ? sp.reflectorPlayerId : undefined;
        out.normalX = canReferenceReflector && sp.normalX !== undefined ? qNormal(sp.normalX) : undefined;
        out.normalY = canReferenceReflector && sp.normalY !== undefined ? qNormal(sp.normalY) : undefined;
        out.normalZ = canReferenceReflector && sp.normalZ !== undefined ? qNormal(sp.normalZ) : undefined;
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
