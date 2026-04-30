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
import type { Entity } from '../types';
import { computeTurretPointVelocity, getEntityVelocity3, getMovementAngle, resolveWeaponWorldPos, getTurretMountHeight } from './combatUtils';
import { getTransformCosSin, solveBallisticPitch, computeInterceptTime, getBarrelTip, normalizeAngle } from '../../math';
import { solveMirrorAim } from './MirrorAimSolver';
import {
  TURRET_RETURN_TO_FORWARD,
  GRAVITY,
} from '../../../config';

/** Pitch is clamped to straight-down → straight-up. Matches the
 *  renderer's pitch range and keeps the ballistic solver from driving
 *  the barrel through the body. */
const PITCH_MIN = -Math.PI / 2;
const PITCH_MAX = Math.PI / 2;
const TURRET_MASK_MAX_INDEX = 30;
const _targetVelocity = { x: 0, y: 0, z: 0 };
const _muzzleVelocity = { x: 0, y: 0, z: 0 };

function turretMaskIncludes(mask: number | undefined, index: number): boolean {
  if (mask === undefined) return true;
  if (mask < 0) return true;
  if (mask === 0) return false;
  if (index > TURRET_MASK_MAX_INDEX) return true;
  return (mask & (1 << index)) !== 0;
}

export function updateTurretRotation(world: WorldState, dtMs: number, units: readonly Entity[] = world.getArmedUnits()): void {
  const dtSec = dtMs / 1000;

  for (const unit of units) {
    if (!unit.unit || !unit.ownership || !unit.turrets) continue;
    if (unit.unit.hp <= 0) continue;

    const { cos, sin } = getTransformCosSin(unit.transform);
    const activeMask = unit.unit.activeTurretMask;

    for (let weaponIndex = 0; weaponIndex < unit.turrets.length; weaponIndex++) {
      if (!turretMaskIncludes(activeMask, weaponIndex)) continue;
      const weapon = unit.turrets[weaponIndex];
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
          // Origin (weapon mount) in true 3D world coords. The
          // targeting system runs earlier in the same tick and
          // populates `weapon.worldPos.{x,y,z}` via getTurretWorldMount,
          // which applies the chassis tilt to the chassis-local mount
          // — exactly the same point projectile spawn and beam tracer
          // use. Reading those three numbers here keeps aim, fire,
          // and the rendered barrel locked together on slopes; if for
          // any reason worldPos isn't populated (very first tick on a
          // newly spawned unit) we fall back to the upright math.
          const unitGroundZ = unit.transform.z - unit.unit.unitRadiusCollider.push;
          let weaponX: number;
          let weaponY: number;
          let mountZ: number;
          if (weapon.worldPos) {
            weaponX = weapon.worldPos.x;
            weaponY = weapon.worldPos.y;
            mountZ = weapon.worldPos.z;
          } else {
            const wp = resolveWeaponWorldPos(weapon, unit.transform.x, unit.transform.y, cos, sin);
            weaponX = wp.x;
            weaponY = wp.y;
            mountZ = unitGroundZ + getTurretMountHeight(unit, weaponIndex);
          }

          // Initial unleaded aim — used to bootstrap the barrel tip
          // reference. The lead step below replaces this with a
          // velocity-predicted intercept point.
          targetAngle = Math.atan2(target.transform.y - weaponY, target.transform.x - weaponX);

          // Ballistic arcs are solved from the actual muzzle TIP (not
          // the turret mount) — otherwise shots would fire from a
          // point one barrel-length farther back than the pitch was
          // solved for, and every projectile would overshoot.
          // Multi-barrel weapons use the stable cluster centerline, so
          // aim no longer depends on the round-robin barrel index.
          let tipRef = getBarrelTip(
            weaponX, weaponY, mountZ,
            targetAngle, weapon.pitch,
            weapon.config,
            unit.unit.unitRadiusCollider.scale,
            0,
          );

          // Lead prediction: aim at where the target will be when the
          // projectile arrives, in the moving turret's frame. That
          // means the relative velocity is target velocity minus the
          // turret's own muzzle velocity, not merely the carrier unit's
          // velocity. For ballistic arcs we run a single refinement
          // pass using horizontal projectile speed (launchSpeed ·
          // cos(pitch)) because high arcs spend longer in flight.
          const shot = weapon.config.shot;
          const targetVelocity = getEntityVelocity3(target, _targetVelocity);

          let aimX = target.transform.x;
          let aimY = target.transform.y;
          let aimZ = target.transform.z;

          // Passive (mirror) turret aim — orient the reflector so the
          // enemy's beam bounces toward the chosen victim. All the
          // bisector geometry, victim selection, and fixed-point P
          // refinement lives in MirrorAimSolver; here we just apply
          // the solved overrides.
          let mirrorPitchOverride: number | null = null;
          if (weapon.config.passive) {
            const aim = solveMirrorAim(
              unit, weapon, target,
              weaponX, weaponY, unitGroundZ,
              targetAngle ?? 0,
            );
            if (aim) {
              targetAngle = aim.targetAngle;
              mirrorPitchOverride = aim.mirrorPitch;
              aimX = aim.aimX;
              aimY = aim.aimY;
              aimZ = aim.aimZ;
            }
          }

          if (shot.type === 'projectile') {
            const launchSpeed = shot.launchForce / shot.mass;
            const muzzleVelocity = _muzzleVelocity;
            if (world.projVelInherit) {
              computeTurretPointVelocity(
                weapon,
                weaponX, weaponY, mountZ,
                tipRef.x, tipRef.y, tipRef.z,
                muzzleVelocity,
              );
            } else {
              muzzleVelocity.x = 0;
              muzzleVelocity.y = 0;
              muzzleVelocity.z = 0;
            }
            const relVx = targetVelocity.x - muzzleVelocity.x;
            const relVy = targetVelocity.y - muzzleVelocity.y;
            const relVz = targetVelocity.z - muzzleVelocity.z;
            const relMoves = (relVx * relVx + relVy * relVy + relVz * relVz) > 1e-6;

            if (relMoves) {
              const dxT = target.transform.x - tipRef.x;
              const dyT = target.transform.y - tipRef.y;
              const dzT = target.transform.z - tipRef.z;

              // First pass — closed-form intercept assuming straight-
              // line projectile speed in the turret's moving frame.
              let tIntercept = computeInterceptTime(dxT, dyT, dzT, relVx, relVy, relVz, launchSpeed);

              // Second pass — refine using the ballistic horizontal
              // speed (gravity drag on the arc). Only meaningful for
              // gravity-affected shots; ignoresGravity shots stay flat.
              if (tIntercept > 0 && !shot.ignoresGravity) {
                const px = target.transform.x + relVx * tIntercept;
                const py = target.transform.y + relVy * tIntercept;
                const pz = target.transform.z + relVz * tIntercept;
                const horizD = Math.hypot(px - tipRef.x, py - tipRef.y);
                const heightD = pz - tipRef.z;
                const pitch0 = solveBallisticPitch(
                  horizD, heightD, launchSpeed, GRAVITY, weapon.config.highArc ?? false,
                );
                const horizSpeed = launchSpeed * Math.max(Math.cos(pitch0), 0.1);
                const tRefined = computeInterceptTime(dxT, dyT, dzT, relVx, relVy, relVz, horizSpeed);
                if (tRefined > 0) tIntercept = tRefined;
              }

              aimX = target.transform.x + relVx * tIntercept;
              aimY = target.transform.y + relVy * tIntercept;
              aimZ = target.transform.z + relVz * tIntercept;
              targetAngle = Math.atan2(aimY - tipRef.y, aimX - tipRef.x);
            }

            // groundAimFraction: aim short of the lead-corrected
            // target so the round lands on the ground at this
            // fraction of the weapon→aim distance, then let the
            // submunition bounce/spread carry the rest. Mortar uses
            // this so its lightShots arc into the impact ring around
            // the target instead of the carrier dropping directly on
            // top. Applied after lead so the "aim point" we shorten
            // is the predicted intercept, not the stale current pos.
            const groundAimFraction = weapon.config.groundAimFraction;
            const leadAimX = aimX;
            const leadAimY = aimY;
            if (groundAimFraction !== undefined && groundAimFraction > 0) {
              const f = groundAimFraction;
              aimX = tipRef.x + f * (aimX - tipRef.x);
              aimY = tipRef.y + f * (aimY - tipRef.y);
              aimZ = 0;
            }

            targetAngle = Math.atan2(aimY - tipRef.y, aimX - tipRef.x);
            tipRef = getBarrelTip(
              weaponX, weaponY, mountZ,
              targetAngle, weapon.pitch,
              weapon.config,
              unit.unit.unitRadiusCollider.scale,
              0,
            );
            if (groundAimFraction !== undefined && groundAimFraction > 0) {
              const f = groundAimFraction;
              aimX = tipRef.x + f * (leadAimX - tipRef.x);
              aimY = tipRef.y + f * (leadAimY - tipRef.y);
              targetAngle = Math.atan2(aimY - tipRef.y, aimX - tipRef.x);
              tipRef = getBarrelTip(
                weaponX, weaponY, mountZ,
                targetAngle, weapon.pitch,
                weapon.config,
                unit.unit.unitRadiusCollider.scale,
                0,
              );
            }
            const horizDist = Math.hypot(aimX - tipRef.x, aimY - tipRef.y);
            const heightDiff = aimZ - tipRef.z;
            targetPitch = solveBallisticPitch(
              horizDist, heightDiff, launchSpeed, GRAVITY, weapon.config.highArc ?? false,
            );
          } else {
            // Beam / laser / force — direct aim, no ballistic drop.
            targetAngle = Math.atan2(aimY - tipRef.y, aimX - tipRef.x);
            tipRef = getBarrelTip(
              weaponX, weaponY, mountZ,
              targetAngle, weapon.pitch,
              weapon.config,
              unit.unit.unitRadiusCollider.scale,
              0,
            );
            const horizDist = Math.hypot(aimX - tipRef.x, aimY - tipRef.y);
            const heightDiff = aimZ - tipRef.z;
            targetPitch = Math.atan2(heightDiff, horizDist);
          }
          // Mirror turrets pivot at the panel center, not the turret
          // mount — override with the panel-aware pitch computed above
          // so the panel normal points at the beam source in 3D.
          if (mirrorPitchOverride !== null) {
            targetPitch = mirrorPitchOverride;
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
