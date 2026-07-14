import type { Entity } from '../sim/types';
import { angleDeltaAbs, lerp, lerpAngle, normalizeAngle } from '../math';
import type { ServerTarget } from './ClientPredictionTargets';

export type ClientProjectileMotionResult = {
  targetSettled: boolean;
};

export type ClientProjectileMotionItem = {
  entity: Entity;
  target: ServerTarget | undefined;
};

const POSITION_EPSILON_SQ = 0.01 * 0.01;
const VELOCITY_EPSILON_SQ = 0.01 * 0.01;
const ROTATION_EPSILON = 0.0001;
const ANGULAR_VELOCITY_EPSILON = 0.0001;

function ensureResult(
  out: ClientProjectileMotionResult[],
  index: number,
): ClientProjectileMotionResult {
  let result = out[index];
  if (result === undefined) {
    result = { targetSettled: true };
    out[index] = result;
  }
  return result;
}

/**
 * Applies the four CLIENT presentation EMA channels to authoritative
 * projectile motion. This function intentionally performs no integration,
 * guidance, collision, lifetime, terrain, or target prediction.
 */
export function applyClientProjectileMotionBatch(options: {
  items: ClientProjectileMotionItem[];
  movPosBlend: number;
  movVelBlend: number;
  rotPosBlend: number;
  rotVelBlend: number;
  out: ClientProjectileMotionResult[];
}): ClientProjectileMotionResult[] {
  const {
    items,
    movPosBlend,
    movVelBlend,
    rotPosBlend,
    rotVelBlend,
    out,
  } = options;
  out.length = items.length;

  for (let i = 0; i < items.length; i++) {
    const { entity, target } = items[i];
    const result = ensureResult(out, i);
    const projectile = entity.projectile;
    result.targetSettled = target === undefined;
    if (projectile === null || target === undefined || projectile.projectileType !== 'projectile') continue;

    if (movPosBlend >= 0) {
      entity.transform.x = lerp(entity.transform.x, target.x, movPosBlend);
      entity.transform.y = lerp(entity.transform.y, target.y, movPosBlend);
      entity.transform.z = lerp(entity.transform.z, target.z, movPosBlend);
    }
    if (movVelBlend >= 1) {
      projectile.velocityX = target.velocityX;
      projectile.velocityY = target.velocityY;
      projectile.velocityZ = target.velocityZ;
    } else if (movVelBlend >= 0) {
      projectile.velocityX = lerp(projectile.velocityX, target.velocityX, movVelBlend);
      projectile.velocityY = lerp(projectile.velocityY, target.velocityY, movVelBlend);
      projectile.velocityZ = lerp(projectile.velocityZ, target.velocityZ, movVelBlend);
    }
    if (rotPosBlend >= 0) {
      entity.transform.rotation = normalizeAngle(lerpAngle(
        entity.transform.rotation,
        target.rotation,
        rotPosBlend,
      ));
    }
    const targetAngularVelocity = target.angularVelocityZ ?? 0;
    if (rotVelBlend >= 1) {
      projectile.angularVelocity = targetAngularVelocity;
    } else if (rotVelBlend >= 0) {
      projectile.angularVelocity = lerp(
        projectile.angularVelocity,
        targetAngularVelocity,
        rotVelBlend,
      );
    }

    const dx = entity.transform.x - target.x;
    const dy = entity.transform.y - target.y;
    const dz = entity.transform.z - target.z;
    const dvx = projectile.velocityX - target.velocityX;
    const dvy = projectile.velocityY - target.velocityY;
    const dvz = projectile.velocityZ - target.velocityZ;
    result.targetSettled =
      (movPosBlend < 0 || dx * dx + dy * dy + dz * dz <= POSITION_EPSILON_SQ) &&
      (movVelBlend < 0 || dvx * dvx + dvy * dvy + dvz * dvz <= VELOCITY_EPSILON_SQ) &&
      (rotPosBlend < 0 || angleDeltaAbs(entity.transform.rotation, target.rotation) <= ROTATION_EPSILON) &&
      (rotVelBlend < 0 || Math.abs(projectile.angularVelocity - targetAngularVelocity) <= ANGULAR_VELOCITY_EPSILON);
  }

  return out;
}
