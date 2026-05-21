// Auto-targeting scheduler bridge — every targeting source flows through Rust.
//
// The slab is the source of truth for per-entity FSM inputs:
// stampCombatTargetingEntityInto pushes priorityTargetId,
// priorityTargetPoint, and nextCombatProbeTick into the combat-
// targeting slab during input stamping, so the scheduled Rust kernel
// reads them by slot instead of accepting JS scratch arrays at the
// boundary. This bridge's TypeScript work is now just:
//   - consume the sourceId queue built during targeting slab stamping,
//   - call combat_targeting_schedule_and_tick_batch once,
//   - dispatch JS-only writeback (Turret pose, activity flags,
//     fire-disabled priority command cleanup) per-row based on the
//     mode byte the kernel wrote back.
// Cooldown decrement, fire-gate dispatch, FSM transitions, and the
// disabled-weapon slab reset all live inside the Rust scheduler.

import type { WorldState } from '../WorldState';
import type { Entity } from '../types';
import { GRAVITY } from '../../../config';
import { clearCombatActivityFlags } from './combatActivity';
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
import { getActiveForceFields } from './forceFieldTurret';
import {
  getCombatTargetingSourceCount,
  getCombatTargetingSourceEntities,
  getCombatTargetingSourceIds,
  writeBackCombatTargetingEntity,
} from './targetingInputStamping';

const _activeCombatUnits: Entity[] = [];

let _targetingBatchModes = new Uint8Array(0);
let _targetingBatchHasCooldown = new Uint8Array(0);
let _targetingBatchCachedFireRanks = new Uint8Array(0);
let _targetingBatchCachedFireDistSqs = new Float64Array(0);
let _targetingBatchMaxTurrets = 0;

function nextTargetingReacquireTick(tick: number): number {
  return tick + 1;
}

function ensureTargetingBatchCapacity(entityCount: number, maxTurrets: number): void {
  if (maxTurrets !== _targetingBatchMaxTurrets) {
    _targetingBatchModes = new Uint8Array(0);
    _targetingBatchHasCooldown = new Uint8Array(0);
    _targetingBatchCachedFireRanks = new Uint8Array(0);
    _targetingBatchCachedFireDistSqs = new Float64Array(0);
    _targetingBatchMaxTurrets = maxTurrets;
  }
  if (entityCount <= _targetingBatchModes.length) return;
  let next = Math.max(8, _targetingBatchModes.length);
  while (next < entityCount) next *= 2;
  _targetingBatchModes = new Uint8Array(next);
  _targetingBatchHasCooldown = new Uint8Array(next);
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
  sourceEntities: readonly Entity[],
  sourceIds: Int32Array,
  count: number,
  tick: number,
  dtMs: number,
  maxTurrets: number,
  mirrorsEnabledFlag: number,
  forceFieldsEnabledFlag: number,
  forceMaterialSightObstructionActiveFlag: number,
): void {
  if (count === 0) return;
  ensureTargetingBatchCapacity(count, maxTurrets);

  const turretValueCount = count * maxTurrets;
  targeting.scheduleAndTickBatch(
    sourceIds,
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
    const unit = sourceEntities[i];
    if (mode === CT_TARGETING_TICK_MODE_SKIP) {
      // Probe-skipped: no FSM transitions ran, but cooldowns may have
      // ticked down on the slab. Mirror those back to JS Turret so
      // firing / snapshot encode read the same numbers as the slab.
      // Activity flags stay zero because a probe-skip means no live
      // turret work, no firing, no rotation — clear them here since
      // the per-entity prep loop no longer does it up front.
      if (_targetingBatchHasCooldown[i] !== 0) {
        writeBackCombatTargetingEntity(unit, null, world);
      }
      clearCombatActivityFlags(unit.combat!);
      continue;
    }
    const combat = unit.combat!;
    const hasActiveTurretWork = writeBackCombatTargetingEntity(unit, tick, world);
    if (mode === CT_TARGETING_TICK_MODE_CLEAR_LOCKS) {
      // Fire-disabled entities had their locks zeroed inside the
      // scheduler. Downstream JS systems (turretSystem,
      // projectileSystem, laser sounds) still read combat.priority*
      // unconditionally, so drop the stale priority commands here.
      combat.priorityTargetId = null;
      combat.priorityTargetPoint = null;
    }
    if (hasActiveTurretWork) {
      combat.nextCombatProbeTick = -1;
      _activeCombatUnits.push(unit);
    } else if (mode === CT_TARGETING_TICK_MODE_AUTO) {
      combat.nextCombatProbeTick = _targetingBatchHasCooldown[i] !== 0
        ? tick + 1
        : nextTargetingReacquireTick(tick);
    } else {
      combat.nextCombatProbeTick = -1;
    }
  }
}

// Update auto-targeting and firing state for all stamped targeting sources.
//
// TypeScript here consumes the source queue that the slab stamping
// pass already built, calls the Rust scheduler, then walks the
// result back into JS Turret objects + combat-activity flags. Every
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
  const sourceIds = getCombatTargetingSourceIds();
  const sourceEntities = getCombatTargetingSourceEntities();
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

  flushTargetingBatch(
    world,
    targeting,
    sourceEntities,
    sourceIds,
    sourceCount,
    tick,
    dtMs,
    maxTurrets,
    mirrorsEnabledFlag,
    forceFieldsEnabledFlag,
    forceMaterialSightObstructionActiveFlag,
  );
  return _activeCombatUnits;
}
