import { magnitude } from '../math';
import { getSimWasm } from '../sim-wasm/init';
import type { Entity, Unit, UnitAction } from './types';
import type { WorldState } from './WorldState';
import {
  SIMULATION_INVALID_BODY_SLOT,
  airborneLoiterRadius,
} from './SimulationAirborneLoiterController';
import { PATHFINDING_ARRIVAL_RADIUS } from './pathfindingTuning';
import { entitySlotRegistry } from './EntitySlotRegistry';
import { growTypedArrays, nextDoublingCapacity } from '../memory/typedArrayGrowth';

/** Reachability geometry runs 1-in-N ticks per unit, staggered by entity id;
 *  steering between checks rides the latched FSM state. */
const AIRBORNE_RETURN_CHECK_INTERVAL_TICKS = 5;
/** Turn-radius estimate clamp (v^2 / driveAccel can degenerate near zero
 *  speed and explode at terminal speed with weak thrust). */
const AIRBORNE_RETURN_MIN_TURN_RADIUS = 40;
const AIRBORNE_RETURN_MAX_TURN_RADIUS = 600;
/** Strict containment for the enter test: any margin above 1 makes a
 *  dead-ahead goal closer than R*sqrt(margin^2-1) read as "inside" and
 *  preempts clean capture. */
const AIRBORNE_RETURN_ENTER_MARGIN = 1.0;
/** Egress exits at this multiple of the committed turn radius — a full
 *  turn-around (2R) plus margin, so the return leg is a straight run that
 *  actually crosses the point. */
const AIRBORNE_RETURN_EXIT_RADIUS_RATIO = 2.5;
/** A check must close at least this many world units on the goal to count as
 *  progress for the stall backstop. */
const AIRBORNE_RETURN_PROGRESS_EPSILON_WU = 1;
const AIRBORNE_RETURN_STALL_CHECK_LIMIT = 2;
/** Stalls only count while velocity is near-tangential to the goal direction
 *  (the orbit signature); an outbound post-turnaround leg does not count. */
const AIRBORNE_RETURN_STALL_ALIGN_DOT_MAX = 0.5;
/** A goal that moved more than this restarts the FSM at approach. */
const AIRBORNE_RETURN_GOAL_EPSILON_WU = 0.5;

/** Waypoint controller for cruise locomotion (plane, aerosub). A forward-
 *  flight body cannot brake at a point, and a goal inside its turning circle
 *  cannot be reached by steering toward it — greedy pursuit decays into a
 *  constant-radius orbit that never completes the order. This controller
 *  captures waypoints at flight-appropriate radii (the arrival radius for
 *  intermediate/queued points, the loiter radius for the final point) and
 *  runs the turn-circle reachability FSM in one WASM batch for every cruise
 *  unit still approaching. */
export class SimulationAirborneReturnController {
  private readonly world: WorldState;
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
  private state = new Uint8Array(0);
  private headingX = new Float64Array(0);
  private headingY = new Float64Array(0);
  private committedRadius = new Float64Array(0);
  private flags = new Uint8Array(0);
  private lastCheckDistance = new Float64Array(0);
  private stallChecks = new Uint8Array(0);
  private fallbackVx = new Float64Array(0);
  private fallbackVy = new Float64Array(0);
  private outThrustX = new Float64Array(0);
  private outThrustY = new Float64Array(0);
  private outState = new Uint8Array(0);
  private outHeadingX = new Float64Array(0);
  private outHeadingY = new Float64Array(0);
  private outRadius = new Float64Array(0);
  private outCheckDistance = new Float64Array(0);
  private outStallChecks = new Uint8Array(0);
  private count = 0;

  constructor(
    world: WorldState,
    callbacks: {
      advanceAction: (entity: Entity) => void;
      advanceActivePathPoint: (entity: Entity) => void;
      queueAirborneLoiter: (entity: Entity) => void;
    },
  ) {
    this.world = world;
    this.advanceAction = callbacks.advanceAction;
    this.advanceActivePathPoint = callbacks.advanceActivePathPoint;
    this.queueAirborneLoiter = callbacks.queueAirborneLoiter;
  }

  /** Route one cruise-unit movement leg: capture the point when inside its
   *  flight-appropriate radius, otherwise queue the FSM steering step. */
  queue(
    entity: Entity,
    action: UnitAction,
    goalX: number,
    goalY: number,
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
      resetAirborneReturnState(unit);
      if (unit.actions.length === 0) this.queueAirborneLoiter(entity);
      return;
    }

    if (
      unit.airborneReturnGoalX === null ||
      unit.airborneReturnGoalY === null ||
      Math.abs(unit.airborneReturnGoalX - goalX) > AIRBORNE_RETURN_GOAL_EPSILON_WU ||
      Math.abs(unit.airborneReturnGoalY - goalY) > AIRBORNE_RETURN_GOAL_EPSILON_WU
    ) {
      resetAirborneReturnState(unit);
      unit.airborneReturnGoalX = goalX;
      unit.airborneReturnGoalY = goalY;
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
    this.state[index] = unit.airborneReturnState;
    this.headingX[index] = unit.airborneReturnHeadingX;
    this.headingY[index] = unit.airborneReturnHeadingY;
    this.committedRadius[index] = unit.airborneReturnRadius;
    this.flags[index] =
      (this.world.getTick() + entity.id) % AIRBORNE_RETURN_CHECK_INTERVAL_TICKS === 0
        ? 1
        : 0;
    this.lastCheckDistance[index] = unit.airborneReturnCheckDistance;
    this.stallChecks[index] = unit.airborneReturnStallChecks;
    this.fallbackVx[index] = unit.velocityX;
    this.fallbackVy[index] = unit.velocityY;
  }

  flush(movingUnits: Entity[]): void {
    const count = this.count;
    if (count === 0) return;

    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('SimulationAirborneReturnController.flush: sim-wasm is not initialized');
    }
    sim.airborneReturnStepBatch(
      this.slots.subarray(0, count),
      this.dx.subarray(0, count),
      this.dy.subarray(0, count),
      this.distance.subarray(0, count),
      this.rotation.subarray(0, count),
      this.state.subarray(0, count),
      this.headingX.subarray(0, count),
      this.headingY.subarray(0, count),
      this.committedRadius.subarray(0, count),
      this.flags.subarray(0, count),
      this.lastCheckDistance.subarray(0, count),
      this.stallChecks.subarray(0, count),
      this.fallbackVx.subarray(0, count),
      this.fallbackVy.subarray(0, count),
      this.outThrustX.subarray(0, count),
      this.outThrustY.subarray(0, count),
      this.outState.subarray(0, count),
      this.outHeadingX.subarray(0, count),
      this.outHeadingY.subarray(0, count),
      this.outRadius.subarray(0, count),
      this.outCheckDistance.subarray(0, count),
      this.outStallChecks.subarray(0, count),
      AIRBORNE_RETURN_MIN_TURN_RADIUS,
      AIRBORNE_RETURN_MAX_TURN_RADIUS,
      AIRBORNE_RETURN_ENTER_MARGIN,
      AIRBORNE_RETURN_EXIT_RADIUS_RATIO,
      AIRBORNE_RETURN_PROGRESS_EPSILON_WU,
      AIRBORNE_RETURN_STALL_CHECK_LIMIT,
      AIRBORNE_RETURN_STALL_ALIGN_DOT_MAX,
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
        unit.airborneReturnState = this.outState[i];
        unit.airborneReturnHeadingX = this.outHeadingX[i];
        unit.airborneReturnHeadingY = this.outHeadingY[i];
        unit.airborneReturnRadius = this.outRadius[i];
        unit.airborneReturnCheckDistance = this.outCheckDistance[i];
        unit.airborneReturnStallChecks = this.outStallChecks[i];
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
      this.state,
      this.headingX,
      this.headingY,
      this.committedRadius,
      this.flags,
      this.lastCheckDistance,
      this.stallChecks,
      this.fallbackVx,
      this.fallbackVy,
    ] = growTypedArrays([
      this.slots,
      this.entitySlots,
      this.dx,
      this.dy,
      this.distance,
      this.rotation,
      this.state,
      this.headingX,
      this.headingY,
      this.committedRadius,
      this.flags,
      this.lastCheckDistance,
      this.stallChecks,
      this.fallbackVx,
      this.fallbackVy,
    ] as const, next);
    this.outThrustX = new Float64Array(next);
    this.outThrustY = new Float64Array(next);
    this.outState = new Uint8Array(next);
    this.outHeadingX = new Float64Array(next);
    this.outHeadingY = new Float64Array(next);
    this.outRadius = new Float64Array(next);
    this.outCheckDistance = new Float64Array(next);
    this.outStallChecks = new Uint8Array(next);
  }
}

/** Restart the FSM at approach: a captured, replaced, or first-seen goal
 *  owns no latched egress heading or stall history. */
export function resetAirborneReturnState(unit: Unit): void {
  unit.airborneReturnState = 0;
  unit.airborneReturnHeadingX = 0;
  unit.airborneReturnHeadingY = 0;
  unit.airborneReturnRadius = 0;
  unit.airborneReturnGoalX = null;
  unit.airborneReturnGoalY = null;
  unit.airborneReturnCheckDistance = 0;
  unit.airborneReturnStallChecks = 0;
}
