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
  ENTITY_LOD_RUNTIME_DISTANCE_MULTIPLIERS,
} from '@/config';
import { getBrowserRenderRuntimeProfile } from '@/browserRuntime';
import type { Entity, EntityId } from '../sim/types';

const FALLBACK_MIN_ENTITY_LOD_RADIUS = 1;
const ENTITY_LOD_BODY_CHANNEL = 'body';
const LOD_HYSTERESIS_STALE_FRAME_LIMIT = 120;
const LOD_HYSTERESIS_PRUNE_INTERVAL_FRAMES = 30;
const RUNTIME_LOD_DISTANCE_MULTIPLIER = (() => {
  const profile = getBrowserRenderRuntimeProfile();
  const configuredValue =
    profile.label === 'tauri-desktop'
      ? ENTITY_LOD_RUNTIME_DISTANCE_MULTIPLIERS.tauriDesktop
      : profile.label === 'browser-mobile'
        ? ENTITY_LOD_RUNTIME_DISTANCE_MULTIPLIERS.browserMobile
        : ENTITY_LOD_RUNTIME_DISTANCE_MULTIPLIERS.browserDesktop;
  const value = configuredValue ?? profile.lodDistanceMultiplier;
  return Number.isFinite(value) && value > 0 ? value : 1;
})();

export type EntityLodEmission3D =
  | 'bodyHud'
  | 'bodyNames'
  | 'turretNames'
  | 'shotNames'
  | 'contactShadows'
  | 'groundPrints'
  | 'lineProjectiles'
  | 'beamSegments'
  | 'beamEndpoints'
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

type EntityLodCutoffDistance3D = number | null;
type EmissionLodHighToLowDistance3D = number | null;

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

function entityCameraDistanceSq3D(camera: THREE.Camera, entity: Entity): number {
  return simPositionCameraDistanceSq3D(
    camera,
    entity.transform.x,
    entity.transform.y,
    entity.transform.z,
  );
}

function simPositionCameraDistanceSq3D(
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

function entityLodFullDetailDistance3D(
  radius: number,
  multiplier: number = 1,
  fullDetailDistance: EntityLodCutoffDistance3D = ENTITY_LOD_FULL_DETAIL_DISTANCE,
): number {
  if (fullDetailDistance === null) return Number.POSITIVE_INFINITY;
  return (
    finitePositiveOr(fullDetailDistance, ENTITY_LOD_FULL_DETAIL_DISTANCE) *
    RUNTIME_LOD_DISTANCE_MULTIPLIER *
    finitePositiveOr(multiplier, 1) *
    finitePositiveRadius(radius) /
    finitePositiveRadius(ENTITY_LOD_REFERENCE_RADIUS)
  );
}

function entityLodFullDetailDistanceSq3D(
  radius: number,
  multiplier: number = 1,
  fullDetailDistance: EntityLodCutoffDistance3D = ENTITY_LOD_FULL_DETAIL_DISTANCE,
): number {
  const distance = entityLodFullDetailDistance3D(radius, multiplier, fullDetailDistance);
  return distance * distance;
}

export function entityEmissionUsesLowLodDistance3D(
  camera: THREE.Camera,
  entity: Entity,
  highToLowDistance: EmissionLodHighToLowDistance3D,
): boolean {
  return simPositionUsesLowEmissionLod3D(
    camera,
    entity.transform.x,
    entity.transform.y,
    entity.transform.z,
    highToLowDistance,
  );
}

export function simPositionUsesLowEmissionLod3D(
  camera: THREE.Camera,
  simX: number,
  simY: number,
  simZ: number,
  highToLowDistance: EmissionLodHighToLowDistance3D,
): boolean {
  if (highToLowDistance === null) return false;
  if (!Number.isFinite(highToLowDistance) || highToLowDistance < 0) return false;
  return simPositionCameraDistanceSq3D(camera, simX, simY, simZ) >
    highToLowDistance * highToLowDistance;
}

export class EntityLodHysteresis3D {
  private readonly proxyIdsByChannel = new Map<string, Set<EntityId>>();
  private readonly lastSeenFrameByChannel = new Map<string, Map<EntityId, number>>();
  private readonly radiusByEntityId = new Map<EntityId, number>();
  private readonly radiusFrameByEntityId = new Map<EntityId, number>();
  private readonly distanceSqByEntityId = new Map<EntityId, number>();
  private readonly distanceSqFrameByEntityId = new Map<EntityId, number>();
  private frame = 0;

  beginFrame(): void {
    this.frame++;
  }

  endFrame(): void {
    if (this.frame % LOD_HYSTERESIS_PRUNE_INTERVAL_FRAMES !== 0) return;
    for (const [channel, proxyIds] of this.proxyIdsByChannel) {
      const lastSeenByEntityId = this.lastSeenFrameByChannel.get(channel);
      for (const entityId of proxyIds) {
        const lastSeenFrame = lastSeenByEntityId?.get(entityId) ?? 0;
        if (this.frame - lastSeenFrame <= LOD_HYSTERESIS_STALE_FRAME_LIMIT) continue;
        proxyIds.delete(entityId);
        lastSeenByEntityId?.delete(entityId);
      }
    }
    for (const [entityId, radiusFrame] of this.radiusFrameByEntityId) {
      if (this.frame - radiusFrame <= LOD_HYSTERESIS_STALE_FRAME_LIMIT) continue;
      this.radiusFrameByEntityId.delete(entityId);
      this.radiusByEntityId.delete(entityId);
    }
    for (const [entityId, distanceFrame] of this.distanceSqFrameByEntityId) {
      if (this.frame - distanceFrame <= LOD_HYSTERESIS_STALE_FRAME_LIMIT) continue;
      this.distanceSqFrameByEntityId.delete(entityId);
      this.distanceSqByEntityId.delete(entityId);
    }
  }

  clear(): void {
    this.proxyIdsByChannel.clear();
    this.lastSeenFrameByChannel.clear();
    this.radiusByEntityId.clear();
    this.radiusFrameByEntityId.clear();
    this.distanceSqByEntityId.clear();
    this.distanceSqFrameByEntityId.clear();
  }

  delete(entityId: EntityId): void {
    for (const proxyIds of this.proxyIdsByChannel.values()) {
      proxyIds.delete(entityId);
    }
    for (const lastSeenByEntityId of this.lastSeenFrameByChannel.values()) {
      lastSeenByEntityId.delete(entityId);
    }
    this.radiusByEntityId.delete(entityId);
    this.radiusFrameByEntityId.delete(entityId);
    this.distanceSqByEntityId.delete(entityId);
    this.distanceSqFrameByEntityId.delete(entityId);
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

    const proxyIds = this.proxyIdsForChannel(channel);
    this.lastSeenForChannel(channel).set(entity.id, this.frame);
    const wasProxy = proxyIds.has(entity.id);
    const multiplier = ENTITY_LOD_HYSTERESIS_ENABLED && wasProxy
      ? exitProxyDistanceMultiplier()
      : enterProxyDistanceMultiplier();
    const useProxy =
      this.entityCameraDistanceSq(camera, entity) >
      entityLodFullDetailDistanceSq3D(
        this.entityLodRadius(entity),
        multiplier,
        fullDetailDistance,
      );

    if (useProxy) proxyIds.add(entity.id);
    else proxyIds.delete(entity.id);
    return useProxy;
  }

  private deleteChannelEntity(channel: string, entityId: EntityId): void {
    this.proxyIdsByChannel.get(channel)?.delete(entityId);
    this.lastSeenFrameByChannel.get(channel)?.delete(entityId);
  }

  private proxyIdsForChannel(channel: string): Set<EntityId> {
    let proxyIds = this.proxyIdsByChannel.get(channel);
    if (proxyIds === undefined) {
      proxyIds = new Set<EntityId>();
      this.proxyIdsByChannel.set(channel, proxyIds);
    }
    return proxyIds;
  }

  private lastSeenForChannel(channel: string): Map<EntityId, number> {
    let lastSeenByEntityId = this.lastSeenFrameByChannel.get(channel);
    if (lastSeenByEntityId === undefined) {
      lastSeenByEntityId = new Map<EntityId, number>();
      this.lastSeenFrameByChannel.set(channel, lastSeenByEntityId);
    }
    return lastSeenByEntityId;
  }

  private entityLodRadius(entity: Entity): number {
    const frame = this.radiusFrameByEntityId.get(entity.id);
    if (frame === this.frame) {
      const cachedRadius = this.radiusByEntityId.get(entity.id);
      if (cachedRadius !== undefined) return cachedRadius;
    }
    const radius = entityLodRadius3D(entity);
    this.radiusByEntityId.set(entity.id, radius);
    this.radiusFrameByEntityId.set(entity.id, this.frame);
    return radius;
  }

  private entityCameraDistanceSq(camera: THREE.Camera, entity: Entity): number {
    const frame = this.distanceSqFrameByEntityId.get(entity.id);
    if (frame === this.frame) {
      const cachedDistanceSq = this.distanceSqByEntityId.get(entity.id);
      if (cachedDistanceSq !== undefined) return cachedDistanceSq;
    }
    const distanceSq = entityCameraDistanceSq3D(camera, entity);
    this.distanceSqByEntityId.set(entity.id, distanceSq);
    this.distanceSqFrameByEntityId.set(entity.id, this.frame);
    return distanceSq;
  }
}
