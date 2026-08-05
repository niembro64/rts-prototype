import { getSimWasm } from '../sim-wasm/init';
import type { Entity, UnitAction } from './types';
import type { UnitActionPlanCode } from './SimulationUnitActionPlanner';
import { growTypedArrays, nextDoublingCapacity } from '../memory/typedArrayGrowth';

export const UNIT_ACTION_MOVEMENT_DECISION_THRUST = 0;
export const UNIT_ACTION_MOVEMENT_DECISION_ADVANCE_PATH = 1;
export const UNIT_ACTION_MOVEMENT_DECISION_HOLD = 2;

export type UnitActionMovementDecision =
  | typeof UNIT_ACTION_MOVEMENT_DECISION_THRUST
  | typeof UNIT_ACTION_MOVEMENT_DECISION_ADVANCE_PATH
  | typeof UNIT_ACTION_MOVEMENT_DECISION_HOLD;

export class SimulationUnitActionMovementPlanner {
  private readonly entities: Entity[] = [];
  private readonly actions: UnitAction[] = [];
  private plans = new Uint8Array(0);
  private slots = new Uint32Array(0);
  private targetX = new Float64Array(0);
  private targetY = new Float64Array(0);
  private threshold = new Float64Array(0);
  private finalPoint = new Uint8Array(0);
  private dx = new Float64Array(0);
  private dy = new Float64Array(0);
  private distance = new Float64Array(0);
  private decision = new Uint8Array(0);
  private count = 0;

  begin(capacityHint = 0): void {
    this.count = 0;
    if (capacityHint > 0) this.ensureCapacity(capacityHint);
  }

  queue(
    entity: Entity,
    action: UnitAction,
    plan: UnitActionPlanCode,
    slot: number,
    targetX: number,
    targetY: number,
    threshold: number,
    isFinalActionPoint: boolean,
  ): number {
    const index = this.count++;
    this.ensureCapacity(this.count);
    this.entities[index] = entity;
    this.actions[index] = action;
    this.plans[index] = plan;
    this.slots[index] = slot >= 0 ? slot : 0xffffffff;
    this.targetX[index] = targetX;
    this.targetY[index] = targetY;
    this.threshold[index] = threshold;
    this.finalPoint[index] = isFinalActionPoint ? 1 : 0;
    return index;
  }

  compute(): number {
    const count = this.count;
    if (count === 0) return 0;
    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('SimulationUnitActionMovementPlanner.compute: sim-wasm is not initialized');
    }
    const ok = sim.unitActionMovementBatch(
      this.slots.subarray(0, count),
      this.targetX.subarray(0, count),
      this.targetY.subarray(0, count),
      this.threshold.subarray(0, count),
      this.finalPoint.subarray(0, count),
      this.dx.subarray(0, count),
      this.dy.subarray(0, count),
      this.distance.subarray(0, count),
      this.decision.subarray(0, count),
    );
    if (ok === 0) {
      throw new Error('SimulationUnitActionMovementPlanner.compute: unit_action_movement_batch rejected its buffers');
    }
    return count;
  }

  entityAt(index: number): Entity {
    return this.entities[index];
  }

  actionAt(index: number): UnitAction {
    return this.actions[index];
  }

  planAt(index: number): UnitActionPlanCode {
    return this.plans[index] as UnitActionPlanCode;
  }

  dxAt(index: number): number {
    return this.dx[index];
  }

  dyAt(index: number): number {
    return this.dy[index];
  }

  distanceAt(index: number): number {
    return this.distance[index];
  }

  isFinalActionPointAt(index: number): boolean {
    return this.finalPoint[index] !== 0;
  }

  decisionAt(index: number): UnitActionMovementDecision {
    return this.decision[index] as UnitActionMovementDecision;
  }

  reset(): void {
    this.count = 0;
    this.entities.length = 0;
    this.actions.length = 0;
  }

  private ensureCapacity(required: number): void {
    if (this.slots.length >= required) return;
    const next = nextDoublingCapacity(this.slots.length, required, 128);
    [
      this.plans,
      this.slots,
      this.targetX,
      this.targetY,
      this.threshold,
      this.finalPoint,
      this.dx,
      this.dy,
      this.distance,
      this.decision,
    ] = growTypedArrays([
      this.plans,
      this.slots,
      this.targetX,
      this.targetY,
      this.threshold,
      this.finalPoint,
      this.dx,
      this.dy,
      this.distance,
      this.decision,
    ] as const, next);
  }
}
