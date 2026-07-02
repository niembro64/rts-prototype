import { actionTypeToCode } from '@/types/network';
import { getSimWasm } from '../sim-wasm/init';
import type { Entity, UnitAction } from './types';

const ACTION_TYPE_NONE = 255;

export const UNIT_ACTION_FLAG_MOVE_STATE_ROAM = 1 << 0;
export const UNIT_ACTION_FLAG_MOVE_STATE_HOLD = 1 << 1;
export const UNIT_ACTION_FLAG_LOAD_IN_RANGE = 1 << 2;
export const UNIT_ACTION_FLAG_TRANSPORT_EMPTY = 1 << 3;
export const UNIT_ACTION_FLAG_TARGET_IN_BUILD_RANGE = 1 << 4;
export const UNIT_ACTION_FLAG_COMBAT_STOP_ANY = 1 << 5;
export const UNIT_ACTION_FLAG_COMBAT_STOP_FIGHT = 1 << 6;
export const UNIT_ACTION_FLAG_GUARD_FRIENDLY = 1 << 7;
export const UNIT_ACTION_FLAG_GUARD_SERVICE = 1 << 8;
export const UNIT_ACTION_FLAG_GUARD_SERVICE_IN_RANGE = 1 << 9;
export const UNIT_ACTION_FLAG_TARGET_PRESENT = 1 << 10;

/** Range checks resolved natively inside unit_action_plan_batch against
 *  the entity-state slab. Kept in lockstep with unit_action.rs. */
export const UNIT_ACTION_RANGE_KIND_NONE = 0;
export const UNIT_ACTION_RANGE_KIND_BUILD = 1;
export const UNIT_ACTION_RANGE_KIND_LOAD = 2;
export const UNIT_ACTION_RANGE_KIND_GUARD_SERVICE = 3;

export const UNIT_ACTION_PLAN_IDLE_LOITER = 0;
export const UNIT_ACTION_PLAN_WAIT_LOITER = 1;
export const UNIT_ACTION_PLAN_LOAD_HOLD = 2;
export const UNIT_ACTION_PLAN_LOAD_MOVE = 3;
export const UNIT_ACTION_PLAN_UNLOAD_ADVANCE = 4;
export const UNIT_ACTION_PLAN_UNLOAD_MOVE = 5;
export const UNIT_ACTION_PLAN_BUILD_HOLD = 6;
export const UNIT_ACTION_PLAN_BUILD_MOVE = 7;
export const UNIT_ACTION_PLAN_ATTACK_HOLD = 8;
export const UNIT_ACTION_PLAN_ATTACK_MOVE = 9;
export const UNIT_ACTION_PLAN_ATTACK_GROUND_HOLD = 10;
export const UNIT_ACTION_PLAN_ATTACK_GROUND_MOVE = 11;
export const UNIT_ACTION_PLAN_GUARD_ADVANCE = 12;
export const UNIT_ACTION_PLAN_GUARD_HOLD = 13;
export const UNIT_ACTION_PLAN_GUARD_SERVICE_HOLD = 14;
export const UNIT_ACTION_PLAN_GUARD_SERVICE_MOVE = 15;
export const UNIT_ACTION_PLAN_GUARD_FOLLOW = 16;
export const UNIT_ACTION_PLAN_FIGHT_PATROL_HOLD = 17;
export const UNIT_ACTION_PLAN_MOVE_COMPLETION = 18;

export type UnitActionPlanCode =
  | typeof UNIT_ACTION_PLAN_IDLE_LOITER
  | typeof UNIT_ACTION_PLAN_WAIT_LOITER
  | typeof UNIT_ACTION_PLAN_LOAD_HOLD
  | typeof UNIT_ACTION_PLAN_LOAD_MOVE
  | typeof UNIT_ACTION_PLAN_UNLOAD_ADVANCE
  | typeof UNIT_ACTION_PLAN_UNLOAD_MOVE
  | typeof UNIT_ACTION_PLAN_BUILD_HOLD
  | typeof UNIT_ACTION_PLAN_BUILD_MOVE
  | typeof UNIT_ACTION_PLAN_ATTACK_HOLD
  | typeof UNIT_ACTION_PLAN_ATTACK_MOVE
  | typeof UNIT_ACTION_PLAN_ATTACK_GROUND_HOLD
  | typeof UNIT_ACTION_PLAN_ATTACK_GROUND_MOVE
  | typeof UNIT_ACTION_PLAN_GUARD_ADVANCE
  | typeof UNIT_ACTION_PLAN_GUARD_HOLD
  | typeof UNIT_ACTION_PLAN_GUARD_SERVICE_HOLD
  | typeof UNIT_ACTION_PLAN_GUARD_SERVICE_MOVE
  | typeof UNIT_ACTION_PLAN_GUARD_FOLLOW
  | typeof UNIT_ACTION_PLAN_FIGHT_PATROL_HOLD
  | typeof UNIT_ACTION_PLAN_MOVE_COMPLETION;

export class SimulationUnitActionPlanner {
  private readonly entities: Entity[] = [];
  private readonly actions: (UnitAction | undefined)[] = [];
  private readonly serviceTargets: (Entity | null)[] = [];
  private actionTypes = new Uint8Array(0);
  private flags = new Uint32Array(0);
  private slots = new Uint32Array(0);
  private rangeKinds = new Uint8Array(0);
  private targetSlots = new Int32Array(0);
  private rangeParams = new Float64Array(0);
  private plans = new Uint8Array(0);
  private count = 0;

  begin(capacityHint = 0): void {
    this.count = 0;
    if (capacityHint > 0) this.ensureCapacity(capacityHint);
  }

  queue(
    entity: Entity,
    action: UnitAction | undefined,
    flags: number,
    serviceTarget: Entity | null = null,
    rangeKind: number = UNIT_ACTION_RANGE_KIND_NONE,
    targetSlot: number = -1,
    rangeParam: number = 0,
  ): number {
    const index = this.count++;
    this.ensureCapacity(this.count);
    this.entities[index] = entity;
    this.actions[index] = action;
    this.serviceTargets[index] = serviceTarget;
    this.actionTypes[index] = action !== undefined
      ? actionTypeToCode(action.type)
      : ACTION_TYPE_NONE;
    this.flags[index] = flags;
    this.slots[index] = entity.entitySlotId >= 0 ? entity.entitySlotId : 0xffffffff;
    this.rangeKinds[index] = rangeKind;
    this.targetSlots[index] = targetSlot;
    this.rangeParams[index] = rangeParam;
    return index;
  }

  compute(): number {
    const count = this.count;
    if (count === 0) return 0;
    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('SimulationUnitActionPlanner.compute: sim-wasm is not initialized');
    }
    const ok = sim.unitActionPlanBatch(
      this.actionTypes.subarray(0, count),
      this.flags.subarray(0, count),
      this.slots.subarray(0, count),
      this.rangeKinds.subarray(0, count),
      this.targetSlots.subarray(0, count),
      this.rangeParams.subarray(0, count),
      this.plans.subarray(0, count),
    );
    if (ok === 0) {
      throw new Error('SimulationUnitActionPlanner.compute: unit_action_plan_batch rejected its buffers');
    }
    return count;
  }

  /** Effective flags after the native batch OR'd in the range bits it
   *  resolved from the entity-state slab. */
  flagsAt(index: number): number {
    return this.flags[index];
  }

  entityAt(index: number): Entity {
    return this.entities[index];
  }

  actionAt(index: number): UnitAction | undefined {
    return this.actions[index];
  }

  serviceTargetAt(index: number): Entity | null {
    return this.serviceTargets[index] ?? null;
  }

  planAt(index: number): UnitActionPlanCode {
    return this.plans[index] as UnitActionPlanCode;
  }

  reset(): void {
    this.count = 0;
    this.entities.length = 0;
    this.actions.length = 0;
    this.serviceTargets.length = 0;
  }

  private ensureCapacity(required: number): void {
    if (this.actionTypes.length >= required) return;
    const next = Math.max(required, this.actionTypes.length * 2, 128);
    const actionTypes = new Uint8Array(next);
    actionTypes.set(this.actionTypes);
    this.actionTypes = actionTypes;
    const flags = new Uint32Array(next);
    flags.set(this.flags);
    this.flags = flags;
    const slots = new Uint32Array(next);
    slots.set(this.slots);
    this.slots = slots;
    const rangeKinds = new Uint8Array(next);
    rangeKinds.set(this.rangeKinds);
    this.rangeKinds = rangeKinds;
    const targetSlots = new Int32Array(next);
    targetSlots.set(this.targetSlots);
    this.targetSlots = targetSlots;
    const rangeParams = new Float64Array(next);
    rangeParams.set(this.rangeParams);
    this.rangeParams = rangeParams;
    const plans = new Uint8Array(next);
    plans.set(this.plans);
    this.plans = plans;
  }
}
