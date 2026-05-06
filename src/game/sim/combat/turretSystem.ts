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
import { getMovementAngle, resolveWeaponWorldMount, turretBit, turretMaskIncludes } from './combatUtils';
import { getTransformCosSin, normalizeAngle } from '../../math';
import { TURRET_RETURN_TO_FORWARD } from '../../../config';
import { createTurretAimScratch, solveTurretAim } from './aimSolver';
import { getUnitGroundZ } from '../unitGeometry';

/** Pitch is clamped to straight-down → straight-up. Matches the
 *  renderer's pitch range and keeps the ballistic solver from driving
 *  the barrel through the body. */
const PITCH_MIN = -Math.PI / 2;
const PITCH_MAX = Math.PI / 2;
const _turretAim = createTurretAimScratch();
const _turretMount = { x: 0, y: 0, z: 0 };

export function updateTurretRotation(world: WorldState, dtMs: number, units: readonly Entity[] = world.getArmedEntities()): void {
  const dtSec = dtMs / 1000;

  for (const unit of units) {
    if (!unit.combat || !unit.ownership) continue;
    const hostHp = unit.unit?.hp ?? unit.building?.hp ?? 0;
    if (hostHp <= 0) continue;
    // Inert shells (in-progress buildable) skip combat entirely until
    // every resource bar tops up.
    if (unit.buildable && !unit.buildable.isComplete) continue;

    const combat = unit.combat;
    const { cos, sin } = getTransformCosSin(unit.transform);
    const activeMask = combat.activeTurretMask;
    const currentTick = world.getTick();
    const unitGroundZ = getUnitGroundZ(unit);

    const turrets = combat.turrets;
    for (let weaponIndex = 0; weaponIndex < turrets.length; weaponIndex++) {
      if (!turretMaskIncludes(activeMask, weaponIndex)) continue;
      const weapon = turrets[weaponIndex];
      if (weapon.config.visualOnly) continue;
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
        weapon.aimTargetYaw = 0;
        weapon.aimTargetPitch = Math.PI / 2;
        weapon.aimErrorYaw = 0;
        weapon.aimErrorPitch = 0;
        weapon.ballisticAimInRange = true;
        continue;
      }

      // --- 1) Derive per-axis target pose for this tick. ---
      let targetAngle: number | null = null;
      let targetPitch = 0;
      let hasActiveTarget = false;
      weapon.ballisticAimInRange = true;

      if (weapon.target !== null) {
        const target = world.getEntity(weapon.target);
        if (target) {
          // Origin (weapon mount) in true 3D world coords. The
          // targeting system runs earlier in the same tick and
          // populates `weapon.worldPos.{x,y,z}` through
          // updateWeaponWorldKinematics, which applies the chassis tilt
          // to the chassis-local mount
          // — exactly the same point projectile spawn and beam tracer
          // use. Reading those three numbers here keeps aim, fire,
          // and the rendered barrel locked together on slopes; if for
          // any reason worldPos isn't populated (very first tick on a
          // newly spawned unit) we fall back to the upright math.
          const mount = resolveWeaponWorldMount(
            unit, weapon, weaponIndex,
            cos, sin,
            { currentTick, unitGroundZ, surfaceN: unit.unit?.surfaceNormal },
            _turretMount,
          );
          const weaponX = mount.x;
          const weaponY = mount.y;
          const mountZ = mount.z;

          // One aiming path for every turret:
          // - direct/line weapons resolve a target body/collider point,
          // - projectile weapons add lead + gravity,
          // - mirrors resolve the bisector point between enemy turret
          //   center and enemy body center.
          const solved = solveTurretAim(
            unit,
            weapon,
            target,
            weaponX, weaponY, mountZ,
            weapon.pitch,
            currentTick,
            (x, y) => world.getGroundZ(x, y),
            _turretAim,
          );
          if (solved) {
            weapon.ballisticAimInRange = solved.hasBallisticSolution;
            if (!solved.hasBallisticSolution) {
              const bit = turretBit(weaponIndex);
              if (bit !== 0 && combat.firingTurretMask >= 0) {
                combat.firingTurretMask &= ~bit;
              }
            }
            targetAngle = solved.yaw;
            targetPitch = solved.pitch;
            hasActiveTarget = true;
          }
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
      const aimTargetYaw = targetAngle!;
      const aimTargetPitch = targetPitch;
      const yawDiff = normalizeAngle(aimTargetYaw - weapon.rotation);
      const yawAccel = yawDiff * k - weapon.angularVelocity * c;
      weapon.angularVelocity += yawAccel * dtSec;
      weapon.rotation = normalizeAngle(weapon.rotation + weapon.angularVelocity * dtSec);

      // Pitch — straight difference; clamp the integrated pitch so
      // the barrel doesn't rotate past vertical.
      const pitchDiff = aimTargetPitch - weapon.pitch;
      const pitchAccel = pitchDiff * k - weapon.pitchVelocity * c;
      weapon.pitchVelocity += pitchAccel * dtSec;
      let newPitch = weapon.pitch + weapon.pitchVelocity * dtSec;
      if (newPitch < PITCH_MIN) { newPitch = PITCH_MIN; weapon.pitchVelocity = 0; }
      else if (newPitch > PITCH_MAX) { newPitch = PITCH_MAX; weapon.pitchVelocity = 0; }
      weapon.pitch = newPitch;
      weapon.aimTargetYaw = aimTargetYaw;
      weapon.aimTargetPitch = aimTargetPitch;
      weapon.aimErrorYaw = normalizeAngle(aimTargetYaw - weapon.rotation);
      weapon.aimErrorPitch = aimTargetPitch - weapon.pitch;
    }
  }
}
