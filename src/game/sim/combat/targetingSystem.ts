// Auto-targeting system — every armed entity flows through Rust.
//
// The slab is the source of truth for per-entity FSM inputs:
// stampCombatTargetingEntityInto pushes priorityTargetId,
// priorityTargetPoint, and nextCombatProbeTick into the combat-
// targeting slab during input stamping, so the scheduled Rust kernel
// reads them by slot instead of accepting JS scratch arrays at the
// boundary. This file's TypeScript work is now just:
//   - walk armed entities and push them into a single sourceId queue,
//   - call combat_targeting_schedule_and_tick_batch once,
//   - dispatch JS-only writeback (Turret pose, activity flags,
//     fire-disabled priority command cleanup) per-row based on the
//     mode byte the kernel wrote back.
// Cooldown decrement, fire-gate dispatch, FSM transitions, and the
// disabled-weapon slab reset all live inside the Rust scheduler.

import type { WorldState } from '../WorldState';
import type { Entity } from '../types';
import { GRAVITY } from '../../../config';
import { clearCombatActivityFlags, updateCombatActivityFlags } from './combatActivity';
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
import { writeBackCombatTargetingEntity } from './targetingInputStamping';

const _activeCombatUnits: Entity[] = [];

const _targetingBatchUnits: Entity[] = [];
let _targetingBatchSourceIds = new Int32Array(0);
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
    _targetingBatchSourceIds = new Int32Array(0);
    _targetingBatchModes = new Uint8Array(0);
    _targetingBatchHasCooldown = new Uint8Array(0);
    _targetingBatchCachedFireRanks = new Uint8Array(0);
    _targetingBatchCachedFireDistSqs = new Float64Array(0);
    _targetingBatchMaxTurrets = maxTurrets;
  }
  if (entityCount <= _targetingBatchSourceIds.length) return;
  let next = Math.max(8, _targetingBatchSourceIds.length);
  while (next < entityCount) next *= 2;
  _targetingBatchSourceIds = new Int32Array(next);
  _targetingBatchModes = new Uint8Array(next);
  _targetingBatchHasCooldown = new Uint8Array(next);
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

type TargetingKernel = ReturnType<typeof getTargetingKernel>;

function queueTargetingUnit(unit: Entity, maxTurrets: number): void {
  const batchIdx = _targetingBatchUnits.length;
  ensureTargetingBatchCapacity(batchIdx + 1, maxTurrets);
  _targetingBatchUnits.push(unit);
  _targetingBatchSourceIds[batchIdx] = unit.id;
  _targetingBatchModes[batchIdx] = CT_TARGETING_TICK_MODE_SKIP;
  _targetingBatchHasCooldown[batchIdx] = 0;
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

  const turretValueCount = count * maxTurrets;
  targeting.scheduleAndTickBatch(
    _targetingBatchSourceIds.subarray(0, count),
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
    writeBackCombatTargetingEntity(unit, tick, world);
    if (mode === CT_TARGETING_TICK_MODE_CLEAR_LOCKS) {
      // Fire-disabled entities had their locks zeroed inside the
      // scheduler. Downstream JS systems (turretSystem,
      // projectileSystem, laser sounds) still read combat.priority*
      // unconditionally, so drop the stale priority commands here.
      combat.priorityTargetId = null;
      combat.priorityTargetPoint = null;
    }
    if (updateCombatActivityFlags(combat)) {
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

  _targetingBatchUnits.length = 0;
}

// Update auto-targeting and firing state for all armed entities.
//
// TypeScript here just walks armed entities once to queue them into
// a single sourceId batch, calls the Rust scheduler, then walks the
// result back into JS Turret objects + combat-activity flags. Every
// FSM decision (priority point / priority target / auto / clear locks
// for fire-disabled, probe-skip) lives inside
// combat_targeting_schedule_and_tick_batch and reads per-entity
// priority + probe state from the slab that was stamped before the
// kernel ran.
//
// PERFORMANCE: One Rust call per tick handles every armed entity.
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

  for (const unit of armedEntities) {
    if (!unit.ownership) continue;
    if (!unit.combat) continue;
    queueTargetingUnit(unit, maxTurrets);
  }

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
  return _activeCombatUnits;
}
