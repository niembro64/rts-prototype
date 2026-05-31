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
  NetworkServerSnapshotResourceMovement,
  NetworkServerSnapshotScanPulse,
  NetworkServerSnapshotSimEvent,
  NetworkServerSnapshotSprayTarget,
  NetworkServerSnapshotTurret,
  NetworkServerSnapshotVelocityUpdate,
} from './NetworkTypes';
import {
  PROJECTILE_TYPE_UNKNOWN,
  RESOURCE_FLOW_INBOUND,
  RESOURCE_KIND_ENERGY,
  TURRET_BLUEPRINT_CODE_UNKNOWN,
} from '@/types/network';
import type { PlayerId } from '@/types/sim';

/** Factory rally wire shape — anonymous in the snapshot type, lifted
 *  here so the centralized copy helpers can name it. */
export type WaypointDto = NonNullable<
  NonNullable<NetworkServerSnapshotEntity['building']>['factory']
>['rally'];

export function createSpawnDto(): NetworkServerSnapshotProjectileSpawn {
  return {
    id: 0,
    pos: { x: 0, y: 0, z: 0 },
    rotation: 0,
    velocity: { x: 0, y: 0, z: 0 },
    projectileType: PROJECTILE_TYPE_UNKNOWN,
    turretBlueprintCode: TURRET_BLUEPRINT_CODE_UNKNOWN,
    maxLifespan: null,
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
  dst.turretBlueprintCode = src.turretBlueprintCode;
  dst.shotBlueprintCode = src.shotBlueprintCode;
  dst.sourceTurretBlueprintCode = src.sourceTurretBlueprintCode;
  dst.sourceTurretEntityId = src.sourceTurretEntityId;
  dst.playerId = src.playerId;
  dst.sourceEntityId = src.sourceEntityId;
  dst.sourceHostEntityId = src.sourceHostEntityId;
  dst.sourceRootEntityId = src.sourceRootEntityId;
  dst.sourceTeamId = src.sourceTeamId;
  dst.spawnTick = src.spawnTick;
  dst.parentShotEntityId = src.parentShotEntityId;
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
    dst.beam = null;
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
    clearHomingTarget: null,
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
  dst.clearHomingTarget = src.clearHomingTarget === true ? true : null;
  return dst;
}

export function createMinimapEntityDto(): NetworkServerSnapshotMinimapEntity {
  return {
    id: 0,
    pos: { x: 0, y: 0 },
    type: 'unit',
    playerId: 1,
    radarOnly: null,
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
  dst.radarOnly = src.radarOnly === true ? true : null;
  return dst;
}

export function createBeamDto(): NetworkServerSnapshotBeamUpdate {
  return {
    id: 0,
    points: [],
    obstructionT: null,
    endpointDamageable: null,
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
      dp = {
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
      dstPts[i] = dp;
    }
    dp.x = sp.x; dp.y = sp.y; dp.z = sp.z;
    dp.vx = sp.vx; dp.vy = sp.vy; dp.vz = sp.vz;
    dp.reflectorEntityId = sp.reflectorEntityId;
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
    turretBlueprintId: '',
    sourceType: null,
    sourceKey: null,
    pos: { x: 0, y: 0, z: 0 },
    playerId: null,
    entityId: null,
    deathContext: null,
    impactContext: null,
    shieldImpact: null,
    killerPlayerId: null,
    victimPlayerId: null,
    audioOnly: null,
  };
}

export function copySimEventInto(
  src: NetworkServerSnapshotSimEvent,
  dst: NetworkServerSnapshotSimEvent,
): NetworkServerSnapshotSimEvent {
  dst.type = src.type;
  dst.turretBlueprintId = src.turretBlueprintId;
  dst.sourceType = src.sourceType;
  dst.sourceKey = src.sourceKey;
  dst.pos.x = src.pos.x;
  dst.pos.y = src.pos.y;
  dst.pos.z = src.pos.z;
  dst.playerId = src.playerId;
  dst.entityId = src.entityId;
  // deathContext / impactContext are emitted as fresh literals per tick
  // by the simulation and never reused, so a ref copy is safe and cheap.
  // shieldImpact's `normal` Vec3 is also a fresh literal but we
  // spread it defensively because the tiny extra alloc is dwarfed by
  // the surrounding event-emit work.
  dst.deathContext = src.deathContext;
  dst.impactContext = src.impactContext;
  dst.shieldImpact = src.shieldImpact
    ? {
        normal: { ...src.shieldImpact.normal },
        playerId: src.shieldImpact.playerId,
      }
    : null;
  dst.killerPlayerId = src.killerPlayerId;
  dst.victimPlayerId = src.victimPlayerId;
  dst.audioOnly = src.audioOnly;
  return dst;
}

export function createActionDto(): NetworkServerSnapshotAction {
  return {
    type: 0,
    pos: null,
    posZ: null,
    pathExp: null,
    targetId: null,
    buildingBlueprintId: null,
    grid: null,
    buildingId: null,
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
    dst.pos = null;
  }
  dst.posZ = src.posZ;
  dst.pathExp = src.pathExp;
  dst.targetId = src.targetId;
  dst.buildingBlueprintId = src.buildingBlueprintId;
  if (src.grid) {
    if (!dst.grid) dst.grid = { x: 0, y: 0 };
    dst.grid.x = src.grid.x;
    dst.grid.y = src.grid.y;
  } else {
    dst.grid = null;
  }
  dst.buildingId = src.buildingId;
  return dst;
}

export function createTurretDto(): NetworkServerSnapshotTurret {
  return {
    turret: {
      turretBlueprintCode: TURRET_BLUEPRINT_CODE_UNKNOWN,
      angular: { rot: 0, vel: 0, pitch: 0, pitchVel: 0 },
    },
    targetId: null,
    state: 0,
    active: null,
    currentShieldRange: null,
    hpCurr: null,
  };
}

export function copyTurretInto(
  src: NetworkServerSnapshotTurret,
  dst: NetworkServerSnapshotTurret,
): NetworkServerSnapshotTurret {
  dst.turret.turretBlueprintCode = src.turret.turretBlueprintCode;
  dst.turret.angular.rot = src.turret.angular.rot;
  dst.turret.angular.vel = src.turret.angular.vel;
  dst.turret.angular.pitch = src.turret.angular.pitch;
  dst.turret.angular.pitchVel = src.turret.angular.pitchVel;
  dst.targetId = src.targetId;
  dst.state = src.state;
  dst.active = src.active;
  dst.currentShieldRange = src.currentShieldRange;
  dst.hpCurr = src.hpCurr;
  return dst;
}

export function createSprayDto(): NetworkServerSnapshotSprayTarget {
  return {
    source: { id: 0, pos: { x: 0, y: 0 }, z: null, playerId: 1 as PlayerId },
    target: { id: 0, pos: { x: 0, y: 0 }, z: null, dim: null, radius: null },
    type: 'build',
    intensity: 0,
    speed: null,
    particleRadius: null,
    ballSpawnRate: null,
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
    dst.target.dim = null;
  }
  dst.target.radius = src.target.radius;
  dst.type = src.type;
  dst.intensity = src.intensity;
  dst.speed = src.speed;
  dst.particleRadius = src.particleRadius;
  dst.ballSpawnRate = src.ballSpawnRate;
  return dst;
}

export function createResourceMovementDto(): NetworkServerSnapshotResourceMovement {
  return {
    playerId: 1 as PlayerId,
    sourceEntityId: 0,
    targetEntityId: null,
    resource: RESOURCE_KIND_ENERGY,
    amountPerSecond: 0,
    direction: RESOURCE_FLOW_INBOUND,
  };
}

export function copyResourceMovementInto(
  src: NetworkServerSnapshotResourceMovement,
  dst: NetworkServerSnapshotResourceMovement,
): NetworkServerSnapshotResourceMovement {
  dst.playerId = src.playerId;
  dst.sourceEntityId = src.sourceEntityId;
  dst.targetEntityId = src.targetEntityId;
  dst.resource = src.resource;
  dst.amountPerSecond = src.amountPerSecond;
  dst.direction = src.direction;
  return dst;
}

export function createWaypointDto(): WaypointDto {
  return { pos: { x: 0, y: 0 }, posZ: null, type: '' };
}

export function copyWaypointInto(src: WaypointDto, dst: WaypointDto): WaypointDto {
  dst.pos.x = src.pos.x;
  dst.pos.y = src.pos.y;
  dst.posZ = src.posZ;
  dst.type = src.type;
  return dst;
}

export function createScanPulseDto(): NetworkServerSnapshotScanPulse {
  return {
    playerId: 1 as PlayerId,
    x: 0,
    y: 0,
    z: 0,
    radius: 0,
    expiresAtTick: 0,
  };
}

export function copyScanPulseInto(
  src: NetworkServerSnapshotScanPulse,
  dst: NetworkServerSnapshotScanPulse,
): NetworkServerSnapshotScanPulse {
  dst.playerId = src.playerId;
  dst.x = src.x;
  dst.y = src.y;
  dst.z = src.z;
  dst.radius = src.radius;
  dst.expiresAtTick = src.expiresAtTick;
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
