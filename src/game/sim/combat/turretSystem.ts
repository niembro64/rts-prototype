// Turret rotation system — damped-spring integrator on both yaw and
// pitch. The solver picks a target pose each tick (target bearing for
// yaw, ballistic-arc angle for pitch); the damper converges the
// weapon's current pose on that target along an overshoot-free curve,
// so tick-to-tick jitter in the solver (e.g. a ballistic solution
// that wobbles slightly as the target moves) doesn't propagate into
// visible barrel oscillation. Continuous beam rays are the exception:
// once they have a solved active target, they snap directly to the
// target pose so the simulated beam trace is locked on immediately.
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
import type { CombatComponent, Entity, Turret } from '../types';
import { turretMaskIncludes } from './combatUtils';
import {
  dropTurretLockMidTick,
  readActiveTurretMaskForUnit,
  refreshSlabActivityMasksForUnit,
} from './combatActivitySlab';
import { isBuildBlockingActivation } from '../buildableHelpers';
import {
  readCombatTargetingTurretAimInto,
  readCombatTargetingTurretFsmInto,
  type CombatTargetingTurretAimOut,
  type CombatTargetingTurretFsmOut,
} from './targetingInputStamping';
import { getSimWasm } from '../../sim-wasm/init';

/** Pitch is clamped to straight-down → straight-up. Matches the
 *  renderer's pitch range and keeps the ballistic solver from driving
 *  the barrel through the body. */
const PITCH_MIN = -Math.PI / 2;
const PITCH_MAX = Math.PI / 2;
const _turretAimPose: CombatTargetingTurretAimOut = {
  hasSolution: true,
  yaw: 0,
  pitch: 0,
};
const _turretRotationFsm: CombatTargetingTurretFsmOut = {
  stateCode: 0,
  targetId: -1,
};
const _turretRotationWeapons: Turret[] = [];
const _turretRotationRefreshUnits: Entity[] = [];
let _turretCurrentYaw = new Float64Array(0);
let _turretYawVelocity = new Float64Array(0);
let _turretTargetYaw = new Float64Array(0);
let _turretCurrentPitch = new Float64Array(0);
let _turretPitchVelocity = new Float64Array(0);
let _turretTargetPitch = new Float64Array(0);
let _turretTurnAccel = new Float64Array(0);
let _turretDrag = new Float64Array(0);
let _turretOutYaw = new Float64Array(0);
let _turretOutYawVelocity = new Float64Array(0);
let _turretOutYawAcceleration = new Float64Array(0);
let _turretOutPitch = new Float64Array(0);
let _turretOutPitchVelocity = new Float64Array(0);
let _turretOutPitchAcceleration = new Float64Array(0);
let _turretOutAimErrorYaw = new Float64Array(0);
let _turretOutAimErrorPitch = new Float64Array(0);

function ensureTurretRotationCapacity(required: number): void {
  if (_turretCurrentYaw.length >= required) return;
  const next = Math.max(64, required, _turretCurrentYaw.length * 2);
  _turretCurrentYaw = new Float64Array(next);
  _turretYawVelocity = new Float64Array(next);
  _turretTargetYaw = new Float64Array(next);
  _turretCurrentPitch = new Float64Array(next);
  _turretPitchVelocity = new Float64Array(next);
  _turretTargetPitch = new Float64Array(next);
  _turretTurnAccel = new Float64Array(next);
  _turretDrag = new Float64Array(next);
  _turretOutYaw = new Float64Array(next);
  _turretOutYawVelocity = new Float64Array(next);
  _turretOutYawAcceleration = new Float64Array(next);
  _turretOutPitch = new Float64Array(next);
  _turretOutPitchVelocity = new Float64Array(next);
  _turretOutPitchAcceleration = new Float64Array(next);
  _turretOutAimErrorYaw = new Float64Array(next);
  _turretOutAimErrorPitch = new Float64Array(next);
}

function queueTurretRotationStep(weapon: Turret, aimTargetYaw: number, aimTargetPitch: number): void {
  const index = _turretRotationWeapons.length;
  ensureTurretRotationCapacity(index + 1);
  _turretRotationWeapons.push(weapon);
  _turretCurrentYaw[index] = weapon.rotation;
  _turretYawVelocity[index] = weapon.angularVelocity;
  _turretTargetYaw[index] = aimTargetYaw;
  _turretCurrentPitch[index] = weapon.pitch;
  _turretPitchVelocity[index] = weapon.pitchVelocity;
  _turretTargetPitch[index] = aimTargetPitch;
  _turretTurnAccel[index] = weapon.turnAccel;
  _turretDrag[index] = weapon.drag;
}

function flushTurretRotationBatch(dtSec: number): void {
  const count = _turretRotationWeapons.length;
  if (count === 0) return;

  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('updateTurretRotation: sim-wasm is not initialized');
  }

  const updated = sim.turretRotationStepBatch(
    _turretCurrentYaw,
    _turretYawVelocity,
    _turretTargetYaw,
    _turretCurrentPitch,
    _turretPitchVelocity,
    _turretTargetPitch,
    _turretTurnAccel,
    _turretDrag,
    _turretOutYaw,
    _turretOutYawVelocity,
    _turretOutYawAcceleration,
    _turretOutPitch,
    _turretOutPitchVelocity,
    _turretOutPitchAcceleration,
    _turretOutAimErrorYaw,
    _turretOutAimErrorPitch,
    count,
    dtSec,
    PITCH_MIN,
    PITCH_MAX,
  );
  if (updated !== count) {
    throw new Error(`updateTurretRotation: turret_rotation_step_batch updated ${updated} of ${count} rows`);
  }

  for (let i = 0; i < count; i++) {
    const weapon = _turretRotationWeapons[i];
    weapon.rotation = _turretOutYaw[i];
    weapon.angularVelocity = _turretOutYawVelocity[i];
    weapon.angularAcceleration = _turretOutYawAcceleration[i];
    weapon.pitch = _turretOutPitch[i];
    weapon.pitchVelocity = _turretOutPitchVelocity[i];
    weapon.pitchAcceleration = _turretOutPitchAcceleration[i];
    weapon.aimTargetYaw = _turretTargetYaw[i];
    weapon.aimTargetPitch = _turretTargetPitch[i];
    weapon.aimErrorYaw = _turretOutAimErrorYaw[i];
    weapon.aimErrorPitch = _turretOutAimErrorPitch[i];
  }
}

function isInstantLockBeamWeapon(weapon: Turret): boolean {
  const shot = weapon.config.shot;
  return shot !== null && shot.type === 'beam';
}

function weaponUsesRotationAim(weapon: Turret): boolean {
  const config = weapon.config;
  if (config.visualOnly || config.verticalLauncher || config.isManualFire) return false;
  const shot = config.shot;
  if (
    shot !== null &&
    shot.type === 'shield' &&
    config.aimStyle.angleType !== 'rayBisectTurretAndBody' &&
    shot.barrier?.shape !== 'aimedCylinder'
  ) {
    return false;
  }
  return true;
}

function snapTurretAimToTarget(weapon: Turret, aimTargetYaw: number, aimTargetPitch: number): void {
  const clampedPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, aimTargetPitch));
  weapon.rotation = aimTargetYaw;
  weapon.angularVelocity = 0;
  weapon.angularAcceleration = 0;
  weapon.pitch = clampedPitch;
  weapon.pitchVelocity = 0;
  weapon.pitchAcceleration = 0;
  weapon.aimTargetYaw = aimTargetYaw;
  weapon.aimTargetPitch = clampedPitch;
  weapon.aimErrorYaw = 0;
  weapon.aimErrorPitch = 0;
}

export function updateTurretRotation(world: WorldState, dtMs: number, units: readonly Entity[] = world.getArmedEntities()): void {
  const dtSec = dtMs / 1000;
  _turretRotationWeapons.length = 0;
  _turretRotationRefreshUnits.length = 0;

  for (const unit of units) {
    if (!unit.combat || !unit.ownership) continue;
    const combat = unit.combat;
    const hostUnit = unit.unit;
    const hostBuilding = unit.building;
    const hostHp = hostUnit !== null
      ? hostUnit.hp
      : hostBuilding !== null
        ? hostBuilding.hp
        : 0;
    if (hostHp <= 0) continue;
    // Inert shells (in-progress buildable) skip combat entirely until
    // every resource bar tops up.
    if (isBuildBlockingActivation(unit.buildable)) continue;
    _turretRotationRefreshUnits.push(unit);

    const activeMask = readActiveTurretMaskForUnit(unit);

    const turrets = combat.turrets;
    for (let weaponIndex = 0; weaponIndex < turrets.length; weaponIndex++) {
      if (!turretMaskIncludes(activeMask, weaponIndex)) continue;
      const weapon = turrets[weaponIndex];
      if (weapon.config.visualOnly) continue;
      // Vertical launchers skip the normal yaw/pitch aim math — the
      // turret always points straight up and each fired rocket picks
      // a random cone-from-vertical direction at launch (projectile-
      // System handles that). Targeting state still runs in the Rust
      // scheduler bridge so the weapon acquires a homing target, but
      // here we just pin the pose so the rendered barrels stay
      // skyward and the gatling spin (driven by engagement state)
      // keeps working.
      if (weapon.config.verticalLauncher) {
        weapon.rotation = 0;
        weapon.angularVelocity = 0;
        weapon.angularAcceleration = 0;
        weapon.pitch = Math.PI / 2;
        weapon.pitchVelocity = 0;
        weapon.pitchAcceleration = 0;
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
      const targetingTargetId = readCombatTargetingTurretFsmInto(
        unit,
        weaponIndex,
        _turretRotationFsm,
      )
        ? _turretRotationFsm.targetId
        : (weapon.target ?? -1);

      if (unit.combat.priorityTargetPoint !== null) {
        if (!weaponUsesRotationAim(weapon)) {
          targetAngle = weapon.rotation;
          targetPitch = weapon.pitch;
          hasActiveTarget = true;
        } else if (readCombatTargetingTurretAimInto(unit, weaponIndex, _turretAimPose)) {
          weapon.ballisticAimInRange = _turretAimPose.hasSolution;
          if (!_turretAimPose.hasSolution) {
            // Drop the lock everywhere in one call (JS Turret target +
            // state, beam inverse index, slab FSM). The local
            // activeMask bit stays set so we still run the damped-spring
            // integrator below; the firing bit drops on its own when the
            // end-of-pass refresh re-derives masks.
            dropTurretLockMidTick(unit, weaponIndex);
          } else {
            targetAngle = _turretAimPose.yaw;
            targetPitch = _turretAimPose.pitch;
            hasActiveTarget = true;
          }
        }
      } else if (targetingTargetId !== -1) {
        if (!weaponUsesRotationAim(weapon)) {
          targetAngle = weapon.rotation;
          targetPitch = weapon.pitch;
          hasActiveTarget = true;
        } else if (readCombatTargetingTurretAimInto(unit, weaponIndex, _turretAimPose)) {
          weapon.ballisticAimInRange = _turretAimPose.hasSolution;
          if (!_turretAimPose.hasSolution) {
            // Drop the lock everywhere in one call (JS Turret target +
            // state, beam inverse index, slab FSM). The local
            // activeMask bit stays set so we still run the damped-spring
            // integrator below; the firing bit drops on its own when the
            // end-of-pass refresh re-derives masks.
            dropTurretLockMidTick(unit, weaponIndex);
          } else {
            targetAngle = _turretAimPose.yaw;
            targetPitch = _turretAimPose.pitch;
            hasActiveTarget = true;
          }
        }
      }

      if (!hasActiveTarget) {
        // No target means no authored default pose. Hold the current
        // yaw/pitch as the spring target and let the normal derivative
        // state decay through the same integrator used while tracking.
        targetAngle = weapon.rotation;
        targetPitch = weapon.pitch;
      }

      // --- 2) Move both axes toward targets. ---
      // Continuous beams trace instant endpoint damage, so their
      // simulation aim snaps to the solved target pose instead of
      // waiting for the visual spring to converge.
      const aimTargetYaw = targetAngle!;
      const aimTargetPitch = targetPitch;
      if (hasActiveTarget && isInstantLockBeamWeapon(weapon)) {
        snapTurretAimToTarget(weapon, aimTargetYaw, aimTargetPitch);
        continue;
      }

      // Damped-spring integrate non-instant weapons.
      // Rust/WASM owns the damped-spring yaw/pitch integration for all
      // queued turrets in one batch. TypeScript only supplies target poses
      // after resolving target policy and ballistic aim.
      queueTurretRotationStep(weapon, aimTargetYaw, aimTargetPitch);
    }
  }

  flushTurretRotationBatch(dtSec);
  for (let i = 0; i < _turretRotationRefreshUnits.length; i++) {
    const unit = _turretRotationRefreshUnits[i];
    const combat: CombatComponent | null = unit.combat;
    if (combat !== null) refreshSlabActivityMasksForUnit(unit, combat);
  }
  _turretRotationWeapons.length = 0;
  _turretRotationRefreshUnits.length = 0;
}
