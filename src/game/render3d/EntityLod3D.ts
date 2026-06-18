import type * as THREE from 'three';
import {
  ENTITY_LOD_ENABLED,
  ENTITY_LOD_ENTER_PROXY_DISTANCE_MULTIPLIER,
  ENTITY_LOD_EXIT_PROXY_DISTANCE_MULTIPLIER,
  ENTITY_LOD_FULL_DETAIL_DISTANCE,
  ENTITY_LOD_HYSTERESIS_ENABLED,
  ENTITY_LOD_MIN_RADIUS,
  ENTITY_LOD_PROXY_ENABLED,
  ENTITY_LOD_REFERENCE_RADIUS,
} from '@/config';
import type { Entity, EntityId } from '../sim/types';

const FALLBACK_MIN_ENTITY_LOD_RADIUS = 1;
const ENTITY_LOD_BODY_CHANNEL = 'body';
const LOD_HYSTERESIS_STALE_FRAME_LIMIT = 120;

export type EntityLodEmission3D =
  | 'bodyHud'
  | 'bodyNames'
  | 'turretNames'
  | 'shotNames'
  | 'contactShadows'
  | 'groundPrints'
  | 'lineProjectiles'
  | 'projectileCores'
  | 'projectileTrailsAndFins'
  | 'projectileBurnMarks'
  | 'projectileSmokeTrails'
  | 'resourceSprays'
  | 'waterSplashes'
  | 'materialDeathExplosions'
  | 'shieldFields'
  | 'shieldImpacts'
  | 'hitImpacts'
  | 'projectileExpireImpacts';

export type EntityLodCutoffDistance3D = number | null;

function finitePositiveRadius(...values: Array<number | null | undefined>): number {
  let radius = 0;
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > radius) {
      radius = value;
    }
  }
  return Math.max(minEntityLodRadius(), radius);
}

function finitePositiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function minEntityLodRadius(): number {
  return finitePositiveOr(ENTITY_LOD_MIN_RADIUS, FALLBACK_MIN_ENTITY_LOD_RADIUS);
}

function enterProxyDistanceMultiplier(): number {
  return finitePositiveOr(ENTITY_LOD_ENTER_PROXY_DISTANCE_MULTIPLIER, 1);
}

function exitProxyDistanceMultiplier(): number {
  const enter = enterProxyDistanceMultiplier();
  const exit = finitePositiveOr(ENTITY_LOD_EXIT_PROXY_DISTANCE_MULTIPLIER, enter);
  return Math.min(enter, exit);
}

function entityLodEnabled(): boolean {
  return ENTITY_LOD_ENABLED && ENTITY_LOD_PROXY_ENABLED;
}

export function entityCameraDistanceSq3D(camera: THREE.Camera, entity: Entity): number {
  return simPositionCameraDistanceSq3D(
    camera,
    entity.transform.x,
    entity.transform.y,
    entity.transform.z,
  );
}

export function simPositionCameraDistanceSq3D(
  camera: THREE.Camera,
  simX: number,
  simY: number,
  simZ: number,
): number {
  const position = camera.position;
  const dx = position.x - simX;
  const dy = position.y - simZ;
  const dz = position.z - simY;
  return dx * dx + dy * dy + dz * dz;
}

export function entityLodRadius3D(entity: Entity): number {
  const unit = entity.unit;
  if (unit !== null) {
    return finitePositiveRadius(
      unit.radius.visual,
      unit.radius.hitbox,
      unit.radius.collision,
    );
  }

  const building = entity.building;
  if (building !== null) {
    return finitePositiveRadius(
      building.targetRadius,
      Math.hypot(building.width, building.height) * 0.5,
    );
  }

  const projectile = entity.projectile;
  if (projectile !== null) {
    const radius = projectile.config.shotProfile.runtime.radius;
    return finitePositiveRadius(radius.visual, radius.hitbox, radius.collision);
  }

  return minEntityLodRadius();
}

export function entityLodFullDetailDistance3D(
  radius: number,
  multiplier: number = 1,
  fullDetailDistance: EntityLodCutoffDistance3D = ENTITY_LOD_FULL_DETAIL_DISTANCE,
): number {
  if (fullDetailDistance === null) return Number.POSITIVE_INFINITY;
  return (
    finitePositiveOr(fullDetailDistance, ENTITY_LOD_FULL_DETAIL_DISTANCE) *
    finitePositiveOr(multiplier, 1) *
    finitePositiveRadius(radius) /
    finitePositiveRadius(ENTITY_LOD_REFERENCE_RADIUS)
  );
}

export function entityLodFullDetailDistanceSq3D(
  radius: number,
  multiplier: number = 1,
  fullDetailDistance: EntityLodCutoffDistance3D = ENTITY_LOD_FULL_DETAIL_DISTANCE,
): number {
  const distance = entityLodFullDetailDistance3D(radius, multiplier, fullDetailDistance);
  return distance * distance;
}

export function entityUsesLodProxy3D(
  camera: THREE.Camera,
  entity: Entity,
  fullDetailDistance: EntityLodCutoffDistance3D = ENTITY_LOD_FULL_DETAIL_DISTANCE,
): boolean {
  if (fullDetailDistance === null) return false;
  if (!entityLodEnabled()) return false;
  return entityCameraDistanceSq3D(camera, entity) >
    entityLodFullDetailDistanceSq3D(
      entityLodRadius3D(entity),
      enterProxyDistanceMultiplier(),
      fullDetailDistance,
    );
}

export function simPositionUsesLodProxy3D(
  camera: THREE.Camera,
  simX: number,
  simY: number,
  simZ: number,
  radius: number = ENTITY_LOD_REFERENCE_RADIUS,
  fullDetailDistance: EntityLodCutoffDistance3D = ENTITY_LOD_FULL_DETAIL_DISTANCE,
): boolean {
  if (fullDetailDistance === null) return false;
  if (!entityLodEnabled()) return false;
  return simPositionCameraDistanceSq3D(camera, simX, simY, simZ) >
    entityLodFullDetailDistanceSq3D(
      radius,
      enterProxyDistanceMultiplier(),
      fullDetailDistance,
    );
}

export class EntityLodHysteresis3D {
  private readonly proxyKeys = new Set<string>();
  private readonly lastSeenFrameByKey = new Map<string, number>();
  private frame = 0;

  beginFrame(): void {
    this.frame++;
  }

  endFrame(): void {
    for (const key of this.proxyKeys) {
      const lastSeenFrame = this.lastSeenFrameByKey.get(key) ?? 0;
      if (this.frame - lastSeenFrame <= LOD_HYSTERESIS_STALE_FRAME_LIMIT) continue;
      this.proxyKeys.delete(key);
      this.lastSeenFrameByKey.delete(key);
    }
  }

  clear(): void {
    this.proxyKeys.clear();
    this.lastSeenFrameByKey.clear();
  }

  delete(entityId: EntityId): void {
    const suffix = `:${entityId}`;
    for (const key of this.proxyKeys) {
      if (key.endsWith(suffix)) this.proxyKeys.delete(key);
    }
    for (const key of this.lastSeenFrameByKey.keys()) {
      if (key.endsWith(suffix)) this.lastSeenFrameByKey.delete(key);
    }
  }

  entityUsesLodProxy(
    camera: THREE.Camera,
    entity: Entity,
    channel: string = ENTITY_LOD_BODY_CHANNEL,
    fullDetailDistance: EntityLodCutoffDistance3D = ENTITY_LOD_FULL_DETAIL_DISTANCE,
  ): boolean {
    if (fullDetailDistance === null) {
      this.deleteChannelEntity(channel, entity.id);
      return false;
    }
    if (!entityLodEnabled()) {
      this.delete(entity.id);
      return false;
    }

    const key = this.key(channel, entity.id);
    this.lastSeenFrameByKey.set(key, this.frame);
    const wasProxy = this.proxyKeys.has(key);
    const multiplier = ENTITY_LOD_HYSTERESIS_ENABLED && wasProxy
      ? exitProxyDistanceMultiplier()
      : enterProxyDistanceMultiplier();
    const useProxy =
      entityCameraDistanceSq3D(camera, entity) >
      entityLodFullDetailDistanceSq3D(
        entityLodRadius3D(entity),
        multiplier,
        fullDetailDistance,
      );

    if (useProxy) this.proxyKeys.add(key);
    else this.proxyKeys.delete(key);
    return useProxy;
  }

  entityEmissionUsesLodProxy(
    camera: THREE.Camera,
    entity: Entity,
    emission: EntityLodEmission3D,
    fullDetailDistance: EntityLodCutoffDistance3D,
  ): boolean {
    return this.entityUsesLodProxy(camera, entity, emission, fullDetailDistance);
  }

  private deleteChannelEntity(channel: string, entityId: EntityId): void {
    const key = this.key(channel, entityId);
    this.proxyKeys.delete(key);
    this.lastSeenFrameByKey.delete(key);
  }

  private key(channel: string, entityId: EntityId): string {
    return `${channel}:${entityId}`;
  }
}
