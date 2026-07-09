import type * as THREE from 'three';
import {
  ENTITY_LOD_AUTO_HIGH_TO_LOW_DISTANCE,
  ENTITY_LOD_ENABLED,
} from '@/config';
import { getLodMode } from '@/clientBarConfig';
import { canIndexClientEntityId } from '../network/ClientEntityIds';
import type { Entity, EntityId } from '../sim/types';
import {
  DETAIL_LEVEL_FULL,
  DETAIL_LEVEL_GLYPH,
  detailLevelForDistance,
} from './EntityDetailLevel3D';
import type { RenderViewState3D } from './RenderFrameState3D';

const DEFAULT_ENTITY_LOD_AUTO_HIGH_TO_LOW_DISTANCE = 3600;
const MIN_ENTITY_LOD_RADIUS = 1;
const ENTITY_LOD_BODY_CHANNEL = 'body';
const LOD_STATE_STALE_FRAME_LIMIT = 120;
const LOD_STATE_PRUNE_INTERVAL_FRAMES = 30;

export const ENTITY_LOD_PROXY_GLYPH_CIRCLE = 0;
export const ENTITY_LOD_PROXY_GLYPH_DIAMOND = 1;
export const ENTITY_LOD_PROXY_GLYPH_TRIANGLE = 2;
export const ENTITY_LOD_PROXY_GLYPH_SQUARE = 3;
export const ENTITY_LOD_PROXY_GLYPH_CROSS = 4;

export type EntityLodProxyGlyph3D =
  | typeof ENTITY_LOD_PROXY_GLYPH_CIRCLE
  | typeof ENTITY_LOD_PROXY_GLYPH_DIAMOND
  | typeof ENTITY_LOD_PROXY_GLYPH_TRIANGLE
  | typeof ENTITY_LOD_PROXY_GLYPH_SQUARE
  | typeof ENTITY_LOD_PROXY_GLYPH_CROSS;

function finitePositiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function entityLodEnabled(): boolean {
  return ENTITY_LOD_ENABLED;
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

function simPositionViewDistanceSq3D(
  view: RenderViewState3D,
  simX: number,
  simY: number,
  simZ: number,
): number {
  const dx = view.cameraX - simX;
  const dy = view.cameraY - simZ;
  const dz = view.cameraZ - simY;
  return dx * dx + dy * dy + dz * dz;
}

/** First finite-positive value, floored to the min LOD radius. Lets the proxy
 *  honor a specific radius channel (collision) with hitbox/visual only as
 *  fallbacks. */
function firstFinitePositiveRadius(...values: Array<number | null | undefined>): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.max(MIN_ENTITY_LOD_RADIUS, value);
    }
  }
  return MIN_ENTITY_LOD_RADIUS;
}

/**
 * Radius the LOD PROXY is drawn at — the entity's COLLISION volume (its
 * collision radius / hitbox), NOT the visual mesh size. The proxy exists to
 * show the collision shape and nothing else, so it uses collision first, with
 * hitbox -> visual only as fallbacks. Buildings already expose their collision
 * footprint via targetRadius.
 */
export function entityLodProxyRadius3D(entity: Entity): number {
  const unit = entity.unit;
  if (unit !== null) {
    return firstFinitePositiveRadius(
      unit.radius.collision,
      unit.radius.hitbox,
      unit.radius.other,
    );
  }

  const building = entity.building;
  if (building !== null) {
    return firstFinitePositiveRadius(
      building.targetRadius,
      Math.hypot(building.width, building.height) * 0.5,
    );
  }

  const projectile = entity.projectile;
  if (projectile !== null) {
    const radius = projectile.config.shotProfile.runtime.radius;
    return firstFinitePositiveRadius(radius.collision, radius.hitbox, radius.other);
  }

  return MIN_ENTITY_LOD_RADIUS;
}

export function entityLodProxyGlyph3D(entity: Entity): EntityLodProxyGlyph3D {
  if (entity.commander !== null) return ENTITY_LOD_PROXY_GLYPH_CROSS;

  const unit = entity.unit;
  if (unit !== null) {
    if (entity.builder !== null) return ENTITY_LOD_PROXY_GLYPH_DIAMOND;
    if (entity.transport !== null || entity.factory !== null) {
      return ENTITY_LOD_PROXY_GLYPH_SQUARE;
    }
    if (unit.locomotion.type === 'flying') return ENTITY_LOD_PROXY_GLYPH_TRIANGLE;
    return ENTITY_LOD_PROXY_GLYPH_CIRCLE;
  }

  if (entity.building !== null) return ENTITY_LOD_PROXY_GLYPH_SQUARE;
  return ENTITY_LOD_PROXY_GLYPH_CIRCLE;
}

function entityLodHighToLowDistance3D(): number {
  return finitePositiveOr(
    ENTITY_LOD_AUTO_HIGH_TO_LOW_DISTANCE,
    DEFAULT_ENTITY_LOD_AUTO_HIGH_TO_LOW_DISTANCE,
  );
}

function entityLodHighToLowDistanceSq3D(): number {
  const distance = entityLodHighToLowDistance3D();
  return distance * distance;
}

export function entityUsesLowLodDistance3D(
  camera: THREE.Camera,
  entity: Entity,
): boolean {
  return simPositionUsesLowLodDistance3D(
    camera,
    entity.transform.x,
    entity.transform.y,
    entity.transform.z,
  );
}

export function simPositionUsesLowLodDistance3D(
  camera: THREE.Camera,
  simX: number,
  simY: number,
  simZ: number,
): boolean {
  return simPositionCameraDistanceSq3D(camera, simX, simY, simZ) >=
    entityLodHighToLowDistanceSq3D();
}

/**
 * Binary per-entity detail level for callers without a render-loop cache.
 * 1 = HIGH/full fidelity, 0 = LOW/proxy glyph.
 */
export function entityDetailLevel3D(camera: THREE.Camera, entity: Entity): number {
  const lodMode = getLodMode();
  if (lodMode === 'high') return DETAIL_LEVEL_FULL;
  if (lodMode === 'low') return DETAIL_LEVEL_GLYPH;
  const switchDistance = entityLodHighToLowDistance3D();
  const distance = Math.sqrt(entityCameraDistanceSq3D(camera, entity));
  return detailLevelForDistance(distance, switchDistance);
}

/**
 * Detail level from a per-frame {@link RenderViewState3D} (camera coords in
 * three space) rather than a THREE.Camera. Lets the render loop compute a
 * host's level with only the frame view it already holds. Same result as
 * {@link entityDetailLevel3D}.
 */
export function entityDetailLevelForView(view: RenderViewState3D, entity: Entity): number {
  const lodMode = getLodMode();
  if (lodMode === 'high') return DETAIL_LEVEL_FULL;
  if (lodMode === 'low') return DETAIL_LEVEL_GLYPH;
  const distance = Math.sqrt(simPositionViewDistanceSq3D(
    view,
    entity.transform.x,
    entity.transform.y,
    entity.transform.z,
  ));
  return detailLevelForDistance(distance, entityLodHighToLowDistance3D());
}

export class EntityLodState3D {
  private readonly proxyIdsByChannel = new Map<string, Set<EntityId>>();
  private readonly lastSeenFrameByChannel = new Map<string, Map<EntityId, number>>();
  private readonly distanceSqByEntityId = new Map<EntityId, number>();
  private readonly distanceSqFrameByEntityId = new Map<EntityId, number>();
  private readonly distanceSqByIndexedEntityId: Array<number | undefined> = [];
  private readonly distanceSqFrameByIndexedEntityId: Array<number | undefined> = [];
  private readonly distanceSqIndexedEntityIds: EntityId[] = [];
  private readonly distanceSqIndexedEntityIdTracked: Array<boolean | undefined> = [];
  private frame = 0;

  beginFrame(): void {
    this.frame++;
  }

  endFrame(): void {
    if (this.frame % LOD_STATE_PRUNE_INTERVAL_FRAMES !== 0) return;
    for (const [channel, proxyIds] of this.proxyIdsByChannel) {
      const lastSeenByEntityId = this.lastSeenFrameByChannel.get(channel);
      for (const entityId of proxyIds) {
        const lastSeenFrame = lastSeenByEntityId?.get(entityId) ?? 0;
        if (this.frame - lastSeenFrame <= LOD_STATE_STALE_FRAME_LIMIT) continue;
        proxyIds.delete(entityId);
        lastSeenByEntityId?.delete(entityId);
      }
    }
    for (const [entityId, distanceFrame] of this.distanceSqFrameByEntityId) {
      if (this.frame - distanceFrame <= LOD_STATE_STALE_FRAME_LIMIT) continue;
      this.distanceSqFrameByEntityId.delete(entityId);
      this.distanceSqByEntityId.delete(entityId);
    }
    this.pruneIndexedEntityCache(
      this.distanceSqIndexedEntityIds,
      this.distanceSqIndexedEntityIdTracked,
      this.distanceSqByIndexedEntityId,
      this.distanceSqFrameByIndexedEntityId,
    );
  }

  clear(): void {
    this.proxyIdsByChannel.clear();
    this.lastSeenFrameByChannel.clear();
    this.distanceSqByEntityId.clear();
    this.distanceSqFrameByEntityId.clear();
    this.distanceSqByIndexedEntityId.length = 0;
    this.distanceSqFrameByIndexedEntityId.length = 0;
    this.distanceSqIndexedEntityIds.length = 0;
    this.distanceSqIndexedEntityIdTracked.length = 0;
  }

  delete(entityId: EntityId): void {
    for (const proxyIds of this.proxyIdsByChannel.values()) {
      proxyIds.delete(entityId);
    }
    for (const lastSeenByEntityId of this.lastSeenFrameByChannel.values()) {
      lastSeenByEntityId.delete(entityId);
    }
    this.distanceSqByEntityId.delete(entityId);
    this.distanceSqFrameByEntityId.delete(entityId);
    if (canIndexClientEntityId(entityId)) {
      this.distanceSqByIndexedEntityId[entityId] = undefined;
      this.distanceSqFrameByIndexedEntityId[entityId] = undefined;
    }
  }

  entityUsesLodProxy(
    camera: THREE.Camera,
    entity: Entity,
    channel: string = ENTITY_LOD_BODY_CHANNEL,
  ): boolean {
    const lodMode = getLodMode();
    if (lodMode === 'high') {
      this.deleteChannelEntity(channel, entity.id);
      return false;
    }
    if (lodMode === 'low') {
      this.proxyIdsForChannel(channel).add(entity.id);
      this.lastSeenForChannel(channel).set(entity.id, this.frame);
      return true;
    }
    if (!entityLodEnabled()) {
      this.delete(entity.id);
      return false;
    }

    const proxyIds = this.proxyIdsForChannel(channel);
    this.lastSeenForChannel(channel).set(entity.id, this.frame);
    const useProxy =
      this.entityCameraDistanceSq(camera, entity) >= entityLodHighToLowDistanceSq3D();

    if (useProxy) proxyIds.add(entity.id);
    else proxyIds.delete(entity.id);
    return useProxy;
  }

  /**
   * AUTO-mode proxy selection for the active 3D render loop. This is the
   * single HIGH/LOW decision: nearer than the configured distance is HIGH,
   * at/after that distance is LOW.
   */
  entityUsesLodProxyForView(
    view: RenderViewState3D,
    entity: Entity,
    channel: string = ENTITY_LOD_BODY_CHANNEL,
  ): boolean {
    const lodMode = getLodMode();
    if (lodMode === 'high') {
      this.deleteChannelEntity(channel, entity.id);
      return false;
    }
    if (lodMode === 'low') {
      this.proxyIdsForChannel(channel).add(entity.id);
      this.lastSeenForChannel(channel).set(entity.id, this.frame);
      return true;
    }
    if (!entityLodEnabled()) {
      this.delete(entity.id);
      return false;
    }

    const proxyIds = this.proxyIdsForChannel(channel);
    this.lastSeenForChannel(channel).set(entity.id, this.frame);
    const useProxy =
      simPositionViewDistanceSq3D(
        view,
        entity.transform.x,
        entity.transform.y,
        entity.transform.z,
      ) >= entityLodHighToLowDistanceSq3D();

    if (useProxy) proxyIds.add(entity.id);
    else proxyIds.delete(entity.id);
    return useProxy;
  }

  /**
   * Binary detail level for this entity, reusing the per-frame cached camera
   * distance. 1 = HIGH/full fidelity, 0 = LOW/glyph.
   */
  entityDetailLevel(camera: THREE.Camera, entity: Entity): number {
    const lodMode = getLodMode();
    if (lodMode === 'high') return DETAIL_LEVEL_FULL;
    if (lodMode === 'low') return DETAIL_LEVEL_GLYPH;
    const distance = Math.sqrt(this.entityCameraDistanceSq(camera, entity));
    return detailLevelForDistance(distance, entityLodHighToLowDistance3D());
  }

  entityUsesLowLodDistance(
    camera: THREE.Camera,
    entity: Entity,
  ): boolean {
    return this.entityCameraDistanceSq(camera, entity) >= entityLodHighToLowDistanceSq3D();
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

  private entityCameraDistanceSq(camera: THREE.Camera, entity: Entity): number {
    if (canIndexClientEntityId(entity.id)) {
      const frame = this.distanceSqFrameByIndexedEntityId[entity.id];
      if (frame === this.frame) {
        const cachedDistanceSq = this.distanceSqByIndexedEntityId[entity.id];
        if (cachedDistanceSq !== undefined) return cachedDistanceSq;
      }
      const distanceSq = entityCameraDistanceSq3D(camera, entity);
      this.trackIndexedEntityCache(
        entity.id,
        this.distanceSqIndexedEntityIds,
        this.distanceSqIndexedEntityIdTracked,
      );
      this.distanceSqByIndexedEntityId[entity.id] = distanceSq;
      this.distanceSqFrameByIndexedEntityId[entity.id] = this.frame;
      return distanceSq;
    }
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

  private trackIndexedEntityCache(
    entityId: EntityId,
    entityIds: EntityId[],
    trackedByEntityId: Array<boolean | undefined>,
  ): void {
    if (trackedByEntityId[entityId] === true) return;
    trackedByEntityId[entityId] = true;
    entityIds.push(entityId);
  }

  private pruneIndexedEntityCache(
    entityIds: EntityId[],
    trackedByEntityId: Array<boolean | undefined>,
    valueByEntityId: Array<number | undefined>,
    frameByEntityId: Array<number | undefined>,
  ): void {
    let writeIndex = 0;
    for (let i = 0; i < entityIds.length; i++) {
      const entityId = entityIds[i];
      const frame = frameByEntityId[entityId];
      if (
        frame === undefined ||
        this.frame - frame > LOD_STATE_STALE_FRAME_LIMIT
      ) {
        trackedByEntityId[entityId] = undefined;
        valueByEntityId[entityId] = undefined;
        frameByEntityId[entityId] = undefined;
        continue;
      }
      entityIds[writeIndex] = entityId;
      writeIndex++;
    }
    entityIds.length = writeIndex;
  }
}
