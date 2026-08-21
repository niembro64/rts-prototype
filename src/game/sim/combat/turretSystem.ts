// Turret rotation system. World-space aim intent is converted into each
// station's local parent frame; the Rust actuator applies hard authored
// angular-speed, angular-acceleration, traverse, and restore limits.

import type { WorldState } from '../WorldState';
import type { CombatComponent, Entity, Turret } from '../types';
import {
  turretMaskIncludes,
  writeTurretArticulationParentYaw,
  type TurretArticulationParentYaw,
} from './combatUtils';
import { normalizeAngle } from '../../math';
import {
  dropTurretLockMidTick,
  refreshSlabActivityMasksForUnit,
} from './combatActivitySlab';
import { isBuildBlockingActivation } from '../buildableHelpers';
import {
  getCombatTargetingEntityReadContext,
  readCombatTargetingTurretAimFromContextInto,
  readCombatTargetingTurretFsmFromContextInto,
  type CombatTargetingEntityReadContext,
  type CombatTargetingTurretAimOut,
  type CombatTargetingTurretFsmOut,
} from './targetingInputStamping';
import { getSimWasm } from '../../sim-wasm/init';
import { isAttackEmitter, isManualEmitterConfig } from '../emitterKinds';
import { growScratchArray } from '../scratchArrayGrowth';
import { beamIndex } from '../BeamIndex';
import { evaluateBeamPulsePlan, type BeamPulseEvaluation } from './beamPulse';
import {
  isBuildingAimPieceAttachment,
  selectBuildingHostPieceTurretIndex,
} from '../../math/BuildingHostSocketGeometry';

const _turretAimPose: CombatTargetingTurretAimOut = {
  hasSolution: true,
  yaw: 0,
  pitch: 0,
};
const _turretRotationFsm: CombatTargetingTurretFsmOut = {
  stateCode: 0,
  targetId: -1,
};
const _turretBeamPulseAim: BeamPulseEvaluation = {
  sourceX: 0,
  sourceY: 0,
  sourceZ: 0,
  targetX: 0,
  targetY: 0,
  targetZ: 0,
  dirX: 1,
  dirY: 0,
  dirZ: 0,
  yaw: 0,
  pitch: 0,
};
const _turretTargetingContext: CombatTargetingEntityReadContext = {
  views: null as never,
  slot: -1,
  turretBase: -1,
  turretCount: 0,
};
const _turretRotationWeapons: Turret[] = [];
const _turretRotationRefreshUnits: Entity[] = [];
let _turretCurrentYaw = new Float64Array(0);
let _turretYawVelocity = new Float64Array(0);
let _turretTargetYaw = new Float64Array(0);
let _turretTargetWorldYaw = new Float64Array(0);
let _turretParentYaw = new Float64Array(0);
let _turretParentYawVelocity = new Float64Array(0);
let _turretYawContinuous = new Uint8Array(0);
let _turretYawMin = new Float64Array(0);
let _turretYawMax = new Float64Array(0);
let _turretYawMaxSpeed = new Float64Array(0);
let _turretYawMaxAcceleration = new Float64Array(0);
let _turretCurrentPitch = new Float64Array(0);
let _turretPitchVelocity = new Float64Array(0);
let _turretTargetPitch = new Float64Array(0);
let _turretPitchMin = new Float64Array(0);
let _turretPitchMax = new Float64Array(0);
let _turretPitchMaxSpeed = new Float64Array(0);
let _turretPitchMaxAcceleration = new Float64Array(0);
let _turretOutYaw = new Float64Array(0);
let _turretOutYawVelocity = new Float64Array(0);
let _turretOutYawAcceleration = new Float64Array(0);
let _turretOutPitch = new Float64Array(0);
let _turretOutPitchVelocity = new Float64Array(0);
let _turretOutPitchAcceleration = new Float64Array(0);
let _turretOutAimErrorYaw = new Float64Array(0);
let _turretOutAimErrorPitch = new Float64Array(0);
const _turretParentYawScratch: TurretArticulationParentYaw = { yaw: 0, velocity: 0 };

// Grows PER QUEUED ROW (queueTurretRotationStep), so rows already written
// this tick must survive the reallocation — see scratchArrayGrowth.ts for
// the determinism leak a contents-dropping growth causes here.
function ensureTurretRotationCapacity(required: number): void {
  if (_turretCurrentYaw.length >= required) return;
  const next = Math.max(64, required, _turretCurrentYaw.length * 2);
  _turretCurrentYaw = growScratchArray(_turretCurrentYaw, next);
  _turretYawVelocity = growScratchArray(_turretYawVelocity, next);
  _turretTargetYaw = growScratchArray(_turretTargetYaw, next);
  _turretTargetWorldYaw = growScratchArray(_turretTargetWorldYaw, next);
  _turretParentYaw = growScratchArray(_turretParentYaw, next);
  _turretParentYawVelocity = growScratchArray(_turretParentYawVelocity, next);
  _turretYawContinuous = growScratchArray(_turretYawContinuous, next);
  _turretYawMin = growScratchArray(_turretYawMin, next);
  _turretYawMax = growScratchArray(_turretYawMax, next);
  _turretYawMaxSpeed = growScratchArray(_turretYawMaxSpeed, next);
  _turretYawMaxAcceleration = growScratchArray(_turretYawMaxAcceleration, next);
  _turretCurrentPitch = growScratchArray(_turretCurrentPitch, next);
  _turretPitchVelocity = growScratchArray(_turretPitchVelocity, next);
  _turretTargetPitch = growScratchArray(_turretTargetPitch, next);
  _turretPitchMin = growScratchArray(_turretPitchMin, next);
  _turretPitchMax = growScratchArray(_turretPitchMax, next);
  _turretPitchMaxSpeed = growScratchArray(_turretPitchMaxSpeed, next);
  _turretPitchMaxAcceleration = growScratchArray(_turretPitchMaxAcceleration, next);
  _turretOutYaw = growScratchArray(_turretOutYaw, next);
  _turretOutYawVelocity = growScratchArray(_turretOutYawVelocity, next);
  _turretOutYawAcceleration = growScratchArray(_turretOutYawAcceleration, next);
  _turretOutPitch = growScratchArray(_turretOutPitch, next);
  _turretOutPitchVelocity = growScratchArray(_turretOutPitchVelocity, next);
  _turretOutPitchAcceleration = growScratchArray(_turretOutPitchAcceleration, next);
  _turretOutAimErrorYaw = growScratchArray(_turretOutAimErrorYaw, next);
  _turretOutAimErrorPitch = growScratchArray(_turretOutAimErrorPitch, next);
}

function queueTurretRotationStep(
  weapon: Turret,
  parentYaw: number,
  parentYawVelocity: number,
  aimTargetWorldYaw: number,
  aimTargetPitch: number,
): void {
  const index = _turretRotationWeapons.length;
  ensureTurretRotationCapacity(index + 1);
  _turretRotationWeapons.push(weapon);
  const articulation = weapon.config.articulation;
  const actuator = weapon.config.angular;
  _turretCurrentYaw[index] = weapon.localYaw;
  _turretYawVelocity[index] = weapon.localYawVelocity;
  _turretTargetYaw[index] = normalizeAngle(aimTargetWorldYaw - parentYaw);
  _turretTargetWorldYaw[index] = aimTargetWorldYaw;
  _turretParentYaw[index] = parentYaw;
  _turretParentYawVelocity[index] = parentYawVelocity;
  _turretYawContinuous[index] = articulation.yaw.continuous ? 1 : 0;
  _turretYawMin[index] = articulation.yaw.minAngle;
  _turretYawMax[index] = articulation.yaw.maxAngle;
  _turretYawMaxSpeed[index] = actuator.yaw.maxSpeed;
  _turretYawMaxAcceleration[index] = actuator.yaw.maxAcceleration;
  _turretCurrentPitch[index] = weapon.localPitch;
  _turretPitchVelocity[index] = weapon.localPitchVelocity;
  _turretTargetPitch[index] = aimTargetPitch;
  _turretPitchMin[index] = articulation.pitch.minAngle;
  _turretPitchMax[index] = articulation.pitch.maxAngle;
  _turretPitchMaxSpeed[index] = actuator.pitch.maxSpeed;
  _turretPitchMaxAcceleration[index] = actuator.pitch.maxAcceleration;
}

function flushTurretRotationBatch(dtSec: number): void {
  const count = _turretRotationWeapons.length;
  if (count === 0) return;

  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('updateTurretRotation: sim-wasm is not initialized');
  }

  const updated = sim.articulationJointStepBatch(
    _turretCurrentYaw,
    _turretYawVelocity,
    _turretTargetYaw,
    _turretYawContinuous,
    _turretYawMin,
    _turretYawMax,
    _turretYawMaxSpeed,
    _turretYawMaxAcceleration,
    _turretCurrentPitch,
    _turretPitchVelocity,
    _turretTargetPitch,
    _turretPitchMin,
    _turretPitchMax,
    _turretPitchMaxSpeed,
    _turretPitchMaxAcceleration,
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
  );
  if (updated !== count) {
    throw new Error(`updateTurretRotation: articulation_joint_step_batch updated ${updated} of ${count} rows`);
  }

  for (let i = 0; i < count; i++) {
    const weapon = _turretRotationWeapons[i];
    weapon.localYaw = _turretOutYaw[i];
    weapon.localYawVelocity = _turretOutYawVelocity[i];
    weapon.localPitch = _turretOutPitch[i];
    weapon.localPitchVelocity = _turretOutPitchVelocity[i];
    weapon.rotation = normalizeAngle(_turretParentYaw[i] + weapon.localYaw);
    weapon.angularVelocity = _turretParentYawVelocity[i] + weapon.localYawVelocity;
    weapon.angularAcceleration = _turretOutYawAcceleration[i];
    weapon.pitch = weapon.localPitch;
    weapon.pitchVelocity = weapon.localPitchVelocity;
    weapon.pitchAcceleration = _turretOutPitchAcceleration[i];
    weapon.articulationParentYaw = _turretParentYaw[i];
    weapon.aimTargetYaw = _turretTargetWorldYaw[i];
    weapon.aimTargetPitch = _turretTargetPitch[i];
    weapon.aimErrorYaw = normalizeAngle(_turretTargetWorldYaw[i] - weapon.rotation);
    weapon.aimErrorPitch = _turretOutAimErrorPitch[i];
  }
}

function weaponUsesRotationAim(weapon: Turret): boolean {
  const config = weapon.config;
  if (!isAttackEmitter(weapon) || config.verticalLauncher || isManualEmitterConfig(config)) return false;
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

/** Include committed-pulse hosts even if live targeting went idle after the
 * captured target died or left range. The fired plan, not the current lock,
 * owns the turret until the pulse expires. */
export function collectTurretRotationUnits(
  world: WorldState,
  _activeTargetingUnits: readonly Entity[],
): readonly Entity[] {
  // Local joints must follow a moving parent and complete delayed restoration
  // even without a targeting probe. The Rust batch keeps the numeric work
  // dense; skipping idle hosts here would reintroduce world-locked turrets as
  // soon as a chassis turned between acquisition scans.
  return world.getArmedEntities();
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

    const hasTargetingContext = getCombatTargetingEntityReadContext(unit, _turretTargetingContext);
    const activeMask = hasTargetingContext
      ? _turretTargetingContext.views.activeTurretMask[_turretTargetingContext.slot]
      : 0;

    const turrets = combat.turrets;
    for (let weaponIndex = 0; weaponIndex < turrets.length; weaponIndex++) {
      const weapon = turrets[weaponIndex];
      const activeBeamId = beamIndex.getBeam(unit.id, weaponIndex);
      const activeBeam = activeBeamId === undefined ? undefined : world.getEntity(activeBeamId);
      const activeBeamProjectile = activeBeam?.projectile ?? null;
      const activeBeamPulsePlan = activeBeamProjectile?.beamPulsePlan ?? null;
      if (!isAttackEmitter(weapon)) continue;
      const activeByTargeting = turretMaskIncludes(activeMask, weaponIndex);
      const parent = writeTurretArticulationParentYaw(
        unit,
        weapon,
        _turretParentYawScratch,
      );
      // Vertical launchers skip normal yaw/pitch aim math. The turret
      // barrel itself is pinned straight up; projectile launch reads
      // this same barrel pose and applies the authored launch force.
      // Targeting still runs so the fired rocket can inherit a lock.
      if (weapon.config.verticalLauncher) {
        weapon.localYaw = weapon.config.articulation.restYaw;
        weapon.localYawVelocity = 0;
        weapon.localPitch = Math.PI / 2;
        weapon.localPitchVelocity = 0;
        weapon.rotation = normalizeAngle(parent.yaw + weapon.localYaw);
        weapon.angularVelocity = parent.velocity;
        weapon.angularAcceleration = 0;
        weapon.pitch = Math.PI / 2;
        weapon.pitchVelocity = 0;
        weapon.pitchAcceleration = 0;
        weapon.articulationParentYaw = parent.yaw;
        weapon.aimTargetYaw = weapon.rotation;
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
      const targetingTargetId = hasTargetingContext &&
        readCombatTargetingTurretFsmFromContextInto(
          _turretTargetingContext,
          weaponIndex,
          _turretRotationFsm,
        )
        ? _turretRotationFsm.targetId
        : (weapon.target ?? -1);

      if (activeBeamPulsePlan !== null && activeBeamProjectile !== null) {
        // While the pulse is on, the turret follows the immutable trajectory
        // captured at emission. Losing or changing the live lock cannot steer
        // an already-fired beam onto a new path.
        const pulseAim = evaluateBeamPulsePlan(
          activeBeamPulsePlan,
          // updateProjectiles advances the beam later in this same fixed tick;
          // aim at that end-of-tick sample so the barrel and traced ray do not
          // carry a permanent one-tick phase offset.
          activeBeamProjectile.timeAlive + dtMs,
          _turretBeamPulseAim,
        );
        targetAngle = pulseAim.yaw;
        targetPitch = pulseAim.pitch;
        hasActiveTarget = true;
      } else if (unit.combat.priorityTargetPoint !== null) {
        if (!weaponUsesRotationAim(weapon)) {
          targetAngle = weapon.rotation;
          targetPitch = weapon.pitch;
          hasActiveTarget = true;
        } else if (
          hasTargetingContext &&
          readCombatTargetingTurretAimFromContextInto(
            _turretTargetingContext,
            weaponIndex,
            _turretAimPose,
          )
        ) {
          weapon.ballisticAimInRange = _turretAimPose.hasSolution;
          if (!_turretAimPose.hasSolution) {
            // Drop the lock everywhere in one call (JS Turret target +
            // state, beam inverse index, slab FSM). The local
            // activeMask bit stays set so we still run the bounded joint
            // motor below; the firing bit drops on its own when the
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
        } else if (
          hasTargetingContext &&
          readCombatTargetingTurretAimFromContextInto(
            _turretTargetingContext,
            weaponIndex,
            _turretAimPose,
          )
        ) {
          weapon.ballisticAimInRange = _turretAimPose.hasSolution;
          if (!_turretAimPose.hasSolution) {
            // Drop the lock everywhere in one call (JS Turret target +
            // state, beam inverse index, slab FSM). The local
            // activeMask bit stays set so we still run the bounded joint
            // motor below; the firing bit drops on its own when the
            // end-of-pass refresh re-derives masks.
            dropTurretLockMidTick(unit, weaponIndex);
          } else {
            targetAngle = _turretAimPose.yaw;
            targetPitch = _turretAimPose.pitch;
            hasActiveTarget = true;
          }
        }
      }

      // A scheduled active bit can survive one tick around target transitions;
      // only a real target/committed pulse owns the station mechanism.
      if (hasTargetingContext && !activeByTargeting && activeBeamPulsePlan === null) {
        hasActiveTarget = false;
      }

      if (!hasActiveTarget) {
        weapon.articulationIdleMs += dtMs;
        // A rest angle is a chassis idea: it is where the weapon sits relative
        // to a body that has a forward. A structure has no forward, so its
        // turrets simply stay where the last engagement left them and keep
        // covering that bearing — see budget_design_philosophy.html,
        // "A building turret has no rest angle". Units are unchanged.
        const restore = hostBuilding === null &&
          weapon.articulationIdleMs >= weapon.config.articulation.restoreDelayMs;
        // Before BAR-style restore delay expires, hold the current LOCAL pose.
        // The world pose therefore follows a turning host instead of remaining
        // nailed to the old compass bearing.
        const targetLocalYaw = restore
          ? weapon.config.articulation.restYaw
          : weapon.localYaw;
        targetAngle = normalizeAngle(parent.yaw + targetLocalYaw);
        targetPitch = restore
          ? weapon.config.articulation.restPitch
          : weapon.localPitch;
      } else {
        weapon.articulationIdleMs = 0;
      }

      // --- 2) Move both axes toward targets. ---
      const aimTargetYaw = targetAngle!;
      const aimTargetPitch = targetPitch;
      const hostAttachment = weapon.config.hostAttachment;
      if (isBuildingAimPieceAttachment(hostAttachment)) {
        const ownerIndex = selectBuildingHostPieceTurretIndex(turrets, hostAttachment.piece);
        const owner = ownerIndex >= 0 ? turrets[ownerIndex] : undefined;
        const sharedYaw = owner !== undefined && Number.isFinite(owner.hostPieceYaw)
          ? owner.hostPieceYaw
          : unit.transform.rotation;
        const sharedPitch = owner?.pitch ?? 0;
        weapon.localYaw = 0;
        weapon.localYawVelocity = 0;
        weapon.localPitch = 0;
        weapon.localPitchVelocity = 0;
        weapon.rotation = sharedYaw;
        weapon.angularVelocity = owner?.hostPieceYawVelocity ?? 0;
        weapon.angularAcceleration = owner?.angularAcceleration ?? 0;
        weapon.pitch = sharedPitch;
        weapon.pitchVelocity = owner?.pitchVelocity ?? 0;
        weapon.pitchAcceleration = owner?.pitchAcceleration ?? 0;
        weapon.articulationParentYaw = sharedYaw;
        weapon.aimTargetYaw = aimTargetYaw;
        weapon.aimTargetPitch = aimTargetPitch;
        weapon.aimErrorYaw = normalizeAngle(aimTargetYaw - sharedYaw);
        weapon.aimErrorPitch = aimTargetPitch - sharedPitch;
        continue;
      }
      // Rust/WASM owns the bounded yaw/pitch joint integration for all
      // queued turrets in one batch. TypeScript only supplies target poses
      // after resolving target policy and ballistic aim.
      queueTurretRotationStep(
        weapon,
        parent.yaw,
        parent.velocity,
        aimTargetYaw,
        aimTargetPitch,
      );
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
