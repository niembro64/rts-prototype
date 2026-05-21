// Auto-targeting system - each weapon independently finds targets

import type { WorldState } from '../WorldState';
import type { Entity, Turret } from '../types';
import type { Vec3 } from '@/types/vec2';
import { GRAVITY } from '../../../config';
import { decrementCooldown } from './combatUtils';
import { clearCombatActivityFlags, updateCombatActivityFlags } from './combatActivity';
import { spatialGrid } from '../SpatialGrid';
import { setWeaponTarget } from './targetIndex';
import { getSimWasm } from '../../sim-wasm/init';
import { resolveTargetAimPoint } from './aimSolver';
import {
  COMBAT_LOS_ENTITY_QUERY_WIDTH,
  COMBAT_LOS_TERRAIN_STEP_LEN,
  SIGHT_DROP_GRACE_TICKS,
} from './lineOfSight';
import { getActiveForceFields } from './forceFieldTurret';
import {
  stampCombatTargetingEntity,
  writeBackCombatTargetingEntityKinematics,
  writeBackCombatTargetingEntity,
} from './targetingInputStamping';

const _activeCombatUnits: Entity[] = [];
// AIM-08.5 unified gate inputs shared across priority-target and
// existing-lock kernels. The Rust kernels read per-turret ballistic
// config, mirror-panel, force-field, cloak, LOS, and ballistic gates
// from the slab. Aim points are TS-resolved so
// lockOnToBody/lockOnToTurret stay in one place.
let _ppAimX = new Float64Array(0);
let _ppAimY = new Float64Array(0);
let _ppAimZ = new Float64Array(0);
const _gateAimPointScratch: Vec3 = { x: 0, y: 0, z: 0 };
const _autoBatchUnits: Entity[] = [];
let _autoBatchSlots = new Uint32Array(0);
let _autoBatchSourceIds = new Int32Array(0);
let _autoBatchHasCooldown = new Uint8Array(0);
let _autoBatchAimX = new Float64Array(0);
let _autoBatchAimY = new Float64Array(0);
let _autoBatchAimZ = new Float64Array(0);
let _autoBatchCachedFireRanks = new Uint8Array(0);
let _autoBatchCachedFireDistSqs = new Float64Array(0);
let _autoBatchMaxTurrets = 0;

function nextTargetingReacquireTick(tick: number): number {
  return tick + 1;
}

function ensurePerWeaponScratchCapacity(count: number): void {
  if (count <= _ppAimX.length) return;
  let next = Math.max(8, _ppAimX.length);
  while (next < count) next *= 2;
  _ppAimX = new Float64Array(next);
  _ppAimY = new Float64Array(next);
  _ppAimZ = new Float64Array(next);
}

function ensureAutoBatchCapacity(entityCount: number, maxTurrets: number): void {
  if (maxTurrets !== _autoBatchMaxTurrets) {
    _autoBatchSlots = new Uint32Array(0);
    _autoBatchSourceIds = new Int32Array(0);
    _autoBatchHasCooldown = new Uint8Array(0);
    _autoBatchAimX = new Float64Array(0);
    _autoBatchAimY = new Float64Array(0);
    _autoBatchAimZ = new Float64Array(0);
    _autoBatchCachedFireRanks = new Uint8Array(0);
    _autoBatchCachedFireDistSqs = new Float64Array(0);
    _autoBatchMaxTurrets = maxTurrets;
  }
  if (entityCount <= _autoBatchSlots.length) return;
  let next = Math.max(8, _autoBatchSlots.length);
  while (next < entityCount) next *= 2;
  _autoBatchSlots = new Uint32Array(next);
  _autoBatchSourceIds = new Int32Array(next);
  _autoBatchHasCooldown = new Uint8Array(next);
  const turretCapacity = next * maxTurrets;
  _autoBatchAimX = new Float64Array(turretCapacity);
  _autoBatchAimY = new Float64Array(turretCapacity);
  _autoBatchAimZ = new Float64Array(turretCapacity);
  _autoBatchCachedFireRanks = new Uint8Array(turretCapacity);
  _autoBatchCachedFireDistSqs = new Float64Array(turretCapacity);
}

/** Resolve each turret's aim point against a known target entity for
 *  the priority-target gate kernel. The kernel itself reads the
 *  mirror-panel slab + force-field slab + cloak/detector data, so
 *  TS only owes per-turret aim points (lockOnToBody / lockOnToTurret
 *  resolution stays in one place here). */
function fillPriorityTargetGateInputs(
  weapons: Turret[],
  target: Entity,
  source: Entity,
  currentTick: number,
): void {
  for (let wi = 0; wi < weapons.length; wi++) {
    const weapon = weapons[wi];
    resolveTargetAimPoint(
      target,
      weapon.worldPos.x, weapon.worldPos.y, weapon.worldPos.z,
      _gateAimPointScratch,
      {
        lockOnType: weapon.config.aimStyle.lockOnType,
        source,
        currentTick,
      },
    );
    _ppAimX[wi] = _gateAimPointScratch.x;
    _ppAimY[wi] = _gateAimPointScratch.y;
    _ppAimZ[wi] = _gateAimPointScratch.z;
  }
}

/** Resolve per-turret existing-lock inputs: aim point only. Weapons
 *  with no current target leave their aim arrays at safe defaults —
 *  the Rust kernel skips those turrets via the slab's
 *  `turret_target_id` field anyway. Cloak observability,
 *  passive-mirror validity, and mirror-panel clearance are computed
 *  inside Rust from slab data. */
function fillExistingLockGateInputsInto(
  weapons: Turret[],
  world: WorldState,
  unit: Entity,
  currentTick: number,
  outX: Float64Array,
  outY: Float64Array,
  outZ: Float64Array,
  offset: number,
): void {
  for (let wi = 0; wi < weapons.length; wi++) {
    const weapon = weapons[wi];
    const outIdx = offset + wi;
    if (weapon.target === null) {
      outX[outIdx] = 0;
      outY[outIdx] = 0;
      outZ[outIdx] = 0;
      continue;
    }
    const target = world.getEntity(weapon.target);
    if (target === undefined) {
      outX[outIdx] = 0;
      outY[outIdx] = 0;
      outZ[outIdx] = 0;
      continue;
    }
    resolveTargetAimPoint(
      target,
      weapon.worldPos.x, weapon.worldPos.y, weapon.worldPos.z,
      _gateAimPointScratch,
      {
        lockOnType: weapon.config.aimStyle.lockOnType,
        source: unit,
        currentTick,
      },
    );
    outX[outIdx] = _gateAimPointScratch.x;
    outY[outIdx] = _gateAimPointScratch.y;
    outZ[outIdx] = _gateAimPointScratch.z;
  }
}

function getTargetingKernel() {
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('targetingSystem: sim-wasm is not initialized');
  }
  return sim.combatTargeting;
}

function weaponSystemDisabled(world: WorldState, weapon: Turret): boolean {
  return (
    weapon.config.visualOnly === true ||
    (weapon.config.passive && !world.mirrorsEnabled) ||
    (weapon.config.shot?.type === 'force' && !world.forceFieldsEnabled)
  );
}

function resetDisabledWeapon(world: WorldState, unit: Entity, weapon: Turret, weaponIndex: number): boolean {
  if (!weaponSystemDisabled(world, weapon)) return false;
  setWeaponTarget(weapon, unit, weaponIndex, null);
  weapon.state = 'idle';
  weapon.cooldown = 0;
  weapon.angularVelocity = 0;
  weapon.angularAcceleration = 0;
  weapon.pitchVelocity = 0;
  weapon.pitchAcceleration = 0;
  if (weapon.burst) {
    weapon.burst.remaining = 0;
    weapon.burst.cooldown = 0;
  }
  if (weapon.forceField) {
    weapon.forceField.transition = 0;
    weapon.forceField.range = 0;
  }
  return true;
}

type TargetingKernel = ReturnType<typeof getTargetingKernel>;

function queueAutoModeTargetingUnit(
  unit: Entity,
  unitSlot: number,
  hasCooldownState: boolean,
  maxTurrets: number,
): void {
  const batchIdx = _autoBatchUnits.length;
  ensureAutoBatchCapacity(batchIdx + 1, maxTurrets);
  _autoBatchUnits.push(unit);
  _autoBatchSlots[batchIdx] = unitSlot;
  _autoBatchSourceIds[batchIdx] = unit.id;
  _autoBatchHasCooldown[batchIdx] = hasCooldownState ? 1 : 0;
}

function flushAutoModeTargetingBatch(
  world: WorldState,
  targeting: TargetingKernel,
  tick: number,
  dtMs: number,
  maxTurrets: number,
  mirrorsEnabledFlag: number,
  forceFieldsEnabledFlag: number,
  forceMaterialSightObstructionActiveFlag: number,
): void {
  const count = _autoBatchUnits.length;
  if (count === 0) return;

  const entitySlots = _autoBatchSlots.subarray(0, count);
  targeting.updateMountKinematicsBatch(
    entitySlots,
    tick,
    dtMs,
    mirrorsEnabledFlag,
    forceFieldsEnabledFlag,
  );

  const turretValueCount = count * maxTurrets;
  for (let i = 0; i < count; i++) {
    const unit = _autoBatchUnits[i];
    writeBackCombatTargetingEntityKinematics(unit, tick);
    fillExistingLockGateInputsInto(
      unit.combat!.turrets,
      world,
      unit,
      tick,
      _autoBatchAimX,
      _autoBatchAimY,
      _autoBatchAimZ,
      i * maxTurrets,
    );
  }

  targeting.autoModeSpatialCandidateTickBatch(
    entitySlots,
    _autoBatchSourceIds.subarray(0, count),
    mirrorsEnabledFlag,
    forceFieldsEnabledFlag,
    forceMaterialSightObstructionActiveFlag,
    COMBAT_LOS_TERRAIN_STEP_LEN,
    COMBAT_LOS_ENTITY_QUERY_WIDTH,
    GRAVITY,
    SIGHT_DROP_GRACE_TICKS,
    _autoBatchAimX.subarray(0, turretValueCount),
    _autoBatchAimY.subarray(0, turretValueCount),
    _autoBatchAimZ.subarray(0, turretValueCount),
    _autoBatchCachedFireRanks.subarray(0, turretValueCount),
    _autoBatchCachedFireDistSqs.subarray(0, turretValueCount),
    world.getMaxTargetableRadius(),
  );

  for (let i = 0; i < count; i++) {
    const unit = _autoBatchUnits[i];
    const combat = unit.combat!;
    writeBackCombatTargetingEntity(unit, tick);
    if (updateCombatActivityFlags(combat)) _activeCombatUnits.push(unit);
    else {
      combat.nextCombatProbeTick = _autoBatchHasCooldown[i] !== 0
        ? tick + 1
        : nextTargetingReacquireTick(tick);
    }
  }

  _autoBatchUnits.length = 0;
}

// Update auto-targeting and firing state for all units in a single pass.
// Each weapon independently finds its own target using its own ranges.
//
// Two modes per unit:
//
// 1) ATTACK MODE (priorityTargetId set by attack command):
//    Weapons try the priority target exclusively. Weapons only lock
//    while their actual LOS and force-field sight gates are clear.
//    Uses the hard max fire envelope, not the broader tracking/search
//    range.
//    The unit is already moving toward the target via the attack action handler.
//
// 2) AUTO MODE (no priorityTargetId):
//    Three-state FSM with hysteresis:
//      idle: no target
//      tracking: turret has a target and is aimed at it
//        - acquire: nearest enemy enters tracking.acquire range
//        - release: tracked target exits tracking.release range (or dies) → idle
//        - promote: tracked target enters hard max fire acquire range → engaged
//      engaged: weapon is actively firing
//        - release: target exits hard max fire release range → tracking
//        - escape: target exits tracking.release → idle
//
//    Hysteresis prevents state flickering at max fire and optional min
//    preference boundaries. engageRangeMin ranks preferred targets; it
//    does not forbid close fallback targets.
//
// PERFORMANCE: Uses spatial grid for O(k) queries instead of O(n) full scans
// PERFORMANCE: Auto-mode runs batch Rust targeting work across contiguous entities.
export function updateTargetingAndFiringState(world: WorldState, dtMs: number): Entity[] {
  _activeCombatUnits.length = 0;
  _autoBatchUnits.length = 0;
  const tick = world.getTick();
  const armedEntities = world.getArmedEntities();
  if (armedEntities.length === 0) return _activeCombatUnits;
  const targeting = getTargetingKernel();
  const maxTurrets = targeting.maxTurretsPerEntity();
  const mirrorsEnabledFlag = world.mirrorsEnabled ? 1 : 0;
  const forceFieldsEnabledFlag = world.forceFieldsEnabled ? 1 : 0;
  // Force-material gate fast-path. Sphere boundaries are stamped into
  // the Rust FF slab before the FSM; mirror panels are checked from
  // live JS geometry. This flag lets common ticks skip aim-point
  // resolve and blocker walks when OBSTRUCT SIGHT is off or no force
  // material is active.
  const forceMaterialSightObstructionActive = world.forceFieldsObstructSight
    && (
      getActiveForceFields().length > 0 ||
      (world.mirrorsEnabled && world.getMirrorUnits().length > 0)
    );
  const forceMaterialSightObstructionActiveFlag =
    forceMaterialSightObstructionActive ? 1 : 0;
  const flushQueuedAutoMode = (): void => {
    flushAutoModeTargetingBatch(
      world,
      targeting,
      tick,
      dtMs,
      maxTurrets,
      mirrorsEnabledFlag,
      forceFieldsEnabledFlag,
      forceMaterialSightObstructionActiveFlag,
    );
  };

  for (const unit of armedEntities) {
    if (!unit.ownership || !unit.combat) continue;
    const combat = unit.combat;
    // Host-aliveness check — units track hp on entity.unit, buildings on
    // entity.building. Combat is host-agnostic; the host components own
    // their own hp.
    const hostHp = unit.unit?.hp ?? unit.building?.hp ?? 0;
    if (hostHp <= 0) {
      clearCombatActivityFlags(combat);
      continue;
    }
    // Inert shells skip targeting until construction completes.
    if (unit.buildable && !unit.buildable.isComplete) {
      clearCombatActivityFlags(combat);
      continue;
    }
    clearCombatActivityFlags(combat);
    if (combat.fireEnabled === false) {
      flushQueuedAutoMode();
      combat.priorityTargetId = null;
      combat.priorityTargetPoint = null;
      combat.nextCombatProbeTick = -1;
      const unitSlot = spatialGrid.getSlot(unit.id);
      targeting.clearEntityLocks(unitSlot);
      writeBackCombatTargetingEntity(unit, null);
      continue;
    }
    const priorityId = combat.priorityTargetId;
    const priorityPoint = combat.priorityTargetPoint;
    if (priorityId !== null || priorityPoint !== null) {
      flushQueuedAutoMode();
    }
    const scheduledProbeTick = combat.nextCombatProbeTick;
    // Sentinel -1 disables the gate (`-1 > tick` is false for tick >= 0).
    if (
      priorityId === null &&
      priorityPoint === null &&
      scheduledProbeTick > tick
    ) {
      continue;
    }

    const playerId = unit.ownership.playerId;
    const weapons = combat.turrets;
    ensurePerWeaponScratchCapacity(weapons.length);

    let hasCooldownState = false;
    let hasEnabledWeapon = false;
    for (let wi = 0; wi < weapons.length; wi++) {
      const weapon = weapons[wi];
      const disabled = resetDisabledWeapon(world, unit, weapon, wi);
      if (disabled) continue;
      hasEnabledWeapon = true;
      if (weapon.cooldown > 0) {
        hasCooldownState = true;
        weapon.cooldown = decrementCooldown(weapon.cooldown, dtMs);
      }

      if (weapon.burst?.cooldown !== undefined && weapon.burst.cooldown > 0) {
        hasCooldownState = true;
        weapon.burst.cooldown = decrementCooldown(weapon.burst.cooldown, dtMs);
      }
    }
    if (!hasEnabledWeapon) {
      flushQueuedAutoMode();
      stampCombatTargetingEntity(unit);
      combat.nextCombatProbeTick = nextTargetingReacquireTick(tick);
      continue;
    }

    combat.nextCombatProbeTick = -1;
    const unitSlot = spatialGrid.getSlot(unit.id);

    // Check for attack-ground priority target.
    if (priorityPoint !== null) {
      flushQueuedAutoMode();
      // Pass 0: refresh JS-mutated reset state, then let Rust compute
      // authoritative per-turret mount kinematics in the slab. The
      // writeback keeps remaining JS consumers on the same cache until
      // AIM-08.6 makes the slab the direct source of truth.
      stampCombatTargetingEntity(unit);
      targeting.updateMountKinematics(
        unitSlot,
        tick,
        dtMs,
        mirrorsEnabledFlag,
        forceFieldsEnabledFlag,
      );
      writeBackCombatTargetingEntityKinematics(unit, tick);
      // Rust owns the LOS / ballistic / FF / mirror-panel gates and
      // applies the FSM transition in the same call — saves ~3
      // boundary crossings per armed weapon vs the legacy per-turret
      // path.
      targeting.computeAndApplyPriorityPointFsmBatch(
        unitSlot,
        priorityPoint.x, priorityPoint.y, priorityPoint.z,
        unit.id,
        mirrorsEnabledFlag,
        forceFieldsEnabledFlag,
        forceMaterialSightObstructionActiveFlag,
        COMBAT_LOS_TERRAIN_STEP_LEN,
        COMBAT_LOS_ENTITY_QUERY_WIDTH,
        GRAVITY,
      );
      writeBackCombatTargetingEntity(unit, tick);
      if (updateCombatActivityFlags(combat)) _activeCombatUnits.push(unit);
      continue;
    }

    // Check for attack command priority target
    if (priorityId !== null) {
      // Validate via Rust: alive + observable (uncloaked or detected).
      // Returns the slab-backed view, matching the gate the damage
      // routing and rest of the FSM use.
      const priorityObservable =
        targeting.canPlayerObserveEntity(priorityId, playerId) === 1;
      const priorityTarget: Entity | null = priorityObservable
        ? (world.getEntity(priorityId) ?? null)
        : null;

      if (priorityTarget) {
        flushQueuedAutoMode();
        // Priority-target gates need current mount positions before
        // TS resolves lockOnToBody / lockOnToTurret aim points.
        stampCombatTargetingEntity(unit);
        targeting.updateMountKinematics(
          unitSlot,
          tick,
          dtMs,
          mirrorsEnabledFlag,
          forceFieldsEnabledFlag,
        );
        writeBackCombatTargetingEntityKinematics(unit, tick);
        // ATTACK MODE: try the priority target, firing only inside
        // hard max range. Rust runs LOS / ballistic / FF /
        // mirror-panel / FSM and the passive-mirror DPS walk in one
        // call; TS only resolves per-turret aim points.
        fillPriorityTargetGateInputs(weapons, priorityTarget, unit, tick);
        targeting.computeAndApplyPriorityTargetFsmBatch(
          unitSlot,
          priorityId,
          unit.id,
          mirrorsEnabledFlag,
          forceFieldsEnabledFlag,
          forceMaterialSightObstructionActiveFlag,
          COMBAT_LOS_TERRAIN_STEP_LEN,
          COMBAT_LOS_ENTITY_QUERY_WIDTH,
          GRAVITY,
          _ppAimX, _ppAimY, _ppAimZ,
        );
        writeBackCombatTargetingEntity(unit, tick);
        if (updateCombatActivityFlags(combat)) _activeCombatUnits.push(unit);
        continue; // Skip auto-targeting entirely for this unit
      }
      // Priority target dead/gone — fall through to auto-targeting
    }

    // AUTO MODE: standard hysteresis FSM
    // Passes 0-3 are flushed in Rust over contiguous auto-mode runs:
    // batched mount kinematics, existing-lock validation + auto-scan,
    // Rust spatial candidate query, then fire/acquisition FSM apply.
    stampCombatTargetingEntity(unit);
    queueAutoModeTargetingUnit(unit, unitSlot, hasCooldownState, maxTurrets);
  }

  flushQueuedAutoMode();
  return _activeCombatUnits;
}
