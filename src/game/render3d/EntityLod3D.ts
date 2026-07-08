import type * as THREE from 'three';
import {
  ENTITY_LOD_ENABLED,
  ENTITY_LOD_FULL_DETAIL_DISTANCE,
  ENTITY_LOD_MIN_RADIUS,
  ENTITY_LOD_PROXY_ENABLED,
  ENTITY_LOD_REFERENCE_RADIUS,
  ENTITY_LOD_RUNTIME_DISTANCE_MULTIPLIERS,
} from '@/config';
import { getBrowserRenderRuntimeProfile } from '@/browserRuntime';
import { getLodMode } from '@/clientBarConfig';
import { canIndexClientEntityId } from '../network/ClientEntityIds';
import type { Entity, EntityId } from '../sim/types';
import {
  DETAIL_LEVEL_FULL,
  DETAIL_LEVEL_GLYPH,
  detailLevelForDistance,
  detailLevelForViewPosition,
} from './EntityDetailLevel3D';
import type { RenderViewState3D } from './RenderFrameState3D';

const FALLBACK_MIN_ENTITY_LOD_RADIUS = 1;
const ENTITY_LOD_BODY_CHANNEL = 'body';
const LOD_STATE_STALE_FRAME_LIMIT = 120;
const LOD_STATE_PRUNE_INTERVAL_FRAMES = 30;
const LOD_PROXY_DETAIL_LEVEL = DETAIL_LEVEL_GLYPH;
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
      unit.radius.other,
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
    return finitePositiveRadius(radius.other, radius.hitbox, radius.collision);
  }

  return minEntityLodRadius();
}

/** First finite-positive value (NOT the max — unlike finitePositiveRadius),
 *  floored to the min LOD radius. Lets the proxy honor a specific radius
 *  channel (collision) with hitbox/visual only as fallbacks. */
function firstFinitePositiveRadius(...values: Array<number | null | undefined>): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.max(minEntityLodRadius(), value);
    }
  }
  return minEntityLodRadius();
}

/**
 * Radius the LOD PROXY is drawn at — the entity's COLLISION volume (its
 * collision radius / hitbox), NOT the visual mesh size. The proxy exists to
 * show the collision shape and nothing else, so it uses collision first, with
 * hitbox -> visual only as fallbacks. Buildings already expose their collision
 * footprint via targetRadius. (entityLodRadius3D — which uses the largest/visual
 * radius — still drives the distance-based LOD switch; only the proxy's drawn
 * size differs.)
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

  return minEntityLodRadius();
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

/**
 * Continuous per-entity detail level L in [0,1] for callers without a
 * render-loop cache. 1 = full fidelity, 0 = glyph. Uses the same per-entity
 * switch distance as the proxy, so L hits 0 where the entity turns into its
 * glyph. Prefer the cached {@link EntityLodState3D.entityDetailLevel}
 * inside the render loop.
 */
export function entityDetailLevel3D(camera: THREE.Camera, entity: Entity): number {
  const lodMode = getLodMode();
  if (lodMode === 'high') return DETAIL_LEVEL_FULL;
  if (lodMode === 'low') return DETAIL_LEVEL_GLYPH;
  const radius = entityLodRadius3D(entity);
  const switchDistance = entityLodFullDetailDistance3D(radius);
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
  const radius = entityLodRadius3D(entity);
  return detailLevelForViewPosition(
    view,
    entity.transform.x,
    entity.transform.y,
    entity.transform.z,
    radius,
  );
}

export class EntityLodState3D {
  private readonly proxyIdsByChannel = new Map<string, Set<EntityId>>();
  private readonly lastSeenFrameByChannel = new Map<string, Map<EntityId, number>>();
  private readonly radiusByEntityId = new Map<EntityId, number>();
  private readonly radiusFrameByEntityId = new Map<EntityId, number>();
  private readonly distanceSqByEntityId = new Map<EntityId, number>();
  private readonly distanceSqFrameByEntityId = new Map<EntityId, number>();
  private readonly radiusByIndexedEntityId: Array<number | undefined> = [];
  private readonly radiusFrameByIndexedEntityId: Array<number | undefined> = [];
  private readonly radiusIndexedEntityIds: EntityId[] = [];
  private readonly radiusIndexedEntityIdTracked: Array<boolean | undefined> = [];
  private readonly distanceSqByIndexedEntityId: Array<number | undefined> = [];
  private readonly distanceSqFrameByIndexedEntityId: Array<number | undefined> = [];
  private readonly distanceSqIndexedEntityIds: EntityId[] = [];
  private readonly distanceSqIndexedEntityIdTracked: Array<boolean | undefined> = [];
  private distanceScale = 1;
  private frame = 0;

  setDistanceScale(scale: number): void {
    this.distanceScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  }

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
    for (const [entityId, radiusFrame] of this.radiusFrameByEntityId) {
      if (this.frame - radiusFrame <= LOD_STATE_STALE_FRAME_LIMIT) continue;
      this.radiusFrameByEntityId.delete(entityId);
      this.radiusByEntityId.delete(entityId);
    }
    for (const [entityId, distanceFrame] of this.distanceSqFrameByEntityId) {
      if (this.frame - distanceFrame <= LOD_STATE_STALE_FRAME_LIMIT) continue;
      this.distanceSqFrameByEntityId.delete(entityId);
      this.distanceSqByEntityId.delete(entityId);
    }
    this.pruneIndexedEntityCache(
      this.radiusIndexedEntityIds,
      this.radiusIndexedEntityIdTracked,
      this.radiusByIndexedEntityId,
      this.radiusFrameByIndexedEntityId,
    );
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
    this.radiusByEntityId.clear();
    this.radiusFrameByEntityId.clear();
    this.distanceSqByEntityId.clear();
    this.distanceSqFrameByEntityId.clear();
    this.radiusByIndexedEntityId.length = 0;
    this.radiusFrameByIndexedEntityId.length = 0;
    this.radiusIndexedEntityIds.length = 0;
    this.radiusIndexedEntityIdTracked.length = 0;
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
    this.radiusByEntityId.delete(entityId);
    this.radiusFrameByEntityId.delete(entityId);
    this.distanceSqByEntityId.delete(entityId);
    this.distanceSqFrameByEntityId.delete(entityId);
    if (canIndexClientEntityId(entityId)) {
      this.radiusByIndexedEntityId[entityId] = undefined;
      this.radiusFrameByIndexedEntityId[entityId] = undefined;
      this.distanceSqByIndexedEntityId[entityId] = undefined;
      this.distanceSqFrameByIndexedEntityId[entityId] = undefined;
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
      this.entityCameraDistanceSq(camera, entity) >
      entityLodFullDetailDistanceSq3D(
        this.entityLodRadius(entity),
        this.distanceScale,
        fullDetailDistance,
      );

    if (useProxy) proxyIds.add(entity.id);
    else proxyIds.delete(entity.id);
    return useProxy;
  }

  /**
   * AUTO-mode proxy selection for the active 3D render loop. Uses projected
   * screen size so the LOD switch matches the 0..1 visual thresholds instead of
   * a camera-angle-dependent distance-only cutoff.
   */
  entityUsesLodProxyForView(
    view: RenderViewState3D,
    entity: Entity,
    channel: string = ENTITY_LOD_BODY_CHANNEL,
    fullDetailDistance: EntityLodCutoffDistance3D = ENTITY_LOD_FULL_DETAIL_DISTANCE,
  ): boolean {
    if (fullDetailDistance === null) {
      this.deleteChannelEntity(channel, entity.id);
      return false;
    }
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
    const detailLevel = detailLevelForViewPosition(
      view,
      entity.transform.x,
      entity.transform.y,
      entity.transform.z,
      this.entityLodRadius(entity) * this.distanceScale,
    );
    const useProxy = detailLevel <= LOD_PROXY_DETAIL_LEVEL;

    if (useProxy) proxyIds.add(entity.id);
    else proxyIds.delete(entity.id);
    return useProxy;
  }

  /**
   * Continuous detail level L in [0,1] for this entity, reusing the per-frame
   * cached camera distance + radius. 1 = full fidelity, 0 = glyph. Composed
   * parts should read their HOST entity's level via this, never their own.
   */
  entityDetailLevel(camera: THREE.Camera, entity: Entity): number {
    const lodMode = getLodMode();
    if (lodMode === 'high') return DETAIL_LEVEL_FULL;
    if (lodMode === 'low') return DETAIL_LEVEL_GLYPH;
    const radius = this.entityLodRadius(entity);
    const switchDistance = entityLodFullDetailDistance3D(
      radius,
      this.distanceScale,
    );
    const distance = Math.sqrt(this.entityCameraDistanceSq(camera, entity));
    return detailLevelForDistance(distance, switchDistance);
  }

  entityEmissionUsesLowLodDistance(
    camera: THREE.Camera,
    entity: Entity,
    highToLowDistance: EmissionLodHighToLowDistance3D,
  ): boolean {
    if (highToLowDistance === null) return false;
    if (!Number.isFinite(highToLowDistance) || highToLowDistance < 0) return false;
    return this.entityCameraDistanceSq(camera, entity) >
      highToLowDistance * highToLowDistance;
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
    if (canIndexClientEntityId(entity.id)) {
      const frame = this.radiusFrameByIndexedEntityId[entity.id];
      if (frame === this.frame) {
        const cachedRadius = this.radiusByIndexedEntityId[entity.id];
        if (cachedRadius !== undefined) return cachedRadius;
      }
      const radius = entityLodRadius3D(entity);
      this.trackIndexedEntityCache(
        entity.id,
        this.radiusIndexedEntityIds,
        this.radiusIndexedEntityIdTracked,
      );
      this.radiusByIndexedEntityId[entity.id] = radius;
      this.radiusFrameByIndexedEntityId[entity.id] = this.frame;
      return radius;
    }
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
