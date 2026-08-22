import { magnitude } from '../math';
import { getSimWasm } from '../sim-wasm/init';
import type { Entity, UnitAction } from './types';
import {
  SIMULATION_INVALID_BODY_SLOT,
  airborneLoiterRadius,
} from './SimulationAirborneLoiterController';
import { PATHFINDING_ARRIVAL_RADIUS } from './pathfindingTuning';
import { entitySlotRegistry } from './EntitySlotRegistry';
import { growTypedArrays, nextDoublingCapacity } from '../memory/typedArrayGrowth';

/** Turn-radius clamp for R = speed / maxYawRate (the yaw ceiling comes from
 *  the sim's own attitude-servo spring inside the kernel). */
const AIRBORNE_STEER_MIN_TURN_RADIUS = 40;
const AIRBORNE_STEER_MAX_TURN_RADIUS = 600;
/** Escape ring = 1.25 x the orbit diameter (2R), i.e. 2.5 x R. Inside it a
 *  unit heading away from the waypoint may not turn at all. */
const AIRBORNE_STEER_ESCAPE_RADIUS_RATIO = 2.5;
/** The no-turn lock applies only while actually moving; below this speed a
 *  boundary-pinned or freshly launched unit steers freely. */
const AIRBORNE_STEER_LOCK_SPEED_FLOOR = 5;

/** Waypoint steering for cruise locomotion (plane, aerosub). A forward-
 *  flight body cannot brake at a point, and a goal inside its turning circle
 *  cannot be reached by steering toward it — greedy pursuit decays into a
 *  constant-radius orbit that never completes the order. This controller
 *  captures waypoints at flight-appropriate radii (the arrival radius for
 *  intermediate/queued points, the loiter radius for the final point) and
 *  steers every remaining approach through the no-turn escape ring: a
 *  stateless per-tick interlock, evaluated for the whole cruise population
 *  in one WASM batch. */
export class SimulationAirborneWaypointController {
  private readonly advanceAction: (entity: Entity) => void;
  private readonly advanceActivePathPoint: (entity: Entity) => void;
  private readonly queueAirborneLoiter: (entity: Entity) => void;
  private readonly entities: Entity[] = [];
  private entitySlots = new Int32Array(0);
  private slots = new Uint32Array(0);
  private dx = new Float64Array(0);
  private dy = new Float64Array(0);
  private distance = new Float64Array(0);
  private rotation = new Float64Array(0);
  private fallbackVx = new Float64Array(0);
  private fallbackVy = new Float64Array(0);
  private outThrustX = new Float64Array(0);
  private outThrustY = new Float64Array(0);
  private count = 0;

  constructor(
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

  /** Route one cruise-unit movement leg: capture the point when inside its
   *  flight-appropriate radius, otherwise queue the escape-ring steer. */
  queue(
    entity: Entity,
    action: UnitAction,
    isFinalActionPoint: boolean,
    dx: number,
    dy: number,
  ): void {
    const unit = entity.unit;
    if (!unit) return;

    const distance = magnitude(dx, dy);
    if (!Number.isFinite(distance)) return;
    const isLastAction =
      isFinalActionPoint && unit.actions.length <= 1 && action.type !== 'patrol';
    const captureRadius = isLastAction
      ? airborneLoiterRadius(unit)
      : PATHFINDING_ARRIVAL_RADIUS;
    if (distance <= captureRadius) {
      if (isFinalActionPoint) {
        this.advanceAction(entity);
      } else {
        this.advanceActivePathPoint(entity);
      }
      unit.stuckTicks = 0;
      if (unit.actions.length === 0) this.queueAirborneLoiter(entity);
      return;
    }

    const index = this.count++;
    this.ensureCapacity(this.count);
    this.entities[index] = entity;
    this.entitySlots[index] = entity.entitySlotId;
    const body = entity.body;
    this.slots[index] = body === null
      ? SIMULATION_INVALID_BODY_SLOT
      : body.physicsBody.slot;
    this.dx[index] = dx;
    this.dy[index] = dy;
    this.distance[index] = distance;
    this.rotation[index] = entity.transform.rotation;
    this.fallbackVx[index] = unit.velocityX;
    this.fallbackVy[index] = unit.velocityY;
  }

  flush(movingUnits: Entity[]): void {
    const count = this.count;
    if (count === 0) return;

    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('SimulationAirborneWaypointController.flush: sim-wasm is not initialized');
    }
    sim.airborneWaypointSteerBatch(
      this.slots.subarray(0, count),
      this.dx.subarray(0, count),
      this.dy.subarray(0, count),
      this.distance.subarray(0, count),
      this.rotation.subarray(0, count),
      this.fallbackVx.subarray(0, count),
      this.fallbackVy.subarray(0, count),
      this.outThrustX.subarray(0, count),
      this.outThrustY.subarray(0, count),
      AIRBORNE_STEER_MIN_TURN_RADIUS,
      AIRBORNE_STEER_MAX_TURN_RADIUS,
      AIRBORNE_STEER_ESCAPE_RADIUS_RATIO,
      AIRBORNE_STEER_LOCK_SPEED_FLOOR,
    );

    for (let i = 0; i < count; i++) {
      const entity = this.entities[i];
      const unit = entity.unit;
      if (unit) {
        entitySlotRegistry.setUnitDriveInput(
          entity,
          this.outThrustX[i],
          this.outThrustY[i],
          this.outThrustX[i],
          this.outThrustY[i],
          this.entitySlots[i],
        );
        movingUnits.push(entity);
      }
      this.entities[i] = undefined as unknown as Entity;
    }
    this.count = 0;
  }

  reset(): void {
    this.count = 0;
    this.entities.length = 0;
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
      this.rotation,
      this.fallbackVx,
      this.fallbackVy,
    ] = growTypedArrays([
      this.slots,
      this.entitySlots,
      this.dx,
      this.dy,
      this.distance,
      this.rotation,
      this.fallbackVx,
      this.fallbackVy,
    ] as const, next);
    this.outThrustX = new Float64Array(next);
    this.outThrustY = new Float64Array(next);
  }
}
