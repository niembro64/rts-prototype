import { magnitude } from '../math';
import { getSimWasm } from '../sim-wasm/init';
import type { Entity, UnitAction } from './types';
import { SIMULATION_INVALID_BODY_SLOT } from './SimulationAirborneLoiterController';
import { isMovementAnchorAction } from './unitActions';
import { PATHFINDING_ARRIVAL_RADIUS } from './pathfindingTuning';
import { entitySlotRegistry } from './EntitySlotRegistry';
import { growTypedArrays, nextDoublingCapacity } from '../memory/typedArrayGrowth';

/** Turn-radius clamp for R = speed / maxYawRate (the yaw ceiling comes from
 *  the sim's own attitude-servo spring inside the kernel). */
const AIRBORNE_STEER_MIN_TURN_RADIUS = 40;
const AIRBORNE_STEER_MAX_TURN_RADIUS = 600;
/** The no-turn lock applies only while actually moving; below this speed a
 *  boundary-pinned or freshly launched unit steers freely. */
const AIRBORNE_STEER_LOCK_SPEED_FLOOR = 5;
/** Fallbacks matching the authored plane/aerosub waypointDeadzone config;
 *  used only if a cruise preset somehow lacks the block. */
const AIRBORNE_STEER_DEFAULT_DEADZONE_TURN_RADIUS_MULTIPLIER = 2.5;
const AIRBORNE_STEER_DEFAULT_FRONT_SLICE_DEGREES = 45;

/** Waypoint steering for cruise locomotion (plane, aerosub). Two rules:
 *  a NON-TERMINATING waypoint has the authored no-turn deadzone — inside
 *  `turnRadiusMultiplier x turn radius` of it, the unit may keep turning
 *  only while the waypoint sits within `frontSliceDegrees` of its nose, so
 *  a miss is a large straight miss — and captures at the standard arrival
 *  radius so the queue advances. The TERMINATING (move/fight anchor)
 *  waypoint has no deadzone and never captures: the unit always turns
 *  toward it at its constant rate, passing through, turning back, and
 *  passing again — the perpetual pursuit is the hold, and it counters wind
 *  by construction. Stateless per tick, one WASM batch for the whole cruise
 *  population. */
export class SimulationAirborneWaypointController {
  private readonly advanceAction: (entity: Entity) => void;
  private readonly advanceActivePathPoint: (entity: Entity) => void;
  private readonly entities: Entity[] = [];
  private entitySlots = new Int32Array(0);
  private slots = new Uint32Array(0);
  private dx = new Float64Array(0);
  private dy = new Float64Array(0);
  private distance = new Float64Array(0);
  private rotation = new Float64Array(0);
  private deadzoneMultiplier = new Float64Array(0);
  private frontSliceDegrees = new Float64Array(0);
  private fallbackVx = new Float64Array(0);
  private fallbackVy = new Float64Array(0);
  private outThrustX = new Float64Array(0);
  private outThrustY = new Float64Array(0);
  private count = 0;

  constructor(
    callbacks: {
      advanceAction: (entity: Entity) => void;
      advanceActivePathPoint: (entity: Entity) => void;
    },
  ) {
    this.advanceAction = callbacks.advanceAction;
    this.advanceActivePathPoint = callbacks.advanceActivePathPoint;
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
    const terminalPursuit = isLastAction && isMovementAnchorAction(action);
    if (!terminalPursuit && distance <= PATHFINDING_ARRIVAL_RADIUS) {
      if (isFinalActionPoint) {
        this.advanceAction(entity);
      } else {
        this.advanceActivePathPoint(entity);
      }
      unit.stuckTicks = 0;
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
    const deadzone = unit.locomotion.motionControl.waypointDeadzone;
    // Multiplier 0 disables the deadzone in the kernel: the terminating
    // waypoint is always turned toward, from any angle and any distance.
    this.deadzoneMultiplier[index] = terminalPursuit
      ? 0
      : deadzone?.turnRadiusMultiplier
        ?? AIRBORNE_STEER_DEFAULT_DEADZONE_TURN_RADIUS_MULTIPLIER;
    this.frontSliceDegrees[index] = deadzone?.frontSliceDegrees
      ?? AIRBORNE_STEER_DEFAULT_FRONT_SLICE_DEGREES;
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
      this.deadzoneMultiplier.subarray(0, count),
      this.frontSliceDegrees.subarray(0, count),
      this.fallbackVx.subarray(0, count),
      this.fallbackVy.subarray(0, count),
      this.outThrustX.subarray(0, count),
      this.outThrustY.subarray(0, count),
      AIRBORNE_STEER_MIN_TURN_RADIUS,
      AIRBORNE_STEER_MAX_TURN_RADIUS,
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
      this.deadzoneMultiplier,
      this.frontSliceDegrees,
      this.fallbackVx,
      this.fallbackVy,
    ] = growTypedArrays([
      this.slots,
      this.entitySlots,
      this.dx,
      this.dy,
      this.distance,
      this.rotation,
      this.deadzoneMultiplier,
      this.frontSliceDegrees,
      this.fallbackVx,
      this.fallbackVy,
    ] as const, next);
    this.outThrustX = new Float64Array(next);
    this.outThrustY = new Float64Array(next);
  }
}
