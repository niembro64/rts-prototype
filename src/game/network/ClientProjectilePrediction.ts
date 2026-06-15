import type { Entity, EntityId } from '../sim/types';
import { NO_ENTITY_ID } from '../sim/types';
import { isRayType, type ProjectileShot } from '@/types/sim';
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
  isLiveHomingTarget,
} from '../sim/combat/combatUtils';
import { resolveTargetAimPoint } from '../sim/combat/aimSolver';
import {
  addProjectileForwardPropulsionAcceleration,
  getProjectileAirDragCoefficient,
  getProjectileAirFrictionPer60HzFrame,
} from '../sim/projectileMotion';
import { windVelocityForAirFriction } from '../sim/motionFriction';
import {
  computeHomingThrust,
  computeTerrainFollowVerticalThrustAccel,
  lerp,
  magnitude3,
  solveKinematicIntercept,
  type KinematicInterceptSolution,
  type KinematicState3,
} from '../math';
import { getSimWasm } from '../sim-wasm/init';
import type { PredictionStep } from './ClientPredictionCadence';
import type { ServerTarget } from './ClientPredictionTargets';

export type ClientProjectilePredictionResult = {
  becameLineProjectile: boolean;
  shouldDelete: boolean;
  targetSettled: boolean;
};

type PredictionWind = {
  x: number;
  y: number;
  z: number;
};

const PROJECTILE_TARGET_POS_EPSILON_SQ = 0.01 * 0.01;
const PROJECTILE_TARGET_VEL_EPSILON_SQ = 0.01 * 0.01;
const STILL_AIR: PredictionWind = { x: 0, y: 0, z: 0 };
const _clientHomingAimPoint = { x: 0, y: 0, z: 0 };
const _clientHomingTargetVelocity = { x: 0, y: 0, z: 0 };
const _clientHomingTargetAcceleration = { x: 0, y: 0, z: 0 };
const _clientProjectilePositionScratch = { x: 0, y: 0, z: 0 };
const _clientProjectileVelocityScratch = { x: 0, y: 0, z: 0 };
const _clientProjectilePredictionWind = { x: 0, y: 0, z: 0 };
const _clientProjectileTargetPositionScratch = { x: 0, y: 0, z: 0 };
const _clientProjectileTargetVelocityScratch = { x: 0, y: 0, z: 0 };
const _clientProjectilePosX = new Float64Array(2);
const _clientProjectilePosY = new Float64Array(2);
const _clientProjectilePosZ = new Float64Array(2);
const _clientProjectileVelX = new Float64Array(2);
const _clientProjectileVelY = new Float64Array(2);
const _clientProjectileVelZ = new Float64Array(2);
const _clientProjectileAccelX = new Float64Array(2);
const _clientProjectileAccelY = new Float64Array(2);
const _clientProjectileAccelZ = new Float64Array(2);
const _clientProjectileAirDragCoefficient = new Float64Array(2);
const _clientProjectileInvMass = new Float64Array(2);
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
type ProjectileAccelScratch = {
  x: number;
  y: number;
  z: number;
  isHoming: boolean;
};
const _clientProjectileEntityAccel = { x: 0, y: 0, z: 0, isHoming: false };
const _clientProjectileTargetAccel = { x: 0, y: 0, z: 0, isHoming: false };

function getHomingMaxThrustAccel(shot: ProjectileShot): number {
  const mass = shot.mass > 1e-6 ? shot.mass : 1e-6;
  return (shot.homingThrust ?? 0) / mass;
}

/** Resolve the homing thrust acceleration the client predicts for a
 *  rocket given its current position and velocity. Used for both the
 *  live dead-reckon path (passing the entity's current state) and the
 *  snapshot-target advance (passing the snapshot's state) so both
 *  evolve under the same gravity + counter-thrust vector. Homing
 *  projectiles steer toward the latest target id supplied by the
 *  server; if that target is missing or dead client-side, local
 *  guidance stops until another authoritative retarget arrives. */
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
  if (proj.timeAlive < (shot.homingDelayMs ?? 0)) return null;
  const maxThrustAccel = getHomingMaxThrustAccel(shot);
  if (maxThrustAccel <= 0) return null;
  const projectileGravity = GRAVITY * shot.gravityForceMultiplier;

  if (proj.homingTargetId === NO_ENTITY_ID) {
    return null;
  }

  const homingTarget = getEntity(proj.homingTargetId);
  const targetValid = homingTarget !== undefined && isLiveHomingTarget(homingTarget);
  if (!targetValid) {
    proj.homingTargetId = NO_ENTITY_ID;
  }
  if (homingTarget === undefined || !targetValid) return null;

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
    const airFrictionPer60HzFrame = getProjectileAirFrictionPer60HzFrame(shot);
    const intercept = solveKinematicIntercept({
      myPosition: _clientHomingOriginState.position,
      myVelocity: _clientHomingOriginState.velocity,
      myAcceleration: _clientHomingOriginState.acceleration,
      targetPosition: _clientHomingTargetState.position,
      targetVelocity: _clientHomingTargetState.velocity,
      targetAcceleration: _clientHomingTargetState.acceleration,
      projectileSpeed,
      projectileMass: shot.mass,
      projectileAirFrictionPer60HzFrame: airFrictionPer60HzFrame,
      windVelocity: windVelocityForAirFriction(
        _clientProjectilePredictionWind,
        airFrictionPer60HzFrame,
      ),
      gravity: projectileGravity,
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
    projectileGravity,
    dt,
  );
  _clientThrustResult.x = thrust.thrustX;
  _clientThrustResult.y = thrust.thrustY;
  _clientThrustResult.z = thrust.thrustZ;
  return _clientThrustResult;
}

function resolveProjectileNetAcceleration(options: {
  entity: Entity;
  dt: number;
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  mapWidth: number;
  mapHeight: number;
  getEntity: (id: EntityId) => Entity | undefined;
}, out: ProjectileAccelScratch): ProjectileAccelScratch {
  const { entity, dt, position, velocity, mapWidth, mapHeight, getEntity } = options;
  const proj = entity.projectile;
  out.x = 0;
  out.y = 0;
  out.z = 0;
  out.isHoming = false;
  if (!proj) return out;

  const dgunProjectile = entity.dgunProjectile;
  const isDGunWave = dgunProjectile !== null && dgunProjectile.isDGun === true;
  const shot = proj.config.shot as ProjectileShot;
  const projectileGravity = GRAVITY * shot.gravityForceMultiplier;
  out.z = -projectileGravity;
  addProjectileForwardPropulsionAcceleration(
    shot,
    velocity.x,
    velocity.y,
    velocity.z,
    out,
  );

  if (!isDGunWave) {
    const thrust = resolveClientHomingThrust({
      entity,
      dt,
      position,
      velocity,
      getEntity,
    });
    if (thrust) {
      out.x += thrust.x;
      out.y += thrust.y;
      out.z += thrust.z;
      out.isHoming = true;
    }
    return out;
  }

  const groundOffset = dgunProjectile !== null
    ? dgunProjectile.groundOffset
    : DGUN_TERRAIN_FOLLOW_HEIGHT;
  const halfDtSq = 0.5 * dt * dt;
  const targetX = position.x + velocity.x * dt + out.x * halfDtSq;
  const targetY = position.y + velocity.y * dt + out.y * halfDtSq;
  const terrainTargetZ =
    getSurfaceHeight(targetX, targetY, mapWidth, mapHeight, LAND_CELL_SIZE) + groundOffset;
  out.z += computeTerrainFollowVerticalThrustAccel({
    positionZ: position.z,
    velocityZ: velocity.z,
    targetZ: terrainTargetZ,
    mass: shot.mass,
    gravity: projectileGravity,
    springAccelPerWorldUnit: DGUN_TERRAIN_FOLLOW_SPRING_ACCEL_PER_WORLD_UNIT,
    dampingRatio: DGUN_TERRAIN_FOLLOW_DAMPING_RATIO,
    maxThrustForce: DGUN_TERRAIN_FOLLOW_MAX_THRUST_FORCE,
  });
  return out;
}

function applyProjectileTargetDrift(
  entity: Entity,
  target: ServerTarget,
  movPosBlend: number,
  movVelBlend: number,
): boolean {
  const proj = entity.projectile;
  if (!proj) return true;

  if (movPosBlend >= 0) {
    entity.transform.x = lerp(entity.transform.x, target.x, movPosBlend);
    entity.transform.y = lerp(entity.transform.y, target.y, movPosBlend);
    entity.transform.z = lerp(entity.transform.z, target.z, movPosBlend);
  }
  if (movVelBlend >= 0) {
    proj.velocityX = lerp(proj.velocityX, target.velocityX, movVelBlend);
    proj.velocityY = lerp(proj.velocityY, target.velocityY, movVelBlend);
    proj.velocityZ = lerp(proj.velocityZ, target.velocityZ, movVelBlend);
  }

  const dx = entity.transform.x - target.x;
  const dy = entity.transform.y - target.y;
  const dz = entity.transform.z - target.z;
  const dvx = proj.velocityX - target.velocityX;
  const dvy = proj.velocityY - target.velocityY;
  const dvz = proj.velocityZ - target.velocityZ;
  return (
    dx * dx + dy * dy + dz * dz <= PROJECTILE_TARGET_POS_EPSILON_SQ &&
    (movVelBlend < 0 || dvx * dvx + dvy * dvy + dvz * dvz <= PROJECTILE_TARGET_VEL_EPSILON_SQ)
  );
}

export function applyClientProjectilePrediction(options: {
  entity: Entity;
  predictionStep: PredictionStep;
  target?: ServerTarget;
  movPosBlend: number;
  movVelBlend: number;
  mapWidth: number;
  mapHeight: number;
  wind: PredictionWind | undefined;
  getEntity: (id: EntityId) => Entity | undefined;
}): ClientProjectilePredictionResult {
  const {
    entity,
    predictionStep,
    target,
    movPosBlend,
    movVelBlend,
    mapWidth,
    mapHeight,
    wind,
    getEntity,
  } = options;
  const proj = entity.projectile;
  if (!proj) return { becameLineProjectile: false, shouldDelete: true, targetSettled: true };
  if (isRayType(proj.projectileType)) {
    return { becameLineProjectile: true, shouldDelete: false, targetSettled: true };
  }

  const entityDeltaMs = predictionStep.entityDeltaMs;
  const dt = entityDeltaMs / 1000;
  proj.timeAlive += entityDeltaMs;
  const shot = proj.config.shot as ProjectileShot;
  const airDragCoefficient = getProjectileAirDragCoefficient(shot);
  const invMass = shot.mass > 1e-6 ? 1 / shot.mass : 0;
  const predictionWind = wind ?? STILL_AIR;
  _clientProjectilePredictionWind.x = Number.isFinite(predictionWind.x) ? predictionWind.x : 0;
  _clientProjectilePredictionWind.y = Number.isFinite(predictionWind.y) ? predictionWind.y : 0;
  _clientProjectilePredictionWind.z = Number.isFinite(predictionWind.z) ? predictionWind.z : 0;

  // Travelling projectiles dead-reckon every frame. Rocket velocity
  // updates also install a separate authoritative correction target;
  // this function advances that target with the same gravity / homing /
  // terrain-follow math, then applies the movement position + velocity
  // EMA channels to the rendered projectile. Reflection events still
  // snap before reaching this path so their tails kink at the exact hit.
  const position = getEntityPosition3d(entity, _clientProjectilePositionScratch);
  _clientProjectileVelocityScratch.x = proj.velocityX;
  _clientProjectileVelocityScratch.y = proj.velocityY;
  _clientProjectileVelocityScratch.z = proj.velocityZ;
  const entityAccel = resolveProjectileNetAcceleration({
    entity,
    dt,
    position,
    velocity: _clientProjectileVelocityScratch,
    mapWidth,
    mapHeight,
    getEntity,
  }, _clientProjectileEntityAccel);

  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('Client projectile prediction requires initialized sim-wasm');
  }
  _clientProjectilePosX[0] = position.x;
  _clientProjectilePosY[0] = position.y;
  _clientProjectilePosZ[0] = position.z;
  _clientProjectileVelX[0] = proj.velocityX;
  _clientProjectileVelY[0] = proj.velocityY;
  _clientProjectileVelZ[0] = proj.velocityZ;
  _clientProjectileAccelX[0] = entityAccel.x;
  _clientProjectileAccelY[0] = entityAccel.y;
  _clientProjectileAccelZ[0] = entityAccel.z;
  _clientProjectileAirDragCoefficient[0] = airDragCoefficient;
  _clientProjectileInvMass[0] = invMass;

  const hasTarget = target !== undefined;
  const batchCount = hasTarget ? 2 : 1;
  if (hasTarget) {
    _clientProjectileTargetPositionScratch.x = target.x;
    _clientProjectileTargetPositionScratch.y = target.y;
    _clientProjectileTargetPositionScratch.z = target.z;
    _clientProjectileTargetVelocityScratch.x = target.velocityX;
    _clientProjectileTargetVelocityScratch.y = target.velocityY;
    _clientProjectileTargetVelocityScratch.z = target.velocityZ;
    const targetAccel = resolveProjectileNetAcceleration({
      entity,
      dt,
      position: _clientProjectileTargetPositionScratch,
      velocity: _clientProjectileTargetVelocityScratch,
      mapWidth,
      mapHeight,
      getEntity,
    }, _clientProjectileTargetAccel);
    _clientProjectilePosX[1] = target.x;
    _clientProjectilePosY[1] = target.y;
    _clientProjectilePosZ[1] = target.z;
    _clientProjectileVelX[1] = target.velocityX;
    _clientProjectileVelY[1] = target.velocityY;
    _clientProjectileVelZ[1] = target.velocityZ;
    _clientProjectileAccelX[1] = targetAccel.x;
    _clientProjectileAccelY[1] = targetAccel.y;
    _clientProjectileAccelZ[1] = targetAccel.z;
    _clientProjectileAirDragCoefficient[1] = airDragCoefficient;
    _clientProjectileInvMass[1] = invMass;
  }

  const integrated = sim.projectileIntegrateStepBatch(
    batchCount,
    _clientProjectilePosX,
    _clientProjectilePosY,
    _clientProjectilePosZ,
    _clientProjectileVelX,
    _clientProjectileVelY,
    _clientProjectileVelZ,
    _clientProjectileAccelX,
    _clientProjectileAccelY,
    _clientProjectileAccelZ,
    _clientProjectileAirDragCoefficient,
    _clientProjectileInvMass,
    _clientProjectilePredictionWind.x,
    _clientProjectilePredictionWind.y,
    _clientProjectilePredictionWind.z,
    dt,
  );
  if (integrated !== batchCount) {
    throw new Error('Client projectile prediction integration failed');
  }
  entity.transform.x = _clientProjectilePosX[0];
  entity.transform.y = _clientProjectilePosY[0];
  entity.transform.z = _clientProjectilePosZ[0];
  proj.velocityX = _clientProjectileVelX[0];
  proj.velocityY = _clientProjectileVelY[0];
  proj.velocityZ = _clientProjectileVelZ[0];

  if (hasTarget) {
    target.x = _clientProjectilePosX[1];
    target.y = _clientProjectilePosY[1];
    target.z = _clientProjectilePosZ[1];
    target.velocityX = _clientProjectileVelX[1];
    target.velocityY = _clientProjectileVelY[1];
    target.velocityZ = _clientProjectileVelZ[1];
    target.rotation = Math.atan2(target.velocityY, target.velocityX);
  }

  if (entityAccel.isHoming) {
    entity.transform.rotation = Math.atan2(proj.velocityY, proj.velocityX);
  }
  const targetSettled = hasTarget
    ? applyProjectileTargetDrift(entity, target, movPosBlend, movVelBlend)
    : true;

  const groundPosition = getEntityPosition3d(entity, _clientProjectilePositionScratch);
  const groundZ = getSurfaceHeight(groundPosition.x, groundPosition.y, mapWidth, mapHeight, LAND_CELL_SIZE);
  if (groundPosition.z <= groundZ && proj.velocityZ <= 0) {
    entity.transform.z = groundZ;
    return { becameLineProjectile: false, shouldDelete: true, targetSettled };
  }

  // Auto-remove if this projectile has a finite runtime timeout.
  if (Number.isFinite(proj.maxLifespan) && proj.timeAlive > proj.maxLifespan) {
    return { becameLineProjectile: false, shouldDelete: true, targetSettled };
  }

  return { becameLineProjectile: false, shouldDelete: false, targetSettled };
}
