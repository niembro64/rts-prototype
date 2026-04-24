// Turret rotation system — yaw slew via angular velocity, pitch set
// directly from the elevation to the target. Pure TS path: the old
// WASM-batched integrator was 2D-only (no pitch) and is gone.

import type { WorldState } from '../WorldState';
import { normalizeAngle, getMovementAngle, resolveWeaponWorldPos } from './combatUtils';
import { getTransformCosSin } from '../../math';
import { TURRET_RETURN_TO_FORWARD } from '../../../config';

// Cache for drag factors
const _dragFactorCache = new Map<number, number>();

export function updateTurretRotation(world: WorldState, dtMs: number): void {
  updateTurretRotationJS(world, dtMs);
}

// JS fallback path (original implementation). Yaw is velocity-damped
// (slews via angularVelocity); pitch tracks the elevation to the
// current target every frame without its own angular-velocity path —
// simpler and matches the game feel of RTS turrets that "tilt" freely
// while their heavy horizontal swing has inertia. Pitch is zeroed
// when there's no target.
function updateTurretRotationJS(world: WorldState, dtMs: number): void {
  const dtSec = dtMs / 1000;
  const dtFrames = dtSec * 60;
  _dragFactorCache.clear();

  for (const unit of world.getUnits()) {
    if (!unit.unit || !unit.ownership || !unit.turrets) continue;
    if (unit.unit.hp <= 0) continue;

    const { cos, sin } = getTransformCosSin(unit.transform);

    for (const weapon of unit.turrets) {
      let targetAngle: number | null = null;
      let hasActiveTarget = false;

      if (weapon.target !== null) {
        const target = world.getEntity(weapon.target);
        if (target) {
          const wp = resolveWeaponWorldPos(weapon, unit.transform.x, unit.transform.y, cos, sin);
          const weaponX = wp.x, weaponY = wp.y;
          const dx = target.transform.x - weaponX;
          const dy = target.transform.y - weaponY;
          targetAngle = Math.atan2(dy, dx);
          // Pitch: elevation angle from the weapon to the target in 3D.
          // Weapon height is approximated as the hull-top for now (M7
          // keeps the math simple — a later pass can thread an explicit
          // per-turret mount height through). atan2(dz, horizontalDist)
          // gives +pitch when the target is above the weapon.
          const weaponZ = unit.transform.z;
          const dz = target.transform.z - weaponZ;
          const horizDist = Math.hypot(dx, dy);
          weapon.pitch = Math.atan2(dz, horizDist);
          hasActiveTarget = true;
        }
      }

      let dragFactor = _dragFactorCache.get(weapon.drag);
      if (dragFactor === undefined) {
        dragFactor = Math.pow(1 - weapon.drag, dtFrames);
        _dragFactorCache.set(weapon.drag, dragFactor);
      }

      if (!hasActiveTarget) {
        // No target → pitch settles to 0 (barrel horizontal).
        weapon.pitch = 0;
        if (TURRET_RETURN_TO_FORWARD) {
          targetAngle = getMovementAngle(unit);
        } else {
          weapon.angularVelocity *= dragFactor;
          weapon.rotation += weapon.angularVelocity * dtSec;
          weapon.rotation = normalizeAngle(weapon.rotation);
          continue;
        }
      }

      const angleDiff = normalizeAngle(targetAngle! - weapon.rotation);
      const accelDirection = Math.sign(angleDiff);
      weapon.angularVelocity += accelDirection * weapon.turnAccel * dtSec;
      weapon.angularVelocity *= dragFactor;
      weapon.rotation += weapon.angularVelocity * dtSec;
      weapon.rotation = normalizeAngle(weapon.rotation);
    }
  }
}
