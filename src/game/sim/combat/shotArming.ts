import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
import type { Entity } from '../types';
import { getBuildingConfig } from '../buildConfigs';
import { deriveShotArmingRadius } from '../shotArmingRadius';

type ProjectileArmingState = {
  projectileType: string;
  isArmed: boolean;
  shotArmingRadius: number;
  collisionStartX: number | null;
  collisionStartY: number | null;
  collisionStartZ: number | null;
};

export function sanitizeShotArmingRadius(radius: number | null | undefined): number {
  return radius !== null && radius !== undefined && Number.isFinite(radius)
    ? Math.max(0, radius)
    : 0;
}

/** Authored host-centered safety sphere copied into every physical shot at launch. */
export function getHostShotArmingRadius(host: Entity): number {
  if (host.unit !== null) {
    return sanitizeShotArmingRadius(
      host.unit.radius.shotArmingRadius ?? deriveShotArmingRadius(host.unit.radius.collision),
    );
  }
  const buildingBlueprintId = host.buildingBlueprintId;
  if (buildingBlueprintId !== undefined && buildingBlueprintId !== null) {
    const radius = getBuildingConfig(buildingBlueprintId).radius;
    return sanitizeShotArmingRadius(
      radius.shotArmingRadius ?? deriveShotArmingRadius(radius.collision),
    );
  }
  return 0;
}

/**
 * Center-distance at which a projectile becomes collision-active. The authored
 * ARM sphere describes the host safety volume; adding the projectile hitbox
 * radius makes activation wait until the whole shot has cleared that volume.
 */
export function getShotArmingClearanceRadius(
  hostArmingRadius: number,
  projectileHitboxRadius: number,
): number {
  return sanitizeShotArmingRadius(hostArmingRadius) +
    sanitizeShotArmingRadius(projectileHitboxRadius);
}

/**
 * Arms a physical shot at the exact swept-segment crossing of its host's ARM
 * sphere. The crossing becomes collisionStart, so no inactive segment can be
 * replayed as a hit after activation.
 */
export function updateProjectileArming(
  projectile: ProjectileArmingState,
  host: Entity | undefined,
  previousX: number,
  previousY: number,
  previousZ: number,
  currentX: number,
  currentY: number,
  currentZ: number,
  projectileHitboxRadius = 0,
): boolean {
  if (projectile.projectileType !== 'projectile') return true;
  if (projectile.isArmed) return true;

  const armingRadius = sanitizeShotArmingRadius(projectile.shotArmingRadius);
  if (armingRadius <= 0 || host === undefined) {
    projectile.isArmed = true;
    projectile.collisionStartX = host === undefined ? currentX : previousX;
    projectile.collisionStartY = host === undefined ? currentY : previousY;
    projectile.collisionStartZ = host === undefined ? currentZ : previousZ;
    return true;
  }

  const prevDx = previousX - host.transform.x;
  const prevDy = previousY - host.transform.y;
  const prevDz = previousZ - host.transform.z;
  const currDx = currentX - host.transform.x;
  const currDy = currentY - host.transform.y;
  const currDz = currentZ - host.transform.z;
  const clearanceRadius = getShotArmingClearanceRadius(
    armingRadius,
    projectileHitboxRadius,
  );
  const radiusSq = clearanceRadius * clearanceRadius;
  const prevDistSq = prevDx * prevDx + prevDy * prevDy + prevDz * prevDz;
  const currDistSq = currDx * currDx + currDy * currDy + currDz * currDz;
  if (currDistSq <= radiusSq) return false;

  let t = 0;
  if (prevDistSq < radiusSq) {
    const segDx = currentX - previousX;
    const segDy = currentY - previousY;
    const segDz = currentZ - previousZ;
    const a = segDx * segDx + segDy * segDy + segDz * segDz;
    const b = 2 * (prevDx * segDx + prevDy * segDy + prevDz * segDz);
    const c = prevDistSq - radiusSq;
    const disc = b * b - 4 * a * c;
    t = a > 1e-12 && disc >= 0
      ? (-b + DMath.sqrt(disc)) / (2 * a)
      : 1;
  }
  const clampedT = Math.max(0, Math.min(1, t));
  projectile.isArmed = true;
  projectile.collisionStartX = previousX + clampedT * (currentX - previousX);
  projectile.collisionStartY = previousY + clampedT * (currentY - previousY);
  projectile.collisionStartZ = previousZ + clampedT * (currentZ - previousZ);
  return true;
}
