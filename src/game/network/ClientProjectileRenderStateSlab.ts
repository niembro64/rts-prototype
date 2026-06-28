import type { Entity, EntityId } from '../sim/types';

const INITIAL_PROJECTILE_RENDER_STATE_CAP = 4096;

export const CLIENT_PROJECTILE_RENDER_FLAG_TRAVELING = 1;
export const CLIENT_PROJECTILE_RENDER_FLAG_SMOKE_TRAIL = 1 << 1;
export const CLIENT_PROJECTILE_RENDER_FLAG_LINE = 1 << 2;
export const CLIENT_PROJECTILE_RENDER_FLAG_BURN_MARK = 1 << 3;
export const CLIENT_PROJECTILE_RENDER_FLAG_HAS_POINTS = 1 << 4;

export type ClientProjectileRenderStateViews = {
  readonly entityIds: Float64Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly minX: Float32Array;
  readonly maxX: Float32Array;
  readonly minY: Float32Array;
  readonly maxY: Float32Array;
  readonly flags: Uint16Array;
};

function growFloat32(source: Float32Array, nextCapacity: number): Float32Array {
  const next = new Float32Array(nextCapacity);
  next.set(source);
  return next;
}

function growFloat64(source: Float64Array, nextCapacity: number): Float64Array {
  const next = new Float64Array(nextCapacity);
  next.set(source);
  return next;
}

function growUint16(source: Uint16Array, nextCapacity: number): Uint16Array {
  const next = new Uint16Array(nextCapacity);
  next.set(source);
  return next;
}

export class ClientProjectileRenderStateSlab {
  private readonly slotByEntityId = new Map<EntityId, number>();
  private readonly freeSlots: number[] = [];
  private nextSlot = 0;
  private views: ClientProjectileRenderStateViews = {
    entityIds: new Float64Array(INITIAL_PROJECTILE_RENDER_STATE_CAP),
    x: new Float32Array(INITIAL_PROJECTILE_RENDER_STATE_CAP),
    y: new Float32Array(INITIAL_PROJECTILE_RENDER_STATE_CAP),
    z: new Float32Array(INITIAL_PROJECTILE_RENDER_STATE_CAP),
    minX: new Float32Array(INITIAL_PROJECTILE_RENDER_STATE_CAP),
    maxX: new Float32Array(INITIAL_PROJECTILE_RENDER_STATE_CAP),
    minY: new Float32Array(INITIAL_PROJECTILE_RENDER_STATE_CAP),
    maxY: new Float32Array(INITIAL_PROJECTILE_RENDER_STATE_CAP),
    flags: new Uint16Array(INITIAL_PROJECTILE_RENDER_STATE_CAP),
  };

  getViews(): ClientProjectileRenderStateViews {
    return this.views;
  }

  getSlot(id: EntityId): number | undefined {
    return this.slotByEntityId.get(id);
  }

  refreshEntity(entity: Entity): number | undefined {
    const projectile = entity.projectile;
    if (projectile === null) {
      this.unsetEntity(entity.id);
      return undefined;
    }
    const slot = this.slotForEntity(entity.id);
    const views = this.views;
    const x = entity.transform.x;
    const y = entity.transform.y;
    const z = entity.transform.z;
    views.entityIds[slot] = entity.id;
    views.x[slot] = x;
    views.y[slot] = y;
    views.z[slot] = z;

    let flags = 0;
    if (projectile.projectileType === 'projectile') {
      flags |= CLIENT_PROJECTILE_RENDER_FLAG_TRAVELING;
      if (projectile.config.shotProfile.visual.smokeTrail !== undefined) {
        flags |= CLIENT_PROJECTILE_RENDER_FLAG_SMOKE_TRAIL;
      }
      if (entity.dgunProjectile?.isDGun === true) {
        flags |= CLIENT_PROJECTILE_RENDER_FLAG_BURN_MARK;
      }
    } else {
      flags |= CLIENT_PROJECTILE_RENDER_FLAG_LINE | CLIENT_PROJECTILE_RENDER_FLAG_BURN_MARK;
    }

    let minX = x;
    let maxX = x;
    let minY = y;
    let maxY = y;
    const points = projectile.points;
    if (points !== null && points.length > 0) {
      flags |= CLIENT_PROJECTILE_RENDER_FLAG_HAS_POINTS;
      for (let i = 0; i < points.length; i++) {
        const point = points[i];
        if (point.x < minX) minX = point.x;
        if (point.x > maxX) maxX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.y > maxY) maxY = point.y;
      }
    }
    views.minX[slot] = minX;
    views.maxX[slot] = maxX;
    views.minY[slot] = minY;
    views.maxY[slot] = maxY;
    views.flags[slot] = flags;
    return slot;
  }

  unsetEntity(id: EntityId): void {
    const slot = this.slotByEntityId.get(id);
    if (slot === undefined) return;
    this.slotByEntityId.delete(id);
    this.views.entityIds[slot] = 0;
    this.views.flags[slot] = 0;
    this.freeSlots.push(slot);
  }

  clear(): void {
    this.slotByEntityId.clear();
    this.freeSlots.length = 0;
    this.nextSlot = 0;
    this.views.entityIds.fill(0);
    this.views.flags.fill(0);
  }

  private slotForEntity(id: EntityId): number {
    const existing = this.slotByEntityId.get(id);
    if (existing !== undefined) return existing;
    const slot = this.freeSlots.pop() ?? this.nextSlot++;
    this.ensureCapacity(slot + 1);
    this.slotByEntityId.set(id, slot);
    this.views.entityIds[slot] = id;
    return slot;
  }

  private ensureCapacity(required: number): void {
    if (required <= this.views.entityIds.length) return;
    let nextCapacity = this.views.entityIds.length;
    while (nextCapacity < required) nextCapacity *= 2;
    const views = this.views;
    this.views = {
      entityIds: growFloat64(views.entityIds, nextCapacity),
      x: growFloat32(views.x, nextCapacity),
      y: growFloat32(views.y, nextCapacity),
      z: growFloat32(views.z, nextCapacity),
      minX: growFloat32(views.minX, nextCapacity),
      maxX: growFloat32(views.maxX, nextCapacity),
      minY: growFloat32(views.minY, nextCapacity),
      maxY: growFloat32(views.maxY, nextCapacity),
      flags: growUint16(views.flags, nextCapacity),
    };
  }
}
