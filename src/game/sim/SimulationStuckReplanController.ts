import { getSimWasm } from '../sim-wasm/init';
import { ARRIVAL_RADIUS } from './SimulationArrivalController';
import type { Entity } from './types';

const STUCK_VEL_THRESHOLD = 5;
const STUCK_TICK_THRESHOLD = 60;
const MAX_REPLANS_PER_TICK = 5;
export const REPLAN_COOLDOWN = -150;
export const REPLAN_FAILURE_COOLDOWN = REPLAN_COOLDOWN;
const STUCK_REPLAN_BATCH_FLAG_SETTLING_CHECK = 1 << 0;

export class SimulationStuckReplanController {
  private readonly tryReplan: (entity: Entity) => boolean;
  private readonly entities: Entity[] = [];
  private slots = new Uint32Array(0);
  private ticks = new Int32Array(0);
  private settlingDx = new Float64Array(0);
  private settlingDy = new Float64Array(0);
  private settlingFlags = new Uint8Array(0);
  private outTicks = new Int32Array(0);
  private outReplan = new Uint8Array(0);
  private replansThisTick = 0;

  constructor(tryReplan: (entity: Entity) => boolean) {
    this.tryReplan = tryReplan;
  }

  beginFrame(): void {
    this.replansThisTick = 0;
  }

  evaluate(movingUnits: readonly Entity[]): void {
    const maxRows = movingUnits.length;
    if (maxRows === 0) return;

    this.ensureCapacity(maxRows);
    let count = 0;
    for (let i = 0; i < maxRows; i++) {
      const entity = movingUnits[i];
      if (!entity.unit || !entity.body) continue;
      const unit = entity.unit;
      const action = unit.actions[0];
      let settlingDx = 0;
      let settlingDy = 0;
      let settlingFlags = 0;
      if (
        action !== undefined &&
        action.type !== 'patrol' &&
        (action.type === 'move' || action.type === 'fight')
      ) {
        settlingDx = action.x - entity.transform.x;
        settlingDy = action.y - entity.transform.y;
        settlingFlags = STUCK_REPLAN_BATCH_FLAG_SETTLING_CHECK;
      }

      this.entities[count] = entity;
      this.slots[count] = entity.body.physicsBody.slot;
      this.ticks[count] = unit.stuckTicks ?? 0;
      this.settlingDx[count] = settlingDx;
      this.settlingDy[count] = settlingDy;
      this.settlingFlags[count] = settlingFlags;
      count++;
    }
    if (count === 0) return;

    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('SimulationStuckReplanController.evaluate: sim-wasm is not initialized');
    }
    sim.stuckReplanStepBatch(
      this.slots.subarray(0, count),
      this.ticks.subarray(0, count),
      this.settlingDx.subarray(0, count),
      this.settlingDy.subarray(0, count),
      this.settlingFlags.subarray(0, count),
      this.outTicks.subarray(0, count),
      this.outReplan.subarray(0, count),
      STUCK_VEL_THRESHOLD,
      STUCK_TICK_THRESHOLD,
      ARRIVAL_RADIUS,
    );

    for (let i = 0; i < count; i++) {
      const entity = this.entities[i];
      const unit = entity.unit;
      if (!unit) {
        this.entities[i] = undefined as unknown as Entity;
        continue;
      }

      unit.stuckTicks = this.outTicks[i];
      if (this.outReplan[i] === 0) {
        this.entities[i] = undefined as unknown as Entity;
        continue;
      }
      if (this.replansThisTick >= MAX_REPLANS_PER_TICK) {
        this.entities[i] = undefined as unknown as Entity;
        continue;
      }
      if (this.tryReplan(entity)) {
        unit.stuckTicks = REPLAN_COOLDOWN;
        this.replansThisTick++;
      } else {
        unit.stuckTicks = REPLAN_FAILURE_COOLDOWN;
      }
      this.entities[i] = undefined as unknown as Entity;
    }
  }

  reset(): void {
    this.entities.length = 0;
    this.replansThisTick = 0;
  }

  private ensureCapacity(required: number): void {
    if (this.slots.length >= required) return;
    const next = Math.max(required, this.slots.length * 2, 128);
    const slots = new Uint32Array(next);
    slots.set(this.slots);
    this.slots = slots;
    const ticks = new Int32Array(next);
    ticks.set(this.ticks);
    this.ticks = ticks;
    const settlingDx = new Float64Array(next);
    settlingDx.set(this.settlingDx);
    this.settlingDx = settlingDx;
    const settlingDy = new Float64Array(next);
    settlingDy.set(this.settlingDy);
    this.settlingDy = settlingDy;
    const settlingFlags = new Uint8Array(next);
    settlingFlags.set(this.settlingFlags);
    this.settlingFlags = settlingFlags;
    this.outTicks = new Int32Array(next);
    this.outReplan = new Uint8Array(next);
  }
}
