// Turret rotation system - acceleration-based physics for weapon turrets

import type { WorldState } from '../WorldState';
import { normalizeAngle, getMovementAngle } from './combatUtils';

// Update turret rotation for all units using acceleration-based physics
// Each weapon has its own acceleration and drag values
// Physics model:
//   1. Calculate direction to target (or forward if no target)
//   2. Apply acceleration toward target direction
//   3. Apply drag to angular velocity
//   4. Update rotation based on velocity
export function updateTurretRotation(world: WorldState, dtMs: number): void {
  const dtSec = dtMs / 1000;

  for (const unit of world.getUnits()) {
    if (!unit.unit || !unit.ownership || !unit.weapons) continue;
    if (unit.unit.hp <= 0) continue;

    const cos = Math.cos(unit.transform.rotation);
    const sin = Math.sin(unit.transform.rotation);

    // Update each weapon's turret rotation using acceleration physics
    for (const weapon of unit.weapons) {
      let targetAngle: number | null = null;
      let hasActiveTarget = false;

      if (weapon.targetEntityId !== null) {
        const target = world.getEntity(weapon.targetEntityId);
        if (target) {
          // Calculate angle from weapon position to target (using rotated coordinates)
          const weaponX = unit.transform.x + cos * weapon.offsetX - sin * weapon.offsetY;
          const weaponY = unit.transform.y + sin * weapon.offsetX + cos * weapon.offsetY;
          const dx = target.transform.x - weaponX;
          const dy = target.transform.y - weaponY;
          targetAngle = Math.atan2(dy, dx);
          hasActiveTarget = true;
        }
      }

      // If no active target, check if we should return to forward
      if (!hasActiveTarget) {
        if (weapon.returnToForward) {
          // Return to forward-facing (movement direction or body direction)
          targetAngle = getMovementAngle(unit);
        } else {
          // No target and not returning to forward - just coast with drag
          // Apply drag (reduces velocity each frame)
          weapon.turretAngularVelocity *= (1 - weapon.turretDrag);
          // Still update rotation based on remaining velocity
          weapon.turretRotation += weapon.turretAngularVelocity * dtSec;
          weapon.turretRotation = normalizeAngle(weapon.turretRotation);
          continue;
        }
      }

      // Calculate angle difference to target
      const angleDiff = normalizeAngle(targetAngle! - weapon.turretRotation);

      // Apply acceleration toward target
      // Acceleration is proportional to direction (sign of angle difference)
      const accelDirection = Math.sign(angleDiff);
      weapon.turretAngularVelocity += accelDirection * weapon.turretTurnAccel * dtSec;

      // Apply drag (reduces velocity each frame)
      // Using multiplicative drag: velocity *= (1 - drag)
      // This naturally limits terminal velocity
      weapon.turretAngularVelocity *= (1 - weapon.turretDrag);

      // Update rotation based on velocity
      weapon.turretRotation += weapon.turretAngularVelocity * dtSec;
      // Keep rotation normalized
      weapon.turretRotation = normalizeAngle(weapon.turretRotation);
    }
  }
}
