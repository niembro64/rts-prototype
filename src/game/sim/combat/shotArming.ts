import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
import type { Entity } from '../types';
import {
  createEntityVolume,
  type EntityVolume,
  writeArmingVolume,
} from '../entityVolumes';

type ProjectileArmingState = {
  projectileType: string;
  isArmed: boolean;
  collisionStartX: number | null;
  collisionStartY: number | null;
  collisionStartZ: number | null;
};

const _hostArmingVolume = createEntityVolume();

function finiteRadius(radius: number): number {
  return Number.isFinite(radius) ? Math.max(0, radius) : 0;
}

/** True while any part of the projectile's spherical HIT volume overlaps ARM. */
export function projectileOverlapsArmingVolume(
  volume: EntityVolume,
  x: number,
  y: number,
  z: number,
  projectileHitboxRadius: number,
): boolean {
  const radius = finiteRadius(projectileHitboxRadius);
  const dx = x - volume.x;
  const dy = y - volume.y;
  const dz = z - volume.z;

  switch (volume.shape) {
    case 'sphere': {
      const clearance = volume.halfX + radius;
      return dx * dx + dy * dy + dz * dz <= clearance * clearance;
    }
    case 'box': {
      const outsideX = Math.max(Math.abs(dx) - volume.halfX, 0);
      const outsideY = Math.max(Math.abs(dy) - volume.halfY, 0);
      const outsideZ = Math.max(Math.abs(dz) - volume.halfZ, 0);
      return outsideX * outsideX + outsideY * outsideY + outsideZ * outsideZ <= radius * radius;
    }
    case 'cylinder': {
      const radialOutside = Math.max(DMath.hypot(dx, dy) - volume.halfX, 0);
      const verticalOutside = Math.max(Math.abs(dz) - volume.halfZ, 0);
      return radialOutside * radialOutside + verticalOutside * verticalOutside <= radius * radius;
    }
    case 'annulus': {
      const radialDistance = DMath.hypot(dx, dy);
      const radialOutside = radialDistance < volume.innerRadius
        ? volume.innerRadius - radialDistance
        : Math.max(radialDistance - volume.halfX, 0);
      const verticalOutside = Math.max(Math.abs(dz) - volume.halfZ, 0);
      return radialOutside * radialOutside + verticalOutside * verticalOutside <= radius * radius;
    }
  }
}

function crossingFraction(
  volume: EntityVolume,
  previousX: number,
  previousY: number,
  previousZ: number,
  currentX: number,
  currentY: number,
  currentZ: number,
  projectileHitboxRadius: number,
): number {
  if (!projectileOverlapsArmingVolume(
    volume,
    previousX,
    previousY,
    previousZ,
    projectileHitboxRadius,
  )) {
    return 0;
  }

  // The overlap distance for boxes/cylinders/annuli is piecewise quadratic.
  // A fixed-count bisection is deterministic and runs only once in a shot's
  // life, at its transition from inert to active.
  let insideT = 0;
  let outsideT = 1;
  for (let i = 0; i < 48; i++) {
    const t = (insideT + outsideT) * 0.5;
    const x = previousX + t * (currentX - previousX);
    const y = previousY + t * (currentY - previousY);
    const z = previousZ + t * (currentZ - previousZ);
    if (projectileOverlapsArmingVolume(volume, x, y, z, projectileHitboxRadius)) {
      insideT = t;
    } else {
      outsideT = t;
    }
  }
  return outsideT;
}

/**
 * Arms a physical shot at the swept-segment crossing of its host's ARM
 * volume. The crossing becomes collisionStart, so no inactive segment can be
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

  if (host === undefined || !writeArmingVolume(host, _hostArmingVolume)) {
    projectile.isArmed = true;
    projectile.collisionStartX = host === undefined ? currentX : previousX;
    projectile.collisionStartY = host === undefined ? currentY : previousY;
    projectile.collisionStartZ = host === undefined ? currentZ : previousZ;
    return true;
  }

  if (projectileOverlapsArmingVolume(
    _hostArmingVolume,
    currentX,
    currentY,
    currentZ,
    projectileHitboxRadius,
  )) return false;

  const t = crossingFraction(
    _hostArmingVolume,
    previousX,
    previousY,
    previousZ,
    currentX,
    currentY,
    currentZ,
    projectileHitboxRadius,
  );
  const clampedT = Math.max(0, Math.min(1, t));
  projectile.isArmed = true;
  projectile.collisionStartX = previousX + clampedT * (currentX - previousX);
  projectile.collisionStartY = previousY + clampedT * (currentY - previousY);
  projectile.collisionStartZ = previousZ + clampedT * (currentZ - previousZ);
  return true;
}
