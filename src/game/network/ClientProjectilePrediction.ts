import type { Entity, EntityId } from '../sim/types';
import { NO_ENTITY_ID } from '../sim/types';
import { isLineShotType, type ProjectileShot } from '@/types/sim';
import {
  GRAVITY,
  DGUN_TERRAIN_FOLLOW_HEIGHT,
  DGUN_TERRAIN_FOLLOW_SPRING_ACCEL_PER_WORLD_UNIT,
  DGUN_TERRAIN_FOLLOW_DAMPING_RATIO,
  DGUN_TERRAIN_FOLLOW_MAX_THRUST_FORCE,
  LAND_CELL_SIZE,
} from '../../config';
import { getSurfaceHeight } from '../sim/Terrain';
import {
  getEntityAcceleration3d,
  getEntityPosition3d,
  getEntityVelocity3d,
} from '../sim/combat/combatUtils';
import { resolveTargetAimPoint } from '../sim/combat/aimSolver';
import {
  computeHomingThrust,
  computeTerrainFollowVerticalThrustAccel,
  integrateConstantAccelerationPosition,
  integrateConstantAccelerationVelocity,
  lerp,
  magnitude3,
  solveKinematicIntercept,
  type KinematicInterceptSolution,
  type KinematicState3,
} from '../math';
import { getChannelBlend } from './driftEma';
import {
  getMovementPosEmaMode,
  getMovementVelEmaMode,
} from '@/clientBarConfig';
import type { PredictionStep } from './ClientPredictionCadence';

type ProjectilePredictionTarget = {
  x: number;
  y: number;
  z: number;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
};

export type ClientProjectilePredictionResult = {
  becameLineProjectile: boolean;
  shouldDelete: boolean;
};

const _clientHomingAimPoint = { x: 0, y: 0, z: 0 };
const _clientHomingTargetVelocity = { x: 0, y: 0, z: 0 };
const _clientHomingTargetAcceleration = { x: 0, y: 0, z: 0 };
const _clientProjectilePositionScratch = { x: 0, y: 0, z: 0 };
const _clientHomingOriginState: KinematicState3 = {
  position: { x: 0, y: 0, z: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  acceleration: { x: 0, y: 0, z: 0 },
};
const _clientHomingTargetState: KinematicState3 = {
  position: { x: 0, y: 0, z: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  acceleration: { x: 0, y: 0, z: 0 },
};
const _clientHomingIntercept: KinematicInterceptSolution = {
  time: 0,
  aimPoint: { x: 0, y: 0, z: 0 },
  launchVelocity: { x: 0, y: 0, z: 0 },
};
const _clientThrustResult = { x: 0, y: 0, z: 0 };

function getHomingMaxThrustAccel(shot: ProjectileShot): number {
  const mass = shot.mass > 1e-6 ? shot.mass : 1e-6;
  return (shot.homingThrust ?? 0) / mass;
}

/** Resolve the homing thrust acceleration the client predicts this
 *  tick. Homing projectiles only steer toward their inherited target;
 *  if that target is missing or dead, guidance stops. */
function resolveClientHomingThrust(options: {
  entity: Entity;
  dt: number;
  position: { x: number; y: number; z: number };
  getEntity: (id: EntityId) => Entity | undefined;
}): { x: number; y: number; z: number } | null {
  const { entity, dt, position, getEntity } = options;
  const proj = entity.projectile;
  if (!proj || proj.homingTurnRate === undefined) return null;
  const shot = proj.config.shot as ProjectileShot;
  const maxThrustAccel = getHomingMaxThrustAccel(shot);
  if (maxThrustAccel <= 0) return null;

  if (proj.homingTargetId === NO_ENTITY_ID) {
    return null;
  }

  const homingTarget = getEntity(proj.homingTargetId);
  const targetValid = !!(homingTarget && ((homingTarget.unit && homingTarget.unit.hp > 0) || (homingTarget.building && homingTarget.building.hp > 0)));
  if (!targetValid) {
    proj.homingTargetId = NO_ENTITY_ID;
  }
  if (!(targetValid && homingTarget)) return null;

  // Lead intercept consumes raw target velocity/acceleration through
  // the shared entity accessors. Client-side unit acceleration is
  // usually zero (the server owns force inputs and the wire ships
  // integrated velocity, not a per-tick force vector), so this falls
  // back to a velocity-only intercept on most snapshots. Projectiles
  // see no per-tick snapshot positions — only spawn/despawn events —
  // so without this local steering they'd fly straight forever.
  const aimPoint = resolveTargetAimPoint(
    homingTarget,
    position.x, position.y, position.z,
    _clientHomingAimPoint,
  );
  let steerX = aimPoint.x;
  let steerY = aimPoint.y;
  let steerZ = aimPoint.z;
  const targetVelocity = getEntityVelocity3d(homingTarget, _clientHomingTargetVelocity);
  const targetAcceleration = getEntityAcceleration3d(homingTarget, _clientHomingTargetAcceleration);
  const targetSpeedSq =
    targetVelocity.x * targetVelocity.x +
    targetVelocity.y * targetVelocity.y +
    targetVelocity.z * targetVelocity.z;
  const targetAccelSq =
    targetAcceleration.x * targetAcceleration.x +
    targetAcceleration.y * targetAcceleration.y +
    targetAcceleration.z * targetAcceleration.z;
  const projectileSpeed = magnitude3(proj.velocityX, proj.velocityY, proj.velocityZ);
  if ((targetSpeedSq > 1e-6 || targetAccelSq > 1e-6) && projectileSpeed > 1e-6) {
    _clientHomingOriginState.position.x = position.x;
    _clientHomingOriginState.position.y = position.y;
    _clientHomingOriginState.position.z = position.z;
    getEntityVelocity3d(entity, _clientHomingOriginState.velocity);
    getEntityAcceleration3d(entity, _clientHomingOriginState.acceleration);
    _clientHomingTargetState.position.x = steerX;
    _clientHomingTargetState.position.y = steerY;
    _clientHomingTargetState.position.z = steerZ;
    _clientHomingTargetState.velocity.x = targetVelocity.x;
    _clientHomingTargetState.velocity.y = targetVelocity.y;
    _clientHomingTargetState.velocity.z = targetVelocity.z;
    _clientHomingTargetState.acceleration.x = targetAcceleration.x;
    _clientHomingTargetState.acceleration.y = targetAcceleration.y;
    _clientHomingTargetState.acceleration.z = targetAcceleration.z;
    const remainingSec = Number.isFinite(proj.maxLifespan)
      ? Math.max(0, (proj.maxLifespan - proj.timeAlive) / 1000)
      : 0;
    const intercept = solveKinematicIntercept({
      myPosition: _clientHomingOriginState.position,
      myVelocity: _clientHomingOriginState.velocity,
      myAcceleration: _clientHomingOriginState.acceleration,
      targetPosition: _clientHomingTargetState.position,
      targetVelocity: _clientHomingTargetState.velocity,
      targetAcceleration: _clientHomingTargetState.acceleration,
      projectileSpeed,
      gravity: GRAVITY,
      preferLateSolution: false,
      maxTimeSec: remainingSec,
    }, _clientHomingIntercept);
    if (intercept) {
      steerX = intercept.aimPoint.x;
      steerY = intercept.aimPoint.y;
      steerZ = intercept.aimPoint.z;
    }
  }

  const thrust = computeHomingThrust(
    proj.velocityX, proj.velocityY, proj.velocityZ,
    steerX, steerY, steerZ,
    position.x, position.y, position.z,
    proj.homingTurnRate ?? 0,
    maxThrustAccel,
    GRAVITY,
    dt,
  );
  _clientThrustResult.x = thrust.thrustX;
  _clientThrustResult.y = thrust.thrustY;
  _clientThrustResult.z = thrust.thrustZ;
  return _clientThrustResult;
}

export function applyClientProjectilePrediction(options: {
  entity: Entity;
  target: ProjectilePredictionTarget | undefined;
  predictionStep: PredictionStep;
  mapWidth: number;
  mapHeight: number;
  getEntity: (id: EntityId) => Entity | undefined;
}): ClientProjectilePredictionResult {
  const {
    entity,
    target,
    predictionStep,
    mapWidth,
    mapHeight,
    getEntity,
  } = options;
  const proj = entity.projectile;
  if (!proj) return { becameLineProjectile: false, shouldDelete: true };
  if (isLineShotType(proj.projectileType)) {
    return { becameLineProjectile: true, shouldDelete: false };
  }

  const entityDeltaMs = predictionStep.entityDeltaMs;
  const dt = entityDeltaMs / 1000;
  const targetDt = predictionStep.targetDeltaMs / 1000;
  // Projectiles follow the same per-channel movement EMAs as units.
  // Movement position always corrects; movement velocity can still IGNORE.
  const movPosBlend = getChannelBlend(getMovementPosEmaMode(), dt);
  const movVelBlend = getChannelBlend(getMovementVelEmaMode(), dt);
  proj.timeAlive += entityDeltaMs;

  const isDGunWave = entity.dgunProjectile?.isDGun === true;
  const projectileGravity = GRAVITY;
  // PREDICT mode picks which authored derivatives feed extrapolation.
  // Projectiles have no per-tick snapshot positions to snap to (only
  // spawn / despawn events), so position integration always runs.
  // All projectiles apply gravity while drifting sparse server targets.
  // Homing and D-gun terrain-follow thrust counter it when available.
  const groundOffset = entity.dgunProjectile?.groundOffset ?? DGUN_TERRAIN_FOLLOW_HEIGHT;
  if (target) {
    target.x += target.velocityX * targetDt;
    target.y += target.velocityY * targetDt;
    if (isDGunWave) {
      const terrainTargetZ =
        getSurfaceHeight(target.x, target.y, mapWidth, mapHeight, LAND_CELL_SIZE) + groundOffset;
      const shot = proj.config.shot as ProjectileShot;
      const thrustZ = computeTerrainFollowVerticalThrustAccel({
        positionZ: target.z,
        velocityZ: target.velocityZ,
        targetZ: terrainTargetZ,
        mass: shot.mass,
        gravity: projectileGravity,
        springAccelPerWorldUnit: DGUN_TERRAIN_FOLLOW_SPRING_ACCEL_PER_WORLD_UNIT,
        dampingRatio: DGUN_TERRAIN_FOLLOW_DAMPING_RATIO,
        maxThrustForce: DGUN_TERRAIN_FOLLOW_MAX_THRUST_FORCE,
      });
      const targetNetZ = -projectileGravity + thrustZ;
      target.z = integrateConstantAccelerationPosition(target.z, target.velocityZ, targetNetZ, targetDt);
      target.velocityZ = integrateConstantAccelerationVelocity(target.velocityZ, targetNetZ, targetDt);
    } else {
      target.z = integrateConstantAccelerationPosition(target.z, target.velocityZ, -projectileGravity, targetDt);
      target.velocityZ = integrateConstantAccelerationVelocity(target.velocityZ, -projectileGravity, targetDt);
    }
    if (movPosBlend >= 0) {
      const position = getEntityPosition3d(entity, _clientProjectilePositionScratch);
      entity.transform.x = lerp(position.x, target.x, movPosBlend);
      entity.transform.y = lerp(position.y, target.y, movPosBlend);
      entity.transform.z = lerp(position.z, target.z, movPosBlend);
    }
    if (movVelBlend >= 0) {
      proj.velocityX = lerp(proj.velocityX, target.velocityX, movVelBlend);
      proj.velocityY = lerp(proj.velocityY, target.velocityY, movVelBlend);
      proj.velocityZ = lerp(proj.velocityZ, target.velocityZ, movVelBlend);
    }
    entity.transform.rotation = Math.atan2(proj.velocityY, proj.velocityX);
  }

  // Traveling projectiles: dead-reckon with one combined-acceleration
  // step. Homing / terrain-follow thrust and gravity share the same
  // vector, matching the authoritative projectile path.
  const position = getEntityPosition3d(entity, _clientProjectilePositionScratch);
  let aNetX = 0;
  let aNetY = 0;
  let aNetZ = -projectileGravity;
  let isHoming = false;
  if (!isDGunWave) {
    const thrust = resolveClientHomingThrust({
      entity,
      dt,
      position,
      getEntity,
    });
    if (thrust) {
      aNetX += thrust.x;
      aNetY += thrust.y;
      aNetZ += thrust.z;
      isHoming = true;
    }
  }

  const halfDtSq = 0.5 * dt * dt;
  if (isDGunWave) {
    const targetX = position.x + proj.velocityX * dt + aNetX * halfDtSq;
    const targetY = position.y + proj.velocityY * dt + aNetY * halfDtSq;
    const terrainTargetZ =
      getSurfaceHeight(targetX, targetY, mapWidth, mapHeight, LAND_CELL_SIZE) + groundOffset;
    const shot = proj.config.shot as ProjectileShot;
    aNetZ += computeTerrainFollowVerticalThrustAccel({
      positionZ: position.z,
      velocityZ: proj.velocityZ,
      targetZ: terrainTargetZ,
      mass: shot.mass,
      gravity: projectileGravity,
      springAccelPerWorldUnit: DGUN_TERRAIN_FOLLOW_SPRING_ACCEL_PER_WORLD_UNIT,
      dampingRatio: DGUN_TERRAIN_FOLLOW_DAMPING_RATIO,
      maxThrustForce: DGUN_TERRAIN_FOLLOW_MAX_THRUST_FORCE,
    });
  }
  entity.transform.x = position.x + proj.velocityX * dt + aNetX * halfDtSq;
  entity.transform.y = position.y + proj.velocityY * dt + aNetY * halfDtSq;
  entity.transform.z = position.z + proj.velocityZ * dt + aNetZ * halfDtSq;
  proj.velocityX += aNetX * dt;
  proj.velocityY += aNetY * dt;
  proj.velocityZ += aNetZ * dt;

  if (isHoming) {
    entity.transform.rotation = Math.atan2(proj.velocityY, proj.velocityX);
  }

  const groundPosition = getEntityPosition3d(entity, _clientProjectilePositionScratch);
  const groundZ = getSurfaceHeight(groundPosition.x, groundPosition.y, mapWidth, mapHeight, LAND_CELL_SIZE);
  if (groundPosition.z <= groundZ && proj.velocityZ <= 0) {
    entity.transform.z = groundZ;
    return { becameLineProjectile: false, shouldDelete: true };
  }

  // Auto-remove if this projectile has a finite runtime timeout.
  if (Number.isFinite(proj.maxLifespan) && proj.timeAlive > proj.maxLifespan) {
    return { becameLineProjectile: false, shouldDelete: true };
  }

  return { becameLineProjectile: false, shouldDelete: false };
}
