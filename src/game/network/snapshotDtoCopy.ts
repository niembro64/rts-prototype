// Centralized copy/factory helpers for the projectile spawn /
// velocity-update / beam-update / sim-event wire DTOs.
//
// These shapes are written from three places — the wire serializer's
// pooled buffers, the client SnapshotBuffer's accumulator, and the
// per-spawn smoothing queue — and previously each site kept its own
// copy of every helper. That made it easy to add a field in one spot
// and miss it in the others, so DTO schema drift was a real risk.
// Keep additions/removals to a single field here so all three pools
// stay in lockstep.

import type {
  NetworkServerSnapshotBeamUpdate,
  NetworkServerSnapshotProjectileSpawn,
  NetworkServerSnapshotSimEvent,
  NetworkServerSnapshotVelocityUpdate,
} from './NetworkTypes';
import { PROJECTILE_TYPE_UNKNOWN, TURRET_ID_UNKNOWN } from '@/types/network';

export function createSpawnDto(): NetworkServerSnapshotProjectileSpawn {
  return {
    id: 0,
    pos: { x: 0, y: 0, z: 0 },
    rotation: 0,
    velocity: { x: 0, y: 0, z: 0 },
    projectileType: PROJECTILE_TYPE_UNKNOWN,
    turretId: TURRET_ID_UNKNOWN,
    shotId: undefined,
    sourceTurretId: undefined,
    playerId: 1,
    sourceEntityId: 0,
    turretIndex: 0,
    barrelIndex: 0,
  };
}

export function copySpawnInto(
  src: NetworkServerSnapshotProjectileSpawn,
  dst: NetworkServerSnapshotProjectileSpawn,
): NetworkServerSnapshotProjectileSpawn {
  dst.id = src.id;
  dst.pos.x = src.pos.x;
  dst.pos.y = src.pos.y;
  dst.pos.z = src.pos.z;
  dst.rotation = src.rotation;
  dst.velocity.x = src.velocity.x;
  dst.velocity.y = src.velocity.y;
  dst.velocity.z = src.velocity.z;
  dst.projectileType = src.projectileType;
  dst.maxLifespan = src.maxLifespan;
  dst.turretId = src.turretId;
  dst.shotId = src.shotId;
  dst.sourceTurretId = src.sourceTurretId;
  dst.playerId = src.playerId;
  dst.sourceEntityId = src.sourceEntityId;
  dst.turretIndex = src.turretIndex;
  dst.barrelIndex = src.barrelIndex;
  dst.isDGun = src.isDGun;
  dst.fromParentDetonation = src.fromParentDetonation;
  if (src.beam) {
    if (!dst.beam) {
      dst.beam = { start: { x: 0, y: 0, z: 0 }, end: { x: 0, y: 0, z: 0 } };
    }
    dst.beam.start.x = src.beam.start.x;
    dst.beam.start.y = src.beam.start.y;
    dst.beam.start.z = src.beam.start.z;
    dst.beam.end.x = src.beam.end.x;
    dst.beam.end.y = src.beam.end.y;
    dst.beam.end.z = src.beam.end.z;
  } else {
    dst.beam = undefined;
  }
  dst.targetEntityId = src.targetEntityId;
  dst.homingTurnRate = src.homingTurnRate;
  return dst;
}

export function createVelocityDto(): NetworkServerSnapshotVelocityUpdate {
  return {
    id: 0,
    pos: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
  };
}

export function copyVelocityInto(
  src: NetworkServerSnapshotVelocityUpdate,
  dst: NetworkServerSnapshotVelocityUpdate,
): NetworkServerSnapshotVelocityUpdate {
  dst.id = src.id;
  dst.pos.x = src.pos.x;
  dst.pos.y = src.pos.y;
  dst.pos.z = src.pos.z;
  dst.velocity.x = src.velocity.x;
  dst.velocity.y = src.velocity.y;
  dst.velocity.z = src.velocity.z;
  return dst;
}

export function createBeamDto(): NetworkServerSnapshotBeamUpdate {
  return {
    id: 0,
    points: [],
    obstructionT: undefined,
    endpointDamageable: undefined,
  };
}

export function copyBeamInto(
  src: NetworkServerSnapshotBeamUpdate,
  dst: NetworkServerSnapshotBeamUpdate,
): NetworkServerSnapshotBeamUpdate {
  dst.id = src.id;
  dst.obstructionT = src.obstructionT;
  dst.endpointDamageable = src.endpointDamageable;
  const dstPts = dst.points;
  dstPts.length = src.points.length;
  for (let i = 0; i < src.points.length; i++) {
    const sp = src.points[i];
    let dp = dstPts[i];
    if (!dp) {
      dp = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
      dstPts[i] = dp;
    }
    dp.x = sp.x; dp.y = sp.y; dp.z = sp.z;
    dp.vx = sp.vx; dp.vy = sp.vy; dp.vz = sp.vz;
    dp.mirrorEntityId = sp.mirrorEntityId;
    dp.reflectorKind = sp.reflectorKind;
    dp.reflectorPlayerId = sp.reflectorPlayerId;
    dp.normalX = sp.normalX;
    dp.normalY = sp.normalY;
    dp.normalZ = sp.normalZ;
  }
  return dst;
}

export function createSimEventDto(): NetworkServerSnapshotSimEvent {
  return {
    type: 'fire',
    turretId: '',
    sourceType: undefined,
    sourceKey: undefined,
    pos: { x: 0, y: 0, z: 0 },
    forceFieldImpact: undefined,
  };
}

export function copySimEventInto(
  src: NetworkServerSnapshotSimEvent,
  dst: NetworkServerSnapshotSimEvent,
): NetworkServerSnapshotSimEvent {
  dst.type = src.type;
  dst.turretId = src.turretId;
  dst.sourceType = src.sourceType;
  dst.sourceKey = src.sourceKey;
  dst.pos.x = src.pos.x;
  dst.pos.y = src.pos.y;
  dst.pos.z = src.pos.z;
  dst.entityId = src.entityId;
  // deathContext / impactContext are emitted as fresh literals per tick
  // by the simulation and never reused, so a ref copy is safe and cheap.
  // forceFieldImpact's `normal` Vec3 is also a fresh literal but we
  // spread it defensively because the tiny extra alloc is dwarfed by
  // the surrounding event-emit work.
  dst.deathContext = src.deathContext;
  dst.impactContext = src.impactContext;
  dst.forceFieldImpact = src.forceFieldImpact
    ? {
        normal: { ...src.forceFieldImpact.normal },
        playerId: src.forceFieldImpact.playerId,
      }
    : undefined;
  return dst;
}
