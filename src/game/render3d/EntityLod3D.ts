import type * as THREE from 'three';
import {
  ENTITY_LOD_AUTO_HIGH_TO_LOW_DISTANCE,
  ENTITY_LOD_ENABLED,
} from '@/config';
import { getLodMode } from '@/clientBarConfig';
import { isRayType } from '@/types/shotTypes';
import { canIndexClientEntityId } from '../network/ClientEntityIds';
import type { Entity, EntityId } from '../sim/types';
import {
  DETAIL_LEVEL_FULL,
  DETAIL_LEVEL_GLYPH,
  DETAIL_RADIUS_FLOOR_BEAM,
  DETAIL_RADIUS_FLOOR_PROJECTILE,
  DETAIL_RUNG_CLOSE,
  DETAIL_RUNG_FAR,
  DETAIL_RUNG_GLYPH,
  DETAIL_RUNG_MID,
  type DetailRung,
  detailLevelForRadiusDistance,
  detailLevelForRung,
  detailRungForLevel,
  detailRungWithHysteresis,
  detailScreenRadiusPx,
  lodProxyFadeAlphaForScreenRadius,
  plasmaDetailRadiusForTailLength,
} from './EntityDetailLevel3D';
import type { RenderViewState3D } from './RenderFrameState3D';

const DEFAULT_ENTITY_LOD_AUTO_HIGH_TO_LOW_DISTANCE = 3600;
const MIN_ENTITY_LOD_RADIUS = 1;
const ENTITY_LOD_BODY_CHANNEL = 'body';
const LOD_STATE_STALE_FRAME_LIMIT = 120;
const LOD_STATE_PRUNE_INTERVAL_FRAMES = 30;
const DEFAULT_FOV_Y_RAD = Math.PI / 4;

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

function isAuthoredGeometryHost(entity: Entity): boolean {
  return entity.unit != null || entity.building != null;
}

function cameraFovYRad(camera: THREE.Camera): number {
  const fovDegrees = (camera as THREE.PerspectiveCamera).fov;
  return typeof fovDegrees === 'number' && Number.isFinite(fovDegrees)
    ? (fovDegrees * Math.PI) / 180
    : DEFAULT_FOV_Y_RAD;
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

/**
 * Radius the DETAIL ladder measures — how big the entity LOOKS: the visual
 * radius for units, the footprint half-diagonal for buildings. Projectiles
 * and beams use authored floors because their visual salience (trails,
 * beam length) far exceeds their tiny body radius.
 */
export function entityDetailRadius3D(entity: Entity): number {
  const unit = entity.unit;
  if (unit !== null) {
    return firstFinitePositiveRadius(
      unit.radius.other,
      unit.radius.hitbox,
      unit.radius.collision,
    );
  }

  const building = entity.building;
  if (building !== null) {
    return firstFinitePositiveRadius(
      Math.hypot(building.width, building.height) * 0.5,
      building.targetRadius,
    );
  }

  const projectile = entity.projectile;
  if (projectile !== null) {
    const floor = isRayType(projectile.config.shot.type)
      ? DETAIL_RADIUS_FLOOR_BEAM
      : DETAIL_RADIUS_FLOOR_PROJECTILE;
    const radius = projectile.config.shotProfile.runtime.radius;
    return Math.max(
      floor,
      firstFinitePositiveRadius(radius.other, radius.hitbox, radius.collision),
    );
  }

  return DETAIL_RADIUS_FLOOR_PROJECTILE;
}

export function entityLodProxyGlyph3D(entity: Entity): EntityLodProxyGlyph3D {
  if (entity.commander !== null) return ENTITY_LOD_PROXY_GLYPH_CROSS;

  const unit = entity.unit;
  if (unit !== null) {
    if (entity.builder !== null) return ENTITY_LOD_PROXY_GLYPH_DIAMOND;
    if (entity.transport !== null || entity.factory !== null) {
      return ENTITY_LOD_PROXY_GLYPH_SQUARE;
    }
    if (unit.locomotion.type === 'flying' || unit.locomotion.type === 'dive') {
      return ENTITY_LOD_PROXY_GLYPH_TRIANGLE;
    }
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
 * Continuous per-entity detail level for callers without a render-loop
 * cache. 1 = full fidelity, 0 = proxy glyph, screen-coverage in between.
 * No hysteresis — use {@link EntityLodState3D.entityDetailRungForView}
 * for anything that triggers rebuilds.
 */
export function entityDetailLevel3D(camera: THREE.Camera, entity: Entity): number {
  const lodMode = getLodMode();
  if (lodMode === 'high') return DETAIL_LEVEL_FULL;
  if (lodMode === 'medium') return detailLevelForRung(DETAIL_RUNG_MID);
  if (lodMode === 'low') {
    return isAuthoredGeometryHost(entity)
      ? detailLevelForRung(DETAIL_RUNG_FAR)
      : DETAIL_LEVEL_GLYPH;
  }
  return detailLevelForRadiusDistance(
    entityDetailRadius3D(entity),
    Math.sqrt(entityCameraDistanceSq3D(camera, entity)),
    cameraFovYRad(camera),
  );
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
  if (lodMode === 'medium') return detailLevelForRung(DETAIL_RUNG_MID);
  if (lodMode === 'low') {
    return isAuthoredGeometryHost(entity)
      ? detailLevelForRung(DETAIL_RUNG_FAR)
      : DETAIL_LEVEL_GLYPH;
  }
  return detailLevelForRadiusDistance(
    entityDetailRadius3D(entity),
    Math.sqrt(simPositionViewDistanceSq3D(
      view,
      entity.transform.x,
      entity.transform.y,
      entity.transform.z,
    )),
    view.fovYRad,
  );
}

/** Plasma-specific projected-detail level. In AUTO, its visual tail length
 * scales the transition distance by the constant-angular-size law; manual
 * HIGH/MED/LOW modes pin the matching authored geometry rung. */
export function plasmaEntityDetailLevelForView(
  view: RenderViewState3D,
  entity: Entity,
  tailLengthWorld: number,
): number {
  const lodMode = getLodMode();
  if (lodMode === 'high') return DETAIL_LEVEL_FULL;
  if (lodMode === 'medium') return detailLevelForRung(DETAIL_RUNG_MID);
  if (lodMode === 'low') return DETAIL_LEVEL_GLYPH;
  return detailLevelForRadiusDistance(
    plasmaDetailRadiusForTailLength(tailLengthWorld),
    Math.sqrt(simPositionViewDistanceSq3D(
      view,
      entity.transform.x,
      entity.transform.y,
      entity.transform.z,
    )),
    view.fovYRad,
  );
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
  // Latched detail rung per entity (hysteresis state). Indexed fast path
  // mirrors the distance cache; the frame stamp doubles as staleness for
  // pruning. A stale/absent entry latches fresh from the raw level.
  private readonly rungByEntityId = new Map<EntityId, DetailRung>();
  private readonly rungFrameByEntityId = new Map<EntityId, number>();
  private readonly rungByIndexedEntityId: Array<DetailRung | undefined> = [];
  private readonly rungFrameByIndexedEntityId: Array<number | undefined> = [];
  private readonly rungIndexedEntityIds: EntityId[] = [];
  private readonly rungIndexedEntityIdTracked: Array<boolean | undefined> = [];
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
    for (const [entityId, rungFrame] of this.rungFrameByEntityId) {
      if (this.frame - rungFrame <= LOD_STATE_STALE_FRAME_LIMIT) continue;
      this.rungFrameByEntityId.delete(entityId);
      this.rungByEntityId.delete(entityId);
    }
    this.pruneIndexedEntityCache(
      this.distanceSqIndexedEntityIds,
      this.distanceSqIndexedEntityIdTracked,
      this.distanceSqByIndexedEntityId,
      this.distanceSqFrameByIndexedEntityId,
    );
    this.pruneIndexedEntityCache(
      this.rungIndexedEntityIds,
      this.rungIndexedEntityIdTracked,
      this.rungByIndexedEntityId,
      this.rungFrameByIndexedEntityId,
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
    this.rungByEntityId.clear();
    this.rungFrameByEntityId.clear();
    this.rungByIndexedEntityId.length = 0;
    this.rungFrameByIndexedEntityId.length = 0;
    this.rungIndexedEntityIds.length = 0;
    this.rungIndexedEntityIdTracked.length = 0;
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
    this.rungByEntityId.delete(entityId);
    this.rungFrameByEntityId.delete(entityId);
    if (canIndexClientEntityId(entityId)) {
      this.distanceSqByIndexedEntityId[entityId] = undefined;
      this.distanceSqFrameByIndexedEntityId[entityId] = undefined;
      this.rungByIndexedEntityId[entityId] = undefined;
      this.rungFrameByIndexedEntityId[entityId] = undefined;
    }
  }

  /**
   * Continuous detail level (no hysteresis) using the per-frame cached
   * camera distance. Feed style ladders and effect scales with this;
   * feed rebuild bands with {@link entityDetailRungForView}.
   */
  entityDetailLevelForView(view: RenderViewState3D, entity: Entity): number {
    const lodMode = getLodMode();
    if (lodMode === 'high') return DETAIL_LEVEL_FULL;
    if (lodMode === 'medium') return detailLevelForRung(DETAIL_RUNG_MID);
    if (lodMode === 'low') {
      return isAuthoredGeometryHost(entity)
        ? detailLevelForRung(DETAIL_RUNG_FAR)
        : DETAIL_LEVEL_GLYPH;
    }
    return detailLevelForRadiusDistance(
      entityDetailRadius3D(entity),
      Math.sqrt(this.entityViewDistanceSq(view, entity)),
      view.fovYRad,
    );
  }

  /**
   * BAR-style icon cross-fade alpha for entities NOT yet latched at the
   * GLYPH rung: 0 outside the fade band, ramping to 1 as the projected
   * screen radius approaches the glyph threshold. Computed from the raw
   * (unlatched) screen radius so the fade is continuous; only the model
   * cut itself rides the hysteresis-latched rung.
   */
  entityLodProxyFadeAlphaForView(view: RenderViewState3D, entity: Entity): number {
    if (getLodMode() !== 'auto') return 0;
    if (!entityLodEnabled()) return 0;
    return lodProxyFadeAlphaForScreenRadius(detailScreenRadiusPx(
      entityDetailRadius3D(entity),
      Math.sqrt(this.entityViewDistanceSq(view, entity)),
      view.fovYRad,
    ));
  }

  /**
   * Latched detail rung with hysteresis — THE per-entity LOD decision for
   * everything that costs a rebuild. Latches once per frame per entity;
   * repeat calls within a frame return the latched value.
   */
  entityDetailRungForView(view: RenderViewState3D, entity: Entity): DetailRung {
    const lodMode = getLodMode();
    if (lodMode === 'high') return DETAIL_RUNG_CLOSE;
    if (lodMode === 'medium') return DETAIL_RUNG_MID;
    if (lodMode === 'low') {
      return isAuthoredGeometryHost(entity) ? DETAIL_RUNG_FAR : DETAIL_RUNG_GLYPH;
    }

    const entityId = entity.id;
    if (canIndexClientEntityId(entityId)) {
      const frame = this.rungFrameByIndexedEntityId[entityId];
      const stored = this.rungByIndexedEntityId[entityId];
      if (frame === this.frame && stored !== undefined) {
        return stored;
      }
      const level = this.entityDetailLevelForView(view, entity);
      const rung = stored !== undefined && frame !== undefined &&
        this.frame - frame <= LOD_STATE_STALE_FRAME_LIMIT
        ? detailRungWithHysteresis(stored, level)
        : detailRungForLevel(level);
      this.trackIndexedEntityCache(
        entityId,
        this.rungIndexedEntityIds,
        this.rungIndexedEntityIdTracked,
      );
      this.rungByIndexedEntityId[entityId] = rung;
      this.rungFrameByIndexedEntityId[entityId] = this.frame;
      return rung;
    }

    const frame = this.rungFrameByEntityId.get(entityId);
    const stored = this.rungByEntityId.get(entityId);
    if (frame === this.frame && stored !== undefined) {
      return stored;
    }
    const level = this.entityDetailLevelForView(view, entity);
    const rung = stored !== undefined && frame !== undefined &&
      this.frame - frame <= LOD_STATE_STALE_FRAME_LIMIT
      ? detailRungWithHysteresis(stored, level)
      : detailRungForLevel(level);
    this.rungByEntityId.set(entityId, rung);
    this.rungFrameByEntityId.set(entityId, this.frame);
    return rung;
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
    if (lodMode === 'medium') {
      this.deleteChannelEntity(channel, entity.id);
      return false;
    }
    if (lodMode === 'low') {
      if (isAuthoredGeometryHost(entity)) {
        this.deleteChannelEntity(channel, entity.id);
        return false;
      }
      this.proxyIdsForChannel(channel).add(entity.id);
      this.lastSeenForChannel(channel).set(entity.id, this.frame);
      return true;
    }
    if (!entityLodEnabled()) {
      // Proxying is off, but the detail ladder's latched-rung state must
      // survive — wiping the whole entity here would erase the hysteresis
      // latch every frame and reintroduce band thrash.
      this.deleteChannelEntity(channel, entity.id);
      return false;
    }

    const proxyIds = this.proxyIdsForChannel(channel);
    this.lastSeenForChannel(channel).set(entity.id, this.frame);
    const useProxy = detailRungForLevel(detailLevelForRadiusDistance(
      entityDetailRadius3D(entity),
      Math.sqrt(this.entityCameraDistanceSq(camera, entity)),
      cameraFovYRad(camera),
    )) === DETAIL_RUNG_GLYPH;

    if (useProxy) proxyIds.add(entity.id);
    else proxyIds.delete(entity.id);
    return useProxy;
  }

  /**
   * AUTO-mode proxy selection for the active 3D render loop: the entity is
   * a glyph exactly when its latched detail rung reaches GLYPH (projected
   * screen radius at/below the configured glyph size, with hysteresis).
   * Units iconify too (BAR behavior) — the cross-fade band beforehand is
   * {@link entityLodProxyFadeAlphaForView}.
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
    if (lodMode === 'medium') {
      this.deleteChannelEntity(channel, entity.id);
      return false;
    }
    if (lodMode === 'low') {
      if (isAuthoredGeometryHost(entity)) {
        this.deleteChannelEntity(channel, entity.id);
        return false;
      }
      this.proxyIdsForChannel(channel).add(entity.id);
      this.lastSeenForChannel(channel).set(entity.id, this.frame);
      return true;
    }
    if (!entityLodEnabled()) {
      // Proxying is off, but the detail ladder's latched-rung state must
      // survive — wiping the whole entity here would erase the hysteresis
      // latch every frame and reintroduce band thrash.
      this.deleteChannelEntity(channel, entity.id);
      return false;
    }

    const proxyIds = this.proxyIdsForChannel(channel);
    this.lastSeenForChannel(channel).set(entity.id, this.frame);
    const useProxy =
      this.entityDetailRungForView(view, entity) === DETAIL_RUNG_GLYPH;

    if (useProxy) proxyIds.add(entity.id);
    else proxyIds.delete(entity.id);
    return useProxy;
  }

  /**
   * Continuous detail level for this entity, reusing the per-frame cached
   * camera distance. 1 = full fidelity, 0 = glyph.
   */
  entityDetailLevel(camera: THREE.Camera, entity: Entity): number {
    const lodMode = getLodMode();
    if (lodMode === 'high') return DETAIL_LEVEL_FULL;
    if (lodMode === 'medium') return detailLevelForRung(DETAIL_RUNG_MID);
    if (lodMode === 'low') {
      return isAuthoredGeometryHost(entity)
        ? detailLevelForRung(DETAIL_RUNG_FAR)
        : DETAIL_LEVEL_GLYPH;
    }
    return detailLevelForRadiusDistance(
      entityDetailRadius3D(entity),
      Math.sqrt(this.entityCameraDistanceSq(camera, entity)),
      cameraFovYRad(camera),
    );
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

  private entityViewDistanceSq(view: RenderViewState3D, entity: Entity): number {
    if (canIndexClientEntityId(entity.id)) {
      const frame = this.distanceSqFrameByIndexedEntityId[entity.id];
      if (frame === this.frame) {
        const cachedDistanceSq = this.distanceSqByIndexedEntityId[entity.id];
        if (cachedDistanceSq !== undefined) return cachedDistanceSq;
      }
      const distanceSq = simPositionViewDistanceSq3D(
        view,
        entity.transform.x,
        entity.transform.y,
        entity.transform.z,
      );
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
    const distanceSq = simPositionViewDistanceSq3D(
      view,
      entity.transform.x,
      entity.transform.y,
      entity.transform.z,
    );
    this.distanceSqByEntityId.set(entity.id, distanceSq);
    this.distanceSqFrameByEntityId.set(entity.id, this.frame);
    return distanceSq;
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
