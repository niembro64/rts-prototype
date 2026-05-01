// Combat utility functions

import type { Entity } from '../types';
import { distance, normalizeAngle, magnitude, getWeaponWorldPosition, getTurretHeadRadius } from '../../math';
import { getBodyMountTopY, getChassisLiftY } from '../../math/BodyDimensions';
import { getUnitBlueprint } from '../blueprints';
import { MIRROR_EXTRA_HEIGHT } from '../../../config';
import type { Vec3 } from '@/types/vec2';

// Re-export common math functions for backward compatibility
export { distance, normalizeAngle };

/** Bit-mask of which turrets are engaged/firing. Indices >= this can't
 *  fit in a 32-bit mask, so the helpers below treat them as always
 *  included (the rare unit with 31+ turrets falls back to "permissive"
 *  semantics rather than silently dropping out of the mask). */
export const TURRET_MASK_MAX_INDEX = 30;

export function turretBit(index: number): number {
  return index <= TURRET_MASK_MAX_INDEX ? (1 << index) : 0;
}

export function turretMaskIncludes(mask: number | undefined, index: number): boolean {
  if (mask === undefined) return true;
  if (mask < 0) return true;
  if (mask === 0) return false;
  if (index > TURRET_MASK_MAX_INDEX) return true;
  return (mask & (1 << index)) !== 0;
}

/** Count turrets currently in the 'engaged' state. Used by movement
 *  decisions (commit/disengage thresholds) and worth a helper because
 *  it's called in multiple movement branches per tick. */
export function engagedTurretCount(turrets: { state: string }[] | undefined): number {
  if (!turrets) return 0;
  let count = 0;
  for (let i = 0; i < turrets.length; i++) {
    if (turrets[i].state === 'engaged') count++;
  }
  return count;
}

// Get target radius for range calculations.
// Buildings precompute targetRadius at construction (dimensions never
// change), so this is a property read, not a per-call sqrt.
export function getTargetRadius(target: Entity): number {
  if (target.unit) {
    return target.unit.unitRadiusCollider.shot;
  } else if (target.building) {
    return target.building.targetRadius;
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

  const turret = unit.turrets?.[turretIndex];
  const bodyTop = chassisLift + (bp
    ? getBodyMountTopY(
        bp.bodyShape,
        unitRadius,
        turret?.offset.x ?? 0,
        turret?.offset.y ?? 0,
      )
    : 2.3 * unitRadius);
  const headRadius = getTurretHeadRadius(unitRadius, turret?.config);

  const hasMirrors = (unit.unit.mirrorPanels?.length ?? 0) > 0;
  if (hasMirrors && turretIndex > 0) {
    // Stacked turret rests on top of the mirror panel stack. Panel
    // top is derived from the host turret's (index 0) own body
    // radius — so a Loris with a chunkier mirror host has a
    // proportionally taller panel column.
    const hostTurret = unit.turrets?.[0];
    const hostHeadRadius = getTurretHeadRadius(unitRadius, hostTurret?.config);
    const hostBodyTop = chassisLift + (bp
      ? getBodyMountTopY(
          bp.bodyShape,
          unitRadius,
          hostTurret?.offset.x ?? 0,
          hostTurret?.offset.y ?? 0,
        )
      : 2.3 * unitRadius);
    const panelTop = hostBodyTop + 2 * hostHeadRadius + MIRROR_EXTRA_HEIGHT;
    return panelTop + headRadius;
  }
  return bodyTop + headRadius;
}

export function getEntityVelocity3(entity: Entity, out: Vec3): Vec3 {
  if (entity.unit) {
    out.x = entity.unit.velocityX ?? 0;
    out.y = entity.unit.velocityY ?? 0;
    out.z = entity.unit.velocityZ ?? 0;
  } else if (entity.projectile) {
    out.x = entity.projectile.velocityX;
    out.y = entity.projectile.velocityY;
    out.z = entity.projectile.velocityZ;
  } else {
    out.x = 0;
    out.y = 0;
    out.z = 0;
  }
  return out;
}

export function computeTurretPointVelocity(
  turret: {
    rotation: number;
    angularVelocity: number;
    pitchVelocity: number;
    worldVelocity?: Vec3;
  },
  mountX: number,
  mountY: number,
  mountZ: number,
  pointX: number,
  pointY: number,
  pointZ: number,
  out: Vec3,
  fallbackMountVelocity?: Vec3,
): Vec3 {
  const base = turret.worldVelocity ?? fallbackMountVelocity;
  out.x = base?.x ?? 0;
  out.y = base?.y ?? 0;
  out.z = base?.z ?? 0;

  const rx = pointX - mountX;
  const ry = pointY - mountY;
  const rz = pointZ - mountZ;

  const yawOmega = turret.angularVelocity;
  if (yawOmega !== 0) {
    out.x += -ry * yawOmega;
    out.y += rx * yawOmega;
  }

  const pitchOmega = turret.pitchVelocity;
  if (pitchOmega !== 0) {
    const pitchAxisX = Math.sin(turret.rotation) * pitchOmega;
    const pitchAxisY = -Math.cos(turret.rotation) * pitchOmega;
    out.x += pitchAxisY * rz;
    out.y += -pitchAxisX * rz;
    out.z += pitchAxisX * ry - pitchAxisY * rx;
  }

  return out;
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
