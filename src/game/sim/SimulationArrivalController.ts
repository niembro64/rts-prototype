import { getSimWasm } from '../sim-wasm/init';
import { applyLocalAvoidance } from './localAvoidance';
import type { Entity, UnitAction } from './types';
import type { WorldState } from './WorldState';
import { SIMULATION_INVALID_BODY_SLOT } from './SimulationAirborneLoiterController';
import {
  PATHFINDING_ARRIVAL_RADIUS,
  PATHFINDING_INTERMEDIATE_CORRIDOR_WU,
} from './pathfindingTuning';
import { entitySlotRegistry } from './EntitySlotRegistry';
import { growTypedArrays, nextDoublingCapacity } from '../memory/typedArrayGrowth';

/** Distance (world units) at which the movement controller considers a
 * waypoint reached. Path legality and physical clearance remain independent
 * configuration-space concerns in the pathfinder. */
export const ARRIVAL_RADIUS = PATHFINDING_ARRIVAL_RADIUS;
const ARRIVAL_FINAL_RADIUS = 15;
/** Completion speed ceiling at the final point. The PD brake converges to
 *  ~0.5·distance by arrival, so real approaches finish well under this; the
 *  ceiling only decides how hot a first pass may complete. At 100 a cruising
 *  Jackal completed at half speed and idle-brake coasted ~30 wu past the
 *  click; 50 keeps the residual coast under ~8 wu. */
const ARRIVAL_FINAL_STOP_SPEED = 50;
const ARRIVAL_CONTROL_RADIUS = 20;
const ARRIVAL_RESPONSE_TIME_SEC = 0.22;
const ARRIVAL_MIN_ACCEL = 0.001;
const ARRIVAL_BATCH_FLAG_MAINTAIN_FULL_THRUST = 1 << 0;
const ARRIVAL_BATCH_FLAG_LAST_ACTION = 1 << 1;
const ARRIVAL_COMPLETION_BATCH_FLAG_MAINTAIN_FULL_THRUST = 1 << 2;

/** Resolve the one policy shared by arrival thrust and arrival completion.
 * Authored locomotion always wins over the global BATTLE setting: full-thrust
 * chassis (plane, aerosub) always bypass the final brake, hover chassis
 * (drone) always keep it — a hover unit that cannot settle at its anchor has
 * no station-keeping at all. The global setting only changes the final point
 * of the final non-patrol action for the remaining ground/sea locomotion,
 * leaving path corners and intermediate waypoints under the normal
 * corner-speed controller. */
export function shouldBypassFinalWaypointSlowdown(
  maintainFullThrustAtWaypoints: boolean,
  alwaysBrakeAtFinalWaypoint: boolean,
  isLastAction: boolean,
  slowDownAtFinalWaypoint: boolean,
): boolean {
  if (maintainFullThrustAtWaypoints) return true;
  if (alwaysBrakeAtFinalWaypoint) return false;
  return isLastAction && !slowDownAtFinalWaypoint;
}

export class SimulationArrivalController {
  private readonly advanceAction: (entity: Entity) => void;
  private readonly advanceActivePathPoint: (entity: Entity) => void;
  private readonly queueAirborneLoiter: (entity: Entity) => void;
  private readonly entities: Entity[] = [];
  private entitySlots = new Int32Array(0);
  private slots = new Uint32Array(0);
  private dx = new Float64Array(0);
  private dy = new Float64Array(0);
  private distance = new Float64Array(0);
  private desiredVelocityX = new Float64Array(0);
  private desiredVelocityY = new Float64Array(0);
  private radiusPush = new Float64Array(0);
  private speedLimitFactor = new Float64Array(0);
  private cornerBendCos = new Float64Array(0);
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
    private readonly world: WorldState,
    callbacks: {
      advanceAction: (entity: Entity) => void;
      advanceActivePathPoint: (entity: Entity) => void;
      queueAirborneLoiter: (entity: Entity) => void;
    },
  ) {
    this.advanceAction = callbacks.advanceAction;
    this.advanceActivePathPoint = callbacks.advanceActivePathPoint;
    this.queueAirborneLoiter = callbacks.queueAirborneLoiter;
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
    const isLastAction =
      unit.actions.length <= 1 && action.type !== 'patrol' && isFinalActionPoint;
    let flags = isLastAction ? ARRIVAL_BATCH_FLAG_LAST_ACTION : 0;
    if (
      shouldBypassFinalWaypointSlowdown(
        unit.locomotion.motionControl.maintainFullThrustAtWaypoints,
        unit.locomotion.motionControl.alwaysBrakeAtFinalWaypoint,
        isLastAction,
        this.world.slowDownAtFinalWaypoint,
      )
    ) {
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
          if (unit.actions.length === 0) this.queueAirborneLoiter(entity);
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
    cornerBendCos = 1,
    desiredVelocityX = 0,
    desiredVelocityY = 0,
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

    // Local avoidance nudges the drive vector around bodies ahead; the
    // waypoint, the plan and the braking distance are untouched.
    const avoided = applyLocalAvoidance(entity, dx, dy, distance);
    dx = avoided.x;
    dy = avoided.y;
    const invDistance = 1 / distance;
    entitySlotRegistry.setUnitDriveInput(entity, 0, 0, dx * invDistance, dy * invDistance, entitySlot);

    const maintainFullThrustAtWaypoints = unit.locomotion.motionControl.maintainFullThrustAtWaypoints;
    const isLastAction = isFinalActionPoint && (
      action.type === 'guard' ||
      (unit.actions.length <= 1 && action.type !== 'patrol')
    );
    const bypassFinalWaypointSlowdown = shouldBypassFinalWaypointSlowdown(
      maintainFullThrustAtWaypoints,
      unit.locomotion.motionControl.alwaysBrakeAtFinalWaypoint,
      isLastAction,
      this.world.slowDownAtFinalWaypoint,
    );
    // Explicit action speed limits remain active when the global final-arrival
    // brake is off. Only an authored full-thrust locomotion policy bypasses
    // those limits.
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
    this.desiredVelocityX[index] = desiredVelocityX;
    this.desiredVelocityY[index] = desiredVelocityY;
    this.radiusPush[index] = unit.radius.collision;
    this.speedLimitFactor[index] = speedLimitFactor;
    this.cornerBendCos[index] = cornerBendCos;
    this.flags[index] =
      (bypassFinalWaypointSlowdown ? ARRIVAL_BATCH_FLAG_MAINTAIN_FULL_THRUST : 0)
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
      this.desiredVelocityX.subarray(0, count),
      this.desiredVelocityY.subarray(0, count),
      this.radiusPush.subarray(0, count),
      this.speedLimitFactor.subarray(0, count),
      this.flags.subarray(0, count),
      this.cornerBendCos.subarray(0, count),
      this.outX.subarray(0, count),
      this.outY.subarray(0, count),
      this.active.subarray(0, count),
      dtSec,
      ARRIVAL_CONTROL_RADIUS,
      ARRIVAL_RESPONSE_TIME_SEC,
      ARRIVAL_MIN_ACCEL,
      PATHFINDING_INTERMEDIATE_CORRIDOR_WU,
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
    const next = nextDoublingCapacity(this.slots.length, required, 128);
    [
      this.slots,
      this.entitySlots,
      this.dx,
      this.dy,
      this.distance,
      this.desiredVelocityX,
      this.desiredVelocityY,
      this.radiusPush,
      this.speedLimitFactor,
      this.cornerBendCos,
      this.flags,
    ] = growTypedArrays([
      this.slots,
      this.entitySlots,
      this.dx,
      this.dy,
      this.distance,
      this.desiredVelocityX,
      this.desiredVelocityY,
      this.radiusPush,
      this.speedLimitFactor,
      this.cornerBendCos,
      this.flags,
    ] as const, next);
    this.outX = new Float64Array(next);
    this.outY = new Float64Array(next);
    this.active = new Uint8Array(next);
  }

  private ensureCompletionCapacity(required: number): void {
    if (this.completionSlots.length >= required) return;
    const next = nextDoublingCapacity(this.completionSlots.length, required, 128);
    [
      this.completionSlots,
      this.completionDx,
      this.completionDy,
      this.completionFallbackVx,
      this.completionFallbackVy,
      this.completionFlags,
      this.completionFinalPoint,
    ] = growTypedArrays([
      this.completionSlots,
      this.completionDx,
      this.completionDy,
      this.completionFallbackVx,
      this.completionFallbackVy,
      this.completionFlags,
      this.completionFinalPoint,
    ] as const, next);
    this.completionDistance = new Float64Array(next);
    this.completionArrived = new Uint8Array(next);
  }
}

function normalizeActionSpeedLimitFactor(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}
