// Combat utility functions

import type { Entity } from '../types';
import { distance, normalizeAngle, magnitude, getWeaponWorldPosition, getTurretHeadRadius } from '../../math';
import { getBodyTopY, getChassisLiftY } from '../../math/BodyDimensions';
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

/** Per-turret mount height — distance above the unit's ground
 *  footprint at which the barrel pivots (and shots spawn) at pitch=0.
 *
 *  Vertical layout for an ordinary turret:
 *
 *    chassis lift + bodyTopY              ← head sphere bottom
 *    chassis lift + bodyTopY + headRadius ← head sphere center  ← muzzle
 *    chassis lift + bodyTopY + 2 × headRadius ← head sphere top
 *
 *  Each turret's `bodyRadius` field drives `headRadius`; the renderer
 *  uses the SAME number to anchor the visible head sphere, so spawn
 *  altitude and visible barrel tip stay locked together at every
 *  turret size.
 *
 *  On mirror-host units (e.g. Loris) the non-mirror turret sits ON TOP
 *  OF the panel stack:
 *
 *    chassis top + 2 × hostHeadRadius  + MIRROR_EXTRA_HEIGHT
 *      ← stacked turret's chassis-top equivalent
 *      ← + headRadius                  ← stacked turret muzzle
 */
export function getTurretMountHeight(unit: Entity, turretIndex: number): number {
  if (!unit.unit) return 0;
  const unitRadius = unit.unit.unitRadiusCollider.scale;
  let bp;
  try { bp = getUnitBlueprint(unit.unit.unitType); }
  catch { /* keep fallback */ }
  const chassisLift = bp ? getChassisLiftY(bp, unitRadius) : 0;
  const bodyTop = chassisLift + (bp ? getBodyTopY(bp.bodyShape, unitRadius) : 2.3 * unitRadius);

  const turret = unit.turrets?.[turretIndex];
  const headRadius = getTurretHeadRadius(unitRadius, turret?.config);

  const hasMirrors = (unit.unit.mirrorPanels?.length ?? 0) > 0;
  if (hasMirrors && turretIndex > 0) {
    // Stacked turret rests on top of the mirror panel stack. Panel
    // top is derived from the host turret's (index 0) own body
    // radius — so a Loris with a chunkier mirror host has a
    // proportionally taller panel column.
    const hostTurret = unit.turrets?.[0];
    const hostHeadRadius = getTurretHeadRadius(unitRadius, hostTurret?.config);
    const panelTop = bodyTop + 2 * hostHeadRadius + MIRROR_EXTRA_HEIGHT;
    return panelTop + headRadius;
  }
  return bodyTop + headRadius;
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
