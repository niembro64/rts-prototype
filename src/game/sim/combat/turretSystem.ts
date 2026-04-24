// Turret rotation system — damped-spring integrator on both yaw and
// pitch. The solver picks a target pose each tick (target bearing for
// yaw, ballistic-arc angle for pitch); the damper converges the
// weapon's current pose on that target along an overshoot-free curve,
// so tick-to-tick jitter in the solver (e.g. a ballistic solution
// that wobbles slightly as the target moves) doesn't propagate into
// visible barrel oscillation.
//
// Per-axis dynamics (rotation axis shown as θ):
//
//   accel = (targetθ − θ) · k  −  θ̇ · c
//   θ̇   += accel · dt
//   θ   += θ̇ · dt
//
// where k = turretTurnAccel (reused as stiffness so existing per-
// turret tuning carries over — stiffer turret = snappier track) and
// c = 2·√k gives critical damping. `turretDrag` from the old bang-
// bang integrator no longer scales velocity directly; instead it's
// applied as an EXTRA damping coefficient on top of critical. A drag
// of 0 produces exactly critical damping; positive values overdamp
// (slower, no-overshoot response).

import type { WorldState } from '../WorldState';
import { getMovementAngle, resolveWeaponWorldPos, getUnitMuzzleHeight } from './combatUtils';
import { getTransformCosSin, solveBallisticPitch, getBarrelTip, normalizeAngle } from '../../math';
import {
  TURRET_RETURN_TO_FORWARD,
  GRAVITY,
} from '../../../config';

/** Pitch is clamped to straight-down → straight-up. Matches the
 *  renderer's pitch range and keeps the ballistic solver from driving
 *  the barrel through the body. */
const PITCH_MIN = -Math.PI / 2;
const PITCH_MAX = Math.PI / 2;

export function updateTurretRotation(world: WorldState, dtMs: number): void {
  const dtSec = dtMs / 1000;

  for (const unit of world.getUnits()) {
    if (!unit.unit || !unit.ownership || !unit.turrets) continue;
    if (unit.unit.hp <= 0) continue;

    const { cos, sin } = getTransformCosSin(unit.transform);

    for (const weapon of unit.turrets) {
      // Vertical launchers skip the normal yaw/pitch aim math — the
      // turret always points straight up and each fired rocket picks
      // a random cone-from-vertical direction at launch (projectile-
      // System handles that). Targeting state still runs in
      // targetingSystem so the weapon acquires a homing target, but
      // here we just pin the pose so the rendered barrels stay
      // skyward and the gatling spin (driven by engagement state)
      // keeps working.
      if (weapon.config.verticalLauncher) {
        weapon.rotation = 0;
        weapon.angularVelocity = 0;
        weapon.pitch = Math.PI / 2;
        weapon.pitchVelocity = 0;
        continue;
      }

      // --- 1) Derive per-axis target pose for this tick. ---
      let targetAngle: number | null = null;
      let targetPitch = 0;
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
          // and yaw direction. Use barrelIndex = 0 (reference barrel)
          // and the CURRENT weapon.pitch — as the damper converges,
          // the solver input settles along with it.
          const unitGroundZ = unit.transform.z - unit.unit.unitRadiusCollider.push;
          const mountZ = unitGroundZ + getUnitMuzzleHeight(unit);
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
            targetPitch = solveBallisticPitch(
              horizDist,
              heightDiff,
              launchSpeed,
              GRAVITY,
              weapon.config.highArc ?? false,
            );
          } else {
            // Beam / laser / force — direct aim, no ballistic drop.
            targetPitch = Math.atan2(heightDiff, horizDist);
          }
          hasActiveTarget = true;
        }
      }

      if (!hasActiveTarget) {
        // No target: pitch settles to 0 (barrel horizontal); yaw
        // either glides toward forward (match movement direction)
        // or coasts via the damper with target = current angle (no
        // pull), letting the existing damping bleed velocity off.
        targetPitch = 0;
        if (TURRET_RETURN_TO_FORWARD) {
          targetAngle = getMovementAngle(unit);
        } else {
          targetAngle = weapon.rotation;
        }
      }

      // --- 2) Damped-spring integrate both axes toward targets. ---
      // k = stiffness; c = 2·√k for critical damping. `weapon.drag`
      // is an optional EXTRA damping coefficient (0 = exactly
      // critical). Tuning `turretTurnAccel` higher gives a snappier
      // response; tuning `turretDrag` higher keeps it smooth-but-
      // slower.
      const k = Math.max(weapon.turnAccel, 1);
      const cCritical = 2 * Math.sqrt(k);
      const c = cCritical * (1 + weapon.drag);

      // Yaw — use normalized angle difference so we always turn the
      // short way around and don't blow up near ±π.
      const yawDiff = normalizeAngle(targetAngle! - weapon.rotation);
      const yawAccel = yawDiff * k - weapon.angularVelocity * c;
      weapon.angularVelocity += yawAccel * dtSec;
      weapon.rotation = normalizeAngle(weapon.rotation + weapon.angularVelocity * dtSec);

      // Pitch — straight difference; clamp the integrated pitch so
      // the barrel doesn't rotate past vertical.
      const pitchDiff = targetPitch - weapon.pitch;
      const pitchAccel = pitchDiff * k - weapon.pitchVelocity * c;
      weapon.pitchVelocity += pitchAccel * dtSec;
      let newPitch = weapon.pitch + weapon.pitchVelocity * dtSec;
      if (newPitch < PITCH_MIN) { newPitch = PITCH_MIN; weapon.pitchVelocity = 0; }
      else if (newPitch > PITCH_MAX) { newPitch = PITCH_MAX; weapon.pitchVelocity = 0; }
      weapon.pitch = newPitch;
    }
  }
}
