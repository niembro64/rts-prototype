// Turret rotation system — yaw slew via angular velocity, pitch set
// directly from the elevation to the target. Pure TS path: the old
// WASM-batched integrator was 2D-only (no pitch) and is gone.

import type { WorldState } from '../WorldState';
import { normalizeAngle, getMovementAngle, resolveWeaponWorldPos, getBarrelTipOffset, getUnitMuzzleHeight } from './combatUtils';
import { getTransformCosSin, solveBallisticPitch } from '../../math';
import {
  TURRET_RETURN_TO_FORWARD,
  GRAVITY,
} from '../../../config';

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
          // Solve the ballistic arc from where the projectile actually
          // leaves the weapon — the barrel TIP, not the turret MOUNT.
          // The tip is one barrelOffset forward along the yaw axis and
          // one per-unit muzzle-height above the unit's footprint (tall
          // bodies like arachnid fire higher than squat scouts).
          // Previous revision aimed from the mount and was
          // systematically short by a whole barrel length: shots passed
          // above the target sphere and registered no hit.
          const barrelOffset = getBarrelTipOffset(weapon.config, unit.unit.unitRadiusCollider.shot);
          const yawCos = Math.cos(targetAngle);
          const yawSin = Math.sin(targetAngle);
          const barrelTipX = weaponX + yawCos * barrelOffset;
          const barrelTipY = weaponY + yawSin * barrelOffset;
          const unitGroundZ = unit.transform.z - unit.unit.unitRadiusCollider.push;
          const muzzleZ = unitGroundZ + getUnitMuzzleHeight(unit);
          const horizDist = Math.hypot(
            target.transform.x - barrelTipX,
            target.transform.y - barrelTipY,
          );
          const heightDiff = target.transform.z - muzzleZ;
          const shot = weapon.config.shot;
          if (shot.type === 'projectile') {
            const launchSpeed = shot.launchForce / shot.mass;
            weapon.pitch = solveBallisticPitch(
              horizDist,
              heightDiff,
              launchSpeed,
              GRAVITY,
              weapon.config.highArc ?? false,
            );
          } else {
            // Beam / laser / force — direct aim, no ballistic drop.
            weapon.pitch = Math.atan2(heightDiff, horizDist);
          }
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
