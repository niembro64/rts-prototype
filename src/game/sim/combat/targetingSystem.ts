// Auto-targeting system - each weapon independently finds targets

import type { WorldState } from '../WorldState';
import type { Entity, Turret } from '../types';
import type { Vec3 } from '@/types/vec2';
import { GRAVITY } from '../../../config';
import { clearCombatActivityFlags, updateCombatActivityFlags } from './combatActivity';
import { spatialGrid } from '../SpatialGrid';
import { setWeaponTarget } from './targetIndex';
import { getSimWasm } from '../../sim-wasm/init';
import {
  COMBAT_LOS_ENTITY_QUERY_WIDTH,
  COMBAT_LOS_TERRAIN_STEP_LEN,
  SIGHT_DROP_GRACE_TICKS,
} from './lineOfSight';
import { getActiveForceFields } from './forceFieldTurret';
import {
  stampCombatTargetingEntity,
  writeBackCombatTargetingEntity,
} from './targetingInputStamping';

const _activeCombatUnits: Entity[] = [];
const TARGETING_BATCH_MODE_AUTO = 0;
const TARGETING_BATCH_MODE_SKIP = 255;

const _targetingBatchUnits: Entity[] = [];
let _targetingBatchSlots = new Uint32Array(0);
let _targetingBatchSourceIds = new Int32Array(0);
let _targetingBatchModes = new Uint8Array(0);
let _targetingBatchPriorityTargetIds = new Int32Array(0);
let _targetingBatchPriorityPointPresent = new Uint8Array(0);
let _targetingBatchPriorityPointX = new Float64Array(0);
let _targetingBatchPriorityPointY = new Float64Array(0);
let _targetingBatchPriorityPointZ = new Float64Array(0);
let _targetingBatchHasCooldown = new Uint8Array(0);
let _targetingBatchScheduledProbeTicks = new Int32Array(0);
let _targetingBatchCachedFireRanks = new Uint8Array(0);
let _targetingBatchCachedFireDistSqs = new Float64Array(0);
let _targetingBatchMaxTurrets = 0;

function nextTargetingReacquireTick(tick: number): number {
  return tick + 1;
}

function ensureTargetingBatchCapacity(entityCount: number, maxTurrets: number): void {
  if (maxTurrets !== _targetingBatchMaxTurrets) {
    _targetingBatchSlots = new Uint32Array(0);
    _targetingBatchSourceIds = new Int32Array(0);
    _targetingBatchModes = new Uint8Array(0);
    _targetingBatchPriorityTargetIds = new Int32Array(0);
    _targetingBatchPriorityPointPresent = new Uint8Array(0);
    _targetingBatchPriorityPointX = new Float64Array(0);
    _targetingBatchPriorityPointY = new Float64Array(0);
    _targetingBatchPriorityPointZ = new Float64Array(0);
    _targetingBatchHasCooldown = new Uint8Array(0);
    _targetingBatchScheduledProbeTicks = new Int32Array(0);
    _targetingBatchCachedFireRanks = new Uint8Array(0);
    _targetingBatchCachedFireDistSqs = new Float64Array(0);
    _targetingBatchMaxTurrets = maxTurrets;
  }
  if (entityCount <= _targetingBatchSlots.length) return;
  let next = Math.max(8, _targetingBatchSlots.length);
  while (next < entityCount) next *= 2;
  _targetingBatchSlots = new Uint32Array(next);
  _targetingBatchSourceIds = new Int32Array(next);
  _targetingBatchModes = new Uint8Array(next);
  _targetingBatchPriorityTargetIds = new Int32Array(next);
  _targetingBatchPriorityPointPresent = new Uint8Array(next);
  _targetingBatchPriorityPointX = new Float64Array(next);
  _targetingBatchPriorityPointY = new Float64Array(next);
  _targetingBatchPriorityPointZ = new Float64Array(next);
  _targetingBatchHasCooldown = new Uint8Array(next);
  _targetingBatchScheduledProbeTicks = new Int32Array(next);
  const turretCapacity = next * maxTurrets;
  _targetingBatchCachedFireRanks = new Uint8Array(turretCapacity);
  _targetingBatchCachedFireDistSqs = new Float64Array(turretCapacity);
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

function queueTargetingUnit(
  unit: Entity,
  unitSlot: number,
  maxTurrets: number,
  priorityTargetId: number | null = null,
  priorityPoint: Vec3 | null = null,
  scheduledProbeTick: number = -1,
): void {
  const batchIdx = _targetingBatchUnits.length;
  ensureTargetingBatchCapacity(batchIdx + 1, maxTurrets);
  _targetingBatchUnits.push(unit);
  _targetingBatchSlots[batchIdx] = unitSlot;
  _targetingBatchSourceIds[batchIdx] = unit.id;
  _targetingBatchModes[batchIdx] = TARGETING_BATCH_MODE_SKIP;
  _targetingBatchPriorityTargetIds[batchIdx] = priorityTargetId ?? -1;
  _targetingBatchPriorityPointPresent[batchIdx] = priorityPoint === null ? 0 : 1;
  _targetingBatchPriorityPointX[batchIdx] = priorityPoint?.x ?? 0;
  _targetingBatchPriorityPointY[batchIdx] = priorityPoint?.y ?? 0;
  _targetingBatchPriorityPointZ[batchIdx] = priorityPoint?.z ?? 0;
  _targetingBatchHasCooldown[batchIdx] = 0;
  _targetingBatchScheduledProbeTicks[batchIdx] = scheduledProbeTick;
}

function flushTargetingBatch(
  world: WorldState,
  targeting: TargetingKernel,
  tick: number,
  dtMs: number,
  maxTurrets: number,
  mirrorsEnabledFlag: number,
  forceFieldsEnabledFlag: number,
  forceMaterialSightObstructionActiveFlag: number,
): void {
  const count = _targetingBatchUnits.length;
  if (count === 0) return;

  const entitySlots = _targetingBatchSlots.subarray(0, count);
  const turretValueCount = count * maxTurrets;
  targeting.scheduleAndTickBatch(
    entitySlots,
    _targetingBatchSourceIds.subarray(0, count),
    _targetingBatchPriorityTargetIds.subarray(0, count),
    _targetingBatchPriorityPointPresent.subarray(0, count),
    _targetingBatchPriorityPointX.subarray(0, count),
    _targetingBatchPriorityPointY.subarray(0, count),
    _targetingBatchPriorityPointZ.subarray(0, count),
    _targetingBatchScheduledProbeTicks.subarray(0, count),
    tick,
    dtMs,
    mirrorsEnabledFlag,
    forceFieldsEnabledFlag,
    forceMaterialSightObstructionActiveFlag,
    COMBAT_LOS_TERRAIN_STEP_LEN,
    COMBAT_LOS_ENTITY_QUERY_WIDTH,
    GRAVITY,
    SIGHT_DROP_GRACE_TICKS,
    _targetingBatchCachedFireRanks.subarray(0, turretValueCount),
    _targetingBatchCachedFireDistSqs.subarray(0, turretValueCount),
    world.getMaxTargetableRadius(),
    _targetingBatchHasCooldown.subarray(0, count),
    _targetingBatchModes.subarray(0, count),
  );

  for (let i = 0; i < count; i++) {
    const mode = _targetingBatchModes[i];
    const unit = _targetingBatchUnits[i];
    if (mode === TARGETING_BATCH_MODE_SKIP) {
      if (_targetingBatchHasCooldown[i] !== 0) {
        writeBackCombatTargetingEntity(unit, null);
      }
      continue;
    }
    const combat = unit.combat!;
    writeBackCombatTargetingEntity(unit, tick);
    if (updateCombatActivityFlags(combat)) {
      combat.nextCombatProbeTick = -1;
      _activeCombatUnits.push(unit);
    } else if (mode === TARGETING_BATCH_MODE_AUTO) {
      combat.nextCombatProbeTick = _targetingBatchHasCooldown[i] !== 0
        ? tick + 1
        : nextTargetingReacquireTick(tick);
    } else {
      combat.nextCombatProbeTick = -1;
    }
  }

  _targetingBatchUnits.length = 0;
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
// PERFORMANCE: Uses spatial grid for O(k) queries instead of O(n) full scans.
// PERFORMANCE: Queued targeting modes share one world-order Rust FSM batch.
export function updateTargetingAndFiringState(world: WorldState, dtMs: number): Entity[] {
  _activeCombatUnits.length = 0;
  _targetingBatchUnits.length = 0;
  const tick = world.getTick();
  const armedEntities = world.getArmedEntities();
  if (armedEntities.length === 0) return _activeCombatUnits;
  const targeting = getTargetingKernel();
  const maxTurrets = targeting.maxTurretsPerEntity();
  const mirrorsEnabledFlag = world.mirrorsEnabled ? 1 : 0;
  const forceFieldsEnabledFlag = world.forceFieldsEnabled ? 1 : 0;
  // Force-material gate fast-path. Sphere boundaries and mirror-panel
  // blockers are stamped into Rust slabs before the FSM. This flag
  // lets common ticks skip blocker walks when OBSTRUCT SIGHT is off or
  // no force material is active.
  const forceMaterialSightObstructionActive = world.forceFieldsObstructSight
    && (
      getActiveForceFields().length > 0 ||
      (world.mirrorsEnabled && world.getMirrorUnits().length > 0)
    );
  const forceMaterialSightObstructionActiveFlag =
    forceMaterialSightObstructionActive ? 1 : 0;
  const flushQueuedTargeting = (): void => {
    flushTargetingBatch(
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
    clearCombatActivityFlags(combat);
    // Host-aliveness check — units track hp on entity.unit, buildings on
    // entity.building. Combat is host-agnostic; the host components own
    // their own hp.
    const hostHp = unit.unit?.hp ?? unit.building?.hp ?? 0;
    if (hostHp <= 0) {
      continue;
    }
    // Inert shells skip targeting until construction completes.
    if (unit.buildable && !unit.buildable.isComplete) {
      continue;
    }
    if (combat.fireEnabled === false) {
      combat.priorityTargetId = null;
      combat.priorityTargetPoint = null;
      combat.nextCombatProbeTick = -1;
      const unitSlot = spatialGrid.getSlot(unit.id);
      if (unitSlot >= 0) {
        stampCombatTargetingEntity(unit);
        queueTargetingUnit(
          unit,
          unitSlot,
          maxTurrets,
          null,
          null,
          -1,
        );
      }
      continue;
    }
    const priorityId = combat.priorityTargetId;
    const priorityPoint = combat.priorityTargetPoint;
    const scheduledProbeTick = combat.nextCombatProbeTick;

    const weapons = combat.turrets;

    let hasEnabledWeapon = false;
    for (let wi = 0; wi < weapons.length; wi++) {
      const weapon = weapons[wi];
      const disabled = resetDisabledWeapon(world, unit, weapon, wi);
      if (disabled) continue;
      hasEnabledWeapon = true;
    }
    if (!hasEnabledWeapon) {
      stampCombatTargetingEntity(unit);
      const unitSlot = spatialGrid.getSlot(unit.id);
      if (unitSlot >= 0) {
        queueTargetingUnit(
          unit,
          unitSlot,
          maxTurrets,
          priorityId,
          priorityPoint,
          scheduledProbeTick,
        );
      } else {
        combat.nextCombatProbeTick = nextTargetingReacquireTick(tick);
      }
      continue;
    }

    const unitSlot = spatialGrid.getSlot(unit.id);
    if (unitSlot < 0) continue;

    // The Rust scheduled batch chooses priority-point, priority-target,
    // hold-fire clear, skip, or auto mode from slab-backed state so TS
    // no longer resolves command targets inside this traversal.
    stampCombatTargetingEntity(unit);
    queueTargetingUnit(
      unit,
      unitSlot,
      maxTurrets,
      priorityId,
      priorityPoint,
      scheduledProbeTick,
    );
  }

  flushQueuedTargeting();
  return _activeCombatUnits;
}
