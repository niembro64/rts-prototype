// Turret rotation system — yaw slew via angular velocity, pitch set
// directly from the elevation to the target. Pure TS path: the old
// WASM-batched integrator was 2D-only (no pitch) and is gone.

import type { WorldState } from '../WorldState';
import { normalizeAngle, getMovementAngle, resolveWeaponWorldPos, getUnitMuzzleHeight } from './combatUtils';
import { getTransformCosSin, solveBallisticPitch, getBarrelTip } from '../../math';
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
          // Ballistic arcs are solved from the actual barrel tip (not
          // the turret mount) — otherwise shots would fire from a point
          // one barrel-length farther back than the pitch was solved
          // for, and every projectile would overshoot the target.
          //
          // The primitive returns a tip in world coords that already
          // accounts for the barrel's orbit offset, pitch contribution,
          // and yaw direction. Use barrelIndex = 0 here since this is
          // the "aim point" reference — the next fired shot may come
          // from a different barrel in the cluster, but the cluster is
          // tight enough that solving from barrel 0 is indistinguishable
          // at gameplay range.
          const unitGroundZ = unit.transform.z - unit.unit.unitRadiusCollider.push;
          const mountZ = unitGroundZ + getUnitMuzzleHeight(unit);
          // Scale the barrel length by the SAME radius the 3D renderer
          // uses (`.scale`, not `.shot`). The renderer draws the barrel
          // at unitRadius.scale · barrelLength; spawning shots from a
          // different fraction would put the sim's muzzle at a point
          // behind or in front of the visible tip. `.scale` and `.shot`
          // diverge on most units (e.g. scout 8 vs 6), so using the
          // wrong one is visible as beams floating off the barrel.
          const tipRef = getBarrelTip(
            weaponX, weaponY, mountZ,
            targetAngle, weapon.pitch,
            weapon.config,
            unit.unit.unitRadiusCollider.scale,
            0,
          );
          const horizDist = Math.hypot(
            target.transform.x - tipRef.x,
            target.transform.y - tipRef.y,
          );
          const heightDiff = target.transform.z - tipRef.z;
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
