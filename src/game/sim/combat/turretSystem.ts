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
import type { CombatComponent, Entity, Turret } from '../types';
import { resolveWeaponWorldMount, turretMaskIncludes } from './combatUtils';
import {
  dropTurretLockMidTick,
  readActiveTurretMaskForUnit,
  refreshSlabActivityMasksForUnit,
} from './combatActivitySlab';
import { isBuildBlockingActivation } from '../buildableHelpers';
import { getTransformCosSin } from '../../math';
import { createTurretAimScratch, solveTurretAim, solveTurretAimAtGroundPoint } from './aimSolver';
import {
  readCombatTargetingTurretFsmInto,
  type CombatTargetingTurretFsmOut,
} from './targetingInputStamping';
import { getUnitGroundZ } from '../unitGeometry';
import { getSimWasm } from '../../sim-wasm/init';

/** Pitch is clamped to straight-down → straight-up. Matches the
 *  renderer's pitch range and keeps the ballistic solver from driving
 *  the barrel through the body. */
const PITCH_MIN = -Math.PI / 2;
const PITCH_MAX = Math.PI / 2;
const _turretAim = createTurretAimScratch();
const _turretMount = { x: 0, y: 0, z: 0 };
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
    const hostSurfaceNormal = hostUnit !== null ? hostUnit.surfaceNormal : undefined;
    if (hostHp <= 0) continue;
    // Inert shells (in-progress buildable) skip combat entirely until
    // every resource bar tops up.
    if (isBuildBlockingActivation(unit.buildable)) continue;
    _turretRotationRefreshUnits.push(unit);

    const { cos, sin } = getTransformCosSin(unit.transform);
    const activeMask = readActiveTurretMaskForUnit(unit);
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
        const targetPoint = unit.combat.priorityTargetPoint;
        const mount = resolveWeaponWorldMount(
          unit, weapon, weaponIndex,
          cos, sin,
          { currentTick, unitGroundZ, surfaceN: hostSurfaceNormal },
          _turretMount,
        );
        const solved = solveTurretAimAtGroundPoint(
          unit,
          weapon,
          weaponIndex,
          targetPoint,
          mount.x, mount.y, mount.z,
          weapon.pitch,
          (x, y) => world.getGroundZ(x, y),
          _turretAim,
          currentTick,
        );
        weapon.ballisticAimInRange = solved.hasBallisticSolution;
        if (!solved.hasBallisticSolution) {
          // Drop the lock everywhere in one call (JS Turret target +
          // state, beam inverse index, slab FSM). The local
          // activeMask bit stays set so we still run the damped-spring
          // integrator below; the firing bit drops on its own when the
          // end-of-pass refresh re-derives masks.
          dropTurretLockMidTick(unit, weaponIndex);
        } else {
          targetAngle = solved.yaw;
          targetPitch = solved.pitch;
          hasActiveTarget = true;
        }
      } else if (targetingTargetId !== -1) {
        const target = world.getEntity(targetingTargetId);
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
            { currentTick, unitGroundZ, surfaceN: hostSurfaceNormal },
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
            weaponIndex,
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
              // No real ballistic solution exists — the target is in
              // horizontal acquire range but beyond the projectile's
              // gravity-bounded reach. Drop the lock outright so the
              // turret is free to find a reachable target instead of
              // silently tracking a fallback "best-guess" pitch
              // forever. Single helper call clears JS Turret + beam
              // index + slab FSM in one step.
              dropTurretLockMidTick(unit, weaponIndex);
            } else {
              targetAngle = solved.yaw;
              targetPitch = solved.pitch;
              hasActiveTarget = true;
            }
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

      // --- 2) Damped-spring integrate both axes toward targets. ---
      // Rust/WASM owns the damped-spring yaw/pitch integration for all
      // queued turrets in one batch. TypeScript only supplies target poses
      // after resolving target policy and ballistic aim.
      const aimTargetYaw = targetAngle!;
      const aimTargetPitch = targetPitch;
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
