import { magnitude } from '../math';
import { getSimWasm } from '../sim-wasm/init';
import type { Entity, Unit, UnitAction } from './types';
import type { WorldState } from './WorldState';
import { entitySlotRegistry } from './EntitySlotRegistry';

export const SIMULATION_INVALID_BODY_SLOT = 0xffffffff;

const FLYING_LOITER_RADIUS_MULT = 8;
const FLYING_LOITER_MIN_RADIUS = 80;
const FLYING_LOITER_RADIAL_GAIN = 0.65;

export class SimulationFlyingLoiterController {
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
    unit.flyingLoiterTargetX = x;
    unit.flyingLoiterTargetY = y;
    unit.flyingLoiterTargetZ = action.z ?? this.world.getGroundZ(x, y);
  }

  queue(entity: Entity): void {
    const unit = entity.unit;
    if (!unit || !unit.locomotion.motionControl.cruiseWhenUncommanded) return;

    const { transform } = entity;
    const storedCenterX = unit.flyingLoiterTargetX;
    const storedCenterY = unit.flyingLoiterTargetY;
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
      unit.flyingLoiterTargetX = centerX;
      unit.flyingLoiterTargetY = centerY;
      unit.flyingLoiterTargetZ = Number.isFinite(transform.z)
        ? transform.z
        : this.world.getGroundZ(centerX, centerY);
    } else {
      centerX = this.clampMapX(storedCenterX);
      centerY = this.clampMapY(storedCenterY);
      unit.flyingLoiterTargetX = centerX;
      unit.flyingLoiterTargetY = centerY;
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
      unit.flyingLoiterTurnSign === 1 || unit.flyingLoiterTurnSign === -1
        ? unit.flyingLoiterTurnSign
        : 0;
    this.fallbackVx[index] = unit.velocityX;
    this.fallbackVy[index] = unit.velocityY;
  }

  flush(movingUnits: Entity[]): void {
    const count = this.count;
    if (count === 0) return;

    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('SimulationFlyingLoiterController.flush: sim-wasm is not initialized');
    }
    sim.flyingLoiterStepBatch(
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
      FLYING_LOITER_MIN_RADIUS,
      FLYING_LOITER_RADIUS_MULT,
      FLYING_LOITER_RADIAL_GAIN,
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
        unit.flyingLoiterTurnSign = turnSign === 1 || turnSign === -1 ? turnSign : null;
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
    const rotation = new Float64Array(next);
    rotation.set(this.rotation);
    this.rotation = rotation;
    const radius = new Float64Array(next);
    radius.set(this.radius);
    this.radius = radius;
    const turnSign = new Float64Array(next);
    turnSign.set(this.turnSign);
    this.turnSign = turnSign;
    const fallbackVx = new Float64Array(next);
    fallbackVx.set(this.fallbackVx);
    this.fallbackVx = fallbackVx;
    const fallbackVy = new Float64Array(next);
    fallbackVy.set(this.fallbackVy);
    this.fallbackVy = fallbackVy;
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
