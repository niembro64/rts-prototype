// Auto-targeting scheduler bridge — every targeting source flows through Rust.
//
// The slab is the source of truth for per-entity FSM inputs:
// stampCombatTargetingEntityInto pushes priorityTargetId,
// priorityTargetPoint, and nextCombatProbeTick into the combat-
// targeting slab during input stamping, so the scheduled Rust kernel
// reads them by slot instead of accepting JS scratch arrays at the
// boundary. This bridge's TypeScript work is now just:
//   - consume the source-slot queue built during targeting slab stamping,
//   - call combat_targeting_schedule_and_tick_batch once,
//   - apply JS-only command/probe bookkeeping from the compact mode
//     and active-work bytes the kernel wrote back.
// Cooldown decrement, fire-gate dispatch, FSM transitions, and the
// disabled-weapon slab reset all live inside the Rust scheduler.

import type { WorldState } from '../WorldState';
import type { Entity } from '../types';
import { GRAVITY } from '../../../config';
import {
  CT_TARGETING_TICK_MODE_AUTO,
  CT_TARGETING_TICK_MODE_CLEAR_LOCKS,
  CT_TARGETING_TICK_MODE_SKIP,
  getSimWasm,
} from '../../sim-wasm/init';
import {
  COMBAT_LOS_ENTITY_QUERY_WIDTH,
  COMBAT_LOS_TERRAIN_STEP_LEN,
  SIGHT_DROP_GRACE_TICKS,
} from './lineOfSight';
import { getActiveShields } from './shieldTurret';
import {
  getCombatTargetingSourceCount,
  getCombatTargetingSourceSlots,
} from './targetingInputStamping';
import { spatialGrid } from '../SpatialGrid';

const _activeCombatUnits: Entity[] = [];

let _targetingBatchModes = new Uint8Array(0);
let _targetingBatchHasCooldown = new Uint8Array(0);
let _targetingBatchHasActiveWork = new Uint8Array(0);
let _targetingBatchCachedFireRanks = new Uint8Array(0);
let _targetingBatchCachedFireDistSqs = new Float64Array(0);
let _targetingBatchMaxTurrets = 0;
// Keep this in sync with COMBAT_TARGETING_REACQUIRE_PERIOD_TICKS in
// rts-sim-wasm/src/combat_targeting.rs. Active combat work stays hot through
// nextCombatProbeTick=-1; this only amortizes idle/no-target broad searches.
const TARGETING_REACQUIRE_PERIOD_TICKS = 96;

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function nextTargetingReacquireTick(tick: number, entityId: number): number {
  const nextTick = tick + 1;
  const phase = positiveModulo(entityId, TARGETING_REACQUIRE_PERIOD_TICKS);
  const delta = positiveModulo(
    phase - positiveModulo(nextTick, TARGETING_REACQUIRE_PERIOD_TICKS),
    TARGETING_REACQUIRE_PERIOD_TICKS,
  );
  return nextTick + delta;
}

function ensureTargetingBatchCapacity(entityCount: number, maxTurrets: number): void {
  if (maxTurrets !== _targetingBatchMaxTurrets) {
    _targetingBatchModes = new Uint8Array(0);
    _targetingBatchHasCooldown = new Uint8Array(0);
    _targetingBatchHasActiveWork = new Uint8Array(0);
    _targetingBatchCachedFireRanks = new Uint8Array(0);
    _targetingBatchCachedFireDistSqs = new Float64Array(0);
    _targetingBatchMaxTurrets = maxTurrets;
  }
  if (entityCount <= _targetingBatchModes.length) return;
  let next = Math.max(8, _targetingBatchModes.length);
  while (next < entityCount) next *= 2;
  _targetingBatchModes = new Uint8Array(next);
  _targetingBatchHasCooldown = new Uint8Array(next);
  _targetingBatchHasActiveWork = new Uint8Array(next);
  const turretCapacity = next * maxTurrets;
  _targetingBatchCachedFireRanks = new Uint8Array(turretCapacity);
  _targetingBatchCachedFireDistSqs = new Float64Array(turretCapacity);
}

function getTargetingKernel() {
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('targetingSchedulerBridge: sim-wasm is not initialized');
  }
  return sim.combatTargeting;
}

type TargetingKernel = ReturnType<typeof getTargetingKernel>;

function flushTargetingBatch(
  world: WorldState,
  targeting: TargetingKernel,
  sourceSlots: Uint32Array,
  count: number,
  tick: number,
  dtMs: number,
  maxTurrets: number,
  turretShieldPanelsEnabledFlag: number,
  turretShieldSpheresEnabledFlag: number,
  forceMaterialSightObstructionActiveFlag: number,
): void {
  if (count === 0) return;
  ensureTargetingBatchCapacity(count, maxTurrets);

  const turretValueCount = count * maxTurrets;
  targeting.scheduleAndTickBatch(
    sourceSlots,
    tick,
    dtMs,
    turretShieldPanelsEnabledFlag,
    turretShieldSpheresEnabledFlag,
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
    _targetingBatchHasActiveWork.subarray(0, count),
  );

  // AIM-08.10 — the scheduler refreshes activity masks and returns the
  // active-work decision in _targetingBatchHasActiveWork, so this loop
  // does not inspect per-entity slab masks after the kernel call.
  for (let i = 0; i < count; i++) {
    const mode = _targetingBatchModes[i];
    if (mode === CT_TARGETING_TICK_MODE_SKIP) continue;
    const unit = spatialGrid.resolveSlot(sourceSlots[i]);
    const combat = unit?.combat;
    if (unit === undefined || combat === null || combat === undefined) continue;
    if (mode === CT_TARGETING_TICK_MODE_CLEAR_LOCKS) {
      // Fire-disabled entities had their locks zeroed inside the
      // scheduler. Downstream JS systems (turretSystem,
      // projectileSystem, laser sounds) still read combat.priority*
      // unconditionally, so drop the stale priority commands here.
      combat.priorityTargetId = null;
      combat.priorityTargetPoint = null;
      combat.manualLaunchActive = false;
    }
    if (_targetingBatchHasActiveWork[i] !== 0) {
      combat.nextCombatProbeTick = -1;
      _activeCombatUnits.push(unit);
    } else if (mode === CT_TARGETING_TICK_MODE_AUTO) {
      combat.nextCombatProbeTick = _targetingBatchHasCooldown[i] !== 0
        ? tick + 1
        : nextTargetingReacquireTick(tick, unit.id);
    } else {
      combat.nextCombatProbeTick = -1;
    }
  }
}

// Update auto-targeting and firing state for all stamped targeting sources.
//
// TypeScript here consumes the source queue that the slab stamping
// pass already built, calls the Rust scheduler, then applies the
// remaining JS command/probe bookkeeping from typed outputs. Every
// FSM decision (priority point / priority target / auto / clear locks
// for fire-disabled, probe-skip) lives inside
// combat_targeting_schedule_and_tick_batch and reads per-entity
// priority + probe state from the slab that was stamped before the
// kernel ran.
//
// PERFORMANCE: One Rust call per tick handles every targeting source.
export function updateTargetingAndFiringState(world: WorldState, dtMs: number): Entity[] {
  _activeCombatUnits.length = 0;
  const tick = world.getTick();
  const sourceCount = getCombatTargetingSourceCount();
  if (sourceCount === 0) return _activeCombatUnits;
  const sourceSlots = getCombatTargetingSourceSlots();
  const targeting = getTargetingKernel();
  const maxTurrets = targeting.maxTurretsPerEntity();
  const turretShieldPanelsEnabledFlag = world.turretShieldPanelsEnabled ? 1 : 0;
  const turretShieldSpheresEnabledFlag = world.turretShieldSpheresEnabled ? 1 : 0;
  // Force-material gate fast-path. Sphere boundaries and shield-panel
  // blockers are stamped into Rust slabs before the FSM. This flag
  // lets common ticks skip blocker walks when shield-aware targeting is
  // off or no force material is active.
  const forceMaterialSightObstructionActive = world.shieldsObstructSight
    && (
      (world.turretShieldSpheresEnabled && getActiveShields().length > 0) ||
      (world.turretShieldPanelsEnabled && world.getShieldPanelUnits().length > 0)
    );
  const forceMaterialSightObstructionActiveFlag =
    forceMaterialSightObstructionActive ? 1 : 0;

  flushTargetingBatch(
    world,
    targeting,
    sourceSlots,
    sourceCount,
    tick,
    dtMs,
    maxTurrets,
    turretShieldPanelsEnabledFlag,
    turretShieldSpheresEnabledFlag,
    forceMaterialSightObstructionActiveFlag,
  );
  return _activeCombatUnits;
}
