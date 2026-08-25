import { magnitude } from '../math';
import { getSimWasm } from '../sim-wasm/init';
import type { Entity, UnitAction } from './types';
import { SIMULATION_INVALID_BODY_SLOT } from './SimulationAirborneLoiterController';
import { isMovementAnchorAction } from './unitActions';
import { entitySlotRegistry } from './EntitySlotRegistry';
import { growTypedArrays, nextDoublingCapacity } from '../memory/typedArrayGrowth';

/** Turn-radius clamp for R = speed / maxYawRate (the yaw ceiling comes from
 *  the sim's own attitude-servo spring inside the kernel). */
const WAYPOINT_STEER_MIN_TURN_RADIUS = 4;
/** Wide enough for even the slowest-slewing body-forward chassis. */
const WAYPOINT_STEER_MAX_TURN_RADIUS = 1200;
/** The no-turn lock applies only while actually moving; below this speed a
 *  boundary-pinned or freshly launched unit steers freely. */
const WAYPOINT_STEER_LOCK_SPEED_FLOOR = 0.25;
const WAYPOINT_STEER_DEFAULT_DEADZONE_TURN_RADIUS_MULTIPLIER = 2.5;
const WAYPOINT_STEER_DEFAULT_FRONT_SLICE_DEGREES = 45;

/** Orbit-proof waypoint steering for every body-forward locomotion preset.
 * Two rules:
 *  a NON-TERMINATING waypoint has the authored no-turn deadzone — inside
 *  `turnRadiusMultiplier x turn radius` of it, the unit may keep turning
 *  only while the waypoint sits within `frontSliceDegrees` of its nose, so
 *  a miss is a large straight miss — and captures at the route leg's
 *  obstacle-aware arrival radius so the queue advances. The TERMINATING
 *  (move/fight anchor)
 *  waypoint uses ordinary arrival braking for non-cruise chassis. A cruise
 *  chassis keeps its old no-capture pursuit, passing and returning forever.
 *  Stateless per tick, one WASM batch for all participating locomotion. */
export class SimulationWaypointOrbitController {
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

  /** Route one body-forward movement leg: capture a pass-through point when
   *  inside its arrival radius, otherwise queue the escape-ring steer. */
  queue(
    entity: Entity,
    action: UnitAction,
    isFinalActionPoint: boolean,
    captureRadius: number,
    dx: number,
    dy: number,
  ): boolean {
    const unit = entity.unit;
    if (!unit) return false;

    const distance = magnitude(dx, dy);
    if (!Number.isFinite(distance)) return false;
    const isLastAction =
      isFinalActionPoint && unit.actions.length <= 1 && action.type !== 'patrol';
    const movementAnchor = isLastAction && isMovementAnchorAction(action);
    const terminalPursuit =
      movementAnchor && unit.locomotion.motionControl.cruiseWhenUncommanded;
    // Non-cruise move/fight anchors must settle and remain durable. Let the
    // shared arrival controller own that final stop; this controller is for
    // pass-through route/action points that must not become an orbit.
    if (movementAnchor && !terminalPursuit) return false;
    if (!terminalPursuit && distance <= captureRadius) {
      if (isFinalActionPoint) {
        this.advanceAction(entity);
      } else {
        this.advanceActivePathPoint(entity);
      }
      unit.stuckTicks = 0;
      return true;
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
        ?? WAYPOINT_STEER_DEFAULT_DEADZONE_TURN_RADIUS_MULTIPLIER;
    this.frontSliceDegrees[index] = deadzone?.frontSliceDegrees
      ?? WAYPOINT_STEER_DEFAULT_FRONT_SLICE_DEGREES;
    this.fallbackVx[index] = unit.velocityX;
    this.fallbackVy[index] = unit.velocityY;
    return true;
  }

  flush(movingUnits: Entity[]): void {
    const count = this.count;
    if (count === 0) return;

    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('SimulationWaypointOrbitController.flush: sim-wasm is not initialized');
    }
    sim.waypointOrbitSteerBatch(
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
      WAYPOINT_STEER_MIN_TURN_RADIUS,
      WAYPOINT_STEER_MAX_TURN_RADIUS,
      WAYPOINT_STEER_LOCK_SPEED_FLOOR,
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
