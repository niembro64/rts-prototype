// Combat utility functions

import type { Entity, WeaponConfig } from '../types';
import { distance, normalizeAngle, magnitude } from '../../math';

// Re-export common math functions for backward compatibility
export { distance, normalizeAngle };

// Get target radius for range calculations
export function getTargetRadius(target: Entity): number {
  if (target.unit) {
    return target.unit.physicsRadius;
  } else if (target.building) {
    const bWidth = target.building.width;
    const bHeight = target.building.height;
    return magnitude(bWidth, bHeight) / 2;
  }
  return 0;
}

// Get barrel tip offset in pixels from weapon mount point.
// Uses the weapon's turret barrel length scaled by the unit's visual radius.
export function getBarrelTipOffset(config: WeaponConfig, unitRadius: number): number {
  const turret = config.turretShape;
  if (!turret || turret.type === 'forceField') return unitRadius;
  return unitRadius * turret.barrelLength;
}

// Get angle to face based on movement (or body direction if stationary)
// Used by weapons when they have no target - they face movement direction
export function getMovementAngle(unit: Entity): number {
  if (!unit.unit) return unit.transform.rotation;

  const velX = unit.unit.velocityX ?? 0;
  const velY = unit.unit.velocityY ?? 0;
  const speed = magnitude(velX, velY);

  if (speed > 1) {
    // Moving - face movement direction
    return Math.atan2(velY, velX);
  }

  // Stationary - use body direction (weapons maintain their own rotation)
  return unit.transform.rotation;
}
