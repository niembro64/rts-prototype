/**
 * ClientViewState - Manages the "client view" of the game state
 *
 * Uses EMA (Exponential Moving Average) + DEAD RECKONING for smooth rendering:
 * - On snapshot: store server's authoritative state as "targets"
 * - Every frame: predict from last-seen velocity, then drift toward server targets
 * - Smooth at any snapshot rate, from 1/sec to 60/sec
 */

import type { Entity, PlayerId, EntityId } from '../sim/types';
import { NO_ENTITY_ID } from '../sim/types';
import {
  getResourceFillRatio,
  isBuildInProgress,
} from '../sim/buildableHelpers';
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
import type { FootprintBounds, ViewportFootprint } from '../ViewportFootprint';
import { economyManager } from '../sim/economy';
import { createEntityFromNetwork } from './helpers';
import {
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_ROT,
  ENTITY_CHANGED_VEL,
  ENTITY_CHANGED_HP,
  ENTITY_CHANGED_BUILDING,
  ENTITY_CHANGED_FACTORY,
  ENTITY_CHANGED_NORMAL,
  RESOURCE_FLOW_OUTBOUND,
  RESOURCE_KIND_ENERGY,
  RESOURCE_KIND_METAL,
  type GamePhase,
  type ResourceFlowDirectionCode,
  type ResourceKindCode,
} from '../../types/network';

import { setAuthoritativeTerrainTileMap } from '../sim/Terrain';
import { EntityCacheManager } from '../sim/EntityCacheManager';
import { ClientMinimapOverrideStore } from './ClientMinimapOverrideStore';
import { ClientSprayTargetStore } from './ClientSprayTargetStore';
import {
  createServerTarget,
  resetClientPredictionTargetPools,
  type ServerTarget,
} from './ClientPredictionTargets';
import { snapClientNonVisualState } from './ClientSnapshotApplier';
import { ClientSelectionState } from './ClientSelectionState';
import { ClientPredictionCadence } from './ClientPredictionCadence';
import {
  clientUnitPredictionIsSettled,
  isPredictionSupportSurfaceProvider,
  resetClientUnitPredictionPools,
} from './ClientUnitPrediction';
import { ClientPredictionStepper } from './ClientPredictionStepper';
import type {
  ClientPredictionCorrectionStats,
  ClientPredictionTargetAgeStats,
} from './ClientPredictionDiagnostics';
import {
  ClientProjectileStore,
  type ClientProjectileRenderLists,
} from './ClientProjectileStore';
import { isLineProjectileEntity } from './ClientProjectileUtils';
import { applyNetworkUnitDriftFieldsToTarget } from './unitSnapshotFields';
import { ClientRenderSpatialIndex } from './ClientRenderSpatialIndex';
import { getEntityRenderScopePadding } from '../entityRenderScope';
import {
  dequantizeEntityPosition as deqEntityPos,
  dequantizeProjectilePosition as deqProjPos,
  dequantizeRotation as deqRot,
  dequantizeVelocity as deqVel,
} from './snapshotQuantization';
import type { EntityHudElement, EntityHudType, SelectionHudMode } from '@/clientBarConfig';
import { getDefaultPlayerName } from '@/playerNamesConfig';
import { NAME_LABEL_OWNER_Y_OFFSET } from '@/nameLabelConfig';
import {
  getBuildingHudBarsY,
  getBuildingHudNameY,
  getUnitHudBarsY,
  getUnitHudNameY,
} from '../render3d/HudAnchor';
import {
  resolveCommanderOwnerName,
  resolveEntityDisplayName,
} from '../render3d/EntityName';
import {
  PIECE_TAG_BODY,
  type BodyHudRenderPacket3D,
} from '../render3d/HealthBar3D';
import {
  PIECE_TAG_COMMANDER_OWNER_NAME,
  type PieceNameRenderPacket3D,
} from '../render3d/NameLabel3D';
import type { ShieldRenderPacket3D } from '../render3d/ShieldRenderer3D';
import type { ContactShadowRenderPacket3D } from '../render3d/ContactShadowRenderer3D';
import type { GroundPrintRenderPacket3D } from '../render3d/GroundPrint3D';
import type { Locomotion3DMesh } from '../render3d/Locomotion3D';
import type {
  BuildingRenderPacket3D,
  UnitRenderPacket3D,
} from '../render3d/EntityRenderPackets3D';

// Shared empty array constant (avoids allocating new [] on every snapshot/frame)
const EMPTY_AUDIO: NetworkServerSnapshot['audioEvents'] = [];

type ClientResourcePylonSignedRates = {
  energy: number;
  metal: number;
};

export type ClientResourcePylonFlow = {
  targetEntityId: EntityId | null;
  resource: ResourceKindCode;
  amountPerSecond: number;
  direction: ResourceFlowDirectionCode;
};

const EMPTY_RESOURCE_PYLON_FLOWS: readonly ClientResourcePylonFlow[] = [];

export type ClientViewRenderEntityPackets3D = {
  unitRows: UnitRenderPacket3D;
  buildingRows: BuildingRenderPacket3D;
  bodyHud: BodyHudRenderPacket3D;
  shields: ShieldRenderPacket3D;
  pieceNames: PieceNameRenderPacket3D;
  contactShadows: ContactShadowRenderPacket3D;
  groundPrints: GroundPrintRenderPacket3D;
};

export type ClientViewRenderPacketOptions3D = {
  renderScope: ViewportFootprint;
  includeBodyHud: boolean;
  includeBodyNames: boolean;
  includeShields: boolean;
  includeContactShadows: boolean;
  includeGroundPrints: boolean;
  hoveredEntity: Entity | null;
  scopedUnitsOut: Entity[];
  scopedBuildingsOut: Entity[];
  selectionHudMode: SelectionHudMode;
  getEntityHudToggle: (type: EntityHudType, toggle: EntityHudElement) => boolean;
  lookupPlayerName: (id: PlayerId) => string | null;
  getGroundPrintLocomotionMesh: (entityId: EntityId) => Locomotion3DMesh;
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
  private resourcePylonFlowsBySource = new Map<EntityId, ClientResourcePylonFlow[]>();
  private readonly resourcePylonSourceIds: EntityId[] = [];

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
  /** Last authoritative game phase from snapshot gameState
   *  ('init' until the first snapshot carrying one arrives). */
  private gamePhase: GamePhase = 'init';

  // Current tick from host
  private currentTick: number = 0;

  // Reusable Set for snapshot diffing (avoids new Set() per snapshot)
  private _serverIds: Set<EntityId> = new Set();
  private _projectileReflectionIds: Set<EntityId> = new Set();

  // Spatial grid debug visualization data
  private gridCells: NetworkServerSnapshotGridCell[] = [];
  private gridSearchCells: NetworkServerSnapshotGridCell[] = [];
  private gridCellSize: number = 0;
  private terrainBuildabilityGrid: TerrainBuildabilityGrid | null = null;

  // Server metadata from latest snapshot
  private serverMeta: NetworkServerSnapshotMeta | null = null;
  private visionPlayerMask = 0;
  private readonly visionPlayerIds: PlayerId[] = [];
  private turretShieldSpheresEnabledForPrediction = true;

  // === CACHED ENTITY ARRAYS (PERFORMANCE CRITICAL) ===
  private cache = new EntityCacheManager();
  private renderSpatialIndex = new ClientRenderSpatialIndex();
  private readonly scopedRenderQueryUnitsScratch: Entity[] = [];
  private readonly scopedRenderQueryBuildingsScratch: Entity[] = [];
  private readonly scopedRenderIncludedIds = new Set<EntityId>();
  private entitySetVersion = 0;
  private projectileCacheDirty = false;

  private predictionCadence = new ClientPredictionCadence();
  private activeEntityPredictionIds: Set<EntityId> = new Set();
  private dirtyUnitRenderIds: Set<EntityId> = new Set();
  private dirtyBuildingRenderIds: Set<EntityId> = new Set();
  private removedUnitRenderIds: EntityId[] = [];
  private removedBuildingRenderIds: EntityId[] = [];
  private renderLifecycleDirtyIds: Set<EntityId> = new Set();
  private predictionSupportSurfaceEntities: Entity[] = [];
  private predictionSupportSurfaceEntityIds = new Set<EntityId>();
  private selectionState = new ClientSelectionState(
    this.entities,
    this.dirtyUnitRenderIds,
    this.dirtyBuildingRenderIds,
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
      supportSurfaceEntities: this.predictionSupportSurfaceEntities,
      getMapWidth: () => this.mapWidth,
      getMapHeight: () => this.mapHeight,
      getServerShieldsEnabled: () => {
        const serverMeta = this.serverMeta;
        return (
          serverMeta !== null &&
          serverMeta.turretShieldSpheresEnabled !== undefined &&
          serverMeta.turretShieldSpheresEnabled !== null
        )
          ? serverMeta.turretShieldSpheresEnabled
          : true;
      },
      setTurretShieldSpheresEnabledForPrediction: (enabled) => {
        this.turretShieldSpheresEnabledForPrediction = enabled;
      },
      applyProjectileSpawn: (spawn) => this.projectileStore.applySpawn(spawn),
      deleteEntityLocalState: (id) => this.deleteEntityLocalState(id),
      markLineProjectilesChanged: () => this.projectileStore.markLineProjectilesChanged(),
      updateProjectileRenderSpatialIndex: (entity) => this.projectileStore.updateRenderSpatialIndex(entity),
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

  private addPredictionSupportSurfaceProvider(entity: Entity): void {
    if (this.predictionSupportSurfaceEntityIds.has(entity.id)) return;
    this.predictionSupportSurfaceEntityIds.add(entity.id);
    this.predictionSupportSurfaceEntities.push(entity);
  }

  private removePredictionSupportSurfaceProvider(id: EntityId): void {
    if (!this.predictionSupportSurfaceEntityIds.delete(id)) return;
    const providers = this.predictionSupportSurfaceEntities;
    for (let i = 0; i < providers.length; i++) {
      if (providers[i].id !== id) continue;
      const last = providers.pop();
      if (last !== undefined && i < providers.length) providers[i] = last;
      return;
    }
  }

  private refreshPredictionSupportSurfaceProvider(entity: Entity): void {
    if (isPredictionSupportSurfaceProvider(entity)) {
      this.addPredictionSupportSurfaceProvider(entity);
    } else {
      this.removePredictionSupportSurfaceProvider(entity.id);
    }
  }

  private getOrCreateServerTarget(id: EntityId): ServerTarget {
    let target = this.serverTargets.get(id);
    if (!target) {
      target = createServerTarget();
      this.serverTargets.set(id, target);
    }
    return target;
  }

  private collectProjectileReflectionIds(
    events: NetworkServerSnapshot['audioEvents'],
  ): Set<EntityId> {
    const ids = this._projectileReflectionIds;
    ids.clear();
    if (events === undefined || events === null || events.length === 0) return ids;
    for (let i = 0; i < events.length; i++) {
      const evt = events[i];
      if (evt.type === 'shieldImpact' && evt.entityId !== null) {
        ids.add(evt.entityId);
      }
    }
    return ids;
  }

  private writeRocketVelocityTarget(
    id: EntityId,
    x: number,
    y: number,
    z: number,
    velocityX: number,
    velocityY: number,
    velocityZ: number,
    now: number,
  ): void {
    const target = this.getOrCreateServerTarget(id);
    this.clearTargetPredictionAccum(id);
    target.x = x;
    target.y = y;
    target.z = z;
    target.rotation = Math.atan2(velocityY, velocityX);
    target.velocityX = velocityX;
    target.velocityY = velocityY;
    target.velocityZ = velocityZ;
    target.surfaceNormalX = 0;
    target.surfaceNormalY = 0;
    target.surfaceNormalZ = 1;
    target.bodyCenterHeight = 0;
    target.predictedGroundContact = false;
    target.orientation = null;
    target.angularVelocityX = null;
    target.angularVelocityY = null;
    target.angularVelocityZ = null;
    target.turrets.length = 0;
    target.updatedAtMs = now;
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
          shieldRange: null,
        });
      }
      target.turrets.length = turrets.length;
      for (let i = 0; i < turrets.length; i++) {
        const wireAng = turrets[i].turret.angular;
        target.turrets[i].rotation = deqRot(wireAng.rot);
        target.turrets[i].angularVelocity = deqRot(wireAng.vel);
        target.turrets[i].pitch = deqRot(wireAng.pitch);
        target.turrets[i].pitchVelocity = deqRot(wireAng.pitchVel);
        target.turrets[i].shieldRange = turrets[i].currentShieldRange ?? null;
      }
      return true;
    }
    if (isFull) target.turrets.length = 0;
    return false;
  }

  private deleteEntityLocalState(id: EntityId): void {
    const existing = this.entities.get(id);
    const wasLineProjectile = existing ? isLineProjectileEntity(existing) : false;
    if (existing !== undefined) {
      if (existing.unit !== null) {
        this.removedUnitRenderIds.push(id);
      } else if (existing.building !== null) {
        this.removedBuildingRenderIds.push(id);
      }
    }
    this.removePredictionSupportSurfaceProvider(id);
    this.entities.delete(id);
    this.serverTargets.delete(id);
    this.projectileStore.remove(id, wasLineProjectile);
    this.renderSpatialIndex.remove(id);
    this.selectionState.delete(id);
    this.activeEntityPredictionIds.delete(id);
    this.dirtyUnitRenderIds.delete(id);
    this.dirtyBuildingRenderIds.delete(id);
    this.renderLifecycleDirtyIds.delete(id);
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
    if (server.type === 'building' || server.type === 'tower') {
      // Towers ride the same building turret-prediction path because
      // their wire payload (server.building) carries turrets identically.
      const building = server.building;
      if (
        cf == null ||
        (cf & (
          ENTITY_CHANGED_POS |
          ENTITY_CHANGED_ROT |
          ENTITY_CHANGED_HP |
          ENTITY_CHANGED_BUILDING |
          ENTITY_CHANGED_FACTORY
        )) !== 0
      ) {
        this.dirtyBuildingRenderIds.add(server.id);
      }
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
        this.turretShieldSpheresEnabledForPrediction,
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
        // would land but the client unit visual prediction EMA — which
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
    this.resourcePylonFlowsBySource.clear();
    this.resourcePylonSourceIds.length = 0;
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
        this.resourcePylonSourceIds.push(movement.sourceEntityId);
      }
      if (movement.resource === RESOURCE_KIND_ENERGY) {
        rates.energy += amount;
      } else if (movement.resource === RESOURCE_KIND_METAL) {
        rates.metal += amount;
      }
      let flows = this.resourcePylonFlowsBySource.get(movement.sourceEntityId);
      if (flows === undefined) {
        flows = [];
        this.resourcePylonFlowsBySource.set(movement.sourceEntityId, flows);
      }
      flows.push({
        targetEntityId: movement.targetEntityId,
        resource: movement.resource,
        amountPerSecond: movement.amountPerSecond,
        direction: movement.direction,
      });
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
      isBuildInProgress(entity.buildable);
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
    const interrupted = build !== null
      ? build.interrupted === true
      : buildable !== null ? buildable.isInterrupted : false;
    return curr < max ||
      !!(buildable && !buildable.isGhost && !complete && !interrupted);
  }

  private buildingHealthBarCacheMembership(entity: Entity): boolean {
    const building = entity.building;
    if (!building) return false;
    return building.hp < building.maxHp ||
      isBuildInProgress(entity.buildable);
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
    const interrupted = build !== null
      ? build.interrupted === true
      : buildable !== null ? buildable.isInterrupted : false;
    return curr < max ||
      !!(buildable && !buildable.isGhost && !complete && !interrupted);
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
    const reflectedProjectileIds = this.collectProjectileReflectionIds(state.audioEvents);
    this.projectileStore.projectileSpawns.recordSnapshot(now);
    this.projectileStore.projectileSpawns.drain(
      now,
      (spawn) => this.projectileStore.applySpawn(spawn),
    );

    // Process entity updates (present in both delta and keyframe snapshots)
    for (const netEntity of state.entities) {
      const cf = netEntity.changedFields;
      const isFull = cf == null;
      // Towers ride the static-entity wire shape (no velocity, has
      // turrets through server.building.turrets), so isBuildingUpdate
      // gates the static branch for both.
      const isBuildingUpdate = netEntity.type === 'building' || netEntity.type === 'tower';
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
        // Delta snapshots with changedFields set may be missing unit blueprint, HP, etc.
        // The entity will be created on the next keyframe.
        if (netEntity.changedFields != null) continue;

        const newEntity = createEntityFromNetwork(netEntity);
        if (newEntity) {
          if (newEntity.selectable && this.selectionState.has(newEntity.id)) {
            newEntity.selectable.selected = true;
          }
          this.entities.set(netEntity.id, newEntity);
          this.renderSpatialIndex.update(newEntity);
          this.markEntityPredictionActive(newEntity);
          this.refreshPredictionSupportSurfaceProvider(newEntity);
          this.entitySetVersion++;
          this.renderLifecycleDirtyIds.add(netEntity.id);
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
        this.renderSpatialIndex.update(existing);
        this.refreshPredictionSupportSurfaceProvider(existing);
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

    const projectiles = state.projectiles;
    if (projectiles !== undefined && projectiles !== null) {
      const spawns = projectiles.spawns;

      // Process projectile spawn events
      if (spawns !== undefined && spawns !== null) {
        for (const spawn of spawns) {
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
      const beamUpdates = projectiles.beamUpdates;
      if (beamUpdates !== undefined && beamUpdates !== null) {
        for (const update of beamUpdates) {
          this.projectileStore.applyBeamUpdate(update, now);
        }
      }

      // Process projectile despawn events (after spawns, so same-snapshot spawn+despawn works)
      const despawns = projectiles.despawns;
      if (despawns !== undefined && despawns !== null) {
        for (const despawn of despawns) {
          this.deleteEntityLocalState(despawn.id);
        }
      }

      // Process projectile velocity updates. Shield reflections are hard
      // topology events and still snap so the trail kink stays exact. Rocket
      // course corrections become EMA targets: the render-side projectile
      // keeps dead-reckoning, while ClientProjectilePrediction advances the
      // target and drifts position + velocity toward it each frame.
      const velocityUpdates = projectiles.velocityUpdates;
      if (velocityUpdates !== undefined && velocityUpdates !== null) {
        for (const vu of velocityUpdates) {
          const entity = this.entities.get(vu.id);
          if (entity !== undefined && entity.projectile !== null) {
            const x = deqProjPos(vu.pos.x);
            const y = deqProjPos(vu.pos.y);
            const z = deqProjPos(vu.pos.z);
            const velocityX = deqVel(vu.velocity.x);
            const velocityY = deqVel(vu.velocity.y);
            const velocityZ = deqVel(vu.velocity.z);
            const shouldSmoothRocket =
              entity.projectile.config.shotProfile.runtime.isRocketLike === true &&
              !reflectedProjectileIds.has(vu.id);
            if (shouldSmoothRocket) {
              this.writeRocketVelocityTarget(vu.id, x, y, z, velocityX, velocityY, velocityZ, now);
            } else {
              entity.transform.x = x;
              entity.transform.y = y;
              entity.transform.z = z;
              entity.projectile.velocityX = velocityX;
              entity.projectile.velocityY = velocityY;
              entity.projectile.velocityZ = velocityZ;
              this.serverTargets.delete(vu.id);
              this.clearTargetPredictionAccum(vu.id);
            }
            if (vu.clearHomingTarget === true) {
              entity.projectile.homingTargetId = NO_ENTITY_ID;
            }
            this.projectileStore.markVelocityUpdateActive(entity, vu.id);
          }
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

    // Stash the exact shield / shield-panel contact point on the
    // reflected projectile so the curved-cone tail renderer can insert
    // it as a forced trail stamp on the next frame. The velocityUpdate
    // above already snapped the head to one-tick-past-bounce; this puts
    // the actual bounce point on the projectile so the trail kinks
    // exactly at the shield surface instead of one tick past it. Reflection
    // velocity updates still snap above; ordinary rocket corrections use an
    // EMA target instead. Audio event pos is unquantized f64.
    const audioEventsForReflection = this.pendingAudioEvents;
    if (audioEventsForReflection !== undefined && audioEventsForReflection.length > 0) {
      for (let i = 0; i < audioEventsForReflection.length; i++) {
        const evt = audioEventsForReflection[i];
        if (evt.type !== 'shieldImpact' || evt.entityId === null) continue;
        const entity = this.entities.get(evt.entityId);
        const proj = entity !== undefined ? entity.projectile : null;
        if (proj === null) continue;
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

    // Track authoritative game phase (battle / paused / gameOver)
    const gameState = state.gameState;
    if (gameState !== undefined && gameState !== null) {
      this.gamePhase = gameState.phase;
      if (gameState.phase === 'gameOver' && gameState.winnerId !== undefined) {
        this.gameOverWinnerId = gameState.winnerId;
      }
    }

    // Store spatial grid debug data. The server sends this diagnostic
    // payload on a slower cadence than normal snapshots; keep the last
    // received grid payload until a new one arrives. When the server
    // toggle is off, serverMeta.grid clears the client copy.
    const serverMeta = state.serverMeta;
    if (state.grid) {
      this.gridCells = state.grid.cells;
      this.gridSearchCells = state.grid.searchCells;
      this.gridCellSize = state.grid.cellSize;
    } else if (serverMeta !== undefined && serverMeta !== null && serverMeta.grid === false) {
      this.gridCells = [];
      this.gridSearchCells = [];
      this.gridCellSize = 0;
    }

    // Store server metadata
    if (serverMeta !== undefined && serverMeta !== null) {
      this.serverMeta = serverMeta;
    }
    this.visionPlayerMask = state.visionPlayerMask ?? 0;
    return applyStats;
  }

  /**
   * Called every frame. Two steps:
   * 1. Predict: advance positions from last-seen velocity
   * 2. Drift: EMA blend position/velocity/rotation toward server targets
   */
  applyPrediction(deltaMs: number): ClientPredictionTargetAgeStats {
    const stats = this.predictionStepper.apply(deltaMs);
    this.refreshPredictedRenderSpatialIndex();
    return stats;
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

  getResourcePylonFlows(entityId: EntityId): readonly ClientResourcePylonFlow[] {
    return this.resourcePylonFlowsBySource.get(entityId) ?? EMPTY_RESOURCE_PYLON_FLOWS;
  }

  getResourcePylonSourceIds(): readonly EntityId[] {
    return this.resourcePylonSourceIds;
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
      if (entity !== undefined && entity.unit !== null) out.push(entity);
    }
    for (const id of this.dirtyUnitRenderIds) {
      if (this.activeEntityPredictionIds.has(id)) continue;
      const entity = this.entities.get(id);
      if (entity !== undefined && entity.unit !== null) out.push(entity);
    }
    this.dirtyUnitRenderIds.clear();
    return out;
  }

  getRenderSpatialEntityPadding(): number {
    return this.renderSpatialIndex.getMaxEntityPadding();
  }

  getProjectileRenderScopePadding(): number {
    return this.projectileStore.getRenderScopePadding();
  }

  collectScopedRenderEntities(
    bounds: FootprintBounds,
    outUnits: Entity[],
    outBuildings: Entity[],
    includeEntity: (entity: Entity) => boolean,
    hoveredEntity: Entity | null,
  ): void {
    const queryUnits = this.scopedRenderQueryUnitsScratch;
    const queryBuildings = this.scopedRenderQueryBuildingsScratch;
    const included = this.scopedRenderIncludedIds;
    outUnits.length = 0;
    outBuildings.length = 0;
    included.clear();
    this.renderSpatialIndex.queryUnitsAndBuildings(bounds, queryUnits, queryBuildings);
    for (let i = 0; i < queryUnits.length; i++) {
      const entity = queryUnits[i];
      if (!includeEntity(entity)) continue;
      outUnits.push(entity);
      included.add(entity.id);
    }
    for (let i = 0; i < queryBuildings.length; i++) {
      const entity = queryBuildings[i];
      if (!includeEntity(entity)) continue;
      outBuildings.push(entity);
      included.add(entity.id);
    }

    if (hoveredEntity !== null) {
      this.pushScopedRenderException(hoveredEntity, outUnits, outBuildings, included);
    }
    for (const id of this.selectionState.get()) {
      const entity = this.entities.get(id);
      if (entity !== undefined) {
        this.pushScopedRenderException(entity, outUnits, outBuildings, included);
      }
    }
  }

  prepareRenderEntityPackets3D(
    out: ClientViewRenderEntityPackets3D,
    options: ClientViewRenderPacketOptions3D,
  ): ClientViewRenderEntityPackets3D {
    out.unitRows.reset();
    out.buildingRows.reset();
    out.bodyHud.reset();
    out.shields.reset();
    out.pieceNames.reset();
    out.contactShadows.reset();
    out.groundPrints.reset();
    this.populateRenderRemovalRows3D(out);

    const renderScope = options.renderScope;
    if (renderScope.getMode() === 'all') {
      const units = this.getUnits();
      const buildings = this.getBuildings();
      this.populateUnitRenderRows3D(units, out);
      this.populateQueuedBuildingRenderRows3D(out);
      if (options.includeBodyHud) {
        this.populateBodyHudPacket3D(this.getHudEntities(), options.hoveredEntity, options, out);
      }
      if (options.includeBodyNames) {
        this.populateBodyNamePacket3D(this.getUnitsAndBuildings(), options, out);
      }
      if (options.includeShields) {
        this.populateShieldPacket3D(this.getShieldUnits(), renderScope, out);
      }
      if (options.includeContactShadows) {
        this.populateContactShadowPacket3D(units, buildings, renderScope, out);
      }
      if (options.includeGroundPrints) {
        this.populateGroundPrintPacket3D(units, options, out);
      }
      return out;
    }

    const units = options.scopedUnitsOut;
    const buildings = options.scopedBuildingsOut;
    this.collectScopedRenderEntities(
      renderScope.getCullingBounds(this.getRenderSpatialEntityPadding()),
      units,
      buildings,
      (entity) => this.entityInRenderScope3D(entity, renderScope),
      options.hoveredEntity,
    );

    let hoveredBodyHudPushed = false;
    for (let i = 0; i < units.length; i++) {
      const entity = units[i];
      this.pushUnitRenderRow3D(entity, out);
      if (options.includeBodyHud && this.entityNeedsBodyHud3D(entity)) {
        const forceVisible = entity === options.hoveredEntity;
        if (forceVisible) hoveredBodyHudPushed = true;
        this.pushBodyHudEntity3D(entity, forceVisible, options, out);
      }
      if (options.includeBodyNames) {
        this.pushBodyNamesForEntity3D(entity, options, out);
      }
      if (options.includeShields && entity.unit !== null && entity.combat !== null) {
        out.shields.pushUnit(entity, renderScope);
      }
    }
    for (let i = 0; i < buildings.length; i++) {
      const entity = buildings[i];
      this.pushBuildingRenderRow3D(entity, out);
      if (options.includeBodyHud && this.entityNeedsBodyHud3D(entity)) {
        const forceVisible = entity === options.hoveredEntity;
        if (forceVisible) hoveredBodyHudPushed = true;
        this.pushBodyHudEntity3D(entity, forceVisible, options, out);
      }
      if (options.includeBodyNames) {
        this.pushBodyNamesForEntity3D(entity, options, out);
      }
    }

    if (options.includeBodyHud && options.hoveredEntity !== null && !hoveredBodyHudPushed) {
      this.pushBodyHudEntity3D(options.hoveredEntity, true, options, out);
    }
    if (options.includeContactShadows) {
      this.populateContactShadowPacket3D(units, buildings, renderScope, out);
    }
    if (options.includeGroundPrints) {
      this.populateGroundPrintPacket3D(units, options, out);
    }
    return out;
  }

  consumeRenderDirties(): void {
    this.dirtyUnitRenderIds.clear();
    this.dirtyBuildingRenderIds.clear();
    this.removedUnitRenderIds.length = 0;
    this.removedBuildingRenderIds.length = 0;
    this.renderLifecycleDirtyIds.clear();
  }

  private refreshPredictedRenderSpatialIndex(): void {
    for (const id of this.activeEntityPredictionIds) {
      const entity = this.entities.get(id);
      if (entity !== undefined) this.renderSpatialIndex.update(entity);
      else this.renderSpatialIndex.remove(id);
    }
    for (const id of this.dirtyUnitRenderIds) {
      const entity = this.entities.get(id);
      if (entity !== undefined) this.renderSpatialIndex.update(entity);
      else this.renderSpatialIndex.remove(id);
    }
  }

  private pushScopedRenderException(
    entity: Entity,
    outUnits: Entity[],
    outBuildings: Entity[],
    included: Set<EntityId>,
  ): void {
    if (included.has(entity.id)) return;
    if (entity.unit !== null) {
      outUnits.push(entity);
      included.add(entity.id);
    } else if (entity.building !== null) {
      outBuildings.push(entity);
      included.add(entity.id);
    }
  }

  private barVisible3D(
    perType: boolean,
    selected: boolean,
    mode: SelectionHudMode,
    notFull: boolean,
  ): boolean {
    if (!perType) return false;
    if (selected) {
      if (mode === 'always') return true;
      if (mode === 'never') return false;
      return notFull;
    }
    return notFull;
  }

  private hudTypeOf3D(entity: Entity): EntityHudType {
    if (entity.type === 'unit') return 'unit';
    if (entity.type === 'tower') return 'tower';
    return 'building';
  }

  private entityInRenderScope3D(entity: Entity, renderScope: ViewportFootprint): boolean {
    return renderScope.inScope(
      entity.transform.x,
      entity.transform.y,
      getEntityRenderScopePadding(entity),
    );
  }

  private entityNeedsBodyHud3D(entity: Entity): boolean {
    const buildInProgress = isBuildInProgress(entity.buildable);
    if (buildInProgress) return true;
    const unit = entity.unit;
    if (unit !== null) return unit.hp > 0 && unit.hp < unit.maxHp;
    const building = entity.building;
    return building !== null && building.hp > 0 && building.hp < building.maxHp;
  }

  private populateUnitRenderRows3D(
    units: readonly Entity[],
    out: ClientViewRenderEntityPackets3D,
  ): void {
    for (let i = 0; i < units.length; i++) {
      this.pushUnitRenderRow3D(units[i], out);
    }
  }

  private populateQueuedBuildingRenderRows3D(out: ClientViewRenderEntityPackets3D): void {
    for (const id of this.activeEntityPredictionIds) {
      const entity = this.entities.get(id);
      if (entity !== undefined && entity.building !== null) this.pushBuildingRenderRow3D(entity, out);
    }
    for (const id of this.dirtyBuildingRenderIds) {
      if (this.activeEntityPredictionIds.has(id)) continue;
      const entity = this.entities.get(id);
      if (entity !== undefined && entity.building !== null) this.pushBuildingRenderRow3D(entity, out);
    }
    for (const id of this.renderLifecycleDirtyIds) {
      if (this.activeEntityPredictionIds.has(id) || this.dirtyBuildingRenderIds.has(id)) continue;
      const entity = this.entities.get(id);
      if (entity !== undefined && entity.building !== null) this.pushBuildingRenderRow3D(entity, out);
    }
  }

  private pushUnitRenderRow3D(
    entity: Entity,
    out: ClientViewRenderEntityPackets3D,
  ): void {
    out.unitRows.pushEntity(
      entity,
      this.activeEntityPredictionIds.has(entity.id),
      this.dirtyUnitRenderIds.has(entity.id),
      this.renderLifecycleDirtyIds.has(entity.id),
    );
  }

  private pushBuildingRenderRow3D(
    entity: Entity,
    out: ClientViewRenderEntityPackets3D,
  ): void {
    out.buildingRows.pushEntity(
      entity,
      this.activeEntityPredictionIds.has(entity.id),
      this.dirtyBuildingRenderIds.has(entity.id),
      this.renderLifecycleDirtyIds.has(entity.id),
    );
  }

  private populateRenderRemovalRows3D(out: ClientViewRenderEntityPackets3D): void {
    const removedUnits = this.removedUnitRenderIds;
    for (let i = 0; i < removedUnits.length; i++) {
      out.unitRows.pushRemovedEntityId(removedUnits[i]);
    }
    const removedBuildings = this.removedBuildingRenderIds;
    for (let i = 0; i < removedBuildings.length; i++) {
      out.buildingRows.pushRemovedEntityId(removedBuildings[i]);
    }
  }

  private populateBodyHudPacket3D(
    entities: readonly Entity[],
    hoveredEntity: Entity | null,
    options: ClientViewRenderPacketOptions3D,
    out: ClientViewRenderEntityPackets3D,
  ): void {
    let hoveredBodyHudPushed = false;
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      const forceVisible = entity === hoveredEntity;
      if (forceVisible) hoveredBodyHudPushed = true;
      this.pushBodyHudEntity3D(entity, forceVisible, options, out);
    }
    if (hoveredEntity !== null && !hoveredBodyHudPushed) {
      this.pushBodyHudEntity3D(hoveredEntity, true, options, out);
    }
  }

  private pushBodyHudEntity3D(
    entity: Entity,
    forceVisible: boolean,
    options: ClientViewRenderPacketOptions3D,
    out: ClientViewRenderEntityPackets3D,
  ): void {
    const unit = entity.unit;
    const building = entity.building;
    if (unit === null && building === null) return;

    const type = this.hudTypeOf3D(entity);
    const selected = entity.selectable?.selected === true;
    const buildable = isBuildInProgress(entity.buildable)
      ? entity.buildable
      : null;
    const hp = unit !== null ? unit.hp : building !== null ? building.hp : 0;
    const maxHp = unit !== null ? unit.maxHp : building !== null ? building.maxHp : 0;
    const healthNotFull = maxHp > 0 && hp < maxHp;
    const showHealth = this.barVisible3D(
      options.getEntityHudToggle(type, 'healthBar'),
      selected,
      options.selectionHudMode,
      healthNotFull,
    );
    const showBuild = this.barVisible3D(
      options.getEntityHudToggle(type, 'buildBars'),
      selected,
      options.selectionHudMode,
      buildable !== null,
    );
    const showHp = maxHp > 0 && (showHealth || forceVisible)
      && (buildable !== null || hp > 0);
    const showBuildBars = showBuild && buildable !== null;
    if (!showHp && !showBuildBars) return;

    out.bodyHud.pushRow(
      entity.id,
      entity.transform.x,
      unit !== null ? getUnitHudBarsY(entity) : getBuildingHudBarsY(entity),
      entity.transform.y,
      unit !== null ? unit.radius.visual * 2 : building!.width,
      maxHp > 0 ? hp / maxHp : 0,
      buildable !== null ? getResourceFillRatio(buildable, 'energy') : 0,
      buildable !== null ? getResourceFillRatio(buildable, 'metal') : 0,
      showHp,
      showBuildBars,
    );
  }

  private populateBodyNamePacket3D(
    entities: readonly Entity[],
    options: ClientViewRenderPacketOptions3D,
    out: ClientViewRenderEntityPackets3D,
  ): void {
    for (let i = 0; i < entities.length; i++) {
      this.pushBodyNamesForEntity3D(entities[i], options, out);
    }
  }

  private pushBodyNamesForEntity3D(
    entity: Entity,
    options: ClientViewRenderPacketOptions3D,
    out: ClientViewRenderEntityPackets3D,
  ): void {
    const type = this.hudTypeOf3D(entity);
    const nameToggle = options.getEntityHudToggle(type, 'name');
    const bodyName = resolveEntityDisplayName(
      entity,
      nameToggle,
      options.selectionHudMode,
    );
    if (bodyName !== null) {
      out.pieceNames.push(
        entity.id,
        PIECE_TAG_BODY,
        entity.transform.x,
        entity.unit !== null ? getUnitHudNameY(entity) : getBuildingHudNameY(entity),
        entity.transform.y,
        bodyName,
      );
    }
    const ownerName = resolveCommanderOwnerName(
      entity,
      (playerId) => options.lookupPlayerName(playerId) ?? getDefaultPlayerName(playerId),
      nameToggle,
      options.selectionHudMode,
    );
    if (ownerName !== null) {
      out.pieceNames.push(
        entity.id,
        PIECE_TAG_COMMANDER_OWNER_NAME,
        entity.transform.x,
        getUnitHudNameY(entity) + NAME_LABEL_OWNER_Y_OFFSET,
        entity.transform.y,
        ownerName,
        'owner',
      );
    }
  }

  private populateShieldPacket3D(
    units: readonly Entity[],
    renderScope: ViewportFootprint,
    out: ClientViewRenderEntityPackets3D,
  ): void {
    for (let i = 0; i < units.length; i++) {
      out.shields.pushUnit(units[i], renderScope);
    }
  }

  private populateContactShadowPacket3D(
    units: readonly Entity[],
    buildings: readonly Entity[],
    renderScope: ViewportFootprint,
    out: ClientViewRenderEntityPackets3D,
  ): void {
    const mapWidth = this.getMapWidth();
    const mapHeight = this.getMapHeight();
    for (let i = 0; i < units.length; i++) {
      out.contactShadows.pushUnit(units[i], mapWidth, mapHeight, renderScope);
    }
    for (let i = 0; i < buildings.length; i++) {
      out.contactShadows.pushBuilding(buildings[i], renderScope);
    }
  }

  private populateGroundPrintPacket3D(
    units: readonly Entity[],
    options: ClientViewRenderPacketOptions3D,
    out: ClientViewRenderEntityPackets3D,
  ): void {
    const mapWidth = this.getMapWidth();
    const mapHeight = this.getMapHeight();
    for (let i = 0; i < units.length; i++) {
      out.groundPrints.pushUnit(
        units[i],
        options.getGroundPrintLocomotionMesh,
        mapWidth,
        mapHeight,
      );
    }
  }

  getPredictionSupportSurfaceEntities(): readonly Entity[] {
    return this.predictionSupportSurfaceEntities;
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

  collectProjectileRenderLists(
    bounds: FootprintBounds | null,
    out: ClientProjectileRenderLists,
  ): ClientProjectileRenderLists {
    return this.projectileStore.collectRenderLists(bounds, out);
  }

  getLineProjectileRenderVersion(): number {
    return this.projectileStore.getLineProjectileRenderVersion();
  }

  getShieldUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getShieldUnits();
  }

  getDamagedUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getDamagedUnits();
  }

  getHealthBarBuildings(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getHealthBarBuildings();
  }

  /** Units / towers / buildings needing ANY HUD bar this frame
   *  (body-damaged, building, or a damaged sub-piece). Selection is
   *  applied by the orchestrator against the live entity ref, not here. */
  getHudEntities(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getHudEntities();
  }

  /** Entities (unit/tower/building) with at least one non-visualOnly
   *  turret. Feeds the turret HUD bar / name pass. */
  getArmedEntities(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getArmedEntities();
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

  getGamePhase(): GamePhase {
    return this.gamePhase;
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
    this.resourcePylonFlowsBySource.clear();
    this.resourcePylonSourceIds.length = 0;
    this.pendingAudioEvents = EMPTY_AUDIO;
    this.scanPulses.length = 0;
    this.visionPlayerMask = 0;
    this.visionPlayerIds.length = 0;
    this.minimapOverrideStore.reset();
    this.gameOverWinnerId = null;
    this.gamePhase = 'init';
    this.selectionState.reset();
    this.gridCells = [];
    this.gridSearchCells = [];
    this.gridCellSize = 0;
    this.terrainBuildabilityGrid = null;
    this.serverMeta = null;
    this.renderSpatialIndex.clear();
    this.predictionStepper.reset();
    this.predictionCadence.clearAll();
    this.activeEntityPredictionIds.clear();
    this.dirtyUnitRenderIds.clear();
    this.dirtyBuildingRenderIds.clear();
    this.renderLifecycleDirtyIds.clear();
    this.predictionSupportSurfaceEntities.length = 0;
    this.predictionSupportSurfaceEntityIds.clear();
    resetClientUnitPredictionPools();
    resetClientPredictionTargetPools();
    this.entitySetVersion++;
    this.invalidateCaches();
  }
}
