/** Snapshot materialization and shared client-view storage. */

import type {
  Entity,
  PlayerId,
  EntityId,
  FactoryDefaultWaypoint,
} from '../sim/types';
import { NO_ENTITY_ID } from '../sim/types';
import {
  isBuildInProgress,
} from '../sim/buildableHelpers';
import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotEntity,
  NetworkServerSnapshotMeta,
  NetworkServerSnapshotResourceMovement,
} from './NetworkManager';
import type { TerrainBuildabilityGrid } from '@/types/terrain';
import { economyManager } from '../sim/economy';
import {
  createEntityFromNetwork,
  createEntityFromTypedFullWireRow,
  readFactoryWaypointFromWire,
} from './helpers';
import {
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_ROT,
  ENTITY_CHANGED_VEL,
  ENTITY_CHANGED_HP,
  ENTITY_CHANGED_BUILDING,
  ENTITY_CHANGED_ACTIONS,
  ENTITY_CHANGED_FACTORY,
  ENTITY_CHANGED_NORMAL,
  ENTITY_CHANGED_TURRETS,
  RESOURCE_FLOW_OUTBOUND,
  RESOURCE_KIND_ENERGY,
  RESOURCE_KIND_METAL,
  codeToBuildingBlueprintId,
  codeToUnitBlueprintId,
  codeToTurretState,
  type GamePhase,
  type ResourceFlowDirectionCode,
  type ResourceKindCode,
} from '../../types/network';
import { setAuthoritativeTerrainTileMap } from '../sim/Terrain';
import { precomputeAllUnitPathTraversabilityGrids } from '../sim/pathfindingTraversabilityGrid';
import { EntityCacheManager } from '../sim/EntityCacheManager';
import { ClientMinimapOverrideStore } from './ClientMinimapOverrideStore';
import { ClientSprayTargetStore } from './ClientSprayTargetStore';
import {
  resizeServerTargetTurrets,
  type ServerTarget,
} from './ClientPredictionTargets';
import { snapClientNonVisualState } from './ClientSnapshotApplier';
import {
  applyNetworkBuildStateFields,
  getBuildingBuildRequired,
  getUnitBuildRequired,
} from './ClientBuildStateApplier';
import { ClientSelectionState } from './ClientSelectionState';
import { ClientSupplementalPresentation } from './ClientSupplementalPresentation';
import { ClientLockstepPresentation } from './ClientLockstepPresentation';
import type { PresentationFrameEvent } from '@/types/game';
import type {
  ClientPredictionCorrectionStats,
} from './ClientPredictionDiagnostics';
import {
  ClientProjectileStore,
} from './ClientProjectileStore';
import { ClientEntityStore } from './ClientEntityStore';
import { ClientEntityIdSet } from './ClientEntityIdSet';
import { IndexedEntityIdMap, IndexedEntityIdSet } from './IndexedEntityIdCollections';
import { ClientServerTargetStore } from './ClientServerTargetStore';
import { isLineProjectileEntity } from './ClientProjectileUtils';
import {
  applyNetworkUnitActionWireRows,
  applyNetworkUnitDriftFieldsToTarget,
} from './unitSnapshotFields';
import {
  decodeFactoryProductionQueueInto,
  decodeFactoryProductionQuotaCountsInto,
  decodeFactoryProductionQuotasInto,
} from './factoryProductionQueueWire';
import { createSpawnDto } from './snapshotDtoCopy';
import { ClientRenderSpatialIndex } from './ClientRenderSpatialIndex';
import {
  recordSnapshotCorrectionStats,
  recordSnapshotVelocityCorrectionStats,
} from './snapshotCorrectionStats';
import {
  trajectoryModeFromWireCode,
  unitFireStateFromWireCode,
  unitMoveStateFromWireCode,
} from './unitCombatStateWireCodes';
import {
  ENTITY_POSITION_WIRE_INV_SCALE,
  NORMAL_WIRE_INV_SCALE,
  ROTATION_WIRE_INV_SCALE,
  VELOCITY_WIRE_INV_SCALE,
  dequantizeEntityPosition as deqEntityPos,
  dequantizeNormal as deqNormal,
  dequantizeProjectilePosition as deqProjPos,
  dequantizeRotation as deqRot,
  dequantizeVelocity as deqVel,
} from './snapshotQuantization';
import {
  ENTITY_SNAPSHOT_WIRE_BASIC_STRIDE,
  ENTITY_SNAPSHOT_WIRE_ACTION_STRIDE,
  ENTITY_SNAPSHOT_WIRE_KIND_BASIC,
  ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE,
  ENTITY_SNAPSHOT_WIRE_KIND_BUILDING,
  ENTITY_SNAPSHOT_WIRE_KIND_UNIT,
  ENTITY_SNAPSHOT_WIRE_TURRET_STRIDE,
  ENTITY_SNAPSHOT_WIRE_TYPE_BUILDING,
  ENTITY_SNAPSHOT_WIRE_TYPE_UNIT,
  ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE,
  getEntitySnapshotWireSource,
  type EntitySnapshotWireSource,
} from './stateSerializerEntities';
import {
  forEachPackedProjectileDespawn,
  forEachPackedProjectileMotionUpdate,
  getPackedProjectileSnapshotWire,
} from './snapshotProjectileWirePack';
import {
  copyProjectileWireSourceSpawnRowFromSourceInto,
  forEachProjectileWireSourceBeamUpdateFieldsFromSource,
  getActiveProjectileSnapshotWireSource,
  PROJECTILE_SPAWN_FLAG_FROM_PARENT_TRUE,
  PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_BLUEPRINT_CODE,
  PROJECTILE_SPAWN_WIRE_STRIDE,
  PROJECTILE_MOTION_WIRE_STRIDE,
  projectileWireSourceHasDirectlyConsumableRows,
  type ProjectileSnapshotWireSource,
} from './stateSerializerProjectiles';
import { projectileSpawnFieldsShouldSmooth } from './ProjectileSpawnQueue';
import {
  addSnapshotMaterializationStageToSnapshot,
  type SnapshotMaterializationStage,
} from './snapshotMaterializationMetadata';
import {
  CLIENT_RENDER_ENTITY_KIND_BUILDING,
  CLIENT_RENDER_ENTITY_KIND_UNIT,
  ClientRenderEntityStateSlab,
} from '../render3d/ClientRenderEntityStateSlab';
import {
  ClientRenderTurretStateSlab,
} from '../render3d/ClientRenderTurretStateSlab';
import { isMetalExtractorBlueprintId } from '../../types/buildingTypes';
import {
  unitBlueprintBarDefaultMoveState,
} from '../sim/unitCommandCapabilities';

function isLocomotionSupportSurfaceProvider(entity: Entity): boolean {
  const building = entity.building;
  if (building !== null) {
    return !building.hovering && building.supportSurface.kind === 'boxTop';
  }
  const unit = entity.unit;
  return unit !== null && unit.hp > 0 && unit.supportSurface.kind === 'discTop';
}

function entityHasShieldEmission(entity: Entity): boolean {
  return entity.combat?.turrets.some((turret) => turret.config.shot?.type === 'shield') === true;
}

























// Shared empty array constant (avoids allocating new [] on every snapshot/frame)
const EMPTY_AUDIO: NetworkServerSnapshot['audioEvents'] = [];
const CLIENT_UNIT_MOTION_DELTA_FIELDS =
  ENTITY_CHANGED_POS |
  ENTITY_CHANGED_ROT |
  ENTITY_CHANGED_VEL |
  ENTITY_CHANGED_NORMAL;
const CLIENT_BASIC_TRANSFORM_DELTA_FIELDS =
  ENTITY_CHANGED_POS |
  ENTITY_CHANGED_ROT;
const CLIENT_UNIT_HOT_MOTION_DELTA_FIELDS =
  ENTITY_CHANGED_POS |
  ENTITY_CHANGED_ROT |
  ENTITY_CHANGED_VEL |
  ENTITY_CHANGED_NORMAL;
const CLIENT_UNIT_METADATA_DELTA_FIELDS =
  ENTITY_CHANGED_HP |
  ENTITY_CHANGED_BUILDING;
const CLIENT_UNIT_TYPED_DELTA_FIELDS =
  CLIENT_UNIT_MOTION_DELTA_FIELDS |
  ENTITY_CHANGED_HP |
  ENTITY_CHANGED_TURRETS |
  ENTITY_CHANGED_BUILDING |
  ENTITY_CHANGED_ACTIONS |
  ENTITY_CHANGED_FACTORY;
const CLIENT_BUILDING_METADATA_DELTA_FIELDS =
  ENTITY_CHANGED_HP |
  ENTITY_CHANGED_BUILDING;
const CLIENT_BUILDING_TYPED_DELTA_FIELDS =
  ENTITY_CHANGED_POS |
  ENTITY_CHANGED_ROT |
  ENTITY_CHANGED_HP |
  ENTITY_CHANGED_TURRETS |
  ENTITY_CHANGED_BUILDING |
  ENTITY_CHANGED_FACTORY;

function typedEntityWireRowId(
  source: EntitySnapshotWireSource,
  entityIndex: number,
): EntityId | null {
  const rowIndex = source.rowIndices[entityIndex];
  if (rowIndex < 0) return null;
  switch (source.kinds[entityIndex]) {
    case ENTITY_SNAPSHOT_WIRE_KIND_BASIC:
      return source.basicRows.values[rowIndex * ENTITY_SNAPSHOT_WIRE_BASIC_STRIDE] as EntityId;
    case ENTITY_SNAPSHOT_WIRE_KIND_UNIT:
      return source.unitRows.values[rowIndex * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE] as EntityId;
    case ENTITY_SNAPSHOT_WIRE_KIND_BUILDING:
      return source.buildingRows.values[rowIndex * ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE] as EntityId;
    default:
      return null;
  }
}

function typedEntityWireRowIsFull(
  source: EntitySnapshotWireSource,
  entityIndex: number,
): boolean {
  const rowIndex = source.rowIndices[entityIndex];
  if (rowIndex < 0) return false;
  switch (source.kinds[entityIndex]) {
    case ENTITY_SNAPSHOT_WIRE_KIND_UNIT: {
      if (rowIndex >= source.unitRows.count) return false;
      const base = rowIndex * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
      const values = source.unitRows.values;
      return values[base + 6] === 0 && (values[base + 7] | 0) === 0;
    }
    case ENTITY_SNAPSHOT_WIRE_KIND_BUILDING: {
      if (rowIndex >= source.buildingRows.count) return false;
      const base = rowIndex * ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE;
      const values = source.buildingRows.values;
      return values[base + 6] === 0 && (values[base + 7] | 0) === 0;
    }
    default:
      return false;
  }
}

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

type ClientSnapshotApplyStats = {
  correction: ClientPredictionCorrectionStats;
};

type ClientSnapshotApplyOptions = {
  syncEconomy: boolean | undefined;
  collectCorrectionStats?: boolean | undefined;
  collectMaterializationStages?: boolean | undefined;
  deferPredictedTurretRenderRefresh?: boolean | undefined;
};

function recordClientApplySubstage(
  state: NetworkServerSnapshot,
  enabled: boolean,
  stage: SnapshotMaterializationStage,
  startedAt: number,
): number {
  if (!enabled) return startedAt;
  const now = performance.now();
  addSnapshotMaterializationStageToSnapshot(state, stage, now - startedAt);
  return now;
}

export class ClientViewStateBase {
  // Entity storage for rendering (client-predicted positions)
  protected entities = new ClientEntityStore();

  // Server target state — owned copies of drift-relevant fields per entity
  protected serverTargets = new ClientServerTargetStore();
  protected projectileStore!: ClientProjectileStore;
  protected readonly directProjectileSpawnScratch = createSpawnDto();

  protected sprayTargetStore = new ClientSprayTargetStore();
  protected resourcePylonSignedRates = new IndexedEntityIdMap<ClientResourcePylonSignedRates>();
  protected resourcePylonFlowsBySource = new IndexedEntityIdMap<ClientResourcePylonFlow[]>();
  protected readonly resourcePylonSourceIds: EntityId[] = [];
  // Free lists for the per-snapshot rate/flow-entry objects. Consumers
  // (BuildingResourcePylonAnimator3D and work-spray rendering) read
  // these synchronously within a frame and never retain entries across
  // snapshot applies, so recycling on clear is safe.
  protected readonly resourcePylonRatePool: ClientResourcePylonSignedRates[] = [];
  protected readonly resourcePylonFlowPool: ClientResourcePylonFlow[] = [];

  // Audio events from last state update
  protected pendingAudioEvents: NetworkServerSnapshot['audioEvents'] = [];

  /** Active temporary vision pulses (FOW-14) the server has confirmed
   *  for this client's team. Mirror of WorldState.scanPulses filtered
   *  through SnapshotVisibility. Snapshot applier overwrites this on
   *  each snapshot; expired entries are pruned authoritatively before
   *  the snapshot is built so the client never needs to drop them. */
  protected scanPulses: NonNullable<NetworkServerSnapshot['scanPulses']> = [];

  protected minimapOverrideStore = new ClientMinimapOverrideStore({
    isSelected: (id) => this.selectionState.has(id),
  });

  // Game over state
  protected gameOverWinnerId: PlayerId | null = null;
  /** Last authoritative game phase from snapshot gameState
   *  ('init' until the first snapshot carrying one arrives). */
  protected gamePhase: GamePhase = 'init';

  // Current tick from host
  protected currentTick: number = 0;

  // Reusable Set for full-state membership reconciliation.
  protected _serverIds: Set<EntityId> = new ClientEntityIdSet();
  protected readonly _fullReconcileRemoveIds: EntityId[] = [];
  protected _projectileReflectionIds: Set<EntityId> = new ClientEntityIdSet();
  protected readonly typedFullCreationScratch: Entity[] = [];
  protected readonly typedFullCreationIds: Set<EntityId> = new ClientEntityIdSet();

  protected terrainBuildabilityGrid: TerrainBuildabilityGrid | null = null;

  // Server metadata from latest snapshot
  protected serverMeta: NetworkServerSnapshotMeta | null = null;
  protected visionPlayerMask = 0;
  protected readonly visionPlayerIds: PlayerId[] = [];

  // === CACHED ENTITY ARRAYS (PERFORMANCE CRITICAL) ===
  protected cache = new EntityCacheManager();
  protected renderSpatialIndex = new ClientRenderSpatialIndex();
  protected renderEntityState = new ClientRenderEntityStateSlab();
  protected renderTurretState = new ClientRenderTurretStateSlab();
  protected readonly scopedRenderIncludedIds = new IndexedEntityIdSet();
  protected readonly scopedRenderUnitSlots: number[] = [];
  protected readonly scopedRenderBuildingSlots: number[] = [];
  protected readonly scopedRenderUnitRowSlots: number[] = [];
  protected readonly scopedRenderBuildingRowSlots: number[] = [];
  protected entitySetVersion = 0;

  protected activeEntityPredictionIds: Set<EntityId> = new ClientEntityIdSet();
  protected dirtyUnitRenderIds: Set<EntityId> = new ClientEntityIdSet();
  protected dirtyBuildingRenderIds: Set<EntityId> = new ClientEntityIdSet();
  protected removedUnitRenderIds: EntityId[] = [];
  protected removedBuildingRenderIds: EntityId[] = [];
  protected renderLifecycleDirtyIds: Set<EntityId> = new ClientEntityIdSet();
  protected locomotionSupportSurfaceEntities: Entity[] = [];
  protected locomotionSupportSurfaceEntityIds = new IndexedEntityIdSet();
  protected selectionState = new ClientSelectionState(
    this.entities,
    this.dirtyUnitRenderIds,
    this.dirtyBuildingRenderIds,
    (entity) => this.markEntityPredictionActive(entity),
  );
  protected supplementalPresentation!: ClientSupplementalPresentation;
  protected readonly lockstepPresentation = new ClientLockstepPresentation();
  protected lockstepPresentationEnabled = false;

  // Map dimensions — needed to evaluate the installed server-authored
  // terrain tile map on the client side. Before the first terrain
  // snapshot arrives, clients fall back to the deterministic authored
  // height function using these same dimensions.
  protected mapWidth: number = 2000;
  protected mapHeight: number = 2000;

  constructor() {
    this.projectileStore = new ClientProjectileStore({
      entities: this.entities,
      handleEntityAdded: (entity) => this.handleLocalEntityAdded(entity),
    });
    this.supplementalPresentation = new ClientSupplementalPresentation({
      entities: this.entities,
      beamPathTargets: this.projectileStore.beamPathTargets,
      projectileSpawns: this.projectileStore.projectileSpawns,
      activeBeamPathIds: this.projectileStore.activeBeamPathIds,
      applyProjectileSpawn: (spawn) => this.projectileStore.applySpawn(spawn),
    });
  }

  /** Plumb in the map dimensions so client-side projectile dead-
   *  reckoning can evaluate the same terrain heightmap the server
   *  uses. Call once after constructing. */
  setMapDimensions(mapWidth: number, mapHeight: number): void {
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
  }

  setLockstepPresentationEnabled(enabled: boolean): void {
    this.lockstepPresentationEnabled = enabled;
    if (!enabled) this.lockstepPresentation.reset();
  }

  noteLockstepPresentationFrame(event: PresentationFrameEvent): void {
    if (!this.lockstepPresentationEnabled) return;
    this.currentTick = event.tick;
    this.lockstepPresentation.noteFixedTick(event.tick, event.capturedAtMs);
  }

  /** Read map dimensions for renderers / overlays that need to sample
   *  the deterministic terrain heightmap. */
  getMapWidth(): number { return this.mapWidth; }
  getMapHeight(): number { return this.mapHeight; }

  protected invalidateCaches(): void {
    this.cache.invalidate();
  }

  protected handleLocalEntityAdded(entity: Entity, deferEntitySetChange = false): void {
    this.cache.handleEntityAdded(entity);
    if (!deferEntitySetChange) this.entitySetVersion++;
  }

  protected attachCreatedNetworkEntity(entity: Entity, deferEntitySetChange = false): void {
    if (entity.selectable && this.selectionState.has(entity.id)) {
      entity.selectable.selected = true;
    }
    this.entities.set(entity.id, entity);
    this.handleLocalEntityAdded(entity, deferEntitySetChange);
    this.refreshRenderableEntityStateAndSpatialIndex(entity);
    this.markEntityPredictionActive(entity);
    this.refreshLocomotionSupportSurfaceProvider(entity);
    this.renderLifecycleDirtyIds.add(entity.id);
  }

  protected handleLocalEntityRemoved(entity: Entity, deferEntitySetChange: boolean): void {
    this.cache.handleEntityRemoved(entity);
    if (!deferEntitySetChange) this.entitySetVersion++;
  }

  protected addLocomotionSupportSurfaceProvider(entity: Entity): void {
    if (this.locomotionSupportSurfaceEntityIds.has(entity.id)) return;
    this.locomotionSupportSurfaceEntityIds.add(entity.id);
    this.locomotionSupportSurfaceEntities.push(entity);
  }

  protected removeLocomotionSupportSurfaceProvider(id: EntityId): void {
    if (!this.locomotionSupportSurfaceEntityIds.delete(id)) return;
    const providers = this.locomotionSupportSurfaceEntities;
    for (let i = 0; i < providers.length; i++) {
      if (providers[i].id !== id) continue;
      const last = providers.pop();
      if (last !== undefined && i < providers.length) providers[i] = last;
      return;
    }
  }

  protected refreshLocomotionSupportSurfaceProvider(entity: Entity): void {
    if (isLocomotionSupportSurfaceProvider(entity)) {
      this.addLocomotionSupportSurfaceProvider(entity);
    } else {
      this.removeLocomotionSupportSurfaceProvider(entity.id);
    }
  }

  protected getOrCreateServerTarget(id: EntityId): ServerTarget {
    return this.serverTargets.getOrCreate(id);
  }

  protected collectProjectileReflectionIds(
    events: NetworkServerSnapshot['audioEvents'],
  ): Set<EntityId> | null {
    const ids = this._projectileReflectionIds;
    ids.clear();
    if (events === undefined || events === null || events.length === 0) return null;
    for (let i = 0; i < events.length; i++) {
      const evt = events[i];
      if (evt.type === 'shieldImpact' && evt.entityId !== null) {
        ids.add(evt.entityId);
      }
    }
    return ids.size > 0 ? ids : null;
  }

  protected writeProjectileMotionTarget(
    id: EntityId,
    x: number,
    y: number,
    z: number,
    velocityX: number,
    velocityY: number,
    velocityZ: number,
    rotation: number,
    angularVelocity: number,
    now: number,
  ): void {
    const target = this.getOrCreateServerTarget(id);
    target.x = x;
    target.y = y;
    target.z = z;
    target.rotation = rotation;
    target.velocityX = velocityX;
    target.velocityY = velocityY;
    target.velocityZ = velocityZ;
    target.surfaceNormalX = 0;
    target.surfaceNormalY = 0;
    target.surfaceNormalZ = 1;
    target.supportPointOffsetZ = 0;
    target.predictedGroundContact = false;
    target.orientation = null;
    target.angularVelocityX = null;
    target.angularVelocityY = null;
    target.angularVelocityZ = angularVelocity;
    resizeServerTargetTurrets(target, 0);
    target.updatedAtMs = now;
  }

  protected applyProjectileMotionUpdateFields(
    id: EntityId,
    qposX: number,
    qposY: number,
    qposZ: number,
    qvelX: number,
    qvelY: number,
    qvelZ: number,
    qrotation: number,
    qangularVelocity: number,
    now: number,
  ): void {
    const entity = this.entities.get(id);
    if (entity === undefined || entity.projectile === null) return;

    const x = deqProjPos(qposX);
    const y = deqProjPos(qposY);
    const z = deqProjPos(qposZ);
    const velocityX = deqVel(qvelX);
    const velocityY = deqVel(qvelY);
    const velocityZ = deqVel(qvelZ);
    this.writeProjectileMotionTarget(
      id,
      x,
      y,
      z,
      velocityX,
      velocityY,
      velocityZ,
      deqRot(qrotation),
      deqRot(qangularVelocity),
      now,
    );
    this.projectileStore.markMotionTargetUpdateActive(entity, id);
    if (!this.lockstepPresentationEnabled) {
      // Only ClientLockstepPresentation consumes projectile motion TARGETS and
      // then refreshes the render spatial slot from the pose it wrote. On the
      // authoritative-snapshot path nothing ever drains them, so without this
      // the shot stays frozen at its spawn point and the render index keeps
      // culling it against a stale position. There, the snapshot row IS the
      // pose, so materialize it directly.
      entity.transform.x = x;
      entity.transform.y = y;
      entity.transform.z = z;
      entity.transform.rotation = deqRot(qrotation);
      const projectile = entity.projectile;
      if (projectile !== null) {
        projectile.velocityX = velocityX;
        projectile.velocityY = velocityY;
        projectile.velocityZ = velocityZ;
      }
      this.projectileStore.updateRenderSpatialIndex(entity);
    }
  }

  protected applyProjectileWireSourceDespawns(
    source: ProjectileSnapshotWireSource | undefined,
  ): boolean {
    if (source === undefined) return false;
    const rows = source.despawns;
    if (rows.count === 0) return false;
    const values = rows.values;
    for (let i = 0; i < rows.count; i++) {
      this.deleteProjectileLocalState(values[i] as EntityId);
    }
    return true;
  }

  protected applyProjectileWireSourceSpawns(
    source: ProjectileSnapshotWireSource | undefined,
    now: number,
  ): boolean {
    if (source === undefined) return false;
    const rows = source.spawns;
    if (rows.count === 0) return false;
    const values = rows.values;
    const queue = this.projectileStore.projectileSpawns;
    const scratch = this.directProjectileSpawnScratch;
    for (let i = 0; i < rows.count; i++) {
      const base = i * PROJECTILE_SPAWN_WIRE_STRIDE;
      const flags = values[base + 31] | 0;
      const shouldSmooth = projectileSpawnFieldsShouldSmooth(
        values[base + 8],
        values[base + 10],
        (flags & PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_BLUEPRINT_CODE) !== 0
          ? values[base + 12]
          : null,
        (flags & PROJECTILE_SPAWN_FLAG_FROM_PARENT_TRUE) !== 0,
      );
      if (shouldSmooth) {
        if (copyProjectileWireSourceSpawnRowFromSourceInto(source, i, scratch)) {
          queue.enqueue(scratch, now);
        }
        continue;
      }
      this.projectileStore.applySpawnWireFields(values, base);
    }
    return true;
  }

  protected applyProjectileWireSourceMotionUpdates(
    source: ProjectileSnapshotWireSource | undefined,
    now: number,
  ): boolean {
    if (source === undefined) return false;
    const rows = source.motionUpdates;
    if (rows.count === 0) return false;
    const values = rows.values;
    for (let i = 0; i < rows.count; i++) {
      const base = i * PROJECTILE_MOTION_WIRE_STRIDE;
      this.applyProjectileMotionUpdateFields(
        values[base + 0] as EntityId,
        values[base + 1],
        values[base + 2],
        values[base + 3],
        values[base + 4],
        values[base + 5],
        values[base + 6],
        values[base + 7],
        values[base + 8],
        now,
      );
    }
    return true;
  }

  protected applyProjectileWireSourceBeamUpdates(
    source: ProjectileSnapshotWireSource | undefined,
    now: number,
  ): boolean {
    return forEachProjectileWireSourceBeamUpdateFieldsFromSource(
      source,
      (id, obstructionT, endpointDamageable, pointValues, pointOffset, pointCount) => {
      this.projectileStore.applyBeamUpdateWireFields(
        id as EntityId,
        obstructionT,
        endpointDamageable,
        pointValues,
        pointOffset,
        pointCount,
        now,
      );
      },
    );
  }

  protected copyNetworkTurretsToTarget(
    target: ServerTarget,
    turrets:
      | NonNullable<NetworkServerSnapshotEntity['unit']>['turrets']
      | NonNullable<NetworkServerSnapshotEntity['building']>['turrets'],
    isFull: boolean,
  ): boolean {
    if (turrets) {
      resizeServerTargetTurrets(target, turrets.length);
      for (let i = 0; i < turrets.length; i++) {
        const wireAng = turrets[i].turret.angular;
        target.turrets[i].rotation = deqRot(wireAng.rot);
        target.turrets[i].angularVelocity = deqRot(wireAng.vel);
        target.turrets[i].pitch = deqRot(wireAng.pitch);
        target.turrets[i].pitchVelocity = deqRot(wireAng.pitchVel);
        target.turrets[i].hostPieceYaw = deqRot(wireAng.hostYaw ?? wireAng.rot);
        target.turrets[i].hostPieceYawVelocity = deqRot(wireAng.hostYawVel ?? 0);
        target.turrets[i].shieldRange = turrets[i].currentShieldRange ?? null;
      }
      return true;
    }
    if (isFull) resizeServerTargetTurrets(target, 0);
    return false;
  }

  protected copyWireUnitTurretsToTarget(
    source: EntitySnapshotWireSource,
    offset: number,
    count: number,
    target: ServerTarget,
    entity: Entity,
  ): boolean {
    if (count <= 0) return false;
    if (offset < 0 || offset + count > source.turretRows.count) return false;
    resizeServerTargetTurrets(target, count);
    const rows = source.turretRows.values;
    const combat = entity.combat;
    const entityTurrets = combat?.turrets;
    const entityTurretLimit = entityTurrets !== undefined
      ? Math.min(count, entityTurrets.length)
      : 0;
    for (let i = 0; i < count; i++) {
      const rowBase = (offset + i) * ENTITY_SNAPSHOT_WIRE_TURRET_STRIDE;
      const targetTurret = target.turrets[i];
      targetTurret.rotation = deqRot(rows[rowBase + 0]);
      targetTurret.angularVelocity = deqRot(rows[rowBase + 1]);
      targetTurret.pitch = deqRot(rows[rowBase + 2]);
      targetTurret.pitchVelocity = deqRot(rows[rowBase + 3]);
      targetTurret.hostPieceYaw = deqRot(rows[rowBase + 11]);
      targetTurret.hostPieceYawVelocity = deqRot(rows[rowBase + 12]);
      const shieldRange = rows[rowBase + 8] !== 0 ? rows[rowBase + 9] : null;
      targetTurret.shieldRange = shieldRange;
      if (i >= entityTurretLimit || entityTurrets === undefined) continue;
      const entityTurret = entityTurrets[i];
      entityTurret.hostPieceYaw = targetTurret.hostPieceYaw;
      entityTurret.hostPieceYawVelocity = targetTurret.hostPieceYawVelocity;
      if (rows[rowBase + 10] !== 0) {
        entityTurret.target = null;
        entityTurret.state = 'idle';
        entityTurret.shield = null;
        continue;
      }
      entityTurret.target = rows[rowBase + 6] !== 0 ? (rows[rowBase + 7] | 0) as EntityId : null;
      entityTurret.state = codeToTurretState(rows[rowBase + 5]);
      if (entityTurret.config.shot?.type === 'shield') {
        // Shield range is visible physical state. ShieldRenderPacket3D reads
        // the render entity, so it cannot remain only on the server target.
        entityTurret.shield = shieldRange === null
          ? null
          : {
            range: shieldRange,
            transition: shieldRange,
            onTimeMs: shieldRange > 0 ? entityTurret.shield?.onTimeMs ?? 0 : 0,
          };
      }
    }
    return true;
  }

  protected deleteEntityLocalState(id: EntityId, deferEntitySetChange = false): boolean {
    const existing = this.entities.get(id);
    const wasLineProjectile = existing ? isLineProjectileEntity(existing) : false;
    if (existing !== undefined) {
      if (existing.unit !== null) {
        this.removedUnitRenderIds.push(id);
      } else if (existing.building !== null) {
        this.removedBuildingRenderIds.push(id);
      }
    }
    this.removeLocomotionSupportSurfaceProvider(id);
    this.projectileStore.remove(id, wasLineProjectile, existing);
    this.entities.delete(id);
    this.serverTargets.delete(id);
    this.renderSpatialIndex.remove(id);
    const renderSlot = this.renderEntityState.getSlot(id);
    if (renderSlot !== undefined) this.renderTurretState.unsetHostSlot(renderSlot);
    this.renderEntityState.unsetEntity(id);
    this.selectionState.delete(id);
    this.activeEntityPredictionIds.delete(id);
    this.dirtyUnitRenderIds.delete(id);
    this.dirtyBuildingRenderIds.delete(id);
    this.renderLifecycleDirtyIds.delete(id);
    if (existing !== undefined) {
      this.handleLocalEntityRemoved(existing, deferEntitySetChange);
      return true;
    }
    return false;
  }

  protected deleteProjectileLocalState(id: EntityId): boolean {
    const existing = this.entities.get(id);
    if (existing !== undefined && existing.projectile === null) {
      return this.deleteEntityLocalState(id);
    }
    const wasLineProjectile = existing !== undefined && isLineProjectileEntity(existing);
    this.projectileStore.remove(id, wasLineProjectile, existing);
    this.entities.delete(id);
    this.serverTargets.delete(id);
    this.selectionState.delete(id);
    if (existing !== undefined) {
      this.handleLocalEntityRemoved(existing, false);
      return true;
    }
    return false;
  }

  protected markSnapshotRemovalsApplied(changed: boolean): void {
    if (changed) this.entitySetVersion++;
  }

  protected markEntityPredictionActive(entity: Entity): void {
    if (entity.unit) {
      this.activeEntityPredictionIds.add(entity.id);
      this.dirtyUnitRenderIds.add(entity.id);
    } else if (entity.building && entity.combat !== null && entity.combat.turrets.length > 0) {
      this.activeEntityPredictionIds.add(entity.id);
    } else if (entity.projectile && !isLineProjectileEntity(entity)) {
      this.projectileStore.activeProjectileMotionIds.add(entity.id);
    }
  }

  protected markNetworkEntityPredictionActive(server: NetworkServerSnapshotEntity): void {
    const cf = server.changedFields;
    if (server.type === 'building') {
      // Every static host uses the building turret-prediction path.
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
      cf == null ||
      (cf & (
        ENTITY_CHANGED_POS |
        ENTITY_CHANGED_ROT |
        ENTITY_CHANGED_VEL |
        // Refresh render state when only the host-authored surface normal
        // moved, including while its ground-contact filter is settling.
        ENTITY_CHANGED_NORMAL
      )) !== 0 ||
      (server.unit !== null && Array.isArray(server.unit.turrets))
    ) {
      this.activeEntityPredictionIds.add(server.id);
      this.dirtyUnitRenderIds.add(server.id);
    }
  }

  /** Return the pooled rate/flow-entry objects to their free lists and
   *  empty the per-snapshot resource-pylon maps. */
  protected clearResourcePylonFlows(): void {
    for (const rates of this.resourcePylonSignedRates.values()) {
      this.resourcePylonRatePool.push(rates);
    }
    for (const flows of this.resourcePylonFlowsBySource.values()) {
      for (let i = 0; i < flows.length; i++) {
        this.resourcePylonFlowPool.push(flows[i]);
      }
    }
    this.resourcePylonSignedRates.clear();
    this.resourcePylonFlowsBySource.clear();
    this.resourcePylonSourceIds.length = 0;
  }

  protected applyResourceMovements(
    movements: readonly NetworkServerSnapshotResourceMovement[] | undefined,
  ): void {
    this.clearResourcePylonFlows();
    if (movements === undefined) return;
    for (let i = 0; i < movements.length; i++) {
      const movement = movements[i];
      const amount = movement.direction === RESOURCE_FLOW_OUTBOUND
        ? movement.amountPerSecond
        : -movement.amountPerSecond;
      if (amount === 0 || !Number.isFinite(amount)) continue;
      let rates = this.resourcePylonSignedRates.get(movement.sourceEntityId);
      if (rates === undefined) {
        rates = this.resourcePylonRatePool.pop();
        if (rates === undefined) {
          rates = { energy: 0, metal: 0 };
        } else {
          rates.energy = 0;
          rates.metal = 0;
        }
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
      const flow = this.resourcePylonFlowPool.pop();
      if (flow === undefined) {
        flows.push({
          targetEntityId: movement.targetEntityId,
          resource: movement.resource,
          amountPerSecond: movement.amountPerSecond,
          direction: movement.direction,
        });
      } else {
        flow.targetEntityId = movement.targetEntityId;
        flow.resource = movement.resource;
        flow.amountPerSecond = movement.amountPerSecond;
        flow.direction = movement.direction;
        flows.push(flow);
      }
    }
  }

  protected snapshotChangesOwnership(
    entity: Entity,
    server: NetworkServerSnapshotEntity,
  ): boolean {
    // Ownership transfer (capture) moves the entity between per-player
    // cache buckets, so it still needs a full cache rebuild.
    return entity.ownership !== null && entity.ownership.playerId !== server.playerId;
  }

  protected snapshotMayAffectHealthBarCacheMembership(
    entity: Entity,
    server: NetworkServerSnapshotEntity,
  ): boolean {
    const cf = server.changedFields;
    return (entity.unit !== null || entity.building !== null) &&
      (cf == null || (cf & (ENTITY_CHANGED_HP | ENTITY_CHANGED_BUILDING)) !== 0);
  }

  protected healthBarCacheMembership(entity: Entity): boolean {
    if (entity.unit !== null) return this.unitHealthBarCacheMembership(entity);
    if (entity.building !== null) return this.buildingHealthBarCacheMembership(entity);
    return false;
  }

  protected snapshotAffectsRenderSpatialIndex(server: NetworkServerSnapshotEntity): boolean {
    const changedFields = server.changedFields;
    return changedFields == null || (changedFields & ENTITY_CHANGED_POS) !== 0;
  }

  protected snapshotIsUnitMotionOnly(
    entity: Entity,
    server: NetworkServerSnapshotEntity,
  ): boolean {
    if (server.type !== 'unit' || entity.unit === null) return false;
    const changedFields = server.changedFields;
    if (changedFields == null || changedFields === 0) return false;
    if ((changedFields & ~CLIENT_UNIT_MOTION_DELTA_FIELDS) !== 0) return false;
    return entity.ownership !== null && entity.ownership.playerId === server.playerId;
  }

  protected renderSlotMatchesSnapshotOwner(
    id: EntityId,
    playerId: PlayerId,
    expectedKind: number,
  ): boolean {
    const slot = this.renderEntityState.getSlot(id);
    if (slot === undefined) return false;
    const views = this.renderEntityState.getViews();
    return views.kind[slot] === expectedKind && views.ownerIds[slot] === playerId;
  }

  protected canApplyBasicTransformTypedDeltaWireRow(
    source: EntitySnapshotWireSource,
    entityIndex: number,
  ): boolean {
    const rowIndex = source.rowIndices[entityIndex];
    if (rowIndex < 0 || rowIndex >= source.basicRows.count) return false;
    const values = source.basicRows.values;
    const base = rowIndex * ENTITY_SNAPSHOT_WIRE_BASIC_STRIDE;
    const changedFields = values[base + 8] | 0;
    if (values[base + 7] === 0 || changedFields === 0) return false;
    if ((changedFields & ~CLIENT_BASIC_TRANSFORM_DELTA_FIELDS) !== 0) return false;
    if ((changedFields & CLIENT_BASIC_TRANSFORM_DELTA_FIELDS) === 0) return false;

    const id = values[base + 0] | 0;
    const typeCode = values[base + 1] | 0;
    const playerId = values[base + 6] | 0;
    if (
      typeCode === ENTITY_SNAPSHOT_WIRE_TYPE_UNIT &&
      this.renderSlotMatchesSnapshotOwner(id as EntityId, playerId as PlayerId, CLIENT_RENDER_ENTITY_KIND_UNIT)
    ) {
      return true;
    }
    if (
      typeCode === ENTITY_SNAPSHOT_WIRE_TYPE_BUILDING &&
      this.renderSlotMatchesSnapshotOwner(id as EntityId, playerId as PlayerId, CLIENT_RENDER_ENTITY_KIND_BUILDING)
    ) {
      return true;
    }
    const existing = this.entities.get(id);
    if (existing === undefined) return false;
    const ownership = existing.ownership;
    if (ownership === null || ownership.playerId !== playerId) return false;
    if (typeCode === ENTITY_SNAPSHOT_WIRE_TYPE_UNIT) return existing.unit !== null;
    if (typeCode === ENTITY_SNAPSHOT_WIRE_TYPE_BUILDING) return existing.building !== null;
    return false;
  }

  protected applyBasicTransformTypedDeltaWireRow(
    values: Float64Array,
    base: number,
    changedFields: number,
    now: number,
  ): boolean {
    if ((changedFields & ~CLIENT_BASIC_TRANSFORM_DELTA_FIELDS) !== 0) return false;
    const hasPos = (changedFields & ENTITY_CHANGED_POS) !== 0;
    const hasRot = (changedFields & ENTITY_CHANGED_ROT) !== 0;
    if (!hasPos && !hasRot) return false;

    const id = values[base + 0] | 0;
    const typeCode = values[base + 1] | 0;
    const playerId = values[base + 6] | 0;

    if (typeCode === ENTITY_SNAPSHOT_WIRE_TYPE_UNIT) {
      if (
        !this.renderSlotMatchesSnapshotOwner(id as EntityId, playerId as PlayerId, CLIENT_RENDER_ENTITY_KIND_UNIT)
      ) {
        const existing = this.entities.get(id);
        if (existing === undefined || existing.unit === null) return false;
        const ownership = existing.ownership;
        if (ownership === null || ownership.playerId !== playerId) return false;
      }
      const target = this.getOrCreateServerTarget(id);
      if (hasPos) {
        target.x = deqEntityPos(values[base + 2]);
        target.y = deqEntityPos(values[base + 3]);
        target.z = deqEntityPos(values[base + 4]);
      }
      if (hasRot) target.rotation = deqRot(values[base + 5]);
      target.updatedAtMs = now;
      this.activeEntityPredictionIds.add(id);
      return true;
    }

    const existing = this.entities.get(id);
    if (existing === undefined) return false;
    const ownership = existing.ownership;
    if (ownership === null || ownership.playerId !== playerId) return false;
    if (typeCode !== ENTITY_SNAPSHOT_WIRE_TYPE_BUILDING || existing.building === null) {
      return false;
    }
    if (hasPos) {
      existing.transform.x = deqEntityPos(values[base + 2]);
      existing.transform.y = deqEntityPos(values[base + 3]);
      existing.transform.z = deqEntityPos(values[base + 4]);
    }
    if (hasRot) existing.transform.rotation = deqRot(values[base + 5]);
    this.refreshRenderableEntityStateFromSnapshot(existing, hasPos);
    this.dirtyBuildingRenderIds.add(id);
    return true;
  }

  protected tryApplyBasicTypedDeltaWireRow(
    source: EntitySnapshotWireSource,
    entityIndex: number,
    now: number,
    collectCorrectionStats: boolean,
    applyStats: ClientSnapshotApplyStats,
  ): boolean {
    const rowIndex = source.rowIndices[entityIndex];
    if (rowIndex < 0 || rowIndex >= source.basicRows.count) return false;
    const values = source.basicRows.values;
    const base = rowIndex * ENTITY_SNAPSHOT_WIRE_BASIC_STRIDE;
    const changedFields = values[base + 8] | 0;
    if (values[base + 7] === 0 || changedFields === 0) return false;
    if ((changedFields & ~CLIENT_BASIC_TRANSFORM_DELTA_FIELDS) !== 0) return false;
    if (!collectCorrectionStats) {
      return this.applyBasicTransformTypedDeltaWireRow(values, base, changedFields, now);
    }

    const id = values[base + 0] | 0;
    const existing = this.entities.get(id);
    if (existing === undefined) return false;
    const playerId = values[base + 6] | 0;
    const ownership = existing.ownership;
    if (ownership === null || ownership.playerId !== playerId) return false;

    const hasPos = (changedFields & ENTITY_CHANGED_POS) !== 0;
    const hasRot = (changedFields & ENTITY_CHANGED_ROT) !== 0;
    if (!hasPos && !hasRot) return false;

    const typeCode = values[base + 1] | 0;
    if (typeCode === ENTITY_SNAPSHOT_WIRE_TYPE_UNIT) {
      if (existing.unit === null) return false;
      const previousTarget = collectCorrectionStats && hasPos
        ? this.serverTargets.get(id)
        : undefined;
      const previousTargetAgeMs =
        previousTarget !== undefined && previousTarget.updatedAtMs
          ? Math.max(0, now - previousTarget.updatedAtMs)
          : 0;
      const target = this.getOrCreateServerTarget(id);
      if (hasPos) {
        const x = deqEntityPos(values[base + 2]);
        const y = deqEntityPos(values[base + 3]);
        const z = deqEntityPos(values[base + 4]);
        target.x = x;
        target.y = y;
        target.z = z;
        if (collectCorrectionStats) {
          recordSnapshotCorrectionStats(
            applyStats,
            existing.transform.x - x,
            existing.transform.y - y,
            existing.transform.z - z,
            previousTargetAgeMs,
          );
        }
      }
      if (hasRot) target.rotation = deqRot(values[base + 5]);
      target.updatedAtMs = now;
      this.activeEntityPredictionIds.add(id);
      return true;
    }

    if (typeCode !== ENTITY_SNAPSHOT_WIRE_TYPE_BUILDING || existing.building === null) {
      return false;
    }
    if (hasPos) {
      existing.transform.x = deqEntityPos(values[base + 2]);
      existing.transform.y = deqEntityPos(values[base + 3]);
      existing.transform.z = deqEntityPos(values[base + 4]);
    }
    if (hasRot) existing.transform.rotation = deqRot(values[base + 5]);
    this.refreshRenderableEntityStateFromSnapshot(existing, hasPos);
    this.dirtyBuildingRenderIds.add(id);
    return true;
  }

  protected canApplyBasicTransformTypedDeltaSource(
    source: EntitySnapshotWireSource,
    entities: readonly (NetworkServerSnapshotEntity | undefined)[],
  ): boolean {
    const count = source.count;
    if (count === 0 || count !== entities.length) return false;
    if (
      source.basicRows.count !== count ||
      source.unitRows.count !== 0 ||
      source.buildingRows.count !== 0 ||
      source.actionRows.count !== 0 ||
      source.turretRows.count !== 0 ||
      source.factorySelectedUnitRows.count !== 0 ||
      source.waypointRows.count !== 0
    ) {
      return false;
    }
    for (let entityIndex = 0; entityIndex < count; entityIndex++) {
      if (entities[entityIndex] !== undefined) return false;
      if (source.kinds[entityIndex] !== ENTITY_SNAPSHOT_WIRE_KIND_BASIC) return false;
      if (!this.canApplyBasicTransformTypedDeltaWireRow(source, entityIndex)) return false;
    }
    return true;
  }

  protected applyBasicTransformTypedDeltaSource(
    source: EntitySnapshotWireSource,
    now: number,
  ): void {
    const values = source.basicRows.values;
    for (let entityIndex = 0; entityIndex < source.count; entityIndex++) {
      const base = source.rowIndices[entityIndex] * ENTITY_SNAPSHOT_WIRE_BASIC_STRIDE;
      this.applyBasicTransformTypedDeltaWireRow(
        values,
        base,
        values[base + 8] | 0,
        now,
      );
    }
  }

  protected tryApplyUnitTypedDeltaWireRow(
    source: EntitySnapshotWireSource,
    entityIndex: number,
    now: number,
    collectCorrectionStats: boolean,
    deferPredictedTurretRenderRefresh: boolean,
    applyStats: ClientSnapshotApplyStats,
  ): boolean {
    const rowIndex = source.rowIndices[entityIndex];
    return this.tryApplyUnitTypedDeltaWireRowAt(
      source,
      rowIndex,
      now,
      collectCorrectionStats,
      deferPredictedTurretRenderRefresh,
      applyStats,
    );
  }

  protected tryApplyUnitTypedDeltaWireRowAt(
    source: EntitySnapshotWireSource,
    rowIndex: number,
    now: number,
    collectCorrectionStats: boolean,
    deferPredictedTurretRenderRefresh: boolean,
    applyStats: ClientSnapshotApplyStats,
  ): boolean {
    if (rowIndex < 0 || rowIndex >= source.unitRows.count) return false;
    const values = source.unitRows.values;
    const base = rowIndex * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
    const changedFields = values[base + 7] | 0;
    if (values[base + 6] === 0 || changedFields === 0) return false;
    if ((changedFields & ~CLIENT_UNIT_TYPED_DELTA_FIELDS) !== 0) return false;
    if (
      !collectCorrectionStats &&
      (changedFields & ~CLIENT_UNIT_HOT_MOTION_DELTA_FIELDS) === 0
    ) {
      return this.tryApplyUnitHotMotionTypedDeltaWireRow(
        values,
        base,
        changedFields,
        now,
      );
    }
    const hasMotionFields = (changedFields & CLIENT_UNIT_MOTION_DELTA_FIELDS) !== 0;
    const hasHpFields = (changedFields & ENTITY_CHANGED_HP) !== 0;
    const hasTurretFields = (changedFields & ENTITY_CHANGED_TURRETS) !== 0;
    const hasBuildFields = (changedFields & ENTITY_CHANGED_BUILDING) !== 0;
    const hasActionFields = (changedFields & ENTITY_CHANGED_ACTIONS) !== 0;
    const hasFactoryFields = (changedFields & ENTITY_CHANGED_FACTORY) !== 0;
    if (!hasMotionFields && !hasHpFields && !hasTurretFields && !hasBuildFields && !hasActionFields && !hasFactoryFields) {
      return false;
    }

    const id = values[base + 0] | 0;
    const playerId = values[base + 5] | 0;
    const existing = this.entities.get(id);
    if (existing === undefined || existing.unit === null) return false;
    const ownership = existing.ownership;
    if (ownership === null || ownership.playerId !== playerId) return false;

    const needsServerTarget = hasMotionFields || hasTurretFields;
    const previousTarget = collectCorrectionStats && needsServerTarget
      ? this.serverTargets.get(id)
      : undefined;
    const previousTargetAgeMs =
      previousTarget !== undefined && previousTarget.updatedAtMs
        ? Math.max(0, now - previousTarget.updatedAtMs)
        : 0;
    const target = needsServerTarget ? this.getOrCreateServerTarget(id) : undefined;

    if (target !== undefined && (changedFields & ENTITY_CHANGED_POS) !== 0) {
      target.x = deqEntityPos(values[base + 1]);
      target.y = deqEntityPos(values[base + 2]);
      target.z = deqEntityPos(values[base + 3]);
    }
    if (target !== undefined && (changedFields & ENTITY_CHANGED_NORMAL) !== 0 && values[base + 23] !== 0) {
      target.surfaceNormalX = deqNormal(values[base + 24]);
      target.surfaceNormalY = deqNormal(values[base + 25]);
      target.surfaceNormalZ = deqNormal(values[base + 26]);
    }
    if (target !== undefined && (changedFields & ENTITY_CHANGED_ROT) !== 0) {
      target.rotation = deqRot(values[base + 4]);
      if (values[base + 27] !== 0) {
        let orientation = target.orientation;
        if (orientation === null) {
          orientation = { x: 0, y: 0, z: 0, w: 1 };
          target.orientation = orientation;
        }
        orientation.x = values[base + 28];
        orientation.y = values[base + 29];
        orientation.z = values[base + 30];
        orientation.w = values[base + 31];
      } else {
        target.orientation = null;
      }
    }
    if (target !== undefined && (changedFields & ENTITY_CHANGED_VEL) !== 0) {
      target.velocityX = deqVel(values[base + 10]);
      target.velocityY = deqVel(values[base + 11]);
      target.velocityZ = deqVel(values[base + 12]);
      if (values[base + 32] !== 0) {
        target.angularVelocityX = values[base + 33];
        target.angularVelocityY = values[base + 34];
        target.angularVelocityZ = values[base + 35];
      } else {
        target.angularVelocityX = null;
        target.angularVelocityY = null;
        target.angularVelocityZ = null;
      }
    }
    let copiedTurretRows = false;
    if (hasTurretFields && values[base + 43] !== 0) {
      if (target === undefined) return false;
      const turretCount = values[base + 44] | 0;
      const turretOffset = values[base + 49] | 0;
      copiedTurretRows = this.copyWireUnitTurretsToTarget(
        source,
        turretOffset,
        turretCount,
        target,
        existing,
      );
      if (!copiedTurretRows) return false;
    }
    let copiedWorkStation = false;
    if (
      hasTurretFields &&
      values[base + 68] !== 0 &&
      existing.builder?.workStation !== null &&
      existing.builder?.workStation !== undefined
    ) {
      const station = existing.builder.workStation;
      station.localYaw = deqRot(values[base + 69]);
      station.localPitch = deqRot(values[base + 70]);
      station.localYawVelocity = deqRot(values[base + 71]);
      station.localPitchVelocity = deqRot(values[base + 72]);
      station.targetEntityId = values[base + 73] !== 0 ? 0 : NO_ENTITY_ID;
      station.aligned = values[base + 74] !== 0;
      station.targetWorldYaw = deqRot(values[base + 75]);
      station.targetWorldPitch = deqRot(values[base + 76]);
      copiedWorkStation = true;
    }

    if (target !== undefined) target.updatedAtMs = now;
    if (collectCorrectionStats && (changedFields & ENTITY_CHANGED_POS) !== 0) {
      this.recordWireMotionCorrectionStats(
        existing,
        values,
        base,
        changedFields,
        previousTargetAgeMs,
        applyStats,
      );
    }

    const refreshHealth = this.applyUnitHpBuildTypedFields(
      existing,
      values,
      base,
      hasHpFields,
      hasBuildFields,
    );

    if (hasActionFields) {
      if (values[base + 41] !== 0) {
        applyNetworkUnitActionWireRows(
          existing.unit,
          source.actionRows.values,
          values[base + 50] | 0,
          values[base + 42] | 0,
          source.actionStrings,
          ENTITY_SNAPSHOT_WIRE_ACTION_STRIDE,
        );
      }
      if (values[base + 53] !== 0) {
        existing.unit.repeatQueue = values[base + 54] !== 0;
      }
      if (values[base + 59] !== 0) {
        const moveStateCode = values[base + 60] | 0;
        existing.unit.moveState = moveStateCode === 2
          ? 'roam'
          : moveStateCode === 1
            ? 'holdPosition'
            : 'maneuver';
      } else if (values[base + 55] !== 0) {
        existing.unit.moveState = values[base + 56] !== 0 ? 'holdPosition' : 'maneuver';
      }
      if (values[base + 61] !== 0) {
        existing.unit.wantCloak = values[base + 62] >= 1;
        existing.unit.cloaked = values[base + 62] >= 2;
      }
      if (existing.builder !== null) {
        if (values[base + 66] !== 0) {
          existing.builder.lowPriority = values[base + 67] !== 0;
        } else if (values[base + 38] !== 0) {
          existing.builder.lowPriority = false;
        }
        if (values[base + 38] !== 0) {
          existing.builder.currentBuildTarget = values[base + 39] === 0
            ? values[base + 40] as EntityId
            : NO_ENTITY_ID;
        }
      }
    }
    if (hasFactoryFields) {
      if (existing.factory === null || values[base + 64] === 0) return false;
      existing.factory.carrierSpawnEnabled = values[base + 65] !== 0;
    }

    // Shields are required visual state, not optional emissions. Refresh them
    // at the wire update even while prediction defers ordinary turret poses.
    const refreshTurretsNow = copiedTurretRows && (
      !deferPredictedTurretRenderRefresh || entityHasShieldEmission(existing)
    );
    if (refreshHealth || refreshTurretsNow || copiedWorkStation) {
      this.refreshRenderableEntityStateSnapshotDelta(
        existing,
        refreshHealth,
        refreshTurretsNow || copiedWorkStation,
        hasBuildFields,
      );
    }

    if (hasMotionFields || copiedTurretRows || copiedWorkStation) {
      this.activeEntityPredictionIds.add(id);
      this.dirtyUnitRenderIds.add(id);
    }
    return true;
  }

  protected tryApplyUnitTypedFullWireRow(
    source: EntitySnapshotWireSource,
    entityIndex: number,
    now: number,
  ): boolean {
    const rowIndex = source.rowIndices[entityIndex];
    return this.tryApplyUnitTypedFullWireRowAt(source, rowIndex, now);
  }

  protected tryApplyUnitTypedFullWireRowAt(
    source: EntitySnapshotWireSource,
    rowIndex: number,
    now: number,
  ): boolean {
    if (rowIndex < 0 || rowIndex >= source.unitRows.count) return false;
    const values = source.unitRows.values;
    const base = rowIndex * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
    if (values[base + 6] !== 0 || (values[base + 7] | 0) !== 0) return false;
    if (values[base + 13] === 0) return false;

    const id = values[base + 0] | 0;
    const playerId = values[base + 5] | 0;
    const existing = this.entities.get(id);
    if (existing === undefined || existing.unit === null) return false;
    const ownership = existing.ownership;
    if (ownership === null || ownership.playerId !== playerId) return false;

    const unitBlueprintId = codeToUnitBlueprintId(values[base + 14]);
    if (unitBlueprintId === null || unitBlueprintId !== existing.unit.unitBlueprintId) {
      return false;
    }

    const target = this.getOrCreateServerTarget(id);
    target.x = deqEntityPos(values[base + 1]);
    target.y = deqEntityPos(values[base + 2]);
    target.z = deqEntityPos(values[base + 3]);
    target.supportPointOffsetZ = existing.unit.supportPointOffsetZ;
    target.rotation = deqRot(values[base + 4]);
    target.velocityX = deqVel(values[base + 10]);
    target.velocityY = deqVel(values[base + 11]);
    target.velocityZ = deqVel(values[base + 12]);
    if (values[base + 23] !== 0) {
      target.surfaceNormalX = deqNormal(values[base + 24]);
      target.surfaceNormalY = deqNormal(values[base + 25]);
      target.surfaceNormalZ = deqNormal(values[base + 26]);
    }
    if (values[base + 27] !== 0) {
      let orientation = target.orientation;
      if (orientation === null) {
        orientation = { x: 0, y: 0, z: 0, w: 1 };
        target.orientation = orientation;
      }
      orientation.x = values[base + 28];
      orientation.y = values[base + 29];
      orientation.z = values[base + 30];
      orientation.w = values[base + 31];
    } else {
      target.orientation = null;
    }
    if (values[base + 32] !== 0) {
      target.angularVelocityX = values[base + 33];
      target.angularVelocityY = values[base + 34];
      target.angularVelocityZ = values[base + 35];
    } else {
      target.angularVelocityX = null;
      target.angularVelocityY = null;
      target.angularVelocityZ = null;
    }

    let copiedTurretRows = false;
    if (values[base + 43] !== 0) {
      const turretCount = values[base + 44] | 0;
      const turretOffset = values[base + 49] | 0;
      if (existing.combat === null || existing.combat.turrets.length !== turretCount) {
        return false;
      }
      copiedTurretRows = this.copyWireUnitTurretsToTarget(
        source,
        turretOffset,
        turretCount,
        target,
        existing,
      );
      if (!copiedTurretRows) return false;
    }
    if (
      values[base + 68] !== 0 &&
      existing.builder?.workStation !== null &&
      existing.builder?.workStation !== undefined
    ) {
      const station = existing.builder.workStation;
      station.localYaw = deqRot(values[base + 69]);
      station.localPitch = deqRot(values[base + 70]);
      station.localYawVelocity = deqRot(values[base + 71]);
      station.localPitchVelocity = deqRot(values[base + 72]);
      station.targetEntityId = values[base + 73] !== 0 ? 0 : NO_ENTITY_ID;
      station.aligned = values[base + 74] !== 0;
      station.targetWorldYaw = deqRot(values[base + 75]);
      station.targetWorldPitch = deqRot(values[base + 76]);
    }
    target.updatedAtMs = now;

    this.applyUnitHpBuildTypedFields(
      existing,
      values,
      base,
      true,
      true,
    );

    if (values[base + 41] !== 0) {
      applyNetworkUnitActionWireRows(
        existing.unit,
        source.actionRows.values,
        values[base + 50] | 0,
        values[base + 42] | 0,
        source.actionStrings,
        ENTITY_SNAPSHOT_WIRE_ACTION_STRIDE,
      );
    }

    const combat = existing.combat;
    if (combat !== null) {
      const fireState = values[base + 51] !== 0
        ? unitFireStateFromWireCode(values[base + 52] | 0)
        : 'fireAtWill';
      combat.fireState = fireState;
      combat.fireEnabled = fireState !== 'holdFire';
      combat.trajectoryMode = values[base + 57] !== 0
        ? trajectoryModeFromWireCode(values[base + 58] | 0)
        : 'auto';
    }

    existing.unit.repeatQueue = values[base + 53] !== 0
      ? values[base + 54] !== 0
      : false;
    if (values[base + 59] !== 0) {
      existing.unit.moveState = unitMoveStateFromWireCode(values[base + 60] | 0);
    } else if (values[base + 55] !== 0) {
      existing.unit.moveState = values[base + 56] !== 0 ? 'holdPosition' : 'maneuver';
    } else {
      existing.unit.moveState = unitBlueprintBarDefaultMoveState(existing.unit.unitBlueprintId);
    }
    if (values[base + 61] !== 0) {
      existing.unit.wantCloak = values[base + 62] >= 1;
      existing.unit.cloaked = values[base + 62] >= 2;
    } else {
      existing.unit.wantCloak = false;
      existing.unit.cloaked = false;
    }
    if (existing.builder !== null) {
      existing.builder.currentBuildTarget = values[base + 38] !== 0 && values[base + 39] === 0
        ? values[base + 40] as EntityId
        : NO_ENTITY_ID;
      existing.builder.lowPriority = values[base + 66] !== 0 && values[base + 67] !== 0;
    }
    if (existing.factory !== null) {
      existing.factory.carrierSpawnEnabled = values[base + 64] !== 0
        ? values[base + 65] !== 0
        : true;
    }

    this.refreshRenderableEntityStateSnapshotDelta(
      existing,
      true,
      copiedTurretRows,
      true,
    );
    if (existing.unit.supportSurface.kind === 'discTop') {
      this.refreshLocomotionSupportSurfaceProvider(existing);
    }
    this.activeEntityPredictionIds.add(id);
    this.dirtyUnitRenderIds.add(id);
    return true;
  }

  protected tryApplyUnitHotMotionTypedDeltaWireRow(
    values: Float64Array,
    base: number,
    changedFields: number,
    now: number,
  ): boolean {
    const id = values[base + 0] | 0;
    const playerId = values[base + 5] | 0;
    if (
      !this.renderSlotMatchesSnapshotOwner(id as EntityId, playerId as PlayerId, CLIENT_RENDER_ENTITY_KIND_UNIT)
    ) {
      const existing = this.entities.get(id);
      if (existing === undefined || existing.unit === null) return false;
      const ownership = existing.ownership;
      if (ownership === null || ownership.playerId !== playerId) return false;
    }

    const target = this.getOrCreateServerTarget(id);
    if ((changedFields & ENTITY_CHANGED_POS) !== 0) {
      target.x = values[base + 1] * ENTITY_POSITION_WIRE_INV_SCALE;
      target.y = values[base + 2] * ENTITY_POSITION_WIRE_INV_SCALE;
      target.z = values[base + 3] * ENTITY_POSITION_WIRE_INV_SCALE;
    }
    if ((changedFields & ENTITY_CHANGED_NORMAL) !== 0 && values[base + 23] !== 0) {
      target.surfaceNormalX = values[base + 24] * NORMAL_WIRE_INV_SCALE;
      target.surfaceNormalY = values[base + 25] * NORMAL_WIRE_INV_SCALE;
      target.surfaceNormalZ = values[base + 26] * NORMAL_WIRE_INV_SCALE;
    }
    if ((changedFields & ENTITY_CHANGED_ROT) !== 0) {
      target.rotation = values[base + 4] * ROTATION_WIRE_INV_SCALE;
      if (values[base + 27] !== 0) {
        let orientation = target.orientation;
        if (orientation === null) {
          orientation = { x: 0, y: 0, z: 0, w: 1 };
          target.orientation = orientation;
        }
        orientation.x = values[base + 28];
        orientation.y = values[base + 29];
        orientation.z = values[base + 30];
        orientation.w = values[base + 31];
      } else {
        target.orientation = null;
      }
    }
    if ((changedFields & ENTITY_CHANGED_VEL) !== 0) {
      target.velocityX = values[base + 10] * VELOCITY_WIRE_INV_SCALE;
      target.velocityY = values[base + 11] * VELOCITY_WIRE_INV_SCALE;
      target.velocityZ = values[base + 12] * VELOCITY_WIRE_INV_SCALE;
      if (values[base + 32] !== 0) {
        target.angularVelocityX = values[base + 33];
        target.angularVelocityY = values[base + 34];
        target.angularVelocityZ = values[base + 35];
      } else {
        target.angularVelocityX = null;
        target.angularVelocityY = null;
        target.angularVelocityZ = null;
      }
    }
    target.updatedAtMs = now;
    this.activeEntityPredictionIds.add(id);
    return true;
  }

  protected canApplyUnitMetadataTypedDeltaWireRowAt(
    values: Float64Array,
    rowIndex: number,
  ): boolean {
    const base = rowIndex * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
    const changedFields = values[base + 7] | 0;
    if (values[base + 6] === 0 || changedFields === 0) return false;
    if ((changedFields & ~CLIENT_UNIT_METADATA_DELTA_FIELDS) !== 0) return false;
    if ((changedFields & CLIENT_UNIT_METADATA_DELTA_FIELDS) === 0) return false;

    const id = values[base + 0] | 0;
    const playerId = values[base + 5] | 0;
    const existing = this.entities.get(id);
    if (existing === undefined || existing.unit === null) return false;
    const ownership = existing.ownership;
    return ownership !== null && ownership.playerId === playerId;
  }

  protected applyUnitHpBuildTypedFields(
    existing: Entity,
    values: Float64Array,
    base: number,
    hasHpFields: boolean,
    hasBuildFields: boolean,
  ): boolean {
    const refreshHealth = hasHpFields || hasBuildFields;
    if (!refreshHealth) return false;
    const healthBarCacheMemberBefore = this.unitHealthBarCacheMembership(existing);

    if (hasHpFields && existing.unit !== null) {
      existing.unit.hp = values[base + 8];
      existing.unit.maxHp = values[base + 9];
    }

    if (hasBuildFields && existing.unit !== null) {
      const hasBuildPayload = values[base + 45] !== 0;
      applyNetworkBuildStateFields(
        existing,
        !hasBuildPayload || values[base + 46] !== 0,
        values[base + 63] !== 0,
        values[base + 47],
        values[base + 48],
        getUnitBuildRequired(existing.unit.unitBlueprintId),
      );
    }

    if (healthBarCacheMemberBefore !== this.unitHealthBarCacheMembership(existing)) {
      this.cache.refreshHealthBarEntity(existing);
    }
    return true;
  }

  protected applyUnitMetadataTypedDeltaWireRow(
    values: Float64Array,
    base: number,
    changedFields: number,
  ): void {
    const id = values[base + 0] | 0;
    const existing = this.entities.get(id);
    if (existing === undefined || existing.unit === null) return;
    const hasHpFields = (changedFields & ENTITY_CHANGED_HP) !== 0;
    const hasBuildFields = (changedFields & ENTITY_CHANGED_BUILDING) !== 0;
    const refreshHealth = this.applyUnitHpBuildTypedFields(
      existing,
      values,
      base,
      hasHpFields,
      hasBuildFields,
    );

    this.refreshRenderableEntityStateSnapshotDelta(
      existing,
      refreshHealth,
      false,
      hasBuildFields,
    );
  }

  protected canApplyBuildingMetadataTypedDeltaWireRowAt(
    values: Float64Array,
    rowIndex: number,
  ): boolean {
    const base = rowIndex * ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE;
    const changedFields = values[base + 7] | 0;
    if (values[base + 6] === 0 || changedFields === 0) return false;
    if ((changedFields & ~CLIENT_BUILDING_METADATA_DELTA_FIELDS) !== 0) return false;
    if ((changedFields & CLIENT_BUILDING_METADATA_DELTA_FIELDS) === 0) return false;

    const id = values[base + 0] | 0;
    const playerId = values[base + 5] | 0;
    const existing = this.entities.get(id);
    if (existing === undefined || existing.building === null) return false;
    const ownership = existing.ownership;
    return ownership !== null && ownership.playerId === playerId;
  }

  protected applyBuildingHpBuildTypedFields(
    existing: Entity,
    values: Float64Array,
    base: number,
    hasHpFields: boolean,
    hasBuildFields: boolean,
  ): boolean {
    const refreshHealth = hasHpFields || hasBuildFields;
    if (!refreshHealth) return false;
    const building = existing.building;
    if (building === null) return false;
    const healthBarCacheMemberBefore = this.buildingHealthBarCacheMembership(existing);

    if (hasHpFields) {
      building.hp = values[base + 13];
      building.maxHp = values[base + 14];
    }

    if (hasBuildFields) {
      applyNetworkBuildStateFields(
        existing,
        values[base + 15] !== 0,
        values[base + 34] !== 0,
        values[base + 16],
        values[base + 17],
        getBuildingBuildRequired(existing.buildingBlueprintId),
      );
      if (values[base + 18] !== 0) {
        existing.metalExtractionRate = values[base + 19];
      }
      if (values[base + 20] !== 0) {
        const activeState = building.activeState;
        building.activeState = {
          open: values[base + 21] !== 0,
          damageDelayMs: activeState === null ? 0 : activeState.damageDelayMs,
          reopenDelayMs: activeState === null ? 0 : activeState.reopenDelayMs,
        };
      }
    }

    if (healthBarCacheMemberBefore !== this.buildingHealthBarCacheMembership(existing)) {
      this.cache.refreshHealthBarEntity(existing);
    }
    return true;
  }

  protected applyBuildingFactoryTypedFields(
    existing: Entity,
    source: EntitySnapshotWireSource,
    values: Float64Array,
    base: number,
  ): boolean {
    const factory = existing.factory;
    if (factory === null || values[base + 24] === 0) return false;

    const selectedCount = values[base + 25] | 0;
    const selectedOffset = values[base + 32] | 0;
    const factoryRows = source.factorySelectedUnitRows.values;
    if (selectedCount > 0) {
      if (selectedOffset < 0 || selectedOffset + selectedCount > source.factorySelectedUnitRows.count) {
        return false;
      }
      factory.selectedUnitBlueprintId = codeToUnitBlueprintId(factoryRows[selectedOffset]) ?? null;
    } else {
      factory.selectedUnitBlueprintId = null;
    }

    const queueCount = values[base + 39] | 0;
    const queueOffset = values[base + 38] | 0;
    if (queueCount > 0) {
      if (queueOffset < 0 || queueOffset + queueCount > source.factorySelectedUnitRows.count) {
        return false;
      }
      decodeFactoryProductionQueueInto(
        factoryRows.subarray(queueOffset, queueOffset + queueCount),
        factory.productionQueue,
      );
    } else {
      decodeFactoryProductionQueueInto(null, factory.productionQueue);
    }

    const rallyCount = values[base + 30] | 0;
    const rallyOffset = values[base + 33] | 0;
    if (rallyCount <= 0) return false;
    const rally = readFactoryWaypointFromWire(source, rallyOffset);
    if (rally === null) return false;
    factory.rallyX = rally.x;
    factory.rallyY = rally.y;
    factory.rallyZ = rally.z;
    factory.rallyType = rally.type === 'guard' ? 'move' : rally.type;

    const routeCount = values[base + 41] | 0;
    const routeOffset = values[base + 40] | 0;
    if (routeCount >= 0) {
      if (routeCount > 0 && (routeOffset < 0 || routeOffset + routeCount > source.waypointRows.count)) {
        return false;
      }
      const existingRoute = factory.defaultWaypoints;
      const route = existingRoute !== null && existingRoute.length === routeCount
        ? existingRoute as FactoryDefaultWaypoint[]
        : new Array<FactoryDefaultWaypoint>(routeCount);
      for (let i = 0; i < routeCount; i++) {
        const waypoint = readFactoryWaypointFromWire(source, routeOffset + i);
        if (waypoint === null) return false;
        let dst = route[i];
        if (dst === undefined) {
          dst = { x: 0, y: 0, z: null, type: 'move' };
          route[i] = dst;
        }
        dst.x = waypoint.x;
        dst.y = waypoint.y;
        dst.z = waypoint.z;
        dst.type = waypoint.type;
      }
      factory.defaultWaypoints = route;
    } else {
      factory.defaultWaypoints = null;
    }

    factory.repeatProduction = values[base + 37] !== 0;
    const quotaOffset = values[base + 42] | 0;
    const quotaCount = values[base + 43] | 0;
    if (quotaCount > 0) {
      if (quotaOffset < 0 || quotaOffset + quotaCount > source.factorySelectedUnitRows.count) {
        return false;
      }
      decodeFactoryProductionQuotasInto(
        factoryRows.subarray(quotaOffset, quotaOffset + quotaCount),
        factory.productionQuotas,
      );
    } else {
      decodeFactoryProductionQuotasInto(null, factory.productionQuotas);
    }

    const quotaCountOffset = values[base + 44] | 0;
    const quotaCountCount = values[base + 45] | 0;
    if (quotaCountCount > 0) {
      if (quotaCountOffset < 0 || quotaCountOffset + quotaCountCount > source.factorySelectedUnitRows.count) {
        return false;
      }
      decodeFactoryProductionQuotaCountsInto(
        factoryRows.subarray(quotaCountOffset, quotaCountOffset + quotaCountCount),
        factory.productionQuotaCounts,
      );
    } else {
      decodeFactoryProductionQuotaCountsInto(null, factory.productionQuotaCounts);
    }
    factory.currentShellId = null;
    factory.currentBuildProgress = values[base + 26];
    factory.isProducing = values[base + 27] !== 0;
    factory.energyRateFraction = values[base + 28];
    factory.metalRateFraction = values[base + 29];
    factory.guardTargetId = values[base + 35] !== 0 ? (values[base + 36] | 0) as EntityId : null;
    factory.lowPriority = values[base + 46] !== 0;
    factory.paused = values[base + 47] !== 0;
    const moveStateCode = values[base + 48] | 0;
    factory.moveState = moveStateCode === 2
      ? 'roam'
      : moveStateCode === 1
        ? 'holdPosition'
        : 'maneuver';
    factory.airIdleState = values[base + 49] !== 0 ? 'fly' : 'land';
    return true;
  }

  protected applyBuildingMetadataTypedDeltaWireRow(
    values: Float64Array,
    base: number,
    changedFields: number,
  ): void {
    const id = values[base + 0] | 0;
    const existing = this.entities.get(id);
    if (existing === undefined || existing.building === null) return;
    const hasHpFields = (changedFields & ENTITY_CHANGED_HP) !== 0;
    const hasBuildFields = (changedFields & ENTITY_CHANGED_BUILDING) !== 0;
    const refreshHealth = this.applyBuildingHpBuildTypedFields(
      existing,
      values,
      base,
      hasHpFields,
      hasBuildFields,
    );

    this.refreshRenderableEntityStateSnapshotDelta(
      existing,
      refreshHealth,
      false,
      hasBuildFields,
    );
    this.dirtyBuildingRenderIds.add(id);
  }

  protected canApplyMetadataTypedDeltaSource(
    source: EntitySnapshotWireSource,
    entities: readonly (NetworkServerSnapshotEntity | undefined)[],
  ): boolean {
    const count = source.count;
    if (count === 0 || count !== entities.length) return false;
    if (
      source.rawEntityRows !== 0 ||
      source.typedEntityRows !== count ||
      source.basicRows.count !== 0 ||
      source.actionRows.count !== 0 ||
      source.turretRows.count !== 0 ||
      source.factorySelectedUnitRows.count !== 0 ||
      source.waypointRows.count !== 0
    ) {
      return false;
    }
    if (source.unitRows.count + source.buildingRows.count !== count) return false;

    for (let entityIndex = 0; entityIndex < count; entityIndex++) {
      if (entities[entityIndex] !== undefined) return false;
    }
    const unitValues = source.unitRows.values;
    for (let rowIndex = 0; rowIndex < source.unitRows.count; rowIndex++) {
      if (!this.canApplyUnitMetadataTypedDeltaWireRowAt(unitValues, rowIndex)) return false;
    }
    const buildingValues = source.buildingRows.values;
    for (let rowIndex = 0; rowIndex < source.buildingRows.count; rowIndex++) {
      if (!this.canApplyBuildingMetadataTypedDeltaWireRowAt(buildingValues, rowIndex)) return false;
    }
    return true;
  }

  protected applyMetadataTypedDeltaSource(source: EntitySnapshotWireSource): void {
    const unitValues = source.unitRows.values;
    for (let rowIndex = 0, base = 0; rowIndex < source.unitRows.count; rowIndex++, base += ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE) {
      this.applyUnitMetadataTypedDeltaWireRow(
        unitValues,
        base,
        unitValues[base + 7] | 0,
      );
    }
    const buildingValues = source.buildingRows.values;
    for (
      let rowIndex = 0, base = 0;
      rowIndex < source.buildingRows.count;
      rowIndex++, base += ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE
    ) {
      this.applyBuildingMetadataTypedDeltaWireRow(
        buildingValues,
        base,
        buildingValues[base + 7] | 0,
      );
    }
  }

  protected tryApplyTypedPlaceholderDeltaSource(
    source: EntitySnapshotWireSource,
    entities: readonly (NetworkServerSnapshotEntity | undefined)[],
    now: number,
    deferPredictedTurretRenderRefresh: boolean,
    applyStats: ClientSnapshotApplyStats,
  ): boolean {
    const count = source.count;
    if (count === 0 || count !== entities.length) return false;
    if (source.typedPlaceholderRows !== count) return false;
    if (this.canApplyUnitHotMotionTypedPlaceholderSource(source)) {
      this.applyUnitHotMotionTypedPlaceholderSource(source, now);
      return true;
    }
    this.applyTypedPlaceholderDeltaSource(
      source,
      now,
      deferPredictedTurretRenderRefresh,
      applyStats,
    );
    return true;
  }

  protected canApplyUnitHotMotionTypedPlaceholderSource(source: EntitySnapshotWireSource): boolean {
    const count = source.count;
    if (
      source.unitRows.count !== count ||
      source.basicRows.count !== 0 ||
      source.buildingRows.count !== 0 ||
      source.actionRows.count !== 0 ||
      source.turretRows.count !== 0 ||
      source.factorySelectedUnitRows.count !== 0 ||
      source.waypointRows.count !== 0
    ) {
      return false;
    }
    return source.unitChangedFieldsOr !== 0 &&
      (source.unitChangedFieldsOr & ~CLIENT_UNIT_HOT_MOTION_DELTA_FIELDS) === 0;
  }

  protected applyUnitHotMotionTypedPlaceholderSource(
    source: EntitySnapshotWireSource,
    now: number,
  ): void {
    this.applyUnitHotMotionTypedRows(source.unitRows.values, source.unitRows.count, now);
  }

  protected applyUnitHotMotionTypedRows(
    values: Float64Array,
    count: number,
    now: number,
  ): void {
    const serverTargets = this.serverTargets;
    const activeEntityPredictionIds = this.activeEntityPredictionIds;
    const renderEntityState = this.renderEntityState;
    const renderViews = renderEntityState.getViews();
    const posScale = ENTITY_POSITION_WIRE_INV_SCALE;
    const rotScale = ROTATION_WIRE_INV_SCALE;
    const velScale = VELOCITY_WIRE_INV_SCALE;
    const normalScale = NORMAL_WIRE_INV_SCALE;
    for (
      let rowIndex = 0, base = 0;
      rowIndex < count;
      rowIndex++, base += ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE
    ) {
      const changedFields = values[base + 7] | 0;
      if (values[base + 6] === 0 || changedFields === 0) continue;
      const id = values[base + 0] | 0;
      const playerId = values[base + 5] | 0;
      const renderSlot = renderEntityState.getSlot(id as EntityId);
      if (
        renderSlot === undefined ||
        renderViews.kind[renderSlot] !== CLIENT_RENDER_ENTITY_KIND_UNIT ||
        renderViews.ownerIds[renderSlot] !== playerId
      ) {
        const existing = this.entities.get(id);
        if (existing === undefined || existing.unit === null) continue;
        const ownership = existing.ownership;
        if (ownership === null || ownership.playerId !== playerId) continue;
      }

      const target = serverTargets.getOrCreate(id);
      if ((changedFields & ENTITY_CHANGED_POS) !== 0) {
        target.x = values[base + 1] * posScale;
        target.y = values[base + 2] * posScale;
        target.z = values[base + 3] * posScale;
      }
      if ((changedFields & ENTITY_CHANGED_NORMAL) !== 0 && values[base + 23] !== 0) {
        target.surfaceNormalX = values[base + 24] * normalScale;
        target.surfaceNormalY = values[base + 25] * normalScale;
        target.surfaceNormalZ = values[base + 26] * normalScale;
      }
      if ((changedFields & ENTITY_CHANGED_ROT) !== 0) {
        target.rotation = values[base + 4] * rotScale;
        if (values[base + 27] !== 0) {
          let orientation = target.orientation;
          if (orientation === null) {
            orientation = { x: 0, y: 0, z: 0, w: 1 };
            target.orientation = orientation;
          }
          orientation.x = values[base + 28];
          orientation.y = values[base + 29];
          orientation.z = values[base + 30];
          orientation.w = values[base + 31];
        } else {
          target.orientation = null;
        }
      }
      if ((changedFields & ENTITY_CHANGED_VEL) !== 0) {
        target.velocityX = values[base + 10] * velScale;
        target.velocityY = values[base + 11] * velScale;
        target.velocityZ = values[base + 12] * velScale;
        if (values[base + 32] !== 0) {
          target.angularVelocityX = values[base + 33];
          target.angularVelocityY = values[base + 34];
          target.angularVelocityZ = values[base + 35];
        } else {
          target.angularVelocityX = null;
          target.angularVelocityY = null;
          target.angularVelocityZ = null;
        }
      }
      target.updatedAtMs = now;
      activeEntityPredictionIds.add(id);
    }
  }

  protected applyUnitHotMotionTypedPlaceholderRows(
    source: EntitySnapshotWireSource,
    now: number,
  ): void {
    const values = source.unitRows.values;
    const entityIndices = source.unitTypedPlaceholderEntityIndices;
    const rowIndices = source.rowIndices;
    for (let i = 0; i < source.unitTypedPlaceholderRows; i++) {
      const rowIndex = rowIndices[entityIndices[i]];
      if (rowIndex < 0 || rowIndex >= source.unitRows.count) continue;
      const base = rowIndex * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
      const changedFields = values[base + 7] | 0;
      if (
        values[base + 6] === 0 ||
        changedFields === 0 ||
        (changedFields & ~CLIENT_UNIT_HOT_MOTION_DELTA_FIELDS) !== 0
      ) {
        continue;
      }
      this.tryApplyUnitHotMotionTypedDeltaWireRow(
        values,
        base,
        changedFields,
        now,
      );
    }
  }

  protected applyTypedPlaceholderDeltaSource(
    source: EntitySnapshotWireSource,
    now: number,
    deferPredictedTurretRenderRefresh: boolean,
    applyStats: ClientSnapshotApplyStats,
  ): void {
    const basicValues = source.basicRows.values;
    for (let rowIndex = 0; rowIndex < source.basicRows.count; rowIndex++) {
      const base = rowIndex * ENTITY_SNAPSHOT_WIRE_BASIC_STRIDE;
      const changedFields = basicValues[base + 8] | 0;
      if (basicValues[base + 7] !== 0 && changedFields !== 0) {
        this.applyBasicTransformTypedDeltaWireRow(
          basicValues,
          base,
          changedFields,
          now,
        );
      }
    }
    const unitValues = source.unitRows.values;
    if (
      source.unitRows.count > 0 &&
      source.unitChangedFieldsOr !== 0 &&
      (source.unitChangedFieldsOr & ~CLIENT_UNIT_HOT_MOTION_DELTA_FIELDS) === 0
    ) {
      this.applyUnitHotMotionTypedRows(unitValues, source.unitRows.count, now);
    } else {
      for (let rowIndex = 0; rowIndex < source.unitRows.count; rowIndex++) {
        const base = rowIndex * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
        const changedFields = unitValues[base + 7] | 0;
        if (
          unitValues[base + 6] !== 0 &&
          changedFields !== 0 &&
          (changedFields & ~CLIENT_UNIT_HOT_MOTION_DELTA_FIELDS) === 0
        ) {
          this.tryApplyUnitHotMotionTypedDeltaWireRow(
            unitValues,
            base,
            changedFields,
            now,
          );
          continue;
        }
        this.tryApplyUnitTypedDeltaWireRowAt(
          source,
          rowIndex,
          now,
          false,
          deferPredictedTurretRenderRefresh,
          applyStats,
        );
      }
    }
    for (let rowIndex = 0; rowIndex < source.buildingRows.count; rowIndex++) {
      this.tryApplyBuildingTypedDeltaWireRowAt(
        source,
        rowIndex,
        now,
        deferPredictedTurretRenderRefresh,
      );
    }
  }

  protected wireRowsOfKindAreTypedPlaceholders(
    source: EntitySnapshotWireSource,
    kind: number,
    rowCount: number,
  ): boolean {
    if (rowCount === 0) return false;
    switch (kind) {
      case ENTITY_SNAPSHOT_WIRE_KIND_BASIC:
        return source.basicTypedPlaceholderRows === rowCount;
      case ENTITY_SNAPSHOT_WIRE_KIND_UNIT:
        return source.unitTypedPlaceholderRows === rowCount;
      case ENTITY_SNAPSHOT_WIRE_KIND_BUILDING:
        return source.buildingTypedPlaceholderRows === rowCount;
      default:
        return false;
    }
  }

  protected applyMixedTypedPlaceholderRows(
    source: EntitySnapshotWireSource,
    now: number,
    deferPredictedTurretRenderRefresh: boolean,
    applyStats: ClientSnapshotApplyStats,
  ): boolean {
    if (source.typedPlaceholderRows === 0) return false;

    if (
      source.basicRows.count === 0 &&
      source.unitTypedPlaceholderRows === source.unitRows.count &&
      source.buildingTypedPlaceholderRows === source.buildingRows.count &&
      source.typedPlaceholderRows === source.unitRows.count + source.buildingRows.count
    ) {
      if (
        source.unitRows.count > 0 &&
        source.unitChangedFieldsOr !== 0 &&
        (source.unitChangedFieldsOr & ~CLIENT_UNIT_HOT_MOTION_DELTA_FIELDS) === 0
      ) {
        this.applyUnitHotMotionTypedRows(source.unitRows.values, source.unitRows.count, now);
      } else {
        for (let rowIndex = 0; rowIndex < source.unitRows.count; rowIndex++) {
          this.tryApplyUnitTypedDeltaWireRowAt(
            source,
            rowIndex,
            now,
            false,
            deferPredictedTurretRenderRefresh,
            applyStats,
          );
        }
      }
      for (let rowIndex = 0; rowIndex < source.buildingRows.count; rowIndex++) {
        this.tryApplyBuildingTypedDeltaWireRowAt(
          source,
          rowIndex,
          now,
          deferPredictedTurretRenderRefresh,
        );
      }
      return true;
    }

    const unitHotMotionPlaceholders =
      source.unitTypedPlaceholderRows > 0 &&
      source.unitTypedPlaceholderRows !== source.unitRows.count &&
      source.unitChangedFieldsOr !== 0 &&
      (source.unitChangedFieldsOr & ~CLIENT_UNIT_HOT_MOTION_DELTA_FIELDS) === 0;
    if (unitHotMotionPlaceholders) {
      this.applyUnitHotMotionTypedPlaceholderRows(source, now);
      if (source.typedPlaceholderRows === source.unitTypedPlaceholderRows) return true;

      const basicPlaceholderIndices = source.basicTypedPlaceholderEntityIndices;
      for (let i = 0; i < source.basicTypedPlaceholderRows; i++) {
        this.tryApplyBasicTypedDeltaWireRow(
          source,
          basicPlaceholderIndices[i],
          now,
          false,
          applyStats,
        );
      }
      const buildingPlaceholderIndices = source.buildingTypedPlaceholderEntityIndices;
      for (let i = 0; i < source.buildingTypedPlaceholderRows; i++) {
        this.tryApplyBuildingTypedDeltaWireRow(
          source,
          buildingPlaceholderIndices[i],
          now,
          deferPredictedTurretRenderRefresh,
        );
      }
      return true;
    }

    const batchUnitHotMotion =
      source.unitRows.count > 0 &&
      source.unitChangedFieldsOr !== 0 &&
      (source.unitChangedFieldsOr & ~CLIENT_UNIT_HOT_MOTION_DELTA_FIELDS) === 0 &&
      this.wireRowsOfKindAreTypedPlaceholders(
        source,
        ENTITY_SNAPSHOT_WIRE_KIND_UNIT,
        source.unitRows.count,
      );
    if (batchUnitHotMotion) {
      this.applyUnitHotMotionTypedRows(source.unitRows.values, source.unitRows.count, now);
      if (source.typedPlaceholderRows === source.unitRows.count) return true;

      const basicPlaceholderIndices = source.basicTypedPlaceholderEntityIndices;
      for (let i = 0; i < source.basicTypedPlaceholderRows; i++) {
        this.tryApplyBasicTypedDeltaWireRow(
          source,
          basicPlaceholderIndices[i],
          now,
          false,
          applyStats,
        );
      }
      const buildingPlaceholderIndices = source.buildingTypedPlaceholderEntityIndices;
      for (let i = 0; i < source.buildingTypedPlaceholderRows; i++) {
        this.tryApplyBuildingTypedDeltaWireRow(
          source,
          buildingPlaceholderIndices[i],
          now,
          deferPredictedTurretRenderRefresh,
        );
      }
      return true;
    }

    let appliedAny = false;
    const placeholderIndices = source.typedPlaceholderEntityIndices;
    for (let i = 0; i < source.typedPlaceholderRows; i++) {
      const entityIndex = placeholderIndices[i];
      switch (source.kinds[entityIndex]) {
        case ENTITY_SNAPSHOT_WIRE_KIND_BASIC:
          this.tryApplyBasicTypedDeltaWireRow(
            source,
            entityIndex,
            now,
            false,
            applyStats,
          );
          break;
        case ENTITY_SNAPSHOT_WIRE_KIND_UNIT:
          if (!batchUnitHotMotion) {
            this.tryApplyUnitTypedDeltaWireRow(
              source,
              entityIndex,
              now,
              false,
              deferPredictedTurretRenderRefresh,
              applyStats,
            );
          }
          break;
        case ENTITY_SNAPSHOT_WIRE_KIND_BUILDING:
          this.tryApplyBuildingTypedDeltaWireRow(
            source,
            entityIndex,
            now,
            deferPredictedTurretRenderRefresh,
          );
          break;
        default:
          continue;
      }
      appliedAny = true;
    }
    return appliedAny;
  }

  protected canApplyTypedFullSnapshotSource(source: EntitySnapshotWireSource): boolean {
    if (
      source.count === 0 ||
      source.typedPlaceholderRows !== 0 ||
      source.rawEntityRows !== 0 ||
      source.typedEntityRows !== source.count ||
      source.basicRows.count !== 0
    ) {
      return false;
    }
    if (source.unitRows.count + source.buildingRows.count !== source.count) return false;
    return source.unitChangedFieldsOr === 0 && source.buildingChangedFieldsOr === 0;
  }

  protected tryApplyTypedFullSnapshotSource(
    source: EntitySnapshotWireSource,
    now: number,
  ): boolean {
    if (this.tryCreateInitialTypedFullSnapshotSource(source)) {
      return true;
    }
    for (let entityIndex = 0; entityIndex < source.count; entityIndex++) {
      let applied = false;
      switch (source.kinds[entityIndex]) {
        case ENTITY_SNAPSHOT_WIRE_KIND_UNIT:
          applied = this.tryApplyUnitTypedFullWireRow(source, entityIndex, now);
          break;
        case ENTITY_SNAPSHOT_WIRE_KIND_BUILDING:
          applied = this.tryApplyBuildingTypedFullWireRow(source, entityIndex, now);
          break;
        default:
          return false;
      }
      if (applied) continue;

      const typedEntityId = typedEntityWireRowId(source, entityIndex);
      const createdEntity = typedEntityId !== null && !this.entities.has(typedEntityId)
        ? createEntityFromTypedFullWireRow(source, entityIndex)
        : null;
      if (createdEntity === null || createdEntity.id !== typedEntityId) {
        return false;
      }
      this.attachCreatedNetworkEntity(createdEntity);
    }
    return true;
  }

  protected tryCreateInitialTypedFullSnapshotSource(
    source: EntitySnapshotWireSource,
  ): boolean {
    if (this.entities.size !== 0) return false;
    const createdEntities = this.typedFullCreationScratch;
    const createdIds = this.typedFullCreationIds;
    createdEntities.length = 0;
    createdIds.clear();
    for (let entityIndex = 0; entityIndex < source.count; entityIndex++) {
      const typedEntityId = typedEntityWireRowId(source, entityIndex);
      if (
        typedEntityId === null ||
        this.entities.has(typedEntityId) ||
        createdIds.has(typedEntityId)
      ) {
        createdEntities.length = 0;
        createdIds.clear();
        return false;
      }
      const createdEntity = createEntityFromTypedFullWireRow(source, entityIndex);
      if (createdEntity === null || createdEntity.id !== typedEntityId) {
        createdEntities.length = 0;
        createdIds.clear();
        return false;
      }
      createdIds.add(typedEntityId);
      createdEntities.push(createdEntity);
    }

    for (let i = 0; i < createdEntities.length; i++) {
      this.attachCreatedNetworkEntity(createdEntities[i], true);
    }
    if (createdEntities.length > 0) this.entitySetVersion++;
    createdEntities.length = 0;
    createdIds.clear();
    return true;
  }

  protected tryApplyBuildingTypedDeltaWireRow(
    source: EntitySnapshotWireSource,
    entityIndex: number,
    now: number,
    deferPredictedTurretRenderRefresh: boolean,
  ): boolean {
    const rowIndex = source.rowIndices[entityIndex];
    return this.tryApplyBuildingTypedDeltaWireRowAt(
      source,
      rowIndex,
      now,
      deferPredictedTurretRenderRefresh,
    );
  }

  protected tryApplyBuildingTypedDeltaWireRowAt(
    source: EntitySnapshotWireSource,
    rowIndex: number,
    now: number,
    deferPredictedTurretRenderRefresh = false,
  ): boolean {
    if (rowIndex < 0 || rowIndex >= source.buildingRows.count) return false;
    const values = source.buildingRows.values;
    const base = rowIndex * ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE;
    const changedFields = values[base + 7] | 0;
    if (values[base + 6] === 0 || changedFields === 0) return false;
    if ((changedFields & ~CLIENT_BUILDING_TYPED_DELTA_FIELDS) !== 0) return false;
    const hasMotionFields = (changedFields & (ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT)) !== 0;
    const hasHpFields = (changedFields & ENTITY_CHANGED_HP) !== 0;
    const hasTurretFields = (changedFields & ENTITY_CHANGED_TURRETS) !== 0;
    const hasBuildFields = (changedFields & ENTITY_CHANGED_BUILDING) !== 0;
    const hasFactoryFields = (changedFields & ENTITY_CHANGED_FACTORY) !== 0;
    if (!hasMotionFields && !hasHpFields && !hasTurretFields && !hasBuildFields && !hasFactoryFields) {
      return false;
    }

    const id = values[base + 0] | 0;
    const playerId = values[base + 5] | 0;
    const existing = this.entities.get(id);
    if (existing === undefined || existing.building === null) return false;
    const ownership = existing.ownership;
    if (ownership === null || ownership.playerId !== playerId) return false;

    const needsServerTarget = hasMotionFields || hasTurretFields;
    const target = needsServerTarget ? this.getOrCreateServerTarget(id) : undefined;
    if (target !== undefined) {
      if ((changedFields & ENTITY_CHANGED_POS) !== 0) {
        const x = deqEntityPos(values[base + 1]);
        const y = deqEntityPos(values[base + 2]);
        const z = deqEntityPos(values[base + 3]);
        target.x = x;
        target.y = y;
        target.z = z;
        existing.transform.x = x;
        existing.transform.y = y;
        existing.transform.z = z;
      }
      if ((changedFields & ENTITY_CHANGED_ROT) !== 0) {
        const rotation = deqRot(values[base + 4]);
        target.rotation = rotation;
        existing.transform.rotation = rotation;
      }
    }

    let copiedTurretRows = false;
    if (hasTurretFields && values[base + 22] !== 0) {
      if (target === undefined) return false;
      const turretCount = values[base + 23] | 0;
      const turretOffset = values[base + 31] | 0;
      copiedTurretRows = this.copyWireUnitTurretsToTarget(
        source,
        turretOffset,
        turretCount,
        target,
        existing,
      );
      if (!copiedTurretRows) return false;
    }
    if (target !== undefined) target.updatedAtMs = now;

    const refreshHealth = this.applyBuildingHpBuildTypedFields(
      existing,
      values,
      base,
      hasHpFields,
      hasBuildFields,
    );
    const refreshFactory = hasFactoryFields
      ? this.applyBuildingFactoryTypedFields(existing, source, values, base)
      : false;
    if (hasFactoryFields && !refreshFactory) return false;

    // Shields are required visual state, not optional emissions. Refresh them
    // at the wire update even while prediction defers ordinary turret poses.
    const refreshTurretsNow = copiedTurretRows && (
      !deferPredictedTurretRenderRefresh || entityHasShieldEmission(existing)
    );
    if (hasMotionFields) {
      this.refreshRenderableEntityStateFromSnapshot(existing, hasMotionFields);
    } else if (refreshHealth || refreshTurretsNow || refreshFactory) {
      this.refreshRenderableEntityStateSnapshotDelta(
        existing,
        refreshHealth,
        refreshTurretsNow,
        hasBuildFields,
      );
    }
    if (
      hasMotionFields ||
      hasHpFields ||
      hasBuildFields ||
      hasFactoryFields ||
      (copiedTurretRows && deferPredictedTurretRenderRefresh)
    ) {
      this.dirtyBuildingRenderIds.add(id);
    }
    if (copiedTurretRows) this.activeEntityPredictionIds.add(id);
    return true;
  }

  protected tryApplyBuildingTypedFullWireRow(
    source: EntitySnapshotWireSource,
    entityIndex: number,
    now: number,
  ): boolean {
    const rowIndex = source.rowIndices[entityIndex];
    return this.tryApplyBuildingTypedFullWireRowAt(source, rowIndex, now);
  }

  protected tryApplyBuildingTypedFullWireRowAt(
    source: EntitySnapshotWireSource,
    rowIndex: number,
    now: number,
  ): boolean {
    if (rowIndex < 0 || rowIndex >= source.buildingRows.count) return false;
    const values = source.buildingRows.values;
    const base = rowIndex * ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE;
    if (values[base + 6] !== 0 || (values[base + 7] | 0) !== 0) return false;

    const id = values[base + 0] | 0;
    const playerId = values[base + 5] | 0;
    const existing = this.entities.get(id);
    if (existing === undefined || existing.building === null) return false;
    const ownership = existing.ownership;
    if (ownership === null || ownership.playerId !== playerId) return false;

    if (values[base + 8] === 0) return false;
    const buildingBlueprintId = codeToBuildingBlueprintId(values[base + 9]);
    if (
      buildingBlueprintId === null ||
      existing.buildingBlueprintId !== buildingBlueprintId
    ) {
      return false;
    }
    if (
      values[base + 10] !== 0 &&
      (
        existing.building.width !== values[base + 11] ||
        existing.building.height !== values[base + 12]
      )
    ) {
      return false;
    }

    const x = deqEntityPos(values[base + 1]);
    const y = deqEntityPos(values[base + 2]);
    const z = deqEntityPos(values[base + 3]);
    const rotation = deqRot(values[base + 4]);
    const transformChanged =
      existing.transform.x !== x ||
      existing.transform.y !== y ||
      existing.transform.z !== z ||
      existing.transform.rotation !== rotation;
    existing.transform.x = x;
    existing.transform.y = y;
    existing.transform.z = z;
    existing.transform.rotation = rotation;

    let copiedTurretRows = false;
    if (values[base + 22] !== 0) {
      const turretCount = values[base + 23] | 0;
      const turretOffset = values[base + 31] | 0;
      if (existing.combat === null || existing.combat.turrets.length !== turretCount) {
        return false;
      }
      const target = this.getOrCreateServerTarget(id);
      target.x = x;
      target.y = y;
      target.z = z;
      target.rotation = rotation;
      copiedTurretRows = this.copyWireUnitTurretsToTarget(
        source,
        turretOffset,
        turretCount,
        target,
        existing,
      );
      if (!copiedTurretRows) return false;
      target.updatedAtMs = now;
    } else {
      this.serverTargets.delete(id);
    }

    this.applyBuildingHpBuildTypedFields(
      existing,
      values,
      base,
      true,
      true,
    );
    if (
      values[base + 20] === 0 &&
      (
        buildingBlueprintId === 'buildingSolar' ||
        buildingBlueprintId === 'buildingWind' ||
        isMetalExtractorBlueprintId(buildingBlueprintId)
      )
    ) {
      const activeState = existing.building.activeState;
      existing.building.activeState = {
        open: buildingBlueprintId !== 'buildingSolar',
        damageDelayMs: activeState === null ? 0 : activeState.damageDelayMs,
        reopenDelayMs: activeState === null ? 0 : activeState.reopenDelayMs,
      };
    }
    if (values[base + 18] === 0 && !isMetalExtractorBlueprintId(buildingBlueprintId)) {
      existing.metalExtractionRate = null;
    }

    if (values[base + 24] !== 0 && !this.applyBuildingFactoryTypedFields(
      existing,
      source,
      values,
      base,
    )) {
      return false;
    }

    if (transformChanged) {
      this.refreshRenderableEntityStateFromSnapshot(existing, true);
    } else {
      this.refreshRenderableEntityStateSnapshotDelta(
        existing,
        true,
        copiedTurretRows,
        true,
      );
    }
    this.refreshLocomotionSupportSurfaceProvider(existing);
    this.dirtyBuildingRenderIds.add(id);
    if (copiedTurretRows) this.activeEntityPredictionIds.add(id);
    return true;
  }

  protected collectFullSnapshotServerIds(
    entities: readonly (NetworkServerSnapshotEntity | undefined)[],
    typedEntityWireSource: EntitySnapshotWireSource | undefined,
  ): void {
    this._serverIds.clear();

    if (
      typedEntityWireSource !== undefined &&
      typedEntityWireSource.count === entities.length &&
      typedEntityWireSource.rawEntityRows === 0 &&
      typedEntityWireSource.typedEntityRows === typedEntityWireSource.count
    ) {
      const basicValues = typedEntityWireSource.basicRows.values;
      for (
        let rowIndex = 0, base = 0;
        rowIndex < typedEntityWireSource.basicRows.count;
        rowIndex++, base += ENTITY_SNAPSHOT_WIRE_BASIC_STRIDE
      ) {
        this._serverIds.add(basicValues[base] as EntityId);
      }
      const unitValues = typedEntityWireSource.unitRows.values;
      for (
        let rowIndex = 0, base = 0;
        rowIndex < typedEntityWireSource.unitRows.count;
        rowIndex++, base += ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE
      ) {
        this._serverIds.add(unitValues[base] as EntityId);
      }
      const buildingValues = typedEntityWireSource.buildingRows.values;
      for (
        let rowIndex = 0, base = 0;
        rowIndex < typedEntityWireSource.buildingRows.count;
        rowIndex++, base += ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE
      ) {
        this._serverIds.add(buildingValues[base] as EntityId);
      }
      return;
    }

    for (let entityIndex = 0; entityIndex < entities.length; entityIndex++) {
      const netEntity = entities[entityIndex];
      if (netEntity !== undefined) {
        this._serverIds.add(netEntity.id);
        continue;
      }
      if (typedEntityWireSource !== undefined) {
        const id = typedEntityWireRowId(typedEntityWireSource, entityIndex);
        if (id !== null) this._serverIds.add(id);
      }
    }
  }

  protected collectFullSnapshotRemoveIds(
    entities: readonly (NetworkServerSnapshotEntity | undefined)[],
    typedEntityWireSource: EntitySnapshotWireSource | undefined,
  ): EntityId[] {
    if (
      typedEntityWireSource !== undefined &&
      typedEntityWireSource.count === entities.length &&
      typedEntityWireSource.rawEntityRows === 0 &&
      typedEntityWireSource.typedEntityRows === typedEntityWireSource.count
    ) {
      return this.renderEntityState.collectEntityIdsMissingFromTypedWireRows(
        typedEntityWireSource.basicRows.values,
        typedEntityWireSource.basicRows.count,
        ENTITY_SNAPSHOT_WIRE_BASIC_STRIDE,
        typedEntityWireSource.unitRows.values,
        typedEntityWireSource.unitRows.count,
        ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE,
        typedEntityWireSource.buildingRows.values,
        typedEntityWireSource.buildingRows.count,
        ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE,
        this._fullReconcileRemoveIds,
      );
    }

    this.collectFullSnapshotServerIds(entities, typedEntityWireSource);
    return this.renderEntityState.collectEntityIdsMissingFrom(
      this._serverIds,
      this._fullReconcileRemoveIds,
    );
  }

  protected recordWireMotionCorrectionStats(
    existing: Entity,
    values: Float64Array | number[],
    base: number,
    changedFields: number,
    previousTargetAgeMs: number,
    applyStats: ClientSnapshotApplyStats,
  ): void {
    const netX = deqEntityPos(values[base + 1]);
    const netY = deqEntityPos(values[base + 2]);
    const netZ = deqEntityPos(values[base + 3]);
    recordSnapshotCorrectionStats(
      applyStats,
      existing.transform.x - netX,
      existing.transform.y - netY,
      existing.transform.z - netZ,
      previousTargetAgeMs,
    );
    const localUnit = existing.unit;
    if (localUnit !== null && (changedFields & ENTITY_CHANGED_VEL) !== 0) {
      recordSnapshotVelocityCorrectionStats(
        applyStats,
        (localUnit.velocityX ?? 0) - deqVel(values[base + 10]),
        (localUnit.velocityY ?? 0) - deqVel(values[base + 11]),
        (localUnit.velocityZ ?? 0) - deqVel(values[base + 12]),
      );
    }
  }

  protected unitHealthBarCacheMembership(entity: Entity): boolean {
    const unit = entity.unit;
    if (!unit) return false;
    // Mirror EntityCacheManager's cachedDamagedUnits/cachedHudEntities
    // bucket condition exactly (hp > 0 so a freshly-spawned 0-hp shell is
    // not counted as "damaged" — it rides build-in-progress instead) so
    // this predicate is a faithful membership-change detector.
    return (unit.hp > 0 && unit.hp < unit.maxHp) ||
      isBuildInProgress(entity.buildable);
  }

  protected buildingHealthBarCacheMembership(entity: Entity): boolean {
    const building = entity.building;
    if (!building) return false;
    // Mirror EntityCacheManager's cachedHealthBarBuildings bucket exactly.
    return (building.hp > 0 && building.hp < building.maxHp) ||
      isBuildInProgress(entity.buildable);
  }

  protected rebuildCachesIfNeeded(): void {
    this.cache.rebuildIfNeeded(this.entities);
  }

  /** Apply received network state and materialize non-root presentation data. */
  applyNetworkState(
    state: NetworkServerSnapshot,
    options: ClientSnapshotApplyOptions = { syncEconomy: undefined },
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
      precomputeAllUnitPathTraversabilityGrids(
        state.terrain.mapWidth,
        state.terrain.mapHeight,
      );
    }
    if (state.buildability) {
      this.terrainBuildabilityGrid = state.buildability;
    }
    this.currentTick = state.tick;
    const entityDeltaOnly = state.entityDeltaOnly === true;
    const projectileDeltaOnly = state.projectileDeltaOnly === true;
    const presentationDeltaOnly = entityDeltaOnly || projectileDeltaOnly;
    const collectCorrectionStats = options.collectCorrectionStats === true;
    const collectMaterializationStages = options.collectMaterializationStages === true;
    const deferPredictedTurretRenderRefresh =
      options.deferPredictedTurretRenderRefresh === true;
    let materializationStageStart = collectMaterializationStages ? performance.now() : 0;
    if (!presentationDeltaOnly || state.minimapEntities !== undefined) {
      this.minimapOverrideStore.applySnapshot(state.minimapEntities);
    }
    let cacheNeedsInvalidate = false;
    const now = performance.now();
    const reflectedProjectileIds = this.collectProjectileReflectionIds(state.audioEvents);
    this.projectileStore.projectileSpawns.recordSnapshot(now);
    this.projectileStore.projectileSpawns.drain(
      now,
      (spawn) => this.projectileStore.applySpawn(spawn),
    );
    materializationStageStart = recordClientApplySubstage(
      state,
      collectMaterializationStages,
      'clientApplyPrelude',
      materializationStageStart,
    );

    // Process entity records from full snapshots and sparse entity-delta
    // snapshots. Projectile-only packets intentionally carry an empty entity
    // list and must not trigger entity drift or full visible-set reconciliation.
    const entityWireSource = !projectileDeltaOnly
      ? getEntitySnapshotWireSource(state.entities)
      : undefined;
    const typedEntityWireSource =
      entityWireSource !== undefined && entityWireSource.count === state.entities.length
        ? entityWireSource
        : undefined;
    let entityApplyPath: SnapshotMaterializationStage | undefined = undefined;
    if (
      !projectileDeltaOnly &&
      !entityDeltaOnly &&
      !collectCorrectionStats &&
      typedEntityWireSource !== undefined &&
      this.canApplyTypedFullSnapshotSource(typedEntityWireSource) &&
      this.tryApplyTypedFullSnapshotSource(typedEntityWireSource, now)
    ) {
      entityApplyPath = 'clientApplyEntitiesTypedFull';
      // Applied by tryApplyTypedFullSnapshotSource above.
    } else if (
      !projectileDeltaOnly &&
      entityDeltaOnly &&
      !collectCorrectionStats &&
      typedEntityWireSource !== undefined &&
      this.tryApplyTypedPlaceholderDeltaSource(
        typedEntityWireSource,
        state.entities,
        now,
        deferPredictedTurretRenderRefresh,
        applyStats,
      )
    ) {
      entityApplyPath = 'clientApplyEntitiesTypedPlaceholder';
      // Applied by tryApplyTypedPlaceholderDeltaSource above.
    } else if (
      !projectileDeltaOnly &&
      entityDeltaOnly &&
      !collectCorrectionStats &&
      typedEntityWireSource !== undefined &&
      this.canApplyBasicTransformTypedDeltaSource(typedEntityWireSource, state.entities)
    ) {
      entityApplyPath = 'clientApplyEntitiesBasicTyped';
      this.applyBasicTransformTypedDeltaSource(typedEntityWireSource, now);
    } else if (
      !projectileDeltaOnly &&
      entityDeltaOnly &&
      typedEntityWireSource !== undefined &&
      this.canApplyMetadataTypedDeltaSource(typedEntityWireSource, state.entities)
    ) {
      entityApplyPath = 'clientApplyEntitiesMetadataTyped';
      this.applyMetadataTypedDeltaSource(typedEntityWireSource);
    } else if (!projectileDeltaOnly) {
      entityApplyPath = 'clientApplyEntitiesGeneric';
      let genericSubstageStart = collectMaterializationStages ? performance.now() : 0;
      const genericTypedPlaceholdersApplied =
        !collectCorrectionStats &&
        typedEntityWireSource !== undefined &&
        typedEntityWireSource.typedPlaceholderRows > 0 &&
        this.applyMixedTypedPlaceholderRows(
          typedEntityWireSource,
          now,
          deferPredictedTurretRenderRefresh,
          applyStats,
        );
      if (genericTypedPlaceholdersApplied && collectMaterializationStages) {
        addSnapshotMaterializationStageToSnapshot(
          state,
          'clientApplyEntitiesGenericTyped',
          performance.now() - genericSubstageStart,
        );
        genericSubstageStart = performance.now();
      }
      const entityLoopCount =
        genericTypedPlaceholdersApplied &&
        typedEntityWireSource !== undefined
          ? typedEntityWireSource.nonPlaceholderEntityRows
          : state.entities.length;
      const entityLoopIndices =
        genericTypedPlaceholdersApplied &&
        typedEntityWireSource !== undefined
          ? typedEntityWireSource.nonPlaceholderEntityIndices
          : undefined;
      for (let entityLoopIndex = 0; entityLoopIndex < entityLoopCount; entityLoopIndex++) {
        const entityIndex = entityLoopIndices !== undefined
          ? entityLoopIndices[entityLoopIndex]
          : entityLoopIndex;
        if (entityIndex >= state.entities.length) {
          continue;
        }
        let appliedTypedEntity = false;
        if (typedEntityWireSource !== undefined) {
          switch (typedEntityWireSource.kinds[entityIndex]) {
            case ENTITY_SNAPSHOT_WIRE_KIND_BASIC:
              appliedTypedEntity = this.tryApplyBasicTypedDeltaWireRow(
                typedEntityWireSource,
                entityIndex,
                now,
                collectCorrectionStats,
                applyStats,
              );
              break;
            case ENTITY_SNAPSHOT_WIRE_KIND_UNIT:
              if (
                !collectCorrectionStats &&
                typedEntityWireRowIsFull(typedEntityWireSource, entityIndex)
              ) {
                appliedTypedEntity = this.tryApplyUnitTypedFullWireRow(
                  typedEntityWireSource,
                  entityIndex,
                  now,
                );
              } else {
                appliedTypedEntity = this.tryApplyUnitTypedDeltaWireRow(
                  typedEntityWireSource,
                  entityIndex,
                  now,
                  collectCorrectionStats,
                  deferPredictedTurretRenderRefresh,
                  applyStats,
                );
              }
              break;
            case ENTITY_SNAPSHOT_WIRE_KIND_BUILDING:
              if (
                !collectCorrectionStats &&
                typedEntityWireRowIsFull(typedEntityWireSource, entityIndex)
              ) {
                appliedTypedEntity = this.tryApplyBuildingTypedFullWireRow(
                  typedEntityWireSource,
                  entityIndex,
                  now,
                );
              } else {
                appliedTypedEntity = this.tryApplyBuildingTypedDeltaWireRow(
                  typedEntityWireSource,
                  entityIndex,
                  now,
                  deferPredictedTurretRenderRefresh,
                );
              }
              break;
          }
        }
        if (appliedTypedEntity) {
          continue;
        }

        if (
          typedEntityWireSource !== undefined &&
          !collectCorrectionStats &&
          typedEntityWireRowIsFull(typedEntityWireSource, entityIndex)
        ) {
          const typedEntityId = typedEntityWireRowId(typedEntityWireSource, entityIndex);
          const createdEntity = typedEntityId !== null && !this.entities.has(typedEntityId)
            ? createEntityFromTypedFullWireRow(
                typedEntityWireSource,
                entityIndex,
              )
            : null;
          if (
            createdEntity !== null &&
            createdEntity.id === typedEntityId
          ) {
            this.attachCreatedNetworkEntity(createdEntity);
            continue;
          }
        }

        const netEntity = state.entities[entityIndex];
        if (netEntity === undefined) continue;
        const cf = netEntity.changedFields;
        const isFull = cf == null;
        // Static hosts have no velocity and publish mounted turrets through
        // server.building.turrets.
        const isBuildingUpdate = netEntity.type === 'building';
        const existing = this.entities.get(netEntity.id);
        const previousTarget = collectCorrectionStats
          ? this.serverTargets.get(netEntity.id)
          : undefined;
        const previousTargetAgeMs =
          previousTarget !== undefined && previousTarget.updatedAtMs
            ? Math.max(0, now - previousTarget.updatedAtMs)
            : 0;
        if (isBuildingUpdate) {
          // Building bodies are static, but armed buildings still use the
          // same turret target/prediction path as units.
          const turretSnapshot = netEntity.building !== null ? netEntity.building.turrets : null;
          if (turretSnapshot) {
            const target = this.getOrCreateServerTarget(netEntity.id);
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
          }
        } else {
          // Copy drift-relevant fields into owned ServerTarget (avoids holding pooled object refs)
          const target = this.getOrCreateServerTarget(netEntity.id);
          applyNetworkUnitDriftFieldsToTarget(target, netEntity, isFull, cf);
          this.copyNetworkTurretsToTarget(target, netEntity.unit !== null ? netEntity.unit.turrets : null, isFull);
          target.updatedAtMs = now;
        }

        if (
          collectCorrectionStats &&
          existing &&
          netEntity.pos &&
          (cf == null || (cf & ENTITY_CHANGED_POS) !== 0)
        ) {
          const netX = deqEntityPos(netEntity.pos.x);
          const netY = deqEntityPos(netEntity.pos.y);
          const netZ = deqEntityPos(netEntity.pos.z);
          recordSnapshotCorrectionStats(
            applyStats,
            existing.transform.x - netX,
            existing.transform.y - netY,
            existing.transform.z - netZ,
            previousTargetAgeMs,
          );
          const netVelocity = netEntity.unit !== null ? netEntity.unit.velocity : null;
          const localUnit = existing.unit;
          if (localUnit && netVelocity && (isFull || (cf & ENTITY_CHANGED_VEL) !== 0)) {
            recordSnapshotVelocityCorrectionStats(
              applyStats,
              (localUnit.velocityX ?? 0) - deqVel(netVelocity.x),
              (localUnit.velocityY ?? 0) - deqVel(netVelocity.y),
              (localUnit.velocityZ ?? 0) - deqVel(netVelocity.z),
            );
          }
        }

        if (!existing) {
          // Full-state lockstep snapshots create entities immediately. The
          // changedFields guard only protects old sparse fixtures/tools.
          if (netEntity.changedFields != null) continue;

          const newEntity = createEntityFromNetwork(netEntity);
          if (newEntity) {
            this.attachCreatedNetworkEntity(newEntity);
          }
        } else {
          // Existing entity — snap non-visual state immediately. The entity
          // cache is rebuilt only for structural/per-player bucket changes.
          // HUD/health-bar bucket transitions are refreshed incrementally so
          // a damage/heal row does not force a full copy-all + sort + rebucket.
          // Pure unit motion rows only update ServerTarget; ClientPredictionStepper
          // mutates the visual entity and refreshes typed render state later in
          // the same frame.
          const unitMotionOnly = this.snapshotIsUnitMotionOnly(existing, netEntity);
          const ownershipChanged = !unitMotionOnly && this.snapshotChangesOwnership(existing, netEntity);
          const mayAffectHealthBarCache = !unitMotionOnly &&
            !ownershipChanged &&
            this.snapshotMayAffectHealthBarCacheMembership(existing, netEntity);
          const healthBarCacheMemberBefore = mayAffectHealthBarCache
            ? this.healthBarCacheMembership(existing)
            : false;
          if (ownershipChanged) cacheNeedsInvalidate = true;
          if (!unitMotionOnly) {
            snapClientNonVisualState(existing, netEntity);
            if (
              mayAffectHealthBarCache &&
              healthBarCacheMemberBefore !== this.healthBarCacheMembership(existing)
            ) {
              this.cache.refreshHealthBarEntity(existing);
            }
            this.refreshRenderableEntityStateFromSnapshot(
              existing,
              this.snapshotAffectsRenderSpatialIndex(netEntity),
            );
            this.refreshLocomotionSupportSurfaceProvider(existing);
          }
          this.markNetworkEntityPredictionActive(netEntity);
        }
      }
      if (
        genericTypedPlaceholdersApplied &&
        collectMaterializationStages
      ) {
        addSnapshotMaterializationStageToSnapshot(
          state,
          'clientApplyEntitiesGenericDto',
          performance.now() - genericSubstageStart,
        );
      }
    }
    if (entityApplyPath !== undefined && collectMaterializationStages) {
      addSnapshotMaterializationStageToSnapshot(
        state,
        entityApplyPath,
        performance.now() - materializationStageStart,
      );
    }
    materializationStageStart = recordClientApplySubstage(
      state,
      collectMaterializationStages,
      'clientApplyEntities',
      materializationStageStart,
    );

    if (!projectileDeltaOnly && state.removedEntityIds) {
      let removedAnyLocalEntity = false;
      for (const id of state.removedEntityIds) {
        removedAnyLocalEntity = this.deleteEntityLocalState(id, true) || removedAnyLocalEntity;
      }
      this.markSnapshotRemovalsApplied(removedAnyLocalEntity);
    }

    // Full-state snapshot: remove non-projectile entities not present
    // in the visible snapshot. Visibility-filtered snapshots omit
    // out-of-sight entities by design.
    if (!presentationDeltaOnly) {
      const removeIds = this.collectFullSnapshotRemoveIds(
        state.entities,
        typedEntityWireSource,
      );
      let removedAnyLocalEntity = false;
      for (let i = 0; i < removeIds.length; i++) {
        removedAnyLocalEntity =
          this.deleteEntityLocalState(removeIds[i], true) || removedAnyLocalEntity;
      }
      this.markSnapshotRemovalsApplied(removedAnyLocalEntity);
    }
    materializationStageStart = recordClientApplySubstage(
      state,
      collectMaterializationStages,
      'clientApplyRemovals',
      materializationStageStart,
    );

    const projectiles = state.projectiles;
    if (projectiles !== undefined && projectiles !== null) {
      let projectileSubstageStart = collectMaterializationStages ? performance.now() : 0;
      const directProjectileSource = getActiveProjectileSnapshotWireSource(projectiles);
      const directProjectileRows =
        projectileWireSourceHasDirectlyConsumableRows(directProjectileSource);
      const packedProjectiles = directProjectileRows
        ? undefined
        : getPackedProjectileSnapshotWire(projectiles);
      projectileSubstageStart = recordClientApplySubstage(
        state,
        collectMaterializationStages,
        'clientApplyProjectileSetup',
        projectileSubstageStart,
      );
      const appliedDirectSpawns = directProjectileRows
        ? this.applyProjectileWireSourceSpawns(directProjectileSource, now)
        : false;
      const spawns = appliedDirectSpawns ? undefined : projectiles.spawns;

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
      projectileSubstageStart = recordClientApplySubstage(
        state,
        collectMaterializationStages,
        'clientApplyProjectileSpawns',
        projectileSubstageStart,
      );

      // Server-authored live beam/laser paths. These carry current
      // start/end/reflection points so the client can draw beams without
      // running local mirror/unit/building beam traces in applyPrediction.
      const appliedDirectBeamUpdates = directProjectileRows
        ? this.applyProjectileWireSourceBeamUpdates(directProjectileSource, now)
        : false;
      const beamUpdates = appliedDirectBeamUpdates ? undefined : projectiles.beamUpdates;
      if (beamUpdates !== undefined && beamUpdates !== null) {
        for (const update of beamUpdates) {
          this.projectileStore.applyBeamUpdate(update, now);
        }
      }
      projectileSubstageStart = recordClientApplySubstage(
        state,
        collectMaterializationStages,
        'clientApplyProjectileBeams',
        projectileSubstageStart,
      );

      // Process projectile despawn events (after spawns, so same-snapshot spawn+despawn works)
      const appliedDirectDespawns = directProjectileRows
        ? this.applyProjectileWireSourceDespawns(directProjectileSource)
        : false;
      const appliedPackedDespawns = !appliedDirectDespawns && packedProjectiles !== undefined
        ? forEachPackedProjectileDespawn(
            packedProjectiles,
            (id) => this.deleteProjectileLocalState(id as EntityId),
          )
        : false;
      const despawns = appliedDirectDespawns || appliedPackedDespawns
        ? undefined
        : projectiles.despawns;
      if (despawns !== undefined && despawns !== null) {
        for (const despawn of despawns) {
          this.deleteProjectileLocalState(despawn.id);
        }
      }
      projectileSubstageStart = recordClientApplySubstage(
        state,
        collectMaterializationStages,
        'clientApplyProjectileDespawns',
        projectileSubstageStart,
      );

      // Retain decoded motion rows for isolated snapshot-consumer recovery.
      // Same-process lockstep presentation overwrites roots from Rust/WASM.
      const appliedDirectMotionUpdates = directProjectileRows
        ? this.applyProjectileWireSourceMotionUpdates(directProjectileSource, now)
        : false;
      const appliedPackedMotionUpdates = !appliedDirectMotionUpdates && packedProjectiles !== undefined
        ? forEachPackedProjectileMotionUpdate(
            packedProjectiles,
            (
              id,
              qposX,
              qposY,
              qposZ,
              qvelX,
              qvelY,
              qvelZ,
              qrotation,
              qangularVelocity,
            ) => this.applyProjectileMotionUpdateFields(
              id as EntityId,
              qposX,
              qposY,
              qposZ,
              qvelX,
              qvelY,
              qvelZ,
              qrotation,
              qangularVelocity,
              now,
            ),
          )
        : false;
      const motionUpdates = appliedDirectMotionUpdates || appliedPackedMotionUpdates
        ? undefined
        : projectiles.motionUpdates;
      if (motionUpdates !== undefined && motionUpdates !== null) {
        for (const vu of motionUpdates) {
          this.applyProjectileMotionUpdateFields(
            vu.id,
            vu.pos.x,
            vu.pos.y,
            vu.pos.z,
            vu.velocity.x,
            vu.velocity.y,
            vu.velocity.z,
            vu.rotation,
            vu.angularVelocity,
            now,
          );
        }
      }
      recordClientApplySubstage(
        state,
        collectMaterializationStages,
        'clientApplyProjectileMotion',
        projectileSubstageStart,
      );
    }
    materializationStageStart = recordClientApplySubstage(
      state,
      collectMaterializationStages,
      'clientApplyProjectiles',
      materializationStageStart,
    );

    if (cacheNeedsInvalidate) this.invalidateCaches();

    // Update economy state (immediate). Local in-memory clients share
    // the local server's economy singleton, so they must not
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

    if (!presentationDeltaOnly || state.resourceMovements !== undefined) {
      this.applyResourceMovements(state.resourceMovements);
    }
    if (!presentationDeltaOnly || state.sprayTargets !== undefined) {
      this.sprayTargetStore.applySnapshot(state.sprayTargets);
    }

    // Store audio events for processing (reuse constant for empty case)
    this.pendingAudioEvents = state.audioEvents ?? EMPTY_AUDIO;

    // Stash the exact shield / shield-panel contact point on the
    // reflected projectile so the curved-cone tail renderer can insert
    // it as a forced trail stamp on the next frame. Projectile root motion
    // remains on the shared adjacent-tick pose path. Audio event position is
    // unquantized f64.
    const audioEventsForReflection = this.pendingAudioEvents;
    if (
      reflectedProjectileIds !== null &&
      audioEventsForReflection !== undefined &&
      audioEventsForReflection.length > 0
    ) {
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
    if (!presentationDeltaOnly || state.scanPulses !== undefined || state.serverMeta !== undefined) {
      const incomingPulses = state.scanPulses;
      if (incomingPulses && incomingPulses.length > 0) {
        this.scanPulses.length = incomingPulses.length;
        for (let i = 0; i < incomingPulses.length; i++) {
          this.scanPulses[i] = incomingPulses[i];
        }
      } else {
        this.scanPulses.length = 0;
      }
    }

    // Track authoritative game phase (battle / paused / gameOver)
    const gameState = state.gameState;
    if (gameState !== undefined && gameState !== null) {
      this.gamePhase = gameState.phase;
      if (gameState.phase === 'gameOver' && gameState.winnerId !== undefined) {
        this.gameOverWinnerId = gameState.winnerId;
      }
    }

    // Store server metadata
    const serverMeta = state.serverMeta;
    if (serverMeta !== undefined && serverMeta !== null) {
      this.serverMeta = serverMeta;
    }
    if (!presentationDeltaOnly || state.visionPlayerMask !== undefined) {
      this.visionPlayerMask = state.visionPlayerMask ?? 0;
    }
    recordClientApplySubstage(
      state,
      collectMaterializationStages,
      'clientApplyStores',
      materializationStageStart,
    );
    return applyStats;
  }


  protected refreshRenderableEntityStateAndSpatialIndex(entity: Entity): void {
    const slot = this.refreshRenderableEntityState(entity);
    if (slot !== undefined) {
      this.renderSpatialIndex.updateSlot(this.renderEntityState.getViews(), slot);
    } else {
      this.renderSpatialIndex.remove(entity.id);
    }
  }

  protected refreshRenderableEntityStateFromSnapshot(
    entity: Entity,
    refreshSpatialIndex: boolean,
  ): void {
    const slot = this.refreshRenderableEntityState(entity);
    if (slot === undefined) {
      this.renderSpatialIndex.remove(entity.id);
      return;
    }
    if (refreshSpatialIndex) {
      this.renderSpatialIndex.updateSlot(this.renderEntityState.getViews(), slot);
    }
  }

  protected refreshRenderableEntityStateSnapshotDelta(
    entity: Entity,
    refreshHealth: boolean,
    refreshTurrets: boolean,
    refreshBuild: boolean,
  ): void {
    let slot: number | undefined;
    if (refreshHealth) slot = this.renderEntityState.refreshHealth(entity);
    if (refreshBuild) slot = this.renderEntityState.refreshBuildState(entity);
    if (refreshTurrets) slot = this.renderEntityState.refreshTurretMetadata(entity);
    if (!refreshHealth && !refreshTurrets && !refreshBuild) {
      slot = this.renderEntityState.getSlot(entity.id)
        ?? this.renderEntityState.refreshEntity(entity);
    }
    if (slot === undefined) {
      this.renderSpatialIndex.remove(entity.id);
      return;
    }
    if (refreshTurrets) this.renderTurretState.refreshHost(entity, slot);
  }

  protected refreshRenderableEntityState(entity: Entity): number | undefined {
    const slot = this.renderEntityState.refreshEntity(entity);
    if (slot !== undefined) this.renderTurretState.refreshHost(entity, slot);
    return slot;
  }

  protected refreshRenderEntityStateById(id: EntityId): number | undefined {
    const entity = this.entities.get(id);
    if (entity !== undefined) {
      const slot = this.renderEntityState.refreshEntity(entity);
      if (slot !== undefined) this.renderTurretState.refreshHost(entity, slot);
      return slot;
    }
    const slot = this.renderEntityState.getSlot(id);
    if (slot !== undefined) this.renderTurretState.unsetHostSlot(slot);
    this.renderEntityState.unsetEntity(id);
    return undefined;
  }

  protected refreshAllRenderableEntityStates(): void {
    for (const entity of this.entities.values()) {
      if (entity.unit !== null || entity.building !== null) {
        const slot = this.renderEntityState.refreshEntity(entity);
        if (slot !== undefined) this.renderTurretState.refreshHost(entity, slot);
      }
    }
  }

  protected getOrRefreshRenderEntityStateSlot(entity: Entity): number | undefined {
    const existing = this.renderEntityState.getSlot(entity.id);
    if (existing !== undefined) return existing;
    const slot = this.renderEntityState.refreshEntity(entity);
    if (slot !== undefined) this.renderTurretState.refreshHost(entity, slot);
    return slot;
  }


}
