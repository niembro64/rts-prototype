// Turret rotation system - acceleration-based physics for weapon turrets

import type { WorldState } from '../WorldState';
import { normalizeAngle, getMovementAngle } from './combatUtils';
import { getWeaponWorldPosition } from '../../math';
import { TURRET_RETURN_TO_FORWARD } from '../../../config';

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

    const cos = unit.transform.rotCos ?? Math.cos(unit.transform.rotation);
    const sin = unit.transform.rotSin ?? Math.sin(unit.transform.rotation);

    // Update each weapon's turret rotation using acceleration physics
    for (const weapon of unit.weapons) {
      let targetAngle: number | null = null;
      let hasActiveTarget = false;

      if (weapon.targetEntityId !== null) {
        const target = world.getEntity(weapon.targetEntityId);
        if (target) {
          // Use cached weapon world position from targeting phase
          let weaponX: number, weaponY: number;
          if (weapon.worldX !== undefined) {
            weaponX = weapon.worldX;
            weaponY = weapon.worldY!;
          } else {
            const wp = getWeaponWorldPosition(unit.transform.x, unit.transform.y, cos, sin, weapon.offsetX, weapon.offsetY);
            weaponX = wp.x;
            weaponY = wp.y;
          }
          const dx = target.transform.x - weaponX;
          const dy = target.transform.y - weaponY;
          targetAngle = Math.atan2(dy, dx);
          hasActiveTarget = true;
        }
      }

      // dt-independent drag: at 60fps apply (1-drag) per frame, variable dt: pow(1-drag, dt*60)
      const dragFactor = Math.pow(1 - weapon.turretDrag, dtSec * 60);

      // If no active target, optionally return turret to forward-facing
      if (!hasActiveTarget) {
        if (TURRET_RETURN_TO_FORWARD) {
          targetAngle = getMovementAngle(unit);
        } else {
          // Hold current rotation — just apply drag to slow down
          weapon.turretAngularVelocity *= dragFactor;
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
      // dt-independent: naturally limits terminal velocity
      weapon.turretAngularVelocity *= dragFactor;

      // Update rotation based on velocity
      weapon.turretRotation += weapon.turretAngularVelocity * dtSec;
      // Keep rotation normalized
      weapon.turretRotation = normalizeAngle(weapon.turretRotation);
    }
  }
}
