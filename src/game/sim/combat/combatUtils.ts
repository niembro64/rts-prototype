// Combat utility functions

import type { Entity, TurretConfig } from '../types';
import { distance, normalizeAngle, magnitude, getWeaponWorldPosition } from '../../math';

// Re-export common math functions for backward compatibility
export { distance, normalizeAngle };

// Get target radius for range calculations
export function getTargetRadius(target: Entity): number {
  if (target.unit) {
    return target.unit.radiusColliderUnitShot;
  } else if (target.building) {
    const bWidth = target.building.width;
    const bHeight = target.building.height;
    return magnitude(bWidth, bHeight) / 2;
  }
  return 0;
}

// Get barrel tip offset in pixels from weapon mount point.
// Uses the weapon's turret barrel length scaled by the unit's visual radius.
export function getBarrelTipOffset(config: TurretConfig, unitRadius: number): number {
  const turret = config.barrel;
  if (!turret || turret.type === 'complexSingleEmitter') return unitRadius;
  return unitRadius * turret.barrelLength;
}

// Resolve turret world position, using cached values if available
const _rwpOut = { x: 0, y: 0 };
export function resolveWeaponWorldPos(
  turret: { worldPos?: { x: number; y: number }; offset: { x: number; y: number } },
  entityX: number, entityY: number, cos: number, sin: number,
): { x: number; y: number } {
  if (turret.worldPos) {
    _rwpOut.x = turret.worldPos.x;
    _rwpOut.y = turret.worldPos.y;
    return _rwpOut;
  }
  return getWeaponWorldPosition(entityX, entityY, cos, sin, turret.offset.x, turret.offset.y);
}

// Get barrel tip world position from weapon mount point, firing angle, and config
const _btOut = { x: 0, y: 0 };
export function getBarrelTipWorldPos(
  weaponX: number, weaponY: number,
  firingAngle: number, config: TurretConfig, unitRadiusColliderShot: number,
): { x: number; y: number } {
  const offset = getBarrelTipOffset(config, unitRadiusColliderShot);
  _btOut.x = weaponX + Math.cos(firingAngle) * offset;
  _btOut.y = weaponY + Math.sin(firingAngle) * offset;
  return _btOut;
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
