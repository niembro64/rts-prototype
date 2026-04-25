// Combat utility functions

import type { Entity } from '../types';
import { distance, normalizeAngle, magnitude, getWeaponWorldPosition } from '../../math';
import { getMuzzleHeightAboveGround } from '../../math/BodyDimensions';
import { getUnitBlueprint } from '../blueprints';
import { MIRROR_EXTRA_HEIGHT } from '../../../config';

// Re-export common math functions for backward compatibility
export { distance, normalizeAngle };

// Get target radius for range calculations
export function getTargetRadius(target: Entity): number {
  if (target.unit) {
    return target.unit.unitRadiusCollider.shot;
  } else if (target.building) {
    const bWidth = target.building.width;
    const bHeight = target.building.height;
    return magnitude(bWidth, bHeight) / 2;
  }
  return 0;
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

// Muzzle altitude above the unit's ground footprint at pitch=0, derived
// from the unit blueprint's render body. Must use the SAME radius the
// 3D renderer uses to size the body mesh (`unitRadiusCollider.scale`)
// — any divergence puts the sim's spawn altitude above or below the
// visible barrel. Falls back to the arachnid body for any unit whose
// blueprint lookup throws.
export function getUnitMuzzleHeight(unit: Entity): number {
  if (!unit.unit) return 0;
  const unitRadius = unit.unit.unitRadiusCollider.scale;
  let renderer = 'arachnid';
  try { renderer = getUnitBlueprint(unit.unit.unitType).renderer ?? 'arachnid'; }
  catch { /* keep fallback */ }
  return getMuzzleHeightAboveGround(renderer, unitRadius);
}

// Per-turret mount height. On mirror-host units (e.g. Loris) the
// projectile turret sits on top of the mirror stack: turret index 0 is
// the mirror host, higher indices get lifted by MIRROR_EXTRA_HEIGHT so
// their barrels clear the reflector panels.
export function getTurretMountHeight(unit: Entity, turretIndex: number): number {
  const base = getUnitMuzzleHeight(unit);
  const hasMirrors = (unit.unit?.mirrorPanels?.length ?? 0) > 0;
  if (hasMirrors && turretIndex > 0) return base + MIRROR_EXTRA_HEIGHT;
  return base;
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
