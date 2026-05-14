import type { Entity, EntityId, PlayerId } from '../sim/types';
import { isLineShotType } from '@/types/sim';
import { GRAVITY, DGUN_TERRAIN_FOLLOW_HEIGHT, LAND_CELL_SIZE } from '../../config';
import { getPredictionMode } from '@/clientBarConfig';
import { getSurfaceHeight } from '../sim/Terrain';
import { getEntityAcceleration3, getEntityVelocity3 } from '../sim/combat/combatUtils';
import { resolveTargetAimPoint } from '../sim/combat/aimSolver';
import {
  applyHomingSteering,
  lerp,
  magnitude3,
  solveKinematicIntercept,
  type KinematicInterceptSolution,
  type KinematicState3,
  type KinematicVec3,
} from '../math';
import { halfLifeBlend, type DriftPreset } from './driftEma';
import type { PredictionStep } from './ClientPredictionLod';

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
const _clientHomingProjectileAcceleration: KinematicVec3 = { x: 0, y: 0, z: 0 };
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

function applyClientProjectileHoming(options: {
  entity: Entity;
  dt: number;
  mapWidth: number;
  mapHeight: number;
  getEntity: (id: EntityId) => Entity | undefined;
  findNearestEnemyForRocket: (projectile: Entity, ownerId: PlayerId) => Entity | null;
}): void {
  const {
    entity,
    dt,
    mapWidth,
    mapHeight,
    getEntity,
    findNearestEnemyForRocket,
  } = options;
  const proj = entity.projectile;
  if (!proj || proj.homingTargetId === undefined) return;

  // Homing steering runs after local gravity/movement integration, matching
  // the authoritative projectileSystem step order.
  let homingTarget = getEntity(proj.homingTargetId);
  let targetValid = !!(homingTarget && ((homingTarget.unit && homingTarget.unit.hp > 0) || (homingTarget.building && homingTarget.building.hp > 0)));
  if (!targetValid) {
    const isRocket = proj.config.shotProfile.runtime.isRocketLike;
    if (isRocket && entity.ownership) {
      homingTarget = findNearestEnemyForRocket(entity, entity.ownership.playerId) ?? undefined;
      if (homingTarget) {
        proj.homingTargetId = homingTarget.id;
        targetValid = true;
      } else {
        proj.homingTargetId = undefined;
      }
    } else {
      proj.homingTargetId = undefined;
    }
  }
  if (targetValid && homingTarget) {
    // PREDICT mode gates how much physics the homing intercept solver
    // gets to use. POS skips homing steering entirely — the projectile
    // flies ballistically until the next snapshot corrects it. VEL
    // keeps steering but feeds zero acceleration into the solver
    // (target accel and projectile gravity), so the intercept assumes
    // constant velocities. ACC is the full kinematic intercept.
    const predictionMode = getPredictionMode();
    if (predictionMode === 'pos') {
      return;
    }
    const useAccel = predictionMode === 'acc';
    const aimPoint = resolveTargetAimPoint(
      homingTarget,
      entity.transform.x, entity.transform.y, entity.transform.z,
      _clientHomingAimPoint,
    );
    let steerX = aimPoint.x;
    let steerY = aimPoint.y;
    let steerZ = aimPoint.z;
    const targetVelocity = getEntityVelocity3(homingTarget, _clientHomingTargetVelocity);
    const targetAcceleration = useAccel
      ? getEntityAcceleration3(
          homingTarget,
          _clientHomingTargetAcceleration,
          (x, y) => getSurfaceHeight(x, y, mapWidth, mapHeight, LAND_CELL_SIZE),
        )
      : (
          _clientHomingTargetAcceleration.x = 0,
          _clientHomingTargetAcceleration.y = 0,
          _clientHomingTargetAcceleration.z = 0,
          _clientHomingTargetAcceleration
        );
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
      _clientHomingOriginState.position.x = entity.transform.x;
      _clientHomingOriginState.position.y = entity.transform.y;
      _clientHomingOriginState.position.z = entity.transform.z;
      _clientHomingOriginState.velocity.x = 0;
      _clientHomingOriginState.velocity.y = 0;
      _clientHomingOriginState.velocity.z = 0;
      _clientHomingOriginState.acceleration.x = 0;
      _clientHomingOriginState.acceleration.y = 0;
      _clientHomingOriginState.acceleration.z = 0;
      _clientHomingTargetState.position.x = steerX;
      _clientHomingTargetState.position.y = steerY;
      _clientHomingTargetState.position.z = steerZ;
      _clientHomingTargetState.velocity.x = targetVelocity.x;
      _clientHomingTargetState.velocity.y = targetVelocity.y;
      _clientHomingTargetState.velocity.z = targetVelocity.z;
      _clientHomingTargetState.acceleration.x = targetAcceleration.x;
      _clientHomingTargetState.acceleration.y = targetAcceleration.y;
      _clientHomingTargetState.acceleration.z = targetAcceleration.z;
      _clientHomingProjectileAcceleration.x = 0;
      _clientHomingProjectileAcceleration.y = 0;
      _clientHomingProjectileAcceleration.z =
        useAccel && !proj.config.shotProfile.runtime.ignoresGravity
          ? -GRAVITY
          : 0;
      const remainingSec = Number.isFinite(proj.maxLifespan)
        ? Math.max(0, (proj.maxLifespan - proj.timeAlive) / 1000)
        : undefined;
      const intercept = solveKinematicIntercept({
        origin: _clientHomingOriginState,
        target: _clientHomingTargetState,
        projectileSpeed,
        projectileAcceleration: _clientHomingProjectileAcceleration,
        maxTimeSec: remainingSec,
      }, _clientHomingIntercept);
      if (intercept) {
        steerX = intercept.aimPoint.x;
        steerY = intercept.aimPoint.y;
        steerZ = intercept.aimPoint.z;
      }
    }
    const steered = applyHomingSteering(
      proj.velocityX, proj.velocityY, proj.velocityZ,
      steerX, steerY, steerZ,
      entity.transform.x, entity.transform.y, entity.transform.z,
      proj.homingTurnRate ?? 0, dt,
    );
    proj.velocityX = steered.velocityX;
    proj.velocityY = steered.velocityY;
    proj.velocityZ = steered.velocityZ;
    entity.transform.rotation = steered.rotation;
  }
}

export function applyClientProjectilePrediction(options: {
  entity: Entity;
  target: ProjectilePredictionTarget | undefined;
  predictionStep: PredictionStep;
  preset: DriftPreset;
  mapWidth: number;
  mapHeight: number;
  getEntity: (id: EntityId) => Entity | undefined;
  findNearestEnemyForRocket: (projectile: Entity, ownerId: PlayerId) => Entity | null;
}): ClientProjectilePredictionResult {
  const {
    entity,
    target,
    predictionStep,
    preset,
    mapWidth,
    mapHeight,
    getEntity,
    findNearestEnemyForRocket,
  } = options;
  const proj = entity.projectile;
  if (!proj) return { becameLineProjectile: false, shouldDelete: true };
  if (isLineShotType(proj.projectileType)) {
    return { becameLineProjectile: true, shouldDelete: false };
  }

  const entityDeltaMs = predictionStep.entityDeltaMs;
  const dt = entityDeltaMs / 1000;
  const targetDt = predictionStep.targetDeltaMs / 1000;
  const movPosDrift = halfLifeBlend(dt, preset.movement.pos);
  const movVelDrift = halfLifeBlend(dt, preset.movement.vel);
  proj.timeAlive += entityDeltaMs;

  // PREDICT mode gates how the client extrapolates between snapshots.
  // 'pos' freezes both the snapshot target and the locally rendered
  // projectile in place between snaps (the lerp drift below still
  // pulls render → target each frame). 'vel' integrates position from
  // velocity each frame but does NOT apply gravity to the velocity.
  // 'acc' is the full ballistic chain (default).
  const predictionMode = getPredictionMode();
  const integratePosition = predictionMode !== 'pos';
  const integrateAcceleration = predictionMode === 'acc';

  // Drift projectile position + velocity toward server target
  // (smooth correction). Server velocity updates are sparse, so gravity
  // is also applied to the target path between corrections.
  const terrainFollow = entity.dgunProjectile?.terrainFollow === true;
  const groundOffset = entity.dgunProjectile?.groundOffset ?? DGUN_TERRAIN_FOLLOW_HEIGHT;
  if (target) {
    const targetIgnoresGravity =
      proj.config.shotProfile.runtime.ignoresGravity;
    if (integrateAcceleration && !targetIgnoresGravity && !terrainFollow) {
      target.velocityZ -= GRAVITY * targetDt;
    }
    if (integratePosition) {
      const targetPrevZ = target.z;
      target.x += target.velocityX * targetDt;
      target.y += target.velocityY * targetDt;
      if (terrainFollow) {
        const nextZ = getSurfaceHeight(target.x, target.y, mapWidth, mapHeight, LAND_CELL_SIZE) + groundOffset;
        target.velocityZ = targetDt > 0 ? (nextZ - targetPrevZ) / targetDt : 0;
        target.z = nextZ;
      } else {
        target.z += target.velocityZ * targetDt;
      }
    }
    entity.transform.x = lerp(entity.transform.x, target.x, movPosDrift);
    entity.transform.y = lerp(entity.transform.y, target.y, movPosDrift);
    entity.transform.z = lerp(entity.transform.z, target.z, movPosDrift);
    proj.velocityX = lerp(proj.velocityX, target.velocityX, movVelDrift);
    proj.velocityY = lerp(proj.velocityY, target.velocityY, movVelDrift);
    proj.velocityZ = lerp(proj.velocityZ, target.velocityZ, movVelDrift);
    entity.transform.rotation = Math.atan2(proj.velocityY, proj.velocityX);
  }

  // Traveling projectiles: dead-reckon using (possibly steered)
  // velocity in full 3D. Ballistic projectiles take gravity; rockets
  // travel on pure thrust and are bent only by homing.
  const ignoresGravity =
    proj.config.shotProfile.runtime.ignoresGravity;
  const prevTerrainFollowZ = entity.transform.z;
  if (integrateAcceleration && !ignoresGravity && !terrainFollow) {
    proj.velocityZ -= GRAVITY * dt;
  }
  if (integratePosition) {
    entity.transform.x += proj.velocityX * dt;
    entity.transform.y += proj.velocityY * dt;
    if (terrainFollow) {
      const nextZ = getSurfaceHeight(entity.transform.x, entity.transform.y, mapWidth, mapHeight, LAND_CELL_SIZE) + groundOffset;
      proj.velocityZ = dt > 0 ? (nextZ - prevTerrainFollowZ) / dt : 0;
      entity.transform.z = nextZ;
    } else {
      entity.transform.z += proj.velocityZ * dt;
    }
  }

  applyClientProjectileHoming({
    entity,
    dt,
    mapWidth,
    mapHeight,
    getEntity,
    findNearestEnemyForRocket,
  });

  const groundZ = getSurfaceHeight(entity.transform.x, entity.transform.y, mapWidth, mapHeight, LAND_CELL_SIZE);
  if (!terrainFollow && entity.transform.z <= groundZ && proj.velocityZ <= 0) {
    entity.transform.z = groundZ;
    return { becameLineProjectile: false, shouldDelete: true };
  }

  // Auto-remove if projectile has exceeded its lifespan.
  if (proj.timeAlive > (proj.maxLifespan ?? 10000)) {
    return { becameLineProjectile: false, shouldDelete: true };
  }

  return { becameLineProjectile: false, shouldDelete: false };
}
