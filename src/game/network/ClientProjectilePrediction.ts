// Migration debt: client-side projectile extrapolation against host snapshots.
// Lockstep renders projectiles from local sim render packets with event-aware
// interpolation instead of remote-state prediction.

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
  magnitude3,
  solveKinematicIntercept,
  type KinematicInterceptSolution,
  type KinematicState3,
} from '../math';
import type { PredictionStep } from './ClientPredictionCadence';

export type ClientProjectilePredictionResult = {
  becameLineProjectile: boolean;
  shouldDelete: boolean;
};

const _clientHomingAimPoint = { x: 0, y: 0, z: 0 };
const _clientHomingTargetVelocity = { x: 0, y: 0, z: 0 };
const _clientHomingTargetAcceleration = { x: 0, y: 0, z: 0 };
const _clientProjectilePositionScratch = { x: 0, y: 0, z: 0 };
const _clientProjectileVelocityScratch = { x: 0, y: 0, z: 0 };
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

/** Resolve the homing thrust acceleration the client predicts for a
 *  rocket given its current position and velocity. Used for both the
 *  live dead-reckon path (passing the entity's current state) and the
 *  snapshot-target advance (passing the snapshot's state) so both
 *  evolve under the same gravity + counter-thrust vector. Homing
 *  projectiles only steer toward their inherited target; if that
 *  target is missing or dead, guidance stops. */
function resolveClientHomingThrust(options: {
  entity: Entity;
  dt: number;
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  getEntity: (id: EntityId) => Entity | undefined;
}): { x: number; y: number; z: number } | null {
  const { entity, dt, position, velocity, getEntity } = options;
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
  const projectileSpeed = magnitude3(velocity.x, velocity.y, velocity.z);
  if ((targetSpeedSq > 1e-6 || targetAccelSq > 1e-6) && projectileSpeed > 1e-6) {
    _clientHomingOriginState.position.x = position.x;
    _clientHomingOriginState.position.y = position.y;
    _clientHomingOriginState.position.z = position.z;
    _clientHomingOriginState.velocity.x = velocity.x;
    _clientHomingOriginState.velocity.y = velocity.y;
    _clientHomingOriginState.velocity.z = velocity.z;
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
    velocity.x, velocity.y, velocity.z,
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
  predictionStep: PredictionStep;
  mapWidth: number;
  mapHeight: number;
  getEntity: (id: EntityId) => Entity | undefined;
}): ClientProjectilePredictionResult {
  const {
    entity,
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
  proj.timeAlive += entityDeltaMs;

  const dgunProjectile = entity.dgunProjectile;
  const isDGunWave = dgunProjectile !== null && dgunProjectile.isDGun === true;
  const projectileGravity = GRAVITY;
  const groundOffset = dgunProjectile !== null
    ? dgunProjectile.groundOffset
    : DGUN_TERRAIN_FOLLOW_HEIGHT;

  // Projectiles are deterministic between discrete events: spawn,
  // reflection, homing course correction, despawn. Each event arrives
  // as a velocityUpdate that has already been *snapped* directly into
  // entity.transform / proj.velocity by ClientViewState. Between events
  // the client just dead-reckons under gravity + homing/terrain-follow
  // thrust — the same vector the server uses — so the client and server
  // trajectories agree to within quantization. No EMA correction loop:
  // applying a low-pass filter to a step function would produce a ramp
  // that doesn't correspond to any real trajectory and visibly wiggles
  // the tail behind reflected projectiles.
  const position = getEntityPosition3d(entity, _clientProjectilePositionScratch);
  let aNetX = 0;
  let aNetY = 0;
  let aNetZ = -projectileGravity;
  let isHoming = false;
  if (!isDGunWave) {
    _clientProjectileVelocityScratch.x = proj.velocityX;
    _clientProjectileVelocityScratch.y = proj.velocityY;
    _clientProjectileVelocityScratch.z = proj.velocityZ;
    const thrust = resolveClientHomingThrust({
      entity,
      dt,
      position,
      velocity: _clientProjectileVelocityScratch,
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
