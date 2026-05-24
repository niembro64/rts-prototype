/**
 * ClientViewState - Manages the "client view" of the game state
 *
 * Uses EMA (Exponential Moving Average) + DEAD RECKONING for smooth rendering:
 * - On snapshot: store server's authoritative state as "targets"
 * - Every frame: predict using velocity/acceleration, then drift toward server targets
 * - Smooth at any snapshot rate, from 1/sec to 60/sec
 */

import type { Entity, PlayerId, EntityId } from '../sim/types';
import { NO_ENTITY_ID } from '../sim/types';
import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotEntity,
  NetworkServerSnapshotGridCell,
  NetworkServerSnapshotMeta,
  NetworkServerSnapshotResourceMovement,
} from './NetworkManager';
import type { SprayTarget } from '../sim/commanderAbilities';
import type { MinimapEntity } from '@/types/ui';
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
  RESOURCE_FLOW_OUTBOUND,
  RESOURCE_KIND_ENERGY,
  RESOURCE_KIND_METAL,
  type ResourceKindCode,
} from '../../types/network';

import { setAuthoritativeTerrainTileMap } from '../sim/Terrain';
import { EntityCacheManager } from '../sim/EntityCacheManager';
import { ClientMinimapOverrideStore } from './ClientMinimapOverrideStore';
import { ClientSprayTargetStore } from './ClientSprayTargetStore';
import {
  createServerTarget,
  type ServerTarget,
} from './ClientPredictionTargets';
import { snapClientNonVisualState } from './ClientSnapshotApplier';
import { ClientSelectionState } from './ClientSelectionState';
import { ClientPredictionCadence } from './ClientPredictionCadence';
import { clientUnitPredictionIsSettled } from './ClientUnitPrediction';
import { ClientPredictionStepper } from './ClientPredictionStepper';
import type {
  ClientPredictionCorrectionStats,
  ClientPredictionTargetAgeStats,
} from './ClientPredictionDiagnostics';
import { ClientProjectileStore } from './ClientProjectileStore';
import { isLineProjectileEntity } from './ClientProjectileUtils';
import { applyNetworkUnitDriftFieldsToTarget } from './unitSnapshotFields';
import {
  dequantizeEntityPosition as deqEntityPos,
  dequantizeProjectilePosition as deqProjPos,
  dequantizeRotation as deqRot,
  dequantizeVelocity as deqVel,
} from './snapshotQuantization';

// Shared empty array constant (avoids allocating new [] on every snapshot/frame)
const EMPTY_AUDIO: NetworkServerSnapshot['audioEvents'] = [];

type ClientResourcePylonSignedRates = {
  energy: number;
  metal: number;
};

export type ClientSnapshotApplyStats = {
  correction: ClientPredictionCorrectionStats;
};

export class ClientViewState {
  // Entity storage for rendering (client-predicted positions)
  private entities: Map<EntityId, Entity> = new Map();

  // Server target state — owned copies of drift-relevant fields per entity
  private serverTargets: Map<EntityId, ServerTarget> = new Map();
  private projectileStore!: ClientProjectileStore;

  private sprayTargetStore = new ClientSprayTargetStore();
  private resourcePylonSignedRates = new Map<EntityId, ClientResourcePylonSignedRates>();

  // Audio events from last state update
  private pendingAudioEvents: NetworkServerSnapshot['audioEvents'] = [];

  /** Active temporary vision pulses (FOW-14) the server has confirmed
   *  for this client's team. Mirror of WorldState.scanPulses filtered
   *  through SnapshotVisibility. Snapshot applier overwrites this on
   *  each keyframe; expired entries are pruned authoritatively before
   *  the snapshot is built so the client never needs to drop them. */
  private scanPulses: NonNullable<NetworkServerSnapshot['scanPulses']> = [];

  private minimapOverrideStore = new ClientMinimapOverrideStore({
    isSelected: (id) => this.selectionState.has(id),
  });

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

  // Server metadata from latest snapshot
  private serverMeta: NetworkServerSnapshotMeta | null = null;
  private visionPlayerMask = 0;
  private readonly visionPlayerIds: PlayerId[] = [];
  private forceFieldsEnabledForPrediction = true;

  // === CACHED ENTITY ARRAYS (PERFORMANCE CRITICAL) ===
  private cache = new EntityCacheManager();
  private entitySetVersion = 0;
  private projectileCacheDirty = false;

  private predictionCadence = new ClientPredictionCadence();
  private activeEntityPredictionIds: Set<EntityId> = new Set();
  private dirtyUnitRenderIds: Set<EntityId> = new Set();
  private selectionState = new ClientSelectionState(
    this.entities,
    this.dirtyUnitRenderIds,
    (entity) => this.markEntityPredictionActive(entity),
  );
  private predictionStepper!: ClientPredictionStepper;

  // Map dimensions — needed to evaluate the installed server-authored
  // terrain tile map on the client side. Before the first terrain
  // keyframe arrives, clients fall back to the deterministic authored
  // height function using these same dimensions.
  private mapWidth: number = 2000;
  private mapHeight: number = 2000;

  constructor() {
    this.projectileStore = new ClientProjectileStore({
      entities: this.entities,
      clearPredictionAccum: (id) => this.clearPredictionAccum(id),
      markEntitySetChanged: (invalidateCaches) => this.markEntitySetChanged(invalidateCaches),
    });
    this.predictionStepper = new ClientPredictionStepper({
      entities: this.entities,
      serverTargets: this.serverTargets,
      beamPathTargets: this.projectileStore.beamPathTargets,
      projectileSpawns: this.projectileStore.projectileSpawns,
      predictionCadence: this.predictionCadence,
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
    this.predictionCadence.clear(id);
  }

  private clearTargetPredictionAccum(id: EntityId): void {
    this.predictionCadence.clearTarget(id);
  }

  private getOrCreateServerTarget(id: EntityId): ServerTarget {
    let target = this.serverTargets.get(id);
    if (!target) {
      target = createServerTarget();
      this.serverTargets.set(id, target);
    }
    return target;
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
          pitchVelocity: 0,
          forceFieldRange: undefined,
        });
      }
      target.turrets.length = turrets.length;
      for (let i = 0; i < turrets.length; i++) {
        const wireAng = turrets[i].turret.angular;
        target.turrets[i].rotation = deqRot(wireAng.rot);
        target.turrets[i].angularVelocity = deqRot(wireAng.vel);
        target.turrets[i].pitch = deqRot(wireAng.pitch);
        target.turrets[i].pitchVelocity = deqRot(wireAng.pitchVel);
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
    this.entities.delete(id);
    this.serverTargets.delete(id);
    this.projectileStore.remove(id, wasLineProjectile);
    this.selectionState.delete(id);
    this.activeEntityPredictionIds.delete(id);
    this.dirtyUnitRenderIds.delete(id);
    if (existing !== undefined) {
      this.markEntitySetChanged(existing.type !== 'shot');
    }
  }

  private markEntityPredictionActive(entity: Entity): void {
    if (entity.unit) {
      this.activeEntityPredictionIds.add(entity.id);
      this.dirtyUnitRenderIds.add(entity.id);
    } else if (entity.building && entity.combat !== null && entity.combat.turrets.length > 0) {
      this.activeEntityPredictionIds.add(entity.id);
    } else if (entity.projectile && !isLineProjectileEntity(entity)) {
      this.projectileStore.activeProjectilePredictionIds.add(entity.id);
    }
  }

  private markNetworkEntityPredictionActive(
    server: NetworkServerSnapshotEntity,
    entity: Entity | undefined = undefined,
  ): void {
    const cf = server.changedFields;
    if (server.type === 'building') {
      const building = server.building;
      if (building !== null && Array.isArray(building.turrets)) {
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
        // Reactivate prediction when only the surface normal moved
        // (host's unit ground normal EMA is still settling on a stationary unit, or
        // the host flipped normal mode). Otherwise the new target.normal
        // would land but applyClientUnitVisualPrediction's EMA — which
        // owns the entity.unit.surfaceNormal lerp — wouldn't run.
        ENTITY_CHANGED_NORMAL
      )) !== 0 ||
      (server.unit !== null && Array.isArray(server.unit.turrets))
    ) {
      this.activeEntityPredictionIds.add(server.id);
      this.dirtyUnitRenderIds.add(server.id);
    }
  }

  private applyResourceMovements(
    movements: readonly NetworkServerSnapshotResourceMovement[] | undefined,
  ): void {
    this.resourcePylonSignedRates.clear();
    if (movements === undefined) return;
    for (let i = 0; i < movements.length; i++) {
      const movement = movements[i];
      const amount = movement.direction === RESOURCE_FLOW_OUTBOUND
        ? movement.amountPerSecond
        : -movement.amountPerSecond;
      if (amount === 0 || !Number.isFinite(amount)) continue;
      let rates = this.resourcePylonSignedRates.get(movement.sourceEntityId);
      if (rates === undefined) {
        rates = { energy: 0, metal: 0 };
        this.resourcePylonSignedRates.set(movement.sourceEntityId, rates);
      }
      if (movement.resource === RESOURCE_KIND_ENERGY) {
        rates.energy += amount;
      } else if (movement.resource === RESOURCE_KIND_METAL) {
        rates.metal += amount;
      }
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
    const serverUnit = server.unit;
    const hp = serverUnit !== null ? serverUnit.hp : null;
    const build = serverUnit !== null ? serverUnit.build : null;
    const entityUnit = entity.unit;
    const buildable = entity.buildable;
    const curr = hp !== null ? hp.curr : entityUnit !== null ? entityUnit.hp : 0;
    const max = hp !== null ? hp.max : entityUnit !== null ? entityUnit.maxHp : 0;
    const complete = build !== null ? build.complete : buildable !== null ? buildable.isComplete : true;
    return curr < max ||
      !!(buildable && !buildable.isGhost && !complete);
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
    const serverBuilding = server.building;
    const hp = serverBuilding !== null ? serverBuilding.hp : null;
    const build = serverBuilding !== null ? serverBuilding.build : null;
    const buildable = entity.buildable;
    const curr = hp !== null ? hp.curr : building !== null ? building.hp : 0;
    const max = hp !== null ? hp.max : building !== null ? building.maxHp : 0;
    const complete = build !== null ? build.complete : buildable !== null ? buildable.isComplete : true;
    return curr < max ||
      !!(buildable && !buildable.isGhost && !complete);
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
  applyNetworkState(
    state: NetworkServerSnapshot,
    options: { syncEconomy: boolean | undefined } = { syncEconomy: undefined },
  ): ClientSnapshotApplyStats {
    const applyStats: ClientSnapshotApplyStats = {
      correction: {
        count: 0,
        totalDistance: 0,
        maxDistance: 0,
        velocityCount: 0,
        totalVelocityDelta: 0,
        maxVelocityDelta: 0,
        targetAgeCount: 0,
        totalTargetAgeMs: 0,
        maxTargetAgeMs: 0,
      },
    };
    if (state.terrain) {
      this.setMapDimensions(state.terrain.mapWidth, state.terrain.mapHeight);
      setAuthoritativeTerrainTileMap(state.terrain);
    }
    if (state.buildability) {
      this.terrainBuildabilityGrid = state.buildability;
    }
    this.currentTick = state.tick;
    this.minimapOverrideStore.applySnapshot(state.minimapEntities, state.isDelta);
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
      const existing = this.entities.get(netEntity.id);
      const previousTarget = this.serverTargets.get(netEntity.id);
      const previousTargetAgeMs = previousTarget !== undefined && previousTarget.updatedAtMs
        ? Math.max(0, now - previousTarget.updatedAtMs)
        : 0;
      if (isBuildingUpdate) {
        // Building bodies are static, but armed buildings still use the
        // same turret target/prediction path as units.
        const turretSnapshot = netEntity.building !== null ? netEntity.building.turrets : null;
        if (turretSnapshot) {
          const target = this.getOrCreateServerTarget(netEntity.id);
          this.clearTargetPredictionAccum(netEntity.id);
          if ((isFull || cf! & ENTITY_CHANGED_POS) && netEntity.pos) {
            target.x = deqEntityPos(netEntity.pos.x);
            target.y = deqEntityPos(netEntity.pos.y);
            target.z = deqEntityPos(netEntity.pos.z);
          }
          if ((isFull || cf! & ENTITY_CHANGED_ROT) && netEntity.rotation !== null) {
            target.rotation = deqRot(netEntity.rotation);
          }
          this.copyNetworkTurretsToTarget(target, turretSnapshot, isFull);
          target.updatedAtMs = now;
        } else if (isFull) {
          this.serverTargets.delete(netEntity.id);
          this.clearPredictionAccum(netEntity.id);
        }
      } else {
        // Copy drift-relevant fields into owned ServerTarget (avoids holding pooled object refs)
        const target = this.getOrCreateServerTarget(netEntity.id);
        // A fresh server target supersedes any sparse-prediction time
        // accumulated before this snapshot. Otherwise an entity can
        // extrapolate the newest target by time that already belonged
        // to an older target and visibly overshoot.
        this.clearTargetPredictionAccum(netEntity.id);
        applyNetworkUnitDriftFieldsToTarget(target, netEntity, isFull, cf);
        this.copyNetworkTurretsToTarget(target, netEntity.unit !== null ? netEntity.unit.turrets : null, isFull);
        target.updatedAtMs = now;
      }

      if (existing && netEntity.pos && (cf == null || (cf & ENTITY_CHANGED_POS) !== 0)) {
        const netX = deqEntityPos(netEntity.pos.x);
        const netY = deqEntityPos(netEntity.pos.y);
        const netZ = deqEntityPos(netEntity.pos.z);
        const dx = existing.transform.x - netX;
        const dy = existing.transform.y - netY;
        const dz = existing.transform.z - netZ;
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        applyStats.correction.count++;
        applyStats.correction.totalDistance += distance;
        if (distance > applyStats.correction.maxDistance) {
          applyStats.correction.maxDistance = distance;
        }
        if (previousTargetAgeMs > 0) {
          applyStats.correction.targetAgeCount++;
          applyStats.correction.totalTargetAgeMs += previousTargetAgeMs;
          if (previousTargetAgeMs > applyStats.correction.maxTargetAgeMs) {
            applyStats.correction.maxTargetAgeMs = previousTargetAgeMs;
          }
        }
        const netVelocity = netEntity.unit !== null ? netEntity.unit.velocity : null;
        const localUnit = existing.unit;
        if (localUnit && netVelocity && (isFull || (cf & ENTITY_CHANGED_VEL) !== 0)) {
          const dvx = (localUnit.velocityX ?? 0) - deqVel(netVelocity.x);
          const dvy = (localUnit.velocityY ?? 0) - deqVel(netVelocity.y);
          const dvz = (localUnit.velocityZ ?? 0) - deqVel(netVelocity.z);
          const velocityDelta = Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz);
          applyStats.correction.velocityCount++;
          applyStats.correction.totalVelocityDelta += velocityDelta;
          if (velocityDelta > applyStats.correction.maxVelocityDelta) {
            applyStats.correction.maxVelocityDelta = velocityDelta;
          }
        }
      }

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
        if (this.snapshotAffectsEntityCaches(existing, netEntity)) {
          cacheNeedsInvalidate = true;
        }
        if (snapClientNonVisualState(existing, netEntity)) {
          this.cache.invalidate();
        }
        this.markNetworkEntityPredictionActive(netEntity, existing);
      }
    }

    if (state.removedEntityIds) {
      for (const id of state.removedEntityIds) {
        this.deleteEntityLocalState(id);
      }
    }

    if (!state.isDelta) {
      // Full keyframe: remove non-projectile entities not present in
      // the snapshot. Visibility-filtered keyframes omit out-of-sight
      // entities by design — dropping them here keeps the client view
      // honest so the player never sees an enemy they shouldn't.
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
        this.projectileStore.applyBeamUpdate(update, now);
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
          target.x = deqProjPos(vu.pos.x);
          target.y = deqProjPos(vu.pos.y);
          target.z = deqProjPos(vu.pos.z);
          target.velocityX = deqVel(vu.velocity.x);
          target.velocityZ = deqVel(vu.velocity.z);
          target.velocityY = deqVel(vu.velocity.y);
          target.updatedAtMs = now;
          if (vu.clearHomingTarget === true) {
            entity.projectile.homingTargetId = NO_ENTITY_ID;
          }
          this.clearTargetPredictionAccum(vu.id);
          this.projectileStore.markVelocityUpdateActive(entity, vu.id);
        }
      }
    }

    if (cacheNeedsInvalidate) this.invalidateCaches();

    // Update economy state (immediate). Local in-memory clients share
    // the authoritative server's economy singleton, so they must not
    // replay older snapshots back into the server state.
    if (options.syncEconomy !== false) {
      // Avoid Object.entries here: snapshots arrive frequently and this
      // path should not allocate an intermediate [key,value][] array
      // just to walk up to six players.
      for (const playerIdStr in state.economy) {
        economyManager.setEconomyState(
          Number(playerIdStr) as PlayerId,
          state.economy[Number(playerIdStr) as PlayerId],
        );
      }
    }

    this.applyResourceMovements(state.resourceMovements);
    this.sprayTargetStore.applySnapshot(state.sprayTargets);

    // Store audio events for processing (reuse constant for empty case)
    this.pendingAudioEvents = state.audioEvents ?? EMPTY_AUDIO;

    // Stamp force-field / mirror-panel collision points onto the
    // reflected projectile so the curved-cone tail renderer can anchor
    // its trailing sample at the actual bounce point. Audio events flow
    // separately to the scheduler; this is a read-only peek.
    const audioEventsForReflection = this.pendingAudioEvents;
    if (audioEventsForReflection) {
      for (let i = 0; i < audioEventsForReflection.length; i++) {
        const evt = audioEventsForReflection[i];
        if (evt.type !== 'forceFieldImpact' || evt.entityId === null) continue;
        const entity = this.entities.get(evt.entityId);
        const proj = entity?.projectile;
        if (!proj) continue;
        proj.pendingReflectionX = evt.pos.x;
        proj.pendingReflectionY = evt.pos.y;
        proj.pendingReflectionZ = evt.pos.z;
      }
    }

    // Snapshot owns the full list of active scan pulses for this
    // client's team. Length is small (a few at most), so a fresh copy
    // each snapshot is cheaper than maintaining incremental state.
    const incomingPulses = state.scanPulses;
    if (incomingPulses && incomingPulses.length > 0) {
      this.scanPulses.length = incomingPulses.length;
      for (let i = 0; i < incomingPulses.length; i++) {
        this.scanPulses[i] = incomingPulses[i];
      }
    } else {
      this.scanPulses.length = 0;
    }

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

    // Store server metadata
    if (state.serverMeta) {
      this.serverMeta = state.serverMeta;
    }
    this.visionPlayerMask = state.visionPlayerMask ?? 0;
    return applyStats;
  }

  /**
   * Called every frame. Two steps:
   * 1. Predict: advance positions using velocity/acceleration
   * 2. Drift: EMA blend position/velocity/rotation toward server targets
   */
  applyPrediction(deltaMs: number): ClientPredictionTargetAgeStats {
    return this.predictionStepper.apply(deltaMs);
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

  getResourcePylonSignedRate(entityId: EntityId, resource: ResourceKindCode): number {
    const rates = this.resourcePylonSignedRates.get(entityId);
    if (rates === undefined) return 0;
    return resource === RESOURCE_KIND_ENERGY ? rates.energy : rates.metal;
  }

  getAllEntities(): Entity[] {
    this.rebuildCachesIfNeeded(true);
    return this.cache.getAll();
  }

  getMinimapEntitiesOverride(): readonly MinimapEntity[] | null {
    return this.minimapOverrideStore.getOverride();
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
    return this.sprayTargetStore.getTargets();
  }

  getPendingAudioEvents(): NetworkServerSnapshot['audioEvents'] {
    const events = this.pendingAudioEvents;
    this.pendingAudioEvents = EMPTY_AUDIO;
    return events;
  }

  /** Active scan pulses for this client's team (FOW-14). The fog shade
   *  renderer reads these to clear fog inside each sweep for the
   *  pulse's remaining lifetime. Returned array is the live
   *  store — callers must not mutate it. */
  getScanPulses(): ReadonlyArray<NonNullable<NetworkServerSnapshot['scanPulses']>[number]> {
    return this.scanPulses;
  }

  /** Player IDs whose full-vision entities should drive live fog /
   *  sight presentation for this client. The host sends a compact
   *  recipient+allies bitmask; older/unfiltered snapshots fall back to
   *  the local player so standalone rendering keeps its prior behavior. */
  getVisionPlayerIds(localPlayerId: PlayerId): readonly PlayerId[] {
    const out = this.visionPlayerIds;
    out.length = 0;
    let pending = this.visionPlayerMask;
    if (pending === 0) {
      out.push(localPlayerId);
      return out;
    }
    while (pending !== 0) {
      const lowBit = pending & -pending;
      out.push((32 - Math.clz32(lowBit)) as PlayerId);
      pending ^= lowBit;
    }
    return out;
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

  findUnitAt(x: number, y: number, playerId: PlayerId | undefined = undefined): Entity | null {
    for (const entity of this.getUnits()) {
      if (playerId !== undefined && (entity.ownership === null || entity.ownership.playerId !== playerId))
        continue;

      const radius = entity.unit !== null ? entity.unit.radius.body : 15;
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
    playerId: PlayerId | undefined = undefined,
  ): Entity[] {
    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2);
    const maxY = Math.max(y1, y2);

    const results: Entity[] = [];

    for (const entity of this.getUnits()) {
      if (playerId !== undefined && (entity.ownership === null || entity.ownership.playerId !== playerId))
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

  getServerMeta(): NetworkServerSnapshotMeta | null {
    return this.serverMeta;
  }

  clear(): void {
    this.entities.clear();
    this.serverTargets.clear();
    this.projectileStore.clear();
    this.sprayTargetStore.reset();
    this.resourcePylonSignedRates.clear();
    this.pendingAudioEvents = EMPTY_AUDIO;
    this.scanPulses.length = 0;
    this.visionPlayerMask = 0;
    this.visionPlayerIds.length = 0;
    this.minimapOverrideStore.reset();
    this.gameOverWinnerId = null;
    this.selectionState.reset();
    this.gridCells = [];
    this.gridSearchCells = [];
    this.gridCellSize = 0;
    this.terrainBuildabilityGrid = null;
    this.serverMeta = null;
    this.predictionStepper.reset();
    this.predictionCadence.clearAll();
    this.activeEntityPredictionIds.clear();
    this.dirtyUnitRenderIds.clear();
    this.entitySetVersion++;
    this.invalidateCaches();
  }
}
