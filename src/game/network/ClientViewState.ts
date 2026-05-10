/**
 * ClientViewState - Manages the "client view" of the game state
 *
 * Uses EMA (Exponential Moving Average) + DEAD RECKONING for smooth rendering:
 * - On snapshot: store server's authoritative state as "targets"
 * - Every frame: predict using velocity/acceleration, then drift toward server targets
 * - Smooth at any snapshot rate, from 1/sec to 60/sec
 */

import type { Entity, PlayerId, EntityId } from '../sim/types';
import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotEntity,
  NetworkServerSnapshotGridCell,
  NetworkServerSnapshotMinimapEntity,
  NetworkServerSnapshotMeta,
} from './NetworkManager';
import type { SprayTarget } from '../sim/commanderAbilities';
import type { MinimapEntity } from '@/types/ui';
import type { NetworkCaptureTile } from '@/types/capture';
import type { TerrainBuildabilityGrid } from '@/types/terrain';
import { economyManager } from '../sim/economy';
import { createEntityFromNetwork } from './helpers';
import {
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_ROT,
  ENTITY_CHANGED_VEL,
  ENTITY_CHANGED_HP,
  ENTITY_CHANGED_BUILDING,
  ENTITY_CHANGED_NORMAL,
  ENTITY_CHANGED_SUSPENSION,
  ENTITY_CHANGED_JUMP,
  ENTITY_CHANGED_MOVEMENT_ACCEL,
} from '../../types/network';

import { setAuthoritativeTerrainTileMap } from '../sim/Terrain';
import { EntityCacheManager } from '../sim/EntityCacheManager';
import {
  createServerTarget,
  type ServerTarget,
} from './ClientPredictionTargets';
import { snapClientNonVisualState } from './ClientSnapshotApplier';
import { ClientSelectionState } from './ClientSelectionState';
import {
  ClientPredictionLod,
  type PredictionLodContext,
} from './ClientPredictionLod';
import { clientUnitPredictionIsSettled } from './ClientUnitPrediction';
import { ClientRocketTargetFinder } from './ClientRocketTargetFinder';
import { ClientPredictionStepper } from './ClientPredictionStepper';
import { ClientProjectileStore } from './ClientProjectileStore';
import { isLineProjectileEntity } from './ClientProjectileUtils';
import { applyNetworkUnitDriftFieldsToTarget } from './unitSnapshotFields';
import { getPlayerPrimaryColor } from '../sim/types';
export type { PredictionLodContext, PredictionLodTier } from './ClientPredictionLod';

// Shared empty array constant (avoids allocating new [] on every snapshot/frame)
const EMPTY_AUDIO: NetworkServerSnapshot['audioEvents'] = [];
const SPRAY_TARGET_POOL_MIN_CAP = 16;
const SPRAY_TARGET_POOL_ACTIVE_MULTIPLIER = 4;
const CAPTURE_TILE_POOL_FALLBACK_CAP = 256;
const minimapColorCache = new Map<number, string>();

function captureHeightsEmpty(heights: NetworkCaptureTile['heights']): boolean {
  for (const _key in heights) return false;
  return true;
}

function minimapColor(color: number): string {
  let cached = minimapColorCache.get(color);
  if (!cached) {
    cached = '#' + color.toString(16).padStart(6, '0');
    minimapColorCache.set(color, cached);
  }
  return cached;
}

export class ClientViewState {
  // Entity storage for rendering (client-predicted positions)
  private entities: Map<EntityId, Entity> = new Map();

  // Server target state — owned copies of drift-relevant fields per entity
  private serverTargets: Map<EntityId, ServerTarget> = new Map();
  private projectileStore!: ClientProjectileStore;

  // Current spray targets for rendering
  private sprayTargets: SprayTarget[] = [];
  private sprayTargetPool: SprayTarget[] = [];

  // Audio events from last state update
  private pendingAudioEvents: NetworkServerSnapshot['audioEvents'] = [];
  private minimapEntitiesOverride: MinimapEntity[] | null = null;

  // Game over state
  private gameOverWinnerId: PlayerId | null = null;

  // Current tick from host
  private currentTick: number = 0;

  // Reusable Set for snapshot diffing (avoids new Set() per snapshot)
  private _serverIds: Set<EntityId> = new Set();

  // Spatial grid debug visualization data
  private gridCells: NetworkServerSnapshotGridCell[] = [];
  private gridSearchCells: NetworkServerSnapshotGridCell[] = [];
  private gridCellSize: number = 0;
  private terrainBuildabilityGrid: TerrainBuildabilityGrid | null = null;

  // Capture tile data — Map for delta merge, array cache for rendering
  private captureTileMap: Map<number, NetworkCaptureTile> = new Map();
  private captureTilesCache: NetworkCaptureTile[] = [];
  private captureDirtyTileMap: Map<number, NetworkCaptureTile> = new Map();
  private captureDirtyTilesScratch: NetworkCaptureTile[] = [];
  private captureTilePool: NetworkCaptureTile[] = [];
  private captureFullDirty: boolean = true;
  private captureTilesDirty: boolean = true;
  private captureVersion: number = 0;
  private captureCellSize: number = 0;

  // Server metadata from latest snapshot
  private serverMeta: NetworkServerSnapshotMeta | null = null;
  private forceFieldsEnabledForPrediction = true;

  // === CACHED ENTITY ARRAYS (PERFORMANCE CRITICAL) ===
  private cache = new EntityCacheManager();
  private entitySetVersion = 0;
  private projectileCacheDirty = false;

  // Client prediction is LOD-stepped by the same camera-centered 3D
  // cells used by rendering. Far entities accumulate elapsed time and
  // run less often instead of paying turret/projectile/beam prediction
  // cost every browser frame.
  private predictionLod = new ClientPredictionLod();
  private activeEntityPredictionIds: Set<EntityId> = new Set();
  private dirtyUnitRenderIds: Set<EntityId> = new Set();
  private selectionState = new ClientSelectionState(
    this.entities,
    this.dirtyUnitRenderIds,
    (entity) => this.markEntityPredictionActive(entity),
  );
  private rocketTargetFinder!: ClientRocketTargetFinder;
  private predictionStepper!: ClientPredictionStepper;

  // Map dimensions — needed to evaluate the installed server-authored
  // terrain tile map on the client side. Before the first terrain
  // keyframe arrives, clients fall back to the deterministic authored
  // height function using these same dimensions.
  private mapWidth: number = 2000;
  private mapHeight: number = 2000;

  constructor() {
    this.rocketTargetFinder = new ClientRocketTargetFinder({
      getUnits: () => this.getUnits(),
      getBuildings: () => this.getBuildings(),
      getFrameCounter: () => this.predictionStepper.getFrameCounter(),
    });
    this.projectileStore = new ClientProjectileStore({
      entities: this.entities,
      getMapWidth: () => this.mapWidth,
      getMapHeight: () => this.mapHeight,
      clearPredictionAccum: (id) => this.clearPredictionAccum(id),
      markEntitySetChanged: (invalidateCaches) => this.markEntitySetChanged(invalidateCaches),
    });
    this.predictionStepper = new ClientPredictionStepper({
      entities: this.entities,
      serverTargets: this.serverTargets,
      beamPathTargets: this.projectileStore.beamPathTargets,
      projectileSpawns: this.projectileStore.projectileSpawns,
      predictionLod: this.predictionLod,
      rocketTargetFinder: this.rocketTargetFinder,
      activeEntityPredictionIds: this.activeEntityPredictionIds,
      activeProjectilePredictionIds: this.projectileStore.activeProjectilePredictionIds,
      activeBeamPathIds: this.projectileStore.activeBeamPathIds,
      dirtyUnitRenderIds: this.dirtyUnitRenderIds,
      getMapWidth: () => this.mapWidth,
      getMapHeight: () => this.mapHeight,
      getServerForceFieldsEnabled: () => this.serverMeta?.forceFieldsEnabled ?? true,
      setForceFieldsEnabledForPrediction: (enabled) => {
        this.forceFieldsEnabledForPrediction = enabled;
      },
      applyProjectileSpawn: (spawn) => this.projectileStore.applySpawn(spawn),
      deleteEntityLocalState: (id) => this.deleteEntityLocalState(id),
      markLineProjectilesChanged: () => this.projectileStore.markLineProjectilesChanged(),
    });
  }

  /** Plumb in the map dimensions so client-side projectile dead-
   *  reckoning can evaluate the same terrain heightmap the server
   *  uses. Call once after constructing. */
  setMapDimensions(mapWidth: number, mapHeight: number): void {
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
  }

  /** Read map dimensions for renderers / overlays that need to sample
   *  the deterministic terrain heightmap. */
  getMapWidth(): number { return this.mapWidth; }
  getMapHeight(): number { return this.mapHeight; }

  private invalidateCaches(): void {
    this.projectileCacheDirty = false;
    this.cache.invalidate();
  }

  private invalidateProjectileCaches(): void {
    this.projectileCacheDirty = true;
  }

  private markEntitySetChanged(invalidateCaches = true): void {
    this.entitySetVersion++;
    if (invalidateCaches) this.invalidateCaches();
    else this.invalidateProjectileCaches();
  }

  private clearPredictionAccum(id: EntityId): void {
    this.predictionLod.clear(id);
  }

  private clearTargetPredictionAccum(id: EntityId): void {
    this.predictionLod.clearTarget(id);
  }

  private getOrCreateServerTarget(id: EntityId): ServerTarget {
    let target = this.serverTargets.get(id);
    if (!target) {
      target = createServerTarget();
      this.serverTargets.set(id, target);
    }
    return target;
  }

  private networkJumpLaunchSeqAdvanced(
    entity: Entity,
    server: NetworkServerSnapshotEntity,
  ): boolean {
    const unit = entity.unit;
    const nextLaunchSeq = server.unit?.jump?.launchSeq;
    if (!unit?.jump || !Number.isFinite(nextLaunchSeq)) return false;
    return nextLaunchSeq! > unit.jump.launchSeq;
  }

  private resetUnitMotionToServerTarget(entity: Entity, target: ServerTarget): void {
    const unit = entity.unit;
    if (!unit) return;
    entity.transform.x = target.x;
    entity.transform.y = target.y;
    entity.transform.z = target.z;
    unit.velocityX = target.velocityX ?? 0;
    unit.velocityY = target.velocityY ?? 0;
    unit.velocityZ = target.velocityZ ?? 0;
    this.clearPredictionAccum(entity.id);
    this.clearTargetPredictionAccum(entity.id);
    this.dirtyUnitRenderIds.add(entity.id);
  }

  private copyNetworkTurretsToTarget(
    target: ServerTarget,
    turrets:
      | NonNullable<NetworkServerSnapshotEntity['unit']>['turrets']
      | NonNullable<NetworkServerSnapshotEntity['building']>['turrets'],
    isFull: boolean,
  ): boolean {
    if (turrets) {
      while (target.turrets.length < turrets.length) {
        target.turrets.push({
          rotation: 0,
          angularVelocity: 0,
          pitch: 0,
          forceFieldRange: undefined,
        });
      }
      target.turrets.length = turrets.length;
      for (let i = 0; i < turrets.length; i++) {
        target.turrets[i].rotation = turrets[i].turret.angular.rot;
        target.turrets[i].angularVelocity = turrets[i].turret.angular.vel;
        target.turrets[i].pitch = turrets[i].turret.angular.pitch;
        target.turrets[i].forceFieldRange = turrets[i].currentForceFieldRange ?? undefined;
      }
      return true;
    }
    if (isFull) target.turrets.length = 0;
    return false;
  }

  private deleteEntityLocalState(id: EntityId): void {
    const existing = this.entities.get(id);
    const wasLineProjectile = existing ? isLineProjectileEntity(existing) : false;
    const existed = this.entities.delete(id);
    this.serverTargets.delete(id);
    this.projectileStore.remove(id, wasLineProjectile);
    this.selectionState.delete(id);
    this.activeEntityPredictionIds.delete(id);
    this.dirtyUnitRenderIds.delete(id);
    if (existed) {
      this.markEntitySetChanged(existing?.type !== 'shot');
    }
  }

  private acquireSprayTarget(): SprayTarget {
    let target = this.sprayTargetPool.pop();
    if (!target) {
      target = {
        source: { id: 0, pos: { x: 0, y: 0 }, z: 0, playerId: 1 as PlayerId },
        target: { id: 0, pos: { x: 0, y: 0 }, z: 0 },
        type: 'build',
        intensity: 0,
      };
    }
    target.speed = undefined;
    target.particleRadius = undefined;
    return target;
  }

  private getSprayTargetPoolLimit(activeCount: number): number {
    return Math.max(
      SPRAY_TARGET_POOL_MIN_CAP,
      activeCount * SPRAY_TARGET_POOL_ACTIVE_MULTIPLIER,
    );
  }

  private trimSprayTargetPool(activeCount: number): void {
    const limit = this.getSprayTargetPoolLimit(activeCount);
    if (this.sprayTargetPool.length > limit) {
      this.sprayTargetPool.length = limit;
    }
  }

  private applyMinimapEntityOverride(
    source: readonly NetworkServerSnapshotMinimapEntity[] | undefined,
  ): void {
    if (!source) {
      this.minimapEntitiesOverride = null;
      return;
    }
    const out = this.minimapEntitiesOverride ?? (this.minimapEntitiesOverride = []);
    out.length = source.length;
    for (let i = 0; i < source.length; i++) {
      const src = source[i];
      let dst = out[i];
      if (!dst) {
        dst = { pos: { x: 0, y: 0 }, type: 'unit', color: '' };
        out[i] = dst;
      }
      dst.pos.x = src.pos.x;
      dst.pos.y = src.pos.y;
      dst.type = src.type;
      dst.color = minimapColor(getPlayerPrimaryColor(src.playerId));
      dst.isSelected = this.selectionState.has(src.id) || undefined;
    }
  }

  private releaseSprayTargets(nextActiveCount = 0): void {
    const limit = this.getSprayTargetPoolLimit(nextActiveCount);
    for (let i = 0; i < this.sprayTargets.length; i++) {
      if (this.sprayTargetPool.length < limit) {
        this.sprayTargetPool.push(this.sprayTargets[i]);
      }
    }
    this.sprayTargets.length = 0;
  }

  private markEntityPredictionActive(entity: Entity): void {
    if (entity.unit) {
      this.activeEntityPredictionIds.add(entity.id);
      this.dirtyUnitRenderIds.add(entity.id);
    } else if (entity.building && entity.combat?.turrets.length) {
      this.activeEntityPredictionIds.add(entity.id);
    } else if (entity.projectile && !isLineProjectileEntity(entity)) {
      this.projectileStore.activeProjectilePredictionIds.add(entity.id);
    }
  }

  private markNetworkEntityPredictionActive(
    server: NetworkServerSnapshotEntity,
    entity?: Entity,
  ): void {
    const cf = server.changedFields;
    if (server.type === 'building') {
      if (Array.isArray(server.building?.turrets)) {
        this.activeEntityPredictionIds.add(server.id);
      }
      return;
    }
    if (server.type !== 'unit') return;
    if (
      cf == null &&
      entity &&
      clientUnitPredictionIsSettled(
        entity,
        this.serverTargets.get(server.id),
        this.forceFieldsEnabledForPrediction,
      )
    ) {
      return;
    }
    if (
      cf == null ||
      (cf & (
        ENTITY_CHANGED_POS |
        ENTITY_CHANGED_ROT |
        ENTITY_CHANGED_VEL |
        ENTITY_CHANGED_MOVEMENT_ACCEL |
        // Reactivate prediction when only the surface normal moved
        // (host's tilt EMA is still settling on a stationary unit, or
        // the host flipped tilt mode). Otherwise the new target.normal
        // would land but applyClientUnitVisualPrediction's EMA — which
        // owns the entity.unit.surfaceNormal lerp — wouldn't run.
        ENTITY_CHANGED_NORMAL |
        // Suspension and jump actuator state can affect prediction even
        // if the quantized body position did not move.
        ENTITY_CHANGED_SUSPENSION |
        ENTITY_CHANGED_JUMP
      )) !== 0 ||
      Array.isArray(server.unit?.turrets)
    ) {
      this.activeEntityPredictionIds.add(server.id);
      this.dirtyUnitRenderIds.add(server.id);
    }
  }

  private snapshotAffectsEntityCaches(
    entity: Entity,
    server: NetworkServerSnapshotEntity,
  ): boolean {
    const cf = server.changedFields;
    if (entity.unit && (cf == null || (cf & (ENTITY_CHANGED_HP | ENTITY_CHANGED_BUILDING)))) {
      return this.unitHealthBarCacheMembership(entity) !==
        this.networkUnitHealthBarCacheMembership(entity, server);
    }
    if (
      entity.building &&
      (cf == null || (cf & (ENTITY_CHANGED_HP | ENTITY_CHANGED_BUILDING)))
    ) {
      return this.buildingHealthBarCacheMembership(entity) !==
        this.networkBuildingHealthBarCacheMembership(entity, server);
    }
    return false;
  }

  private unitHealthBarCacheMembership(entity: Entity): boolean {
    const unit = entity.unit;
    if (!unit) return false;
    return unit.hp < unit.maxHp ||
      !!(entity.buildable && !entity.buildable.isComplete && !entity.buildable.isGhost);
  }

  private networkUnitHealthBarCacheMembership(
    entity: Entity,
    server: NetworkServerSnapshotEntity,
  ): boolean {
    const hp = server.unit?.hp;
    const build = server.unit?.build;
    const curr = hp?.curr ?? entity.unit?.hp ?? 0;
    const max = hp?.max ?? entity.unit?.maxHp ?? 0;
    const complete = build?.complete ?? entity.buildable?.isComplete ?? true;
    return curr < max ||
      !!(entity.buildable && !entity.buildable.isGhost && !complete);
  }

  private buildingHealthBarCacheMembership(entity: Entity): boolean {
    const building = entity.building;
    if (!building) return false;
    return building.hp < building.maxHp ||
      !!(entity.buildable && !entity.buildable.isComplete && !entity.buildable.isGhost);
  }

  private networkBuildingHealthBarCacheMembership(
    entity: Entity,
    server: NetworkServerSnapshotEntity,
  ): boolean {
    const building = entity.building;
    const hp = server.building?.hp;
    const build = server.building?.build;
    const curr = hp?.curr ?? building?.hp ?? 0;
    const max = hp?.max ?? building?.maxHp ?? 0;
    const complete = build?.complete ?? entity.buildable?.isComplete ?? true;
    return curr < max ||
      !!(entity.buildable && !entity.buildable.isGhost && !complete);
  }

  private rebuildCachesIfNeeded(includeProjectileChanges = false): void {
    if (includeProjectileChanges && this.projectileCacheDirty) {
      this.projectileCacheDirty = false;
      this.cache.invalidate();
    }
    if (this.cache.rebuildIfNeeded(this.entities)) {
      this.projectileCacheDirty = false;
    }
  }

  /**
   * Apply received network state — store server targets, snap non-visual state.
   * Visual blending toward these targets happens in applyPrediction() each frame.
   */
  applyNetworkState(state: NetworkServerSnapshot): void {
    if (state.terrain) {
      this.setMapDimensions(state.terrain.mapWidth, state.terrain.mapHeight);
      setAuthoritativeTerrainTileMap(state.terrain);
    }
    if (state.buildability) {
      this.terrainBuildabilityGrid = state.buildability;
      this.trimCaptureTilePool();
    }
    this.currentTick = state.tick;
    if (state.minimapEntities !== undefined) {
      this.applyMinimapEntityOverride(state.minimapEntities);
    } else if (!state.isDelta) {
      this.applyMinimapEntityOverride(undefined);
    }
    let cacheNeedsInvalidate = false;
    const now = performance.now();
    this.projectileStore.projectileSpawns.recordSnapshot(now);
    this.projectileStore.projectileSpawns.drain(
      now,
      (spawn) => this.projectileStore.applySpawn(spawn),
    );

    // Process entity updates (present in both delta and keyframe snapshots)
    for (const netEntity of state.entities) {
      const cf = netEntity.changedFields;
      const isFull = cf == null;
      const isBuildingUpdate = netEntity.type === 'building';
      if (isBuildingUpdate) {
        // Building bodies are static, but armed buildings still use the
        // same turret target/prediction path as units.
        const turretSnapshot = netEntity.building?.turrets;
        if (turretSnapshot) {
          const target = this.getOrCreateServerTarget(netEntity.id);
          this.clearTargetPredictionAccum(netEntity.id);
          if (isFull || cf! & ENTITY_CHANGED_POS) {
            target.x = netEntity.pos.x;
            target.y = netEntity.pos.y;
            target.z = netEntity.pos.z;
          }
          if (isFull || cf! & ENTITY_CHANGED_ROT) {
            target.rotation = netEntity.rotation;
          }
          this.copyNetworkTurretsToTarget(target, turretSnapshot, isFull);
        } else if (isFull) {
          this.serverTargets.delete(netEntity.id);
          this.clearPredictionAccum(netEntity.id);
        }
      } else {
        // Copy drift-relevant fields into owned ServerTarget (avoids holding pooled object refs)
        const target = this.getOrCreateServerTarget(netEntity.id);
        // A fresh server target supersedes any sparse-prediction time
        // accumulated before this snapshot. Otherwise far entities can
        // extrapolate the newest target by time that already belonged
        // to an older target and visibly overshoot.
        this.clearTargetPredictionAccum(netEntity.id);
        applyNetworkUnitDriftFieldsToTarget(target, netEntity, isFull, cf);
        this.copyNetworkTurretsToTarget(target, netEntity.unit?.turrets, isFull);
      }

      const existing = this.entities.get(netEntity.id);

      if (!existing) {
        // Only create entities from full data (keyframes or new-entity entries).
        // Delta snapshots with changedFields set may be missing unit type, HP, etc.
        // The entity will be created on the next keyframe.
        if (netEntity.changedFields != null) continue;

        const newEntity = createEntityFromNetwork(netEntity);
        if (newEntity) {
          if (newEntity.selectable && this.selectionState.has(newEntity.id)) {
            newEntity.selectable.selected = true;
          }
          this.entities.set(netEntity.id, newEntity);
          this.markEntityPredictionActive(newEntity);
          this.entitySetVersion++;
          cacheNeedsInvalidate = true;
        }
      } else {
        // Existing entity — snap non-visual state immediately
        const resetMotionFromJump = this.networkJumpLaunchSeqAdvanced(existing, netEntity);
        if (this.snapshotAffectsEntityCaches(existing, netEntity)) {
          cacheNeedsInvalidate = true;
        }
        if (snapClientNonVisualState(existing, netEntity)) {
          this.cache.invalidate();
        }
        if (resetMotionFromJump) {
          const target = this.serverTargets.get(netEntity.id);
          if (target) this.resetUnitMotionToServerTarget(existing, target);
        }
        this.markNetworkEntityPredictionActive(netEntity, existing);
      }
    }

    if (state.isDelta) {
      // Delta snapshot: only remove entities explicitly listed in removedEntityIds
      if (state.removedEntityIds) {
        for (const id of state.removedEntityIds) {
          this.deleteEntityLocalState(id);
        }
      }
    } else {
      // Full keyframe: remove non-projectile entities not present in the snapshot
      this._serverIds.clear();
      for (const netEntity of state.entities) {
        this._serverIds.add(netEntity.id);
      }
      for (const [id, entity] of this.entities) {
        if (entity.type === 'shot') continue;
        if (!this._serverIds.has(id)) {
          this.deleteEntityLocalState(id);
        }
      }
    }

    // Process projectile spawn events
    if (state.projectiles?.spawns) {
      for (const spawn of state.projectiles.spawns) {
        if (this.projectileStore.projectileSpawns.shouldSmooth(spawn)) {
          this.projectileStore.projectileSpawns.enqueue(spawn, now);
          continue;
        }
        this.projectileStore.applySpawn(spawn);
      }
    }

    // Server-authored live beam/laser paths. These carry current
    // start/end/reflection points so the client can draw beams without
    // running local mirror/unit/building beam traces in applyPrediction.
    if (state.projectiles?.beamUpdates) {
      for (const update of state.projectiles.beamUpdates) {
        this.projectileStore.applyBeamUpdate(update);
      }
    }

    // Process projectile despawn events (after spawns, so same-snapshot spawn+despawn works)
    if (state.projectiles?.despawns) {
      for (const despawn of state.projectiles.despawns) {
        this.deleteEntityLocalState(despawn.id);
      }
    }

    // Process projectile velocity updates (homing / server correction)
    // Store as drift targets — client-side prediction should already be close
    if (state.projectiles?.velocityUpdates) {
      for (const vu of state.projectiles.velocityUpdates) {
        const entity = this.entities.get(vu.id);
        if (entity?.projectile) {
          let target = this.serverTargets.get(vu.id);
          if (!target) {
            target = createServerTarget();
            this.serverTargets.set(vu.id, target);
          }
          target.x = vu.pos.x;
          target.y = vu.pos.y;
          target.z = vu.pos.z;
          target.velocityX = vu.velocity.x;
          target.velocityZ = vu.velocity.z;
          target.velocityY = vu.velocity.y;
          this.clearTargetPredictionAccum(vu.id);
          this.projectileStore.markVelocityUpdateActive(entity, vu.id);
        }
      }
    }

    if (cacheNeedsInvalidate) this.invalidateCaches();

    // Update economy state (immediate). Avoid Object.entries here:
    // snapshots arrive frequently and this path should not allocate an
    // intermediate [key,value][] array just to walk up to six players.
    for (const playerIdStr in state.economy) {
      economyManager.setEconomyState(
        Number(playerIdStr) as PlayerId,
        state.economy[Number(playerIdStr) as PlayerId],
      );
    }

    // Store spray targets for rendering. Reuse nested objects instead
    // of retaining pooled snapshot references or allocating a fresh
    // object tree on every construction snapshot.
    const snapshotSprayTargets = state.sprayTargets;
    const nextSprayTargetCount = snapshotSprayTargets?.length ?? 0;
    this.releaseSprayTargets(nextSprayTargetCount);
    if (snapshotSprayTargets && snapshotSprayTargets.length > 0) {
      const src = snapshotSprayTargets;
      for (let i = 0; i < src.length; i++) {
        const st = src[i];
        const target = this.acquireSprayTarget();
        target.source.id = st.source.id;
        target.source.pos.x = st.source.pos.x;
        target.source.pos.y = st.source.pos.y;
        target.source.z = st.source.z;
        target.source.playerId = st.source.playerId;
        target.target.id = st.target.id;
        target.target.pos.x = st.target.pos.x;
        target.target.pos.y = st.target.pos.y;
        target.target.z = st.target.z;
        target.target.dim = st.target.dim;
        target.target.radius = st.target.radius;
        target.type = st.type;
        target.intensity = st.intensity;
        target.speed = st.speed;
        target.particleRadius = st.particleRadius;
        this.sprayTargets.push(target);
      }
    }
    this.trimSprayTargetPool(nextSprayTargetCount);

    // Store audio events for processing (reuse constant for empty case)
    this.pendingAudioEvents = state.audioEvents ?? EMPTY_AUDIO;

    // Check game over
    if (
      state.gameState?.phase === 'gameOver' &&
      state.gameState.winnerId !== undefined
    ) {
      this.gameOverWinnerId = state.gameState.winnerId;
    }

    // Store spatial grid debug data. The server sends this diagnostic
    // payload on a slower cadence than normal snapshots; keep the last
    // received grid payload until a new one arrives. When the server
    // toggle is off, serverMeta.grid clears the client copy.
    if (state.grid) {
      this.gridCells = state.grid.cells;
      this.gridSearchCells = state.grid.searchCells;
      this.gridCellSize = state.grid.cellSize;
    } else if (state.serverMeta?.grid === false) {
      this.gridCells = [];
      this.gridSearchCells = [];
      this.gridCellSize = 0;
    }

    // Merge capture tile data (delta-aware)
    if (state.capture) {
      this.captureCellSize = state.capture.cellSize;
      if (!state.isDelta) {
        // Keyframe: replace all
        this.clearCaptureTileMaps();
        this.captureFullDirty = true;
      }
      for (const tile of state.capture.tiles) {
        const key = ((tile.cx + 32768) & 0xFFFF) << 16 | ((tile.cy + 32768) & 0xFFFF);
        if (captureHeightsEmpty(tile.heights)) {
          const removed = this.captureTileMap.get(key);
          const previousDirty = this.captureDirtyTileMap.get(key);
          if (removed) {
            this.captureTileMap.delete(key);
            this.releaseCaptureTile(removed);
          }
          if (!this.captureFullDirty) {
            const dirty = this.acquireCaptureTile(tile.cx, tile.cy, undefined);
            if (previousDirty && previousDirty !== removed) this.releaseCaptureTile(previousDirty);
            this.captureDirtyTileMap.set(key, dirty);
          }
        } else {
          // Copy heights — tile objects may be pooled/reused by the server
          const copy = this.acquireCaptureTile(tile.cx, tile.cy, tile.heights);
          const previous = this.captureTileMap.get(key);
          const previousDirty = this.captureDirtyTileMap.get(key);
          if (previous) this.releaseCaptureTile(previous);
          this.captureTileMap.set(key, copy);
          if (!this.captureFullDirty) {
            if (previousDirty && previousDirty !== previous) this.releaseCaptureTile(previousDirty);
            this.captureDirtyTileMap.set(key, copy);
          }
        }
      }
      this.captureTilesDirty = true;
      this.captureVersion++;
    } else if (!state.isDelta) {
      // Keyframe with no capture data: clear
      this.clearCaptureTileMaps();
      this.captureFullDirty = true;
      this.captureTilesDirty = true;
      this.captureVersion++;
    }

    // Store server metadata
    if (state.serverMeta) {
      this.serverMeta = state.serverMeta;
    }
  }

  /**
   * Called every frame. Two steps:
   * 1. Predict: advance positions using velocity/acceleration
   * 2. Drift: EMA blend position/velocity/rotation toward server targets
   */
  applyPrediction(deltaMs: number, lod?: PredictionLodContext): void {
    this.predictionStepper.apply(deltaMs, lod);
  }

  // === Accessors for rendering and input ===

  getEntity(id: EntityId): Entity | undefined {
    return this.entities.get(id);
  }

  getEntitySetVersion(): number {
    return this.entitySetVersion;
  }

  getTerrainBuildabilityGrid(): TerrainBuildabilityGrid | null {
    return this.terrainBuildabilityGrid;
  }

  getAllEntities(): Entity[] {
    this.rebuildCachesIfNeeded(true);
    return this.cache.getAll();
  }

  getMinimapEntitiesOverride(): readonly MinimapEntity[] | null {
    return this.minimapEntitiesOverride;
  }

  getUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getUnits();
  }

  getUnitsByPlayer(playerId: PlayerId): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getUnitsByPlayer(playerId);
  }

  collectActiveUnitRenderEntities(out: Entity[]): Entity[] {
    out.length = 0;
    for (const id of this.activeEntityPredictionIds) {
      const entity = this.entities.get(id);
      if (entity?.unit) out.push(entity);
    }
    for (const id of this.dirtyUnitRenderIds) {
      if (this.activeEntityPredictionIds.has(id)) continue;
      const entity = this.entities.get(id);
      if (entity?.unit) out.push(entity);
    }
    this.dirtyUnitRenderIds.clear();
    return out;
  }

  getBuildings(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getBuildings();
  }

  /** Units + buildings as a single iterable. Hot per-frame UI loops
   *  (minimap, name labels) used to call getUnits() and getBuildings()
   *  back-to-back; this lets them iterate once and branch inline on
   *  entity.unit vs entity.building. */
  getUnitsAndBuildings(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getUnitsAndBuildings();
  }

  getBuildingsByPlayer(playerId: PlayerId): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getBuildingsByPlayer(playerId);
  }

  getProjectiles(): Entity[] {
    this.rebuildCachesIfNeeded(true);
    return this.cache.getProjectiles();
  }

  getTravelingProjectiles(): Entity[] {
    this.rebuildCachesIfNeeded(true);
    return this.cache.getTravelingProjectiles();
  }

  getSmokeTrailProjectiles(): Entity[] {
    this.rebuildCachesIfNeeded(true);
    return this.cache.getSmokeTrailProjectiles();
  }

  getLineProjectiles(): Entity[] {
    this.rebuildCachesIfNeeded(true);
    return this.cache.getLineProjectiles();
  }

  collectTravelingProjectiles(out: Entity[]): Entity[] {
    return this.projectileStore.collectTraveling(out);
  }

  collectSmokeTrailProjectiles(out: Entity[]): Entity[] {
    return this.projectileStore.collectSmokeTrail(out);
  }

  collectLineProjectiles(out: Entity[]): Entity[] {
    return this.projectileStore.collectLine(out);
  }

  collectBurnMarkProjectiles(out: Entity[]): Entity[] {
    return this.projectileStore.collectBurnMark(out);
  }

  getLineProjectileRenderVersion(): number {
    return this.projectileStore.getLineProjectileRenderVersion();
  }

  getForceFieldUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getForceFieldUnits();
  }

  getDamagedUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getDamagedUnits();
  }

  getHealthBarBuildings(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getHealthBarBuildings();
  }

  getSprayTargets(): SprayTarget[] {
    return this.sprayTargets;
  }

  getPendingAudioEvents(): NetworkServerSnapshot['audioEvents'] {
    const events = this.pendingAudioEvents;
    this.pendingAudioEvents = EMPTY_AUDIO;
    return events;
  }

  getGameOverWinnerId(): PlayerId | null {
    return this.gameOverWinnerId;
  }

  getTick(): number {
    return this.currentTick;
  }

  // === Selection management ===

  setSelectedIds(ids: Set<EntityId>): void {
    this.selectionState.set(ids);
  }

  getSelectedIds(): Set<EntityId> {
    return this.selectionState.get();
  }

  selectEntity(id: EntityId): void {
    this.selectionState.select(id);
  }

  deselectEntity(id: EntityId): void {
    this.selectionState.deselect(id);
  }

  clearSelection(): void {
    this.selectionState.clear();
  }

  // === Entity lookup for input handling ===

  findUnitAt(x: number, y: number, playerId?: PlayerId): Entity | null {
    for (const entity of this.getUnits()) {
      if (playerId !== undefined && entity.ownership?.playerId !== playerId)
        continue;

      const radius = entity.unit?.radius.body ?? 15;
      const dx = entity.transform.x - x;
      const dy = entity.transform.y - y;
      if (dx * dx + dy * dy <= radius * radius) {
        return entity;
      }
    }
    return null;
  }

  findBuildingAt(x: number, y: number): Entity | null {
    for (const entity of this.getBuildings()) {
      if (!entity.building) continue;

      const hw = entity.building.width / 2;
      const hh = entity.building.height / 2;
      if (
        x >= entity.transform.x - hw &&
        x <= entity.transform.x + hw &&
        y >= entity.transform.y - hh &&
        y <= entity.transform.y + hh
      ) {
        return entity;
      }
    }
    return null;
  }

  findEntitiesInRect(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    playerId?: PlayerId,
  ): Entity[] {
    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2);
    const maxY = Math.max(y1, y2);

    const results: Entity[] = [];

    for (const entity of this.getUnits()) {
      if (playerId !== undefined && entity.ownership?.playerId !== playerId)
        continue;

      if (
        entity.transform.x >= minX &&
        entity.transform.x <= maxX &&
        entity.transform.y >= minY &&
        entity.transform.y <= maxY
      ) {
        results.push(entity);
      }
    }

    return results;
  }

  // === Spatial grid debug data ===

  getGridCells(): NetworkServerSnapshotGridCell[] {
    return this.gridCells;
  }

  getGridSearchCells(): NetworkServerSnapshotGridCell[] {
    return this.gridSearchCells;
  }

  getGridCellSize(): number {
    return this.gridCellSize;
  }

  // === Capture tile data ===

  private acquireCaptureTile(
    cx: number,
    cy: number,
    heights: NetworkCaptureTile['heights'] | undefined,
  ): NetworkCaptureTile {
    const tile = this.captureTilePool.pop() ?? { cx: 0, cy: 0, heights: {} };
    tile.cx = cx;
    tile.cy = cy;
    const dst = tile.heights;
    for (const key in dst) delete dst[key];
    if (heights) {
      for (const key in heights) dst[Number(key)] = heights[key];
    }
    return tile;
  }

  private releaseCaptureTile(tile: NetworkCaptureTile): void {
    for (const key in tile.heights) delete tile.heights[key];
    if (this.captureTilePool.length < this.getCaptureTilePoolLimit()) {
      this.captureTilePool.push(tile);
    }
  }

  private getCaptureTilePoolLimit(): number {
    const grid = this.terrainBuildabilityGrid;
    if (!grid) return CAPTURE_TILE_POOL_FALLBACK_CAP;
    return Math.max(0, grid.cellsX * grid.cellsY);
  }

  private trimCaptureTilePool(): void {
    const limit = this.getCaptureTilePoolLimit();
    if (this.captureTilePool.length > limit) {
      this.captureTilePool.length = limit;
    }
  }

  private clearCaptureTileMaps(): void {
    for (const [key, tile] of this.captureDirtyTileMap) {
      if (this.captureTileMap.get(key) !== tile) this.releaseCaptureTile(tile);
    }
    this.captureDirtyTileMap.clear();
    for (const tile of this.captureTileMap.values()) this.releaseCaptureTile(tile);
    this.captureTileMap.clear();
    this.captureTilesCache.length = 0;
    this.captureDirtyTilesScratch.length = 0;
  }

  getCaptureTiles(): NetworkCaptureTile[] {
    if (this.captureTilesDirty) {
      this.captureTilesCache.length = 0;
      for (const tile of this.captureTileMap.values()) {
        this.captureTilesCache.push(tile);
      }
      this.captureTilesDirty = false;
    }
    return this.captureTilesCache;
  }

  consumeCaptureTileChanges(): {
    version: number;
    full: boolean;
    tiles: NetworkCaptureTile[];
  } {
    if (this.captureFullDirty) {
      this.captureFullDirty = false;
      this.captureDirtyTileMap.clear();
      return {
        version: this.captureVersion,
        full: true,
        tiles: this.getCaptureTiles(),
      };
    }

    if (this.captureDirtyTileMap.size === 0) {
      return {
        version: this.captureVersion,
        full: false,
        tiles: [],
      };
    }

    const tiles = this.captureDirtyTilesScratch;
    tiles.length = 0;
    for (const tile of this.captureDirtyTileMap.values()) {
      tiles.push(tile);
    }
    this.captureDirtyTileMap.clear();
    return {
      version: this.captureVersion,
      full: false,
      tiles,
    };
  }

  getCaptureCellSize(): number {
    return this.captureCellSize;
  }

  getCaptureVersion(): number {
    return this.captureVersion;
  }

  getServerMeta(): NetworkServerSnapshotMeta | null {
    return this.serverMeta;
  }

  clear(): void {
    this.entities.clear();
    this.serverTargets.clear();
    this.projectileStore.clear();
    this.releaseSprayTargets(0);
    this.sprayTargetPool.length = 0;
    this.pendingAudioEvents = EMPTY_AUDIO;
    this.gameOverWinnerId = null;
    this.selectionState.reset();
    this.gridCells = [];
    this.gridSearchCells = [];
    this.gridCellSize = 0;
    this.terrainBuildabilityGrid = null;
    this.clearCaptureTileMaps();
    this.captureTilePool.length = 0;
    this.captureFullDirty = true;
    this.captureTilesDirty = true;
    this.captureVersion++;
    this.captureCellSize = 0;
    this.serverMeta = null;
    this.predictionStepper.reset();
    this.predictionLod.clearAll();
    this.rocketTargetFinder.clear();
    this.activeEntityPredictionIds.clear();
    this.dirtyUnitRenderIds.clear();
    this.entitySetVersion++;
    this.invalidateCaches();
  }
}
