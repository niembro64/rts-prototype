import { UNIT_LOCOMOTION_FORCE_REFERENCE_MASS, UNIT_MASS_MULTIPLIER } from '../../config';
import { getSimWasm } from '../sim-wasm/init';
import { LOCOMOTION_FORCE_SCALE } from './locomotion';
import type { Entity, UnitAction } from './types';
import type { WorldState } from './WorldState';
import { SIMULATION_INVALID_BODY_SLOT } from './SimulationFlyingLoiterController';
import { PATHFINDING_ARRIVAL_RADIUS } from './pathfindingTuning';
import { entitySlotRegistry } from './EntitySlotRegistry';

/** Distance (world units) at which a unit ticks a waypoint as reached. Single
 *  source of truth in pathfindingTuningConfig.json so the WASM pathfinder folds
 *  this same value into per-unit clearance (preventing corner-cuts into
 *  blockers); the two can never drift apart. */
export const ARRIVAL_RADIUS = PATHFINDING_ARRIVAL_RADIUS;
const ARRIVAL_FINAL_RADIUS = 15;
const ARRIVAL_FINAL_STOP_SPEED = 100;
const ARRIVAL_CONTROL_RADIUS = 20;
const ARRIVAL_RESPONSE_TIME_SEC = 0.22;
const ARRIVAL_MIN_ACCEL = 0.001;
const ARRIVAL_BATCH_FLAG_MAINTAIN_FULL_THRUST = 1 << 0;
const ARRIVAL_BATCH_FLAG_LAST_ACTION = 1 << 1;
const ARRIVAL_COMPLETION_BATCH_FLAG_MAINTAIN_FULL_THRUST = 1 << 2;

export class SimulationArrivalController {
  private readonly world: WorldState;
  private readonly advanceAction: (entity: Entity) => void;
  private readonly advanceActivePathPoint: (entity: Entity) => void;
  private readonly queueFlyingLoiter: (entity: Entity) => void;
  private readonly entities: Entity[] = [];
  private entitySlots = new Int32Array(0);
  private slots = new Uint32Array(0);
  private dx = new Float64Array(0);
  private dy = new Float64Array(0);
  private distance = new Float64Array(0);
  private radiusPush = new Float64Array(0);
  private speedLimitFactor = new Float64Array(0);
  private flags = new Uint8Array(0);
  private outX = new Float64Array(0);
  private outY = new Float64Array(0);
  private active = new Uint8Array(0);
  private count = 0;
  private readonly completionEntities: Entity[] = [];
  private readonly completionActions: UnitAction[] = [];
  private completionSlots = new Uint32Array(0);
  private completionDx = new Float64Array(0);
  private completionDy = new Float64Array(0);
  private completionFallbackVx = new Float64Array(0);
  private completionFallbackVy = new Float64Array(0);
  private completionFlags = new Uint8Array(0);
  private completionFinalPoint = new Uint8Array(0);
  private completionDistance = new Float64Array(0);
  private completionArrived = new Uint8Array(0);
  private completionCount = 0;

  constructor(
    world: WorldState,
    callbacks: {
      advanceAction: (entity: Entity) => void;
      advanceActivePathPoint: (entity: Entity) => void;
      queueFlyingLoiter: (entity: Entity) => void;
    },
  ) {
    this.world = world;
    this.advanceAction = callbacks.advanceAction;
    this.advanceActivePathPoint = callbacks.advanceActivePathPoint;
    this.queueFlyingLoiter = callbacks.queueFlyingLoiter;
  }

  beginFrame(): void {
    this.count = 0;
  }

  queueCompletion(
    entity: Entity,
    action: UnitAction,
    dx: number,
    dy: number,
    isFinalActionPoint: boolean,
  ): void {
    const unit = entity.unit;
    if (!unit) return;

    const index = this.completionCount++;
    this.ensureCompletionCapacity(this.completionCount);
    this.completionEntities[index] = entity;
    this.completionActions[index] = action;
    this.completionSlots[index] =
      entity.body !== null ? entity.body.physicsBody.slot : SIMULATION_INVALID_BODY_SLOT;
    this.completionDx[index] = dx;
    this.completionDy[index] = dy;
    this.completionFallbackVx[index] = unit.velocityX;
    this.completionFallbackVy[index] = unit.velocityY;
    let flags = unit.actions.length <= 1 && action.type !== 'patrol'
      && isFinalActionPoint
      ? ARRIVAL_BATCH_FLAG_LAST_ACTION
      : 0;
    if (unit.locomotion.maintainFullThrustAtWaypoints) {
      flags |= ARRIVAL_COMPLETION_BATCH_FLAG_MAINTAIN_FULL_THRUST;
    }
    this.completionFlags[index] = flags;
    this.completionFinalPoint[index] = isFinalActionPoint ? 1 : 0;
  }

  flushCompletion(): void {
    const count = this.completionCount;
    if (count === 0) return;

    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('SimulationArrivalController.flushCompletion: sim-wasm is not initialized');
    }
    sim.arrivalCompletionStepBatch(
      this.completionSlots.subarray(0, count),
      this.completionDx.subarray(0, count),
      this.completionDy.subarray(0, count),
      this.completionFallbackVx.subarray(0, count),
      this.completionFallbackVy.subarray(0, count),
      this.completionFlags.subarray(0, count),
      this.completionDistance.subarray(0, count),
      this.completionArrived.subarray(0, count),
      ARRIVAL_RADIUS,
      ARRIVAL_FINAL_RADIUS,
      ARRIVAL_FINAL_STOP_SPEED,
    );

    for (let i = 0; i < count; i++) {
      const entity = this.completionEntities[i];
      const action = this.completionActions[i];
      const unit = entity.unit;
      if (unit) {
        if (this.completionArrived[i] !== 0) {
          if (this.completionFinalPoint[i] !== 0) {
            this.advanceAction(entity);
          } else {
            this.advanceActivePathPoint(entity);
          }
          unit.stuckTicks = 0;
          if (unit.actions.length === 0) this.queueFlyingLoiter(entity);
        } else {
          this.queueThrust(
            entity,
            action,
            this.completionDx[i],
            this.completionDy[i],
            this.completionDistance[i],
            this.completionFinalPoint[i] !== 0,
          );
        }
      }
      this.completionEntities[i] = undefined as unknown as Entity;
      this.completionActions[i] = undefined as unknown as UnitAction;
      this.completionFinalPoint[i] = 0;
    }
    this.completionCount = 0;
  }

  queueThrust(
    entity: Entity,
    action: UnitAction,
    dx: number,
    dy: number,
    distance: number,
    isFinalActionPoint = true,
  ): void {
    const unit = entity.unit;
    const body = entity.body;
    const bodySlot = body !== null ? body.physicsBody.slot : -1;
    const entitySlot = entity.entitySlotId;
    if (!unit || bodySlot < 0 || !Number.isFinite(distance) || distance <= 0.0001) {
      if (unit) {
        entitySlotRegistry.setUnitDriveInput(entity, 0, 0, 0, 0, entitySlot);
      }
      return;
    }

    const invDistance = 1 / distance;
    entitySlotRegistry.setUnitDriveInput(entity, 0, 0, dx * invDistance, dy * invDistance, entitySlot);

    const maintainFullThrustAtWaypoints = unit.locomotion.maintainFullThrustAtWaypoints;
    const isLastAction = isFinalActionPoint && unit.actions.length <= 1 && action.type !== 'patrol';
    const speedLimitFactor = maintainFullThrustAtWaypoints
      ? 1
      : normalizeActionSpeedLimitFactor(action.speedLimitFactor);
    const index = this.count++;
    this.ensureCapacity(this.count);
    this.entities[index] = entity;
    this.entitySlots[index] = entitySlot;
    this.slots[index] = bodySlot;
    this.dx[index] = dx;
    this.dy[index] = dy;
    this.distance[index] = distance;
    this.radiusPush[index] = unit.radius.collision;
    this.speedLimitFactor[index] = speedLimitFactor;
    this.flags[index] =
      (maintainFullThrustAtWaypoints ? ARRIVAL_BATCH_FLAG_MAINTAIN_FULL_THRUST : 0)
      | (isLastAction ? ARRIVAL_BATCH_FLAG_LAST_ACTION : 0);
  }

  flushThrust(movingUnits: Entity[], dtSec: number): void {
    const count = this.count;
    if (count === 0) return;

    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('SimulationArrivalController.flushThrust: sim-wasm is not initialized');
    }
    sim.arrivalControlStepBatch(
      this.slots.subarray(0, count),
      this.dx.subarray(0, count),
      this.dy.subarray(0, count),
      this.distance.subarray(0, count),
      this.radiusPush.subarray(0, count),
      this.speedLimitFactor.subarray(0, count),
      this.flags.subarray(0, count),
      this.outX.subarray(0, count),
      this.outY.subarray(0, count),
      this.active.subarray(0, count),
      dtSec,
      this.world.thrustMultiplier,
      LOCOMOTION_FORCE_SCALE,
      UNIT_LOCOMOTION_FORCE_REFERENCE_MASS,
      UNIT_MASS_MULTIPLIER,
      ARRIVAL_CONTROL_RADIUS,
      ARRIVAL_RESPONSE_TIME_SEC,
      ARRIVAL_MIN_ACCEL,
    );

    for (let i = 0; i < count; i++) {
      const entity = this.entities[i];
      const unit = entity.unit;
      if (unit) {
        const speedLimitFactor = this.speedLimitFactor[i];
        const invDistance = this.distance[i] > 0.0001 ? 1 / this.distance[i] : 0;
        entitySlotRegistry.setUnitDriveInput(
          entity,
          this.outX[i] * speedLimitFactor,
          this.outY[i] * speedLimitFactor,
          this.dx[i] * invDistance,
          this.dy[i] * invDistance,
          this.entitySlots[i],
        );
        if (this.active[i] !== 0) movingUnits.push(entity);
      }
      this.entities[i] = undefined as unknown as Entity;
    }
    this.count = 0;
  }

  reset(): void {
    this.count = 0;
    this.entities.length = 0;
    this.completionCount = 0;
    this.completionEntities.length = 0;
    this.completionActions.length = 0;
  }

  private ensureCapacity(required: number): void {
    if (this.slots.length >= required) return;
    const next = Math.max(required, this.slots.length * 2, 128);
    const slots = new Uint32Array(next);
    slots.set(this.slots);
    this.slots = slots;
    const entitySlots = new Int32Array(next);
    entitySlots.set(this.entitySlots);
    this.entitySlots = entitySlots;
    const dx = new Float64Array(next);
    dx.set(this.dx);
    this.dx = dx;
    const dy = new Float64Array(next);
    dy.set(this.dy);
    this.dy = dy;
    const distance = new Float64Array(next);
    distance.set(this.distance);
    this.distance = distance;
    const radiusCollision = new Float64Array(next);
    radiusCollision.set(this.radiusPush);
    this.radiusPush = radiusCollision;
    const speedLimitFactor = new Float64Array(next);
    speedLimitFactor.set(this.speedLimitFactor);
    this.speedLimitFactor = speedLimitFactor;
    const flags = new Uint8Array(next);
    flags.set(this.flags);
    this.flags = flags;
    this.outX = new Float64Array(next);
    this.outY = new Float64Array(next);
    this.active = new Uint8Array(next);
  }

  private ensureCompletionCapacity(required: number): void {
    if (this.completionSlots.length >= required) return;
    const next = Math.max(required, this.completionSlots.length * 2, 128);
    const slots = new Uint32Array(next);
    slots.set(this.completionSlots);
    this.completionSlots = slots;
    const dx = new Float64Array(next);
    dx.set(this.completionDx);
    this.completionDx = dx;
    const dy = new Float64Array(next);
    dy.set(this.completionDy);
    this.completionDy = dy;
    const fallbackVx = new Float64Array(next);
    fallbackVx.set(this.completionFallbackVx);
    this.completionFallbackVx = fallbackVx;
    const fallbackVy = new Float64Array(next);
    fallbackVy.set(this.completionFallbackVy);
    this.completionFallbackVy = fallbackVy;
    const flags = new Uint8Array(next);
    flags.set(this.completionFlags);
    this.completionFlags = flags;
    const finalPoint = new Uint8Array(next);
    finalPoint.set(this.completionFinalPoint);
    this.completionFinalPoint = finalPoint;
    this.completionDistance = new Float64Array(next);
    this.completionArrived = new Uint8Array(next);
  }
}

function normalizeActionSpeedLimitFactor(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}
