import type { Entity, EntityId, PlayerId } from '../sim/types';
import { getConstructionPieceRenderFraction } from '../sim/buildableHelpers';
import { getUnitGroundZ } from '../sim/unitGeometry';

const ENTITY_RENDER_PACKET_INITIAL_CAP = 4096;
const NO_OWNER_ID = 0;

const ENTITY_RENDER_FLAG_SELECTED = 1;

function growFloat32(
  source: Float32Array<ArrayBuffer>,
  nextCapacity: number,
): Float32Array<ArrayBuffer> {
  const next = new Float32Array(nextCapacity);
  next.set(source);
  return next;
}

function growFloat64(
  source: Float64Array<ArrayBuffer>,
  nextCapacity: number,
): Float64Array<ArrayBuffer> {
  const next = new Float64Array(nextCapacity);
  next.set(source);
  return next;
}

function growUint8(
  source: Uint8Array<ArrayBuffer>,
  nextCapacity: number,
): Uint8Array<ArrayBuffer> {
  const next = new Uint8Array(nextCapacity);
  next.set(source);
  return next;
}

export class UnitRenderPacket3D {
  ids = new Float64Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  ownerIds = new Float64Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  x = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  y = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  z = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  rotation = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  groundY = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  radiusVisual = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  normalX = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  normalY = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  normalZ = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  velocityX = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  velocityY = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  yawRate = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  flags = new Uint8Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  count = 0;

  reset(): void {
    this.count = 0;
  }

  pushEntity(entity: Entity): void {
    const unit = entity.unit;
    if (unit === null) return;
    const cursor = this.count;
    this.ensureCapacity(cursor + 1);
    this.ids[cursor] = entity.id;
    this.ownerIds[cursor] = entity.ownership?.playerId ?? NO_OWNER_ID;
    this.x[cursor] = entity.transform.x;
    this.y[cursor] = entity.transform.y;
    this.z[cursor] = entity.transform.z;
    this.rotation[cursor] = entity.transform.rotation;
    this.groundY[cursor] = getUnitGroundZ(entity);
    this.radiusVisual[cursor] = unit.radius.visual || unit.radius.hitbox || 15;
    this.normalX[cursor] = unit.surfaceNormal.nx;
    this.normalY[cursor] = unit.surfaceNormal.ny;
    this.normalZ[cursor] = unit.surfaceNormal.nz;
    this.velocityX[cursor] = unit.velocityX;
    this.velocityY[cursor] = unit.velocityY;
    this.yawRate[cursor] = unit.angularVelocity3?.z ?? 0;
    this.flags[cursor] = entity.selectable?.selected === true
      ? ENTITY_RENDER_FLAG_SELECTED
      : 0;
    this.count = cursor + 1;
  }

  entityIdAt(row: number): EntityId {
    return this.ids[row] as EntityId;
  }

  ownerIdAt(row: number): PlayerId | undefined {
    const ownerId = this.ownerIds[row];
    return ownerId > 0 ? ownerId as PlayerId : undefined;
  }

  selectedAt(row: number): boolean {
    return (this.flags[row] & ENTITY_RENDER_FLAG_SELECTED) !== 0;
  }

  private ensureCapacity(required: number): void {
    if (required <= this.ids.length) return;
    let nextCapacity = this.ids.length;
    while (nextCapacity < required) nextCapacity *= 2;
    this.ids = growFloat64(this.ids, nextCapacity);
    this.ownerIds = growFloat64(this.ownerIds, nextCapacity);
    this.x = growFloat32(this.x, nextCapacity);
    this.y = growFloat32(this.y, nextCapacity);
    this.z = growFloat32(this.z, nextCapacity);
    this.rotation = growFloat32(this.rotation, nextCapacity);
    this.groundY = growFloat32(this.groundY, nextCapacity);
    this.radiusVisual = growFloat32(this.radiusVisual, nextCapacity);
    this.normalX = growFloat32(this.normalX, nextCapacity);
    this.normalY = growFloat32(this.normalY, nextCapacity);
    this.normalZ = growFloat32(this.normalZ, nextCapacity);
    this.velocityX = growFloat32(this.velocityX, nextCapacity);
    this.velocityY = growFloat32(this.velocityY, nextCapacity);
    this.yawRate = growFloat32(this.yawRate, nextCapacity);
    this.flags = growUint8(this.flags, nextCapacity);
  }
}

export class BuildingRenderPacket3D {
  ids = new Float64Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  ownerIds = new Float64Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  x = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  y = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  z = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  rotation = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  baseY = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  width = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  footprintDepth = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  progress = new Float32Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  flags = new Uint8Array(ENTITY_RENDER_PACKET_INITIAL_CAP);
  count = 0;

  reset(): void {
    this.count = 0;
  }

  pushEntity(entity: Entity): void {
    const building = entity.building;
    if (building === null) return;
    const cursor = this.count;
    this.ensureCapacity(cursor + 1);
    this.ids[cursor] = entity.id;
    this.ownerIds[cursor] = entity.ownership?.playerId ?? NO_OWNER_ID;
    this.x[cursor] = entity.transform.x;
    this.y[cursor] = entity.transform.y;
    this.z[cursor] = entity.transform.z;
    this.rotation[cursor] = entity.transform.rotation;
    this.baseY[cursor] = entity.transform.z - building.depth / 2;
    this.width[cursor] = building.width;
    this.footprintDepth[cursor] = building.height;
    this.progress[cursor] = getConstructionPieceRenderFraction(entity, 'body');
    this.flags[cursor] = entity.selectable?.selected === true
      ? ENTITY_RENDER_FLAG_SELECTED
      : 0;
    this.count = cursor + 1;
  }

  entityIdAt(row: number): EntityId {
    return this.ids[row] as EntityId;
  }

  ownerIdAt(row: number): PlayerId | undefined {
    const ownerId = this.ownerIds[row];
    return ownerId > 0 ? ownerId as PlayerId : undefined;
  }

  selectedAt(row: number): boolean {
    return (this.flags[row] & ENTITY_RENDER_FLAG_SELECTED) !== 0;
  }

  private ensureCapacity(required: number): void {
    if (required <= this.ids.length) return;
    let nextCapacity = this.ids.length;
    while (nextCapacity < required) nextCapacity *= 2;
    this.ids = growFloat64(this.ids, nextCapacity);
    this.ownerIds = growFloat64(this.ownerIds, nextCapacity);
    this.x = growFloat32(this.x, nextCapacity);
    this.y = growFloat32(this.y, nextCapacity);
    this.z = growFloat32(this.z, nextCapacity);
    this.rotation = growFloat32(this.rotation, nextCapacity);
    this.baseY = growFloat32(this.baseY, nextCapacity);
    this.width = growFloat32(this.width, nextCapacity);
    this.footprintDepth = growFloat32(this.footprintDepth, nextCapacity);
    this.progress = growFloat32(this.progress, nextCapacity);
    this.flags = growUint8(this.flags, nextCapacity);
  }
}
