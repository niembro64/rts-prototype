// Auto-targeting system — every armed entity flows through Rust.
//
// The TypeScript pass here is now a slab-stamping + JS-only mutation
// pass: it clears combat activity flags, optionally clears stale
// priority commands on fire-disabled units, and queues each armed
// entity for the Rust scheduler. The actual mode decision (priority
// point / priority target / auto / clear locks / probe-skip) lives
// inside combat_targeting_schedule_and_tick_batch. Disabled-weapon
// slab state is reset by that kernel too; this file's writeback
// finishes the job for the JS-only Turret fields that never cross
// the WASM boundary.

import type { WorldState } from '../WorldState';
import type { Entity } from '../types';
import type { Vec3 } from '@/types/vec2';
import { GRAVITY } from '../../../config';
import { clearCombatActivityFlags, updateCombatActivityFlags } from './combatActivity';
import { getSimWasm } from '../../sim-wasm/init';
import {
  COMBAT_LOS_ENTITY_QUERY_WIDTH,
  COMBAT_LOS_TERRAIN_STEP_LEN,
  SIGHT_DROP_GRACE_TICKS,
} from './lineOfSight';
import { getActiveForceFields } from './forceFieldTurret';
import { writeBackCombatTargetingEntity } from './targetingInputStamping';

const _activeCombatUnits: Entity[] = [];
const TARGETING_BATCH_MODE_AUTO = 0;
const TARGETING_BATCH_MODE_SKIP = 255;

const _targetingBatchUnits: Entity[] = [];
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
  if (entityCount <= _targetingBatchSourceIds.length) return;
  let next = Math.max(8, _targetingBatchSourceIds.length);
  while (next < entityCount) next *= 2;
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

type TargetingKernel = ReturnType<typeof getTargetingKernel>;

function queueTargetingUnit(
  unit: Entity,
  maxTurrets: number,
  priorityTargetId: number | null,
  priorityPoint: Vec3 | null,
  scheduledProbeTick: number,
): void {
  const batchIdx = _targetingBatchUnits.length;
  ensureTargetingBatchCapacity(batchIdx + 1, maxTurrets);
  _targetingBatchUnits.push(unit);
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

  const turretValueCount = count * maxTurrets;
  targeting.scheduleAndTickBatch(
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
        writeBackCombatTargetingEntity(unit, null, world);
      }
      continue;
    }
    const combat = unit.combat!;
    writeBackCombatTargetingEntity(unit, tick, world);
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

// Update auto-targeting and firing state for all armed entities.
//
// TypeScript here only stamps inputs and queues each armed entity;
// the Rust scheduler picks the per-entity mode (priority point,
// priority target, auto, clear-locks for fire-disabled, or
// probe-skip), runs the appropriate FSM kernel, decrements cooldowns,
// and writes the result back into the combat-targeting slab. JS
// Turret writeback then copies that slab back into the entity for
// rendering, firing, and snapshot encode to consume.
//
// PERFORMANCE: Uses spatial grid for O(k) queries instead of O(n) full scans.
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
    const combat = unit.combat;
    if (!combat) continue;
    clearCombatActivityFlags(combat);
    // Stale priority commands left over from an attack issued while
    // hold-fire is on: drop them now so the next fire-enabled tick
    // starts clean. The Rust scheduler would ignore them while
    // fire_enabled=false, but downstream JS systems (turretSystem,
    // projectileSystem, laser sounds) still read priorityTargetPoint
    // unconditionally.
    if (combat.fireEnabled === false) {
      combat.priorityTargetId = null;
      combat.priorityTargetPoint = null;
      combat.nextCombatProbeTick = -1;
    }
    queueTargetingUnit(
      unit,
      maxTurrets,
      combat.priorityTargetId,
      combat.priorityTargetPoint,
      combat.nextCombatProbeTick,
    );
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
