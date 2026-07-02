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
  getProjectileHomingEngagementScale,
  getProjectileHomingThrustAcceleration,
  getProjectileRocketCounterGravityCarryAcceleration,
} from '../sim/projectileMotion';
import { windVelocityForAirFriction } from '../sim/motionFriction';
import {
  computeHomingThrust,
  computeConstantSpeedHomingVelocity,
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
// Packed projectile integration buffers, grown on demand to hold every
// active projectile plus its optional correction target in a single
// projectileIntegrateStepBatch call per frame (mirrors the batched unit
// prediction path; never shrunk to avoid per-frame allocation churn).
let _clientProjectileBatchCapacity = 0;
let _clientProjectilePosX = new Float64Array(0);
let _clientProjectilePosY = new Float64Array(0);
let _clientProjectilePosZ = new Float64Array(0);
let _clientProjectileVelX = new Float64Array(0);
let _clientProjectileVelY = new Float64Array(0);
let _clientProjectileVelZ = new Float64Array(0);
let _clientProjectileAccelX = new Float64Array(0);
let _clientProjectileAccelY = new Float64Array(0);
let _clientProjectileAccelZ = new Float64Array(0);
let _clientProjectileAirDragCoefficient = new Float64Array(0);
let _clientProjectileInvMass = new Float64Array(0);

function ensureClientProjectileBatchCapacity(slots: number): void {
  if (slots <= _clientProjectileBatchCapacity) return;
  const cap = Math.max(slots, _clientProjectileBatchCapacity === 0 ? 8 : _clientProjectileBatchCapacity * 2);
  _clientProjectilePosX = new Float64Array(cap);
  _clientProjectilePosY = new Float64Array(cap);
  _clientProjectilePosZ = new Float64Array(cap);
  _clientProjectileVelX = new Float64Array(cap);
  _clientProjectileVelY = new Float64Array(cap);
  _clientProjectileVelZ = new Float64Array(cap);
  _clientProjectileAccelX = new Float64Array(cap);
  _clientProjectileAccelY = new Float64Array(cap);
  _clientProjectileAccelZ = new Float64Array(cap);
  _clientProjectileAirDragCoefficient = new Float64Array(cap);
  _clientProjectileInvMass = new Float64Array(cap);
  _clientProjectileBatchCapacity = cap;
}

type ClientProjectileBatchSlot = {
  entity: Entity;
  selfSlot: number;
  targetSlot: number;
  hasTarget: boolean;
  isHoming: boolean;
  skip: boolean;
};
const _clientProjectileBatchSlots: ClientProjectileBatchSlot[] = [];
function ensureClientProjectileBatchSlot(i: number): ClientProjectileBatchSlot {
  let slot = _clientProjectileBatchSlots[i];
  if (slot === undefined) {
    slot = {
      entity: null as unknown as Entity,
      selfSlot: -1,
      targetSlot: -1,
      hasTarget: false,
      isHoming: false,
      skip: true,
    };
    _clientProjectileBatchSlots[i] = slot;
  }
  return slot;
}

function ensureClientProjectileResult(
  out: ClientProjectilePredictionResult[],
  i: number,
): ClientProjectilePredictionResult {
  let result = out[i];
  if (result === undefined) {
    result = { becameLineProjectile: false, shouldDelete: false, targetSettled: true };
    out[i] = result;
  }
  return result;
}
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

function resolveClientHomingAimPoint(options: {
  entity: Entity;
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  projectileGravity: number;
  getEntity: (id: EntityId) => Entity | undefined;
}): { x: number; y: number; z: number } | null {
  const { entity, position, velocity, projectileGravity, getEntity } = options;
  const proj = entity.projectile;
  if (proj === null) return null;
  const shot = proj.config.shot as ProjectileShot;

  if (proj.homingTargetId === NO_ENTITY_ID) {
    return null;
  }

  const homingTarget = getEntity(proj.homingTargetId);
  const targetValid = homingTarget !== undefined && isLiveHomingTarget(homingTarget);
  if (!targetValid) {
    proj.homingTargetId = NO_ENTITY_ID;
  }
  if (homingTarget === undefined || !targetValid) return null;

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

  _clientThrustResult.x = steerX;
  _clientThrustResult.y = steerY;
  _clientThrustResult.z = steerZ;
  return _clientThrustResult;
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
  timeAliveForHomingMs: number;
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  getEntity: (id: EntityId) => Entity | undefined;
}): { x: number; y: number; z: number } | null {
  const { entity, dt, timeAliveForHomingMs, position, velocity, getEntity } = options;
  const proj = entity.projectile;
  if (!proj || proj.homingTurnRate === undefined) return null;
  const shot = proj.config.shot as ProjectileShot;
  if (shot.type === 'missile') return null;
  const engagementScale = getProjectileHomingEngagementScale(
    shot,
    timeAliveForHomingMs,
    dt * 1000,
  );
  const maxThrustAccel = getProjectileHomingThrustAcceleration(shot);
  if (maxThrustAccel <= 0) return null;
  const projectileGravity = GRAVITY * shot.gravityForceMultiplier;
  const counterGravityCarry = getProjectileRocketCounterGravityCarryAcceleration(
    shot,
    engagementScale,
    projectileGravity,
  );
  if (engagementScale <= 0 && counterGravityCarry <= 0) return null;
  const aimPoint = resolveClientHomingAimPoint({
    entity,
    position,
    velocity,
    projectileGravity,
    getEntity,
  });
  if (aimPoint === null) return null;

  if (engagementScale > 0) {
    const thrust = computeHomingThrust(
      velocity.x, velocity.y, velocity.z,
      aimPoint.x, aimPoint.y, aimPoint.z,
      position.x, position.y, position.z,
      (proj.homingTurnRate ?? 0) * engagementScale,
      maxThrustAccel * engagementScale,
      projectileGravity,
      dt,
    );
    _clientThrustResult.x = thrust.thrustX;
    _clientThrustResult.y = thrust.thrustY;
    _clientThrustResult.z = thrust.thrustZ + counterGravityCarry;
  } else {
    _clientThrustResult.x = 0;
    _clientThrustResult.y = 0;
    _clientThrustResult.z = counterGravityCarry;
  }
  return _clientThrustResult;
}

function applyClientMissileHomingVelocity(options: {
  entity: Entity;
  dt: number;
  timeAliveForHomingMs: number;
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  getEntity: (id: EntityId) => Entity | undefined;
}): boolean {
  const { entity, dt, timeAliveForHomingMs, position, velocity, getEntity } = options;
  const proj = entity.projectile;
  if (!proj || proj.homingTurnRate === undefined) return false;
  const shot = proj.config.shot as ProjectileShot;
  if (shot.type !== 'missile') return false;
  const engagementScale = getProjectileHomingEngagementScale(
    shot,
    timeAliveForHomingMs,
    dt * 1000,
  );
  if (engagementScale <= 0) return false;
  const aimPoint = resolveClientHomingAimPoint({
    entity,
    position,
    velocity,
    projectileGravity: GRAVITY * shot.gravityForceMultiplier,
    getEntity,
  });
  if (aimPoint === null) return false;
  const guided = computeConstantSpeedHomingVelocity(
    velocity.x, velocity.y, velocity.z,
    aimPoint.x, aimPoint.y, aimPoint.z,
    position.x, position.y, position.z,
    (proj.homingTurnRate ?? 0) * engagementScale,
    dt,
  );
  velocity.x = guided.velocityX;
  velocity.y = guided.velocityY;
  velocity.z = guided.velocityZ;
  return true;
}

function resolveProjectileNetAcceleration(options: {
  entity: Entity;
  dt: number;
  timeAliveForHomingMs: number;
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

  if (!isDGunWave && shot.type !== 'missile') {
    const thrust = resolveClientHomingThrust({
      entity,
      dt,
      timeAliveForHomingMs: options.timeAliveForHomingMs,
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

export type ClientProjectilePredictionItem = {
  entity: Entity;
  target: ServerTarget | undefined;
};

/** Advance every active travelling projectile's client visual prediction in
 *  one batched pass. All projectiles (and their optional rocket correction
 *  targets) are packed into the shared buffers and integrated with a SINGLE
 *  projectileIntegrateStepBatch call per frame, mirroring the batched unit
 *  prediction path — instead of one WASM boundary crossing per projectile.
 *  `out` is a caller-owned, reused result array (one entry per input item);
 *  it is grown/reused in place to avoid per-frame allocation. */
export function applyClientProjectileVisualPredictionBatch(options: {
  items: ClientProjectilePredictionItem[];
  predictionStep: PredictionStep;
  movPosBlend: number;
  movVelBlend: number;
  mapWidth: number;
  mapHeight: number;
  wind: PredictionWind | undefined;
  getEntity: (id: EntityId) => Entity | undefined;
  out: ClientProjectilePredictionResult[];
}): ClientProjectilePredictionResult[] {
  const {
    items,
    predictionStep,
    movPosBlend,
    movVelBlend,
    mapWidth,
    mapHeight,
    wind,
    getEntity,
    out,
  } = options;
  const count = items.length;
  out.length = count;
  if (count === 0) return out;

  const entityDeltaMs = predictionStep.entityDeltaMs;
  const dt = entityDeltaMs / 1000;
  const predictionWind = wind ?? STILL_AIR;
  _clientProjectilePredictionWind.x = Number.isFinite(predictionWind.x) ? predictionWind.x : 0;
  _clientProjectilePredictionWind.y = Number.isFinite(predictionWind.y) ? predictionWind.y : 0;
  _clientProjectilePredictionWind.z = Number.isFinite(predictionWind.z) ? predictionWind.z : 0;

  ensureClientProjectileBatchCapacity(count * 2);

  // Pass A — per-projectile steering + net acceleration, packed into the
  // shared integration buffers. Travelling projectiles dead-reckon every
  // frame; a rocket velocity update also installs a separate authoritative
  // correction target advanced with the same gravity / homing / terrain-
  // follow math (packed as a second slot) so the movement position +
  // velocity EMA channels can blend the rendered projectile toward it.
  // Reflection events still snap before reaching this path.
  let packed = 0;
  for (let i = 0; i < count; i++) {
    const item = items[i];
    const entity = item.entity;
    const result = ensureClientProjectileResult(out, i);
    const slot = ensureClientProjectileBatchSlot(i);
    slot.entity = entity;
    slot.hasTarget = false;
    slot.isHoming = false;
    slot.skip = true;

    const proj = entity.projectile;
    if (!proj) {
      result.becameLineProjectile = false;
      result.shouldDelete = true;
      result.targetSettled = true;
      continue;
    }
    if (isRayType(proj.projectileType)) {
      result.becameLineProjectile = true;
      result.shouldDelete = false;
      result.targetSettled = true;
      continue;
    }

    const timeAliveBeforeStep = proj.timeAlive;
    proj.timeAlive += entityDeltaMs;
    const shot = proj.config.shot as ProjectileShot;
    const airDragCoefficient = getProjectileAirDragCoefficient(shot);
    const invMass = shot.mass > 1e-6 ? 1 / shot.mass : 0;

    const position = getEntityPosition3d(entity, _clientProjectilePositionScratch);
    _clientProjectileVelocityScratch.x = proj.velocityX;
    _clientProjectileVelocityScratch.y = proj.velocityY;
    _clientProjectileVelocityScratch.z = proj.velocityZ;
    const missileSteered = applyClientMissileHomingVelocity({
      entity,
      dt,
      timeAliveForHomingMs: timeAliveBeforeStep,
      position,
      velocity: _clientProjectileVelocityScratch,
      getEntity,
    });
    const entityAccel = resolveProjectileNetAcceleration({
      entity,
      dt,
      timeAliveForHomingMs: timeAliveBeforeStep,
      position,
      velocity: _clientProjectileVelocityScratch,
      mapWidth,
      mapHeight,
      getEntity,
    }, _clientProjectileEntityAccel);
    if (missileSteered) entityAccel.isHoming = true;
    slot.isHoming = entityAccel.isHoming;

    const selfSlot = packed++;
    slot.selfSlot = selfSlot;
    _clientProjectilePosX[selfSlot] = position.x;
    _clientProjectilePosY[selfSlot] = position.y;
    _clientProjectilePosZ[selfSlot] = position.z;
    _clientProjectileVelX[selfSlot] = _clientProjectileVelocityScratch.x;
    _clientProjectileVelY[selfSlot] = _clientProjectileVelocityScratch.y;
    _clientProjectileVelZ[selfSlot] = _clientProjectileVelocityScratch.z;
    _clientProjectileAccelX[selfSlot] = entityAccel.x;
    _clientProjectileAccelY[selfSlot] = entityAccel.y;
    _clientProjectileAccelZ[selfSlot] = entityAccel.z;
    _clientProjectileAirDragCoefficient[selfSlot] = airDragCoefficient;
    _clientProjectileInvMass[selfSlot] = invMass;

    const target = item.target;
    if (target !== undefined) {
      _clientProjectileTargetPositionScratch.x = target.x;
      _clientProjectileTargetPositionScratch.y = target.y;
      _clientProjectileTargetPositionScratch.z = target.z;
      _clientProjectileTargetVelocityScratch.x = target.velocityX;
      _clientProjectileTargetVelocityScratch.y = target.velocityY;
      _clientProjectileTargetVelocityScratch.z = target.velocityZ;
      applyClientMissileHomingVelocity({
        entity,
        dt,
        timeAliveForHomingMs: timeAliveBeforeStep,
        position: _clientProjectileTargetPositionScratch,
        velocity: _clientProjectileTargetVelocityScratch,
        getEntity,
      });
      const targetAccel = resolveProjectileNetAcceleration({
        entity,
        dt,
        timeAliveForHomingMs: timeAliveBeforeStep,
        position: _clientProjectileTargetPositionScratch,
        velocity: _clientProjectileTargetVelocityScratch,
        mapWidth,
        mapHeight,
        getEntity,
      }, _clientProjectileTargetAccel);
      const targetSlot = packed++;
      slot.hasTarget = true;
      slot.targetSlot = targetSlot;
      _clientProjectilePosX[targetSlot] = target.x;
      _clientProjectilePosY[targetSlot] = target.y;
      _clientProjectilePosZ[targetSlot] = target.z;
      _clientProjectileVelX[targetSlot] = _clientProjectileTargetVelocityScratch.x;
      _clientProjectileVelY[targetSlot] = _clientProjectileTargetVelocityScratch.y;
      _clientProjectileVelZ[targetSlot] = _clientProjectileTargetVelocityScratch.z;
      _clientProjectileAccelX[targetSlot] = targetAccel.x;
      _clientProjectileAccelY[targetSlot] = targetAccel.y;
      _clientProjectileAccelZ[targetSlot] = targetAccel.z;
      _clientProjectileAirDragCoefficient[targetSlot] = airDragCoefficient;
      _clientProjectileInvMass[targetSlot] = invMass;
    }
    slot.skip = false;
  }

  if (packed === 0) return out;

  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('Client projectile prediction requires initialized sim-wasm');
  }
  const integrated = sim.projectileIntegrateStepBatch(
    packed,
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
  if (integrated !== packed) {
    throw new Error('Client projectile prediction integration failed');
  }

  // Pass B — unpack integrated state, apply the rocket correction-target
  // EMA drift, and decide each projectile's outcome.
  for (let i = 0; i < count; i++) {
    const slot = _clientProjectileBatchSlots[i];
    if (slot.skip) continue;
    const entity = slot.entity;
    const proj = entity.projectile;
    const result = out[i];
    if (!proj) {
      result.becameLineProjectile = false;
      result.shouldDelete = true;
      result.targetSettled = true;
      continue;
    }
    const s = slot.selfSlot;
    entity.transform.x = _clientProjectilePosX[s];
    entity.transform.y = _clientProjectilePosY[s];
    entity.transform.z = _clientProjectilePosZ[s];
    proj.velocityX = _clientProjectileVelX[s];
    proj.velocityY = _clientProjectileVelY[s];
    proj.velocityZ = _clientProjectileVelZ[s];

    const target = items[i].target;
    const hasTarget = slot.hasTarget && target !== undefined;
    if (hasTarget) {
      const t = slot.targetSlot;
      target.x = _clientProjectilePosX[t];
      target.y = _clientProjectilePosY[t];
      target.z = _clientProjectilePosZ[t];
      target.velocityX = _clientProjectileVelX[t];
      target.velocityY = _clientProjectileVelY[t];
      target.velocityZ = _clientProjectileVelZ[t];
      target.rotation = Math.atan2(target.velocityY, target.velocityX);
    }

    if (slot.isHoming) {
      entity.transform.rotation = Math.atan2(proj.velocityY, proj.velocityX);
    }
    const targetSettled = hasTarget
      ? applyProjectileTargetDrift(entity, target, movPosBlend, movVelBlend)
      : true;

    const groundPosition = getEntityPosition3d(entity, _clientProjectilePositionScratch);
    const groundZ = getSurfaceHeight(groundPosition.x, groundPosition.y, mapWidth, mapHeight, LAND_CELL_SIZE);
    if (groundPosition.z <= groundZ && proj.velocityZ <= 0) {
      entity.transform.z = groundZ;
      result.becameLineProjectile = false;
      result.shouldDelete = true;
      result.targetSettled = targetSettled;
      continue;
    }
    // Auto-remove if this projectile has a finite runtime timeout.
    if (Number.isFinite(proj.maxLifespan) && proj.timeAlive > proj.maxLifespan) {
      result.becameLineProjectile = false;
      result.shouldDelete = true;
      result.targetSettled = targetSettled;
      continue;
    }
    result.becameLineProjectile = false;
    result.shouldDelete = false;
    result.targetSettled = targetSettled;
  }
  return out;
}
