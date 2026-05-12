import type { WorldState } from '../sim/WorldState';
import type { PlayerId } from '../sim/types';
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
import { SNAPSHOT_CONFIG } from '../../config';
import { shouldRunOnStride } from '../math';
import {
  PROJECTILE_TYPE_UNKNOWN,
  TURRET_ID_UNKNOWN,
  projectileTypeToCode,
  shotIdToCode,
  turretIdToCode,
} from '../../types/network';

type ProjectileSnapshot = NonNullable<NetworkServerSnapshot['projectiles']>;

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
  tick: number;
  recipientPlayerId?: PlayerId;
  visibility?: SnapshotVisibility;
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

function qPos(n: number): number {
  return Math.round(n);
}

function qVel(n: number): number {
  return Math.round(n * 10) / 10;
}

function qAccel(n: number): number {
  return Math.round(n * 10) / 10;
}

function qRot(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function qNormal(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function createPooledBeamUpdate(): NetworkServerSnapshotBeamUpdate {
  return {
    id: 0,
    points: [],
    obstructionT: undefined,
    endpointDamageable: undefined,
  };
}

function createPooledBeamPoint(): NetworkServerSnapshotBeamPoint {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ax: 0, ay: 0, az: 0 };
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
    _pos: { x: 0, y: 0, z: 0 },
    _velocity: { x: 0, y: 0, z: 0 },
    _beamStart: { x: 0, y: 0, z: 0 },
    _beamEnd: { x: 0, y: 0, z: 0 },
    _beam: { start: { x: 0, y: 0, z: 0 }, end: { x: 0, y: 0, z: 0 } },
  };
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
    _pos: { x: 0, y: 0, z: 0 },
    _velocity: { x: 0, y: 0, z: 0 },
  };
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

function shouldSendProjectileSideChannel(
  ownerId: PlayerId | undefined,
  recipientPlayerId: PlayerId | undefined,
  tick: number,
): boolean {
  const rawStride = recipientPlayerId === undefined || ownerId === recipientPlayerId
    ? SNAPSHOT_CONFIG.ownedProjectileUpdateStride
    : SNAPSHOT_CONFIG.observedProjectileUpdateStride;
  const stride = Math.max(1, Math.floor(rawStride));
  return shouldRunOnStride(tick, stride);
}

function shouldSendProjectileAtPoint(
  ownerId: PlayerId | undefined,
  recipientPlayerId: PlayerId | undefined,
  visibility: SnapshotVisibility | undefined,
  x: number,
  y: number,
  homingTargetId?: number,
  world?: WorldState,
): boolean {
  if (!visibility || !visibility.isFiltered) return true;
  if (ownerId !== undefined && ownerId === recipientPlayerId) return true;
  if (visibility.isPointVisible(x, y)) return true;
  // FOW-08-followup: forward in-flight updates when the projectile is
  // homing on one of the recipient's own entities, so the player at
  // least sees the missile veering toward their unit instead of
  // taking a silent HP drop from an attacker still hidden in fog.
  if (homingTargetId !== undefined && world) {
    const target = world.getEntity(homingTargetId);
    if (target?.ownership?.playerId === recipientPlayerId) return true;
  }
  return false;
}

function shouldSendBeamPath(
  ownerId: PlayerId | undefined,
  recipientPlayerId: PlayerId | undefined,
  visibility: SnapshotVisibility | undefined,
  points: ReadonlyArray<{ x: number; y: number }>,
): boolean {
  if (!visibility || !visibility.isFiltered) return true;
  if (ownerId !== undefined && ownerId === recipientPlayerId) return true;
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
  recipientPlayerId: PlayerId | undefined,
  visibility: SnapshotVisibility | undefined,
  world: WorldState,
): boolean {
  if (!visibility || !visibility.isFiltered) return true;
  if (spawn.playerId === recipientPlayerId) return true;
  if (visibility.isPointVisible(spawn.pos.x, spawn.pos.y)) return true;
  // FOW-08: forward the spawn when the shot is targeting one of the
  // recipient's own entities. Without this, an attacker hidden in fog
  // can land a kill on the player without the player ever seeing a
  // projectile in flight — the unit just takes a silent HP drop. With
  // this, the client renders the trail from (the still-shrouded)
  // spawn position toward the player's unit, so the player at least
  // sees the incoming arc and can guess the attacker's direction.
  if (spawn.targetEntityId !== undefined) {
    const target = world.getEntity(spawn.targetEntityId);
    if (target?.ownership?.playerId === recipientPlayerId) return true;
  }
  return false;
}

function canReferenceEntityId(
  world: WorldState,
  visibility: SnapshotVisibility | undefined,
  entityId: number | undefined,
): boolean {
  if (entityId === undefined) return false;
  return visibility?.canReferenceEntityId(world, entityId) ?? true;
}

function resetProjectilePools(): void {
  _spawnPoolIndex = 0;
  _despawnPoolIndex = 0;
  _velUpdatePoolIndex = 0;
  _beamUpdatePoolIndex = 0;
  _beamPointPoolIndex = 0;
}

export function serializeProjectileSnapshot({
  world,
  deltaEnabled,
  tick,
  recipientPlayerId,
  visibility,
  projectileSpawns,
  projectileDespawns,
  projectileVelocityUpdates,
}: SerializeProjectileSnapshotOptions): ProjectileSnapshot | undefined {
  resetProjectilePools();

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
        if (!shouldSendProjectileSpawnEvent(ps, recipientPlayerId, visibility, world)) continue;
        const out = getPooledProjectileSpawn();
        out.id = ps.id;
        out._pos.x = ps.pos.x;
        out._pos.y = ps.pos.y;
        out._pos.z = ps.pos.z;
        out.rotation = ps.rotation;
        out._velocity.x = ps.velocity.x;
        out._velocity.y = ps.velocity.y;
        out._velocity.z = ps.velocity.z;
        out.projectileType = projectileTypeToCode(ps.projectileType);
        out.maxLifespan = ps.maxLifespan;
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
        out.isDGun = ps.isDGun;
        out.fromParentDetonation = ps.fromParentDetonation;
        if (ps.beam) {
          out._beamStart.x = ps.beam.start.x;
          out._beamStart.y = ps.beam.start.y;
          out._beamStart.z = ps.beam.start.z;
          out._beamEnd.x = ps.beam.end.x;
          out._beamEnd.y = ps.beam.end.y;
          out._beamEnd.z = ps.beam.end.z;
          out.beam = out._beam;
        } else {
          out.beam = undefined;
        }
        out.targetEntityId = canReferenceEntityId(world, visibility, ps.targetEntityId)
          ? ps.targetEntityId
          : undefined;
        out.homingTurnRate = ps.homingTurnRate;
        _spawnBuf.push(out);
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
            recipientPlayerId,
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
        out._pos.x = entity.transform.x;
        out._pos.y = entity.transform.y;
        out._pos.z = entity.transform.z;
        out.rotation = entity.transform.rotation;
        out._velocity.x = proj.velocityX;
        out._velocity.y = proj.velocityY;
        out._velocity.z = proj.velocityZ;
        out.projectileType = projectileTypeToCode(proj.projectileType);
        out.maxLifespan = proj.maxLifespan;
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
          out._beamStart.x = start.x;
          out._beamStart.y = start.y;
          out._beamStart.z = start.z;
          out._beamEnd.x = end.x;
          out._beamEnd.y = end.y;
          out._beamEnd.z = end.z;
          out.beam = out._beam;
        } else {
          out.beam = undefined;
        }
        out.targetEntityId = canReferenceEntityId(world, visibility, proj.homingTargetId)
          ? proj.homingTargetId
          : undefined;
        out.homingTurnRate = proj.homingTurnRate;
        _spawnBuf.push(out);
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
    }
    netProjectileDespawns = _despawnBuf;
  }

  let netVelocityUpdates: NetworkServerSnapshotVelocityUpdate[] | undefined;
  if (projectileVelocityUpdates && projectileVelocityUpdates.length > 0) {
    _velUpdateBuf.length = 0;
    for (let i = 0; i < projectileVelocityUpdates.length; i++) {
      const vu = projectileVelocityUpdates[i];
      const projectile = world.getEntity(vu.id)?.projectile;
      if (!shouldSendProjectileSideChannel(projectile?.ownerId, recipientPlayerId, tick)) continue;
      if (
        !shouldSendProjectileAtPoint(
          projectile?.ownerId,
          recipientPlayerId,
          visibility,
          vu.pos.x,
          vu.pos.y,
          projectile?.homingTargetId,
          world,
        )
      ) {
        continue;
      }
      const out = getPooledVelocityUpdate();
      out.id = vu.id;
      out._pos.x = vu.pos.x;
      out._pos.y = vu.pos.y;
      out._pos.z = vu.pos.z;
      out._velocity.x = vu.velocity.x;
      out._velocity.y = vu.velocity.y;
      out._velocity.z = vu.velocity.z;
      _velUpdateBuf.push(out);
    }
    if (_velUpdateBuf.length > 0) netVelocityUpdates = _velUpdateBuf;
  }

  let netBeamUpdates: NetworkServerSnapshotBeamUpdate[] | undefined;
  const lineProjectiles = world.getLineProjectiles();
  if (lineProjectiles.length > 0) {
    _beamUpdateBuf.length = 0;
    for (let i = 0; i < lineProjectiles.length; i++) {
      const entity = lineProjectiles[i];
      const proj = entity.projectile;
      if (!proj) continue;
      if (!shouldSendProjectileSideChannel(proj.ownerId, recipientPlayerId, tick)) continue;
      const srcPts = proj.points;
      if (!srcPts || srcPts.length < 2) continue;
      if (!shouldSendBeamPath(proj.ownerId, recipientPlayerId, visibility, srcPts)) continue;

      const update = getPooledBeamUpdate();
      update.id = entity.id;
      update.obstructionT = proj.obstructionT === undefined ? undefined : qRot(proj.obstructionT);
      update.endpointDamageable = proj.endpointDamageable === false ? false : undefined;
      const dstPts = update.points;
      dstPts.length = srcPts.length;
      for (let p = 0; p < srcPts.length; p++) {
        const sp = srcPts[p];
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
        if (sp.ax === 0 && sp.ay === 0 && sp.az === 0) {
          out.ax = 0;
          out.ay = 0;
          out.az = 0;
        } else {
          out.ax = qAccel(sp.ax);
          out.ay = qAccel(sp.ay);
          out.az = qAccel(sp.az);
        }
        const canReferenceReflector = canReferenceEntityId(world, visibility, sp.mirrorEntityId);
        out.mirrorEntityId = canReferenceReflector ? sp.mirrorEntityId : undefined;
        out.reflectorKind = canReferenceReflector ? sp.reflectorKind : undefined;
        out.reflectorPlayerId = canReferenceReflector ? sp.reflectorPlayerId : undefined;
        out.normalX = canReferenceReflector && sp.normalX !== undefined ? qNormal(sp.normalX) : undefined;
        out.normalY = canReferenceReflector && sp.normalY !== undefined ? qNormal(sp.normalY) : undefined;
        out.normalZ = canReferenceReflector && sp.normalZ !== undefined ? qNormal(sp.normalZ) : undefined;
        dstPts[p] = out;
      }

      _beamUpdateBuf.push(update);
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
