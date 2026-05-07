import type { Entity, EntityId, PlayerId } from '../sim/types';
import { isLineShotType } from '@/types/sim';
import { GRAVITY, DGUN_TERRAIN_FOLLOW_HEIGHT, LAND_CELL_SIZE } from '../../config';
import { getSurfaceHeight } from '../sim/Terrain';
import { getEntityVelocity3 } from '../sim/combat/combatUtils';
import { resolveTargetAimPoint } from '../sim/combat/aimSolver';
import {
  applyHomingSteering,
  computeInterceptTime,
  lerp,
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

  // Homing steering — 3D velocity rotation toward the target,
  // identical math to the server's projectileSystem call so
  // predicted and authoritative paths agree frame-for-frame.
  // Rocket-class shots (ignoresGravity=true) also re-acquire
  // the nearest enemy when their original target dies.
  if (proj.homingTargetId !== undefined) {
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
      const aimPoint = resolveTargetAimPoint(
        homingTarget,
        entity.transform.x, entity.transform.y, entity.transform.z,
        _clientHomingAimPoint,
      );
      let steerX = aimPoint.x;
      let steerY = aimPoint.y;
      let steerZ = aimPoint.z;
      const targetVelocity = getEntityVelocity3(homingTarget, _clientHomingTargetVelocity);
      const targetSpeedSq =
        targetVelocity.x * targetVelocity.x +
        targetVelocity.y * targetVelocity.y +
        targetVelocity.z * targetVelocity.z;
      const projectileSpeed = Math.hypot(proj.velocityX, proj.velocityY, proj.velocityZ);
      if (targetSpeedSq > 1e-6 && projectileSpeed > 1e-6) {
        const tLead = computeInterceptTime(
          steerX - entity.transform.x,
          steerY - entity.transform.y,
          steerZ - entity.transform.z,
          targetVelocity.x, targetVelocity.y, targetVelocity.z,
          projectileSpeed,
        );
        if (tLead > 0) {
          const remainingSec = Number.isFinite(proj.maxLifespan)
            ? Math.max(0, (proj.maxLifespan - proj.timeAlive) / 1000)
            : tLead;
          const leadT = remainingSec > 0 ? Math.min(tLead, remainingSec) : tLead;
          steerX += targetVelocity.x * leadT;
          steerY += targetVelocity.y * leadT;
          steerZ += targetVelocity.z * leadT;
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

  // Drift projectile position + velocity toward server target
  // (smooth correction). Server velocity updates are sparse, so gravity
  // is also applied to the target path between corrections.
  const terrainFollow = entity.dgunProjectile?.terrainFollow === true;
  const groundOffset = entity.dgunProjectile?.groundOffset ?? DGUN_TERRAIN_FOLLOW_HEIGHT;
  if (target) {
    const targetIgnoresGravity =
      proj.config.shotProfile.runtime.ignoresGravity;
    if (!targetIgnoresGravity && !terrainFollow) {
      target.velocityZ -= GRAVITY * targetDt;
    }
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
  if (!ignoresGravity && !terrainFollow) {
    proj.velocityZ -= GRAVITY * dt;
  }
  entity.transform.x += proj.velocityX * dt;
  entity.transform.y += proj.velocityY * dt;
  if (terrainFollow) {
    const nextZ = getSurfaceHeight(entity.transform.x, entity.transform.y, mapWidth, mapHeight, LAND_CELL_SIZE) + groundOffset;
    proj.velocityZ = dt > 0 ? (nextZ - prevTerrainFollowZ) / dt : 0;
    entity.transform.z = nextZ;
  } else {
    entity.transform.z += proj.velocityZ * dt;
  }

  const groundZ = getSurfaceHeight(entity.transform.x, entity.transform.y, mapWidth, mapHeight, LAND_CELL_SIZE);
  if (!terrainFollow && entity.transform.z <= groundZ && proj.velocityZ <= 0) {
    entity.transform.z = groundZ;
    return { becameLineProjectile: false, shouldDelete: true };
  }

  // Auto-remove if projectile has exceeded its lifespan.
  proj.timeAlive += entityDeltaMs;
  if (proj.timeAlive > (proj.maxLifespan ?? 10000)) {
    return { becameLineProjectile: false, shouldDelete: true };
  }

  return { becameLineProjectile: false, shouldDelete: false };
}
