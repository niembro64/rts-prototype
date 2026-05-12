// Centralized copy/factory helpers for the wire DTO shapes that the
// snapshot serializer, snapshot cloner, projectile-spawn smoothing
// queue, and debug-grid publisher all build into pooled buffers.
//
// Each shape used to keep its own factory + per-field copy in two or
// three modules, which is exactly how DTO fields drift — add a new
// optional field in one site, miss the others, and the wire schema
// silently desyncs. Every pair below is the single source of truth;
// pool wrappers in the serializer, the cloner, the spawn-smoothing
// queue, and the debug-grid publisher import these directly.

import type {
  NetworkServerSnapshotAction,
  NetworkServerSnapshotBeamUpdate,
  NetworkServerSnapshotEntity,
  NetworkServerSnapshotGridCell,
  NetworkServerSnapshotMinimapEntity,
  NetworkServerSnapshotProjectileSpawn,
  NetworkServerSnapshotSimEvent,
  NetworkServerSnapshotSprayTarget,
  NetworkServerSnapshotTurret,
  NetworkServerSnapshotVelocityUpdate,
} from './NetworkTypes';
import { PROJECTILE_TYPE_UNKNOWN, TURRET_ID_UNKNOWN } from '@/types/network';
import type { PlayerId } from '@/types/sim';

/** Factory waypoint wire shape — anonymous in the snapshot type, lifted
 *  here so the centralized waypoint helpers can name it. */
export type WaypointDto = NonNullable<
  NonNullable<NetworkServerSnapshotEntity['building']>['factory']
>['waypoints'][number];

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

export function createMinimapEntityDto(): NetworkServerSnapshotMinimapEntity {
  return {
    id: 0,
    pos: { x: 0, y: 0 },
    type: 'unit',
    playerId: 1,
  };
}

export function copyMinimapEntityInto(
  src: NetworkServerSnapshotMinimapEntity,
  dst: NetworkServerSnapshotMinimapEntity,
): NetworkServerSnapshotMinimapEntity {
  dst.id = src.id;
  dst.pos.x = src.pos.x;
  dst.pos.y = src.pos.y;
  dst.type = src.type;
  dst.playerId = src.playerId;
  if (src.radarOnly) dst.radarOnly = true;
  else delete dst.radarOnly;
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
      dp = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ax: 0, ay: 0, az: 0 };
      dstPts[i] = dp;
    }
    dp.x = sp.x; dp.y = sp.y; dp.z = sp.z;
    dp.vx = sp.vx; dp.vy = sp.vy; dp.vz = sp.vz;
    dp.ax = sp.ax; dp.ay = sp.ay; dp.az = sp.az;
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
    playerId: undefined,
    forceFieldImpact: undefined,
    killerPlayerId: undefined,
    victimPlayerId: undefined,
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
  dst.playerId = src.playerId;
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
  dst.killerPlayerId = src.killerPlayerId;
  dst.victimPlayerId = src.victimPlayerId;
  return dst;
}

export function createActionDto(): NetworkServerSnapshotAction {
  return {
    type: 0,
    pos: undefined,
    posZ: undefined,
    pathExp: undefined,
    targetId: undefined,
    buildingType: undefined,
    grid: undefined,
    buildingId: undefined,
  };
}

export function copyActionInto(
  src: NetworkServerSnapshotAction,
  dst: NetworkServerSnapshotAction,
): NetworkServerSnapshotAction {
  dst.type = src.type;
  if (src.pos) {
    if (!dst.pos) dst.pos = { x: 0, y: 0 };
    dst.pos.x = src.pos.x;
    dst.pos.y = src.pos.y;
  } else {
    dst.pos = undefined;
  }
  dst.posZ = src.posZ;
  dst.pathExp = src.pathExp;
  dst.targetId = src.targetId;
  dst.buildingType = src.buildingType;
  if (src.grid) {
    if (!dst.grid) dst.grid = { x: 0, y: 0 };
    dst.grid.x = src.grid.x;
    dst.grid.y = src.grid.y;
  } else {
    dst.grid = undefined;
  }
  dst.buildingId = src.buildingId;
  return dst;
}

export function createTurretDto(): NetworkServerSnapshotTurret {
  return {
    turret: {
      id: TURRET_ID_UNKNOWN,
      angular: { rot: 0, vel: 0, pitch: 0 },
    },
    targetId: undefined,
    state: 0,
    currentForceFieldRange: undefined,
  };
}

export function copyTurretInto(
  src: NetworkServerSnapshotTurret,
  dst: NetworkServerSnapshotTurret,
): NetworkServerSnapshotTurret {
  dst.turret.id = src.turret.id;
  dst.turret.angular.rot = src.turret.angular.rot;
  dst.turret.angular.vel = src.turret.angular.vel;
  dst.turret.angular.pitch = src.turret.angular.pitch;
  dst.targetId = src.targetId;
  dst.state = src.state;
  dst.currentForceFieldRange = src.currentForceFieldRange;
  return dst;
}

export function createSprayDto(): NetworkServerSnapshotSprayTarget {
  return {
    source: { id: 0, pos: { x: 0, y: 0 }, z: undefined, playerId: 1 as PlayerId },
    target: { id: 0, pos: { x: 0, y: 0 }, z: undefined, dim: undefined, radius: undefined },
    type: 'build',
    intensity: 0,
    speed: undefined,
    particleRadius: undefined,
  };
}

export function copySprayInto(
  src: NetworkServerSnapshotSprayTarget,
  dst: NetworkServerSnapshotSprayTarget,
): NetworkServerSnapshotSprayTarget {
  dst.source.id = src.source.id;
  dst.source.pos.x = src.source.pos.x;
  dst.source.pos.y = src.source.pos.y;
  dst.source.z = src.source.z;
  dst.source.playerId = src.source.playerId;
  dst.target.id = src.target.id;
  dst.target.pos.x = src.target.pos.x;
  dst.target.pos.y = src.target.pos.y;
  dst.target.z = src.target.z;
  if (src.target.dim) {
    if (!dst.target.dim) dst.target.dim = { x: 0, y: 0 };
    dst.target.dim.x = src.target.dim.x;
    dst.target.dim.y = src.target.dim.y;
  } else {
    dst.target.dim = undefined;
  }
  dst.target.radius = src.target.radius;
  dst.type = src.type;
  dst.intensity = src.intensity;
  dst.speed = src.speed;
  dst.particleRadius = src.particleRadius;
  return dst;
}

export function createWaypointDto(): WaypointDto {
  return { pos: { x: 0, y: 0 }, posZ: undefined, type: '' };
}

export function copyWaypointInto(src: WaypointDto, dst: WaypointDto): WaypointDto {
  dst.pos.x = src.pos.x;
  dst.pos.y = src.pos.y;
  dst.posZ = src.posZ;
  dst.type = src.type;
  return dst;
}

export function createCellDto(): NetworkServerSnapshotGridCell {
  return { cell: { x: 0, y: 0, z: 0 }, players: [] };
}

export function copyCellInto(
  src: NetworkServerSnapshotGridCell,
  dst: NetworkServerSnapshotGridCell,
): NetworkServerSnapshotGridCell {
  dst.cell.x = src.cell.x;
  dst.cell.y = src.cell.y;
  dst.cell.z = src.cell.z;
  dst.players.length = src.players.length;
  for (let i = 0; i < src.players.length; i++) dst.players[i] = src.players[i];
  return dst;
}
