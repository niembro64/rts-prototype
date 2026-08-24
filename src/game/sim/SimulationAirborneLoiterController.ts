import { magnitude } from '../math';
import { getSimWasm } from '../sim-wasm/init';
import type { Entity, Unit, UnitAction } from './types';
import type { WorldState } from './WorldState';
import { entitySlotRegistry } from './EntitySlotRegistry';
import { growTypedArrays, nextDoublingCapacity } from '../memory/typedArrayGrowth';

export const SIMULATION_INVALID_BODY_SLOT = 0xffffffff;

const AIRBORNE_LOITER_RADIUS_MULT = 8;
const AIRBORNE_LOITER_MIN_RADIUS = 80;
const AIRBORNE_LOITER_RADIAL_GAIN = 0.65;

export class SimulationAirborneLoiterController {
  private readonly world: WorldState;
  private readonly entities: Entity[] = [];
  private entitySlots = new Int32Array(0);
  private slots = new Uint32Array(0);
  private dx = new Float64Array(0);
  private dy = new Float64Array(0);
  private distance = new Float64Array(0);
  private rotation = new Float64Array(0);
  private radius = new Float64Array(0);
  private turnSign = new Float64Array(0);
  private fallbackVx = new Float64Array(0);
  private fallbackVy = new Float64Array(0);
  private outX = new Float64Array(0);
  private outY = new Float64Array(0);
  private outTurnSign = new Float64Array(0);
  private active = new Uint8Array(0);
  private count = 0;

  constructor(world: WorldState) {
    this.world = world;
  }

  rememberTarget(unit: Unit, action: UnitAction): void {
    if (!unit.locomotion.motionControl.cruiseWhenUncommanded) return;
    const x = this.clampMapX(action.x);
    const y = this.clampMapY(action.y);
    unit.airborneLoiterTargetX = x;
    unit.airborneLoiterTargetY = y;
    unit.airborneLoiterTargetZ = action.z ?? this.world.getGroundZ(x, y);
  }

  queue(entity: Entity): void {
    const unit = entity.unit;
    if (!unit || !unit.locomotion.motionControl.cruiseWhenUncommanded) return;

    const { transform } = entity;
    const storedCenterX = unit.airborneLoiterTargetX;
    const storedCenterY = unit.airborneLoiterTargetY;
    let centerX: number;
    let centerY: number;
    if (
      typeof storedCenterX !== 'number' ||
      typeof storedCenterY !== 'number' ||
      !Number.isFinite(storedCenterX) ||
      !Number.isFinite(storedCenterY)
    ) {
      centerX = this.clampMapX(transform.x);
      centerY = this.clampMapY(transform.y);
      unit.airborneLoiterTargetX = centerX;
      unit.airborneLoiterTargetY = centerY;
      unit.airborneLoiterTargetZ = Number.isFinite(transform.z)
        ? transform.z
        : this.world.getGroundZ(centerX, centerY);
    } else {
      centerX = this.clampMapX(storedCenterX);
      centerY = this.clampMapY(storedCenterY);
      unit.airborneLoiterTargetX = centerX;
      unit.airborneLoiterTargetY = centerY;
    }

    const dx = centerX - transform.x;
    const dy = centerY - transform.y;
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
    this.distance[index] = magnitude(dx, dy);
    this.rotation[index] = transform.rotation;
    this.radius[index] = unit.radius.collision;
    this.turnSign[index] =
      unit.airborneLoiterTurnSign === 1 || unit.airborneLoiterTurnSign === -1
        ? unit.airborneLoiterTurnSign
        : 0;
    this.fallbackVx[index] = unit.velocityX;
    this.fallbackVy[index] = unit.velocityY;
  }

  flush(movingUnits: Entity[]): void {
    const count = this.count;
    if (count === 0) return;

    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('SimulationAirborneLoiterController.flush: sim-wasm is not initialized');
    }
    sim.airborneLoiterStepBatch(
      this.slots.subarray(0, count),
      this.dx.subarray(0, count),
      this.dy.subarray(0, count),
      this.distance.subarray(0, count),
      this.rotation.subarray(0, count),
      this.radius.subarray(0, count),
      this.turnSign.subarray(0, count),
      this.fallbackVx.subarray(0, count),
      this.fallbackVy.subarray(0, count),
      this.outX.subarray(0, count),
      this.outY.subarray(0, count),
      this.outTurnSign.subarray(0, count),
      this.active.subarray(0, count),
      AIRBORNE_LOITER_MIN_RADIUS,
      AIRBORNE_LOITER_RADIUS_MULT,
      AIRBORNE_LOITER_RADIAL_GAIN,
    );

    for (let i = 0; i < count; i++) {
      const entity = this.entities[i];
      const unit = entity.unit;
      if (unit) {
        entitySlotRegistry.setUnitDriveInput(
          entity,
          this.outX[i],
          this.outY[i],
          this.outX[i],
          this.outY[i],
          this.entitySlots[i],
        );
        const turnSign = this.outTurnSign[i];
        unit.airborneLoiterTurnSign = turnSign === 1 || turnSign === -1 ? turnSign : null;
        if (this.active[i] !== 0) movingUnits.push(entity);
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
      this.radius,
      this.turnSign,
      this.fallbackVx,
      this.fallbackVy,
    ] = growTypedArrays([
      this.slots,
      this.entitySlots,
      this.dx,
      this.dy,
      this.distance,
      this.rotation,
      this.radius,
      this.turnSign,
      this.fallbackVx,
      this.fallbackVy,
    ] as const, next);
    this.outX = new Float64Array(next);
    this.outY = new Float64Array(next);
    this.outTurnSign = new Float64Array(next);
    this.active = new Uint8Array(next);
  }

  private clampMapX(x: number): number {
    return Math.max(0, Math.min(this.world.mapWidth, x));
  }

  private clampMapY(y: number): number {
    return Math.max(0, Math.min(this.world.mapHeight, y));
  }
}
