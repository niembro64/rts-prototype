// Turret rotation system - acceleration-based physics for weapon turrets

import type { WorldState } from '../WorldState';
import { normalizeAngle, getMovementAngle, resolveWeaponWorldPos } from './combatUtils';
import { getTransformCosSin } from '../../math';
import { TURRET_RETURN_TO_FORWARD } from '../../../config';

// Cache for drag factors: avoids recomputing Math.pow per weapon when only ~4 unique drag values exist
const _dragFactorCache = new Map<number, number>();

// Update turret rotation for all units using acceleration-based physics
// Each weapon has its own acceleration and drag values
// Physics model:
//   1. Calculate direction to target (or forward if no target)
//   2. Apply acceleration toward target direction
//   3. Apply drag to angular velocity
//   4. Update rotation based on velocity
export function updateTurretRotation(world: WorldState, dtMs: number): void {
  const dtSec = dtMs / 1000;
  const dtFrames = dtSec * 60;
  _dragFactorCache.clear();

  for (const unit of world.getUnits()) {
    if (!unit.unit || !unit.ownership || !unit.turrets) continue;
    if (unit.unit.hp <= 0) continue;

    const { cos, sin } = getTransformCosSin(unit.transform);

    // Update each weapon's turret rotation using acceleration physics
    for (const weapon of unit.turrets) {
      let targetAngle: number | null = null;
      let hasActiveTarget = false;

      if (weapon.target !== null) {
        const target = world.getEntity(weapon.target);
        if (target) {
          // Use cached weapon world position from targeting phase
          const wp = resolveWeaponWorldPos(weapon, unit.transform.x, unit.transform.y, cos, sin);
          const weaponX = wp.x, weaponY = wp.y;
          const dx = target.transform.x - weaponX;
          const dy = target.transform.y - weaponY;
          targetAngle = Math.atan2(dy, dx);
          hasActiveTarget = true;
        }
      }

      // dt-independent drag: at 60fps apply (1-drag) per frame, variable dt: pow(1-drag, dt*60)
      // Cached per unique drag value (~4 unique values → ~4 pow calls instead of 400+)
      let dragFactor = _dragFactorCache.get(weapon.drag);
      if (dragFactor === undefined) {
        dragFactor = Math.pow(1 - weapon.drag, dtFrames);
        _dragFactorCache.set(weapon.drag, dragFactor);
      }

      // If no active target, optionally return turret to forward-facing
      if (!hasActiveTarget) {
        if (TURRET_RETURN_TO_FORWARD) {
          targetAngle = getMovementAngle(unit);
        } else {
          // Hold current rotation — just apply drag to slow down
          weapon.angularVelocity *= dragFactor;
          weapon.rotation += weapon.angularVelocity * dtSec;
          weapon.rotation = normalizeAngle(weapon.rotation);
          continue;
        }
      }

      // Calculate angle difference to target
      const angleDiff = normalizeAngle(targetAngle! - weapon.rotation);

      // Apply acceleration toward target
      // Acceleration is proportional to direction (sign of angle difference)
      const accelDirection = Math.sign(angleDiff);
      weapon.angularVelocity += accelDirection * weapon.turnAccel * dtSec;

      // Apply drag (reduces velocity each frame)
      // dt-independent: naturally limits terminal velocity
      weapon.angularVelocity *= dragFactor;

      // Update rotation based on velocity
      weapon.rotation += weapon.angularVelocity * dtSec;
      // Keep rotation normalized
      weapon.rotation = normalizeAngle(weapon.rotation);
    }
  }
}
