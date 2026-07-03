/**
 * ClientViewState - Manages the "client view" of the game state
 *
 * Uses EMA (Exponential Moving Average) + DEAD RECKONING for smooth rendering:
 * - On snapshot: store server's authoritative state as "targets"
 * - Every frame: predict from last-seen velocity, then drift toward server targets
 * - Smooth at any snapshot rate, from 1/sec to 60/sec
 */

import type { Entity, PlayerId, EntityId, FactoryDefaultWaypoint } from '../sim/types';
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
  ENTITY_CHANGED_ACTIONS,
  ENTITY_CHANGED_FACTORY,
  ENTITY_CHANGED_NORMAL,
  ENTITY_CHANGED_TURRETS,
  RESOURCE_FLOW_OUTBOUND,
  RESOURCE_KIND_ENERGY,
  RESOURCE_KIND_METAL,
  codeToUnitBlueprintId,
  codeToTurretState,
  type GamePhase,
  type ResourceFlowDirectionCode,
  type ResourceKindCode,
} from '../../types/network';

import { setAuthoritativeTerrainTileMap } from '../sim/Terrain';
import { EntityCacheManager } from '../sim/EntityCacheManager';
import { ClientMinimapOverrideStore } from './ClientMinimapOverrideStore';
import { ClientSprayTargetStore } from './ClientSprayTargetStore';
import {
  resetClientPredictionTargetPools,
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
  ENTITY_SNAPSHOT_WIRE_WAYPOINT_STRIDE,
  getEntitySnapshotWireSource,
  type EntitySnapshotWireSource,
} from './stateSerializerEntities';
import {
  forEachPackedProjectileDespawn,
  forEachPackedProjectileVelocityUpdate,
  getPackedProjectileSnapshotWire,
} from './snapshotProjectileWirePack';
import {
  forEachProjectileWireSourceSpawnFromSource,
  getActiveProjectileSnapshotWireSource,
  PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_FALSE,
  PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_TRUE,
  PROJECTILE_BEAM_UPDATE_FLAG_OBSTRUCTION_T,
  PROJECTILE_BEAM_UPDATE_WIRE_STRIDE,
  PROJECTILE_VELOCITY_WIRE_STRIDE,
  projectileWireSourceHasDirectlyConsumableRows,
  type ProjectileSnapshotWireSource,
} from './stateSerializerProjectiles';
import {
  addSnapshotMaterializationStageToSnapshot,
  type SnapshotMaterializationStage,
} from './snapshotMaterializationMetadata';
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
import { getLocomotionSurfaceHeight } from '../render3d/LocomotionTerrainSampler';
import type {
  BuildingRenderPacket3D,
  UnitRenderPacket3D,
} from '../render3d/EntityRenderPackets3D';
import type { EntityLodEmission3D } from '../render3d/EntityLod3D';
import {
  CLIENT_RENDER_ENTITY_FLAG_BUILD_IN_PROGRESS,
  CLIENT_RENDER_ENTITY_FLAG_SELECTED,
  CLIENT_RENDER_ENTITY_KIND_BUILDING,
  CLIENT_RENDER_ENTITY_KIND_UNIT,
  ClientRenderEntityStateSlab,
} from '../render3d/ClientRenderEntityStateSlab';
import {
  ClientRenderTurretStateSlab,
  type ClientRenderTurretHostRows,
} from '../render3d/ClientRenderTurretStateSlab';
import { isUnitGroundPenetrationInContact } from '../sim/unitGroundPhysics';

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

type ClientViewRenderEntityPackets3D = {
  unitRows: UnitRenderPacket3D;
  buildingRows: BuildingRenderPacket3D;
  bodyHud: BodyHudRenderPacket3D;
  shields: ShieldRenderPacket3D;
  pieceNames: PieceNameRenderPacket3D;
  contactShadows: ContactShadowRenderPacket3D;
  groundPrints: GroundPrintRenderPacket3D;
};

type ClientViewRenderPacketOptions3D = {
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
  isEntityFarLod?: (entity: Entity) => boolean;
  isEntityEmissionFarLod?: (entity: Entity, emission: EntityLodEmission3D) => boolean;
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

export class ClientViewState {
  // Entity storage for rendering (client-predicted positions)
  private entities = new ClientEntityStore();

  // Server target state — owned copies of drift-relevant fields per entity
  private serverTargets = new ClientServerTargetStore();
  private projectileStore!: ClientProjectileStore;
  private readonly directProjectileSpawnScratch = createSpawnDto();

  private sprayTargetStore = new ClientSprayTargetStore();
  private resourcePylonSignedRates = new IndexedEntityIdMap<ClientResourcePylonSignedRates>();
  private resourcePylonFlowsBySource = new IndexedEntityIdMap<ClientResourcePylonFlow[]>();
  private readonly resourcePylonSourceIds: EntityId[] = [];

  // Audio events from last state update
  private pendingAudioEvents: NetworkServerSnapshot['audioEvents'] = [];

  /** Active temporary vision pulses (FOW-14) the server has confirmed
   *  for this client's team. Mirror of WorldState.scanPulses filtered
   *  through SnapshotVisibility. Snapshot applier overwrites this on
   *  each snapshot; expired entries are pruned authoritatively before
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

  // Reusable Set for full-state membership reconciliation.
  private _serverIds: Set<EntityId> = new ClientEntityIdSet();
  private readonly _fullReconcileRemoveIds: EntityId[] = [];
  private _projectileReflectionIds: Set<EntityId> = new ClientEntityIdSet();

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
  private renderEntityState = new ClientRenderEntityStateSlab();
  private renderTurretState = new ClientRenderTurretStateSlab();
  private readonly scopedRenderIncludedIds = new IndexedEntityIdSet();
  private readonly scopedRenderUnitSlots: number[] = [];
  private readonly scopedRenderBuildingSlots: number[] = [];
  private readonly scopedRenderUnitRowSlots: number[] = [];
  private readonly scopedRenderBuildingRowSlots: number[] = [];
  private entitySetVersion = 0;

  private predictionCadence = new ClientPredictionCadence();
  private activeEntityPredictionIds: Set<EntityId> = new ClientEntityIdSet();
  private dirtyUnitRenderIds: Set<EntityId> = new ClientEntityIdSet();
  private dirtyBuildingRenderIds: Set<EntityId> = new ClientEntityIdSet();
  private removedUnitRenderIds: EntityId[] = [];
  private removedBuildingRenderIds: EntityId[] = [];
  private renderLifecycleDirtyIds: Set<EntityId> = new ClientEntityIdSet();
  private predictionSupportSurfaceEntities: Entity[] = [];
  private predictionSupportSurfaceEntityIds = new IndexedEntityIdSet();
  private selectionState = new ClientSelectionState(
    this.entities,
    this.dirtyUnitRenderIds,
    this.dirtyBuildingRenderIds,
    (entity) => this.markEntityPredictionActive(entity),
  );
  private predictionStepper!: ClientPredictionStepper;

  // Map dimensions — needed to evaluate the installed server-authored
  // terrain tile map on the client side. Before the first terrain
  // snapshot arrives, clients fall back to the deterministic authored
  // height function using these same dimensions.
  private mapWidth: number = 2000;
  private mapHeight: number = 2000;

  constructor() {
    this.projectileStore = new ClientProjectileStore({
      entities: this.entities,
      handleEntityAdded: (entity) => this.handleLocalEntityAdded(entity),
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
      getWind: () => this.serverMeta?.wind,
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
      markBeamHostRenderDirty: (beamEntity) => this.markBeamHostRenderDirty(beamEntity),
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
    this.cache.invalidate();
  }

  private handleLocalEntityAdded(entity: Entity): void {
    this.cache.handleEntityAdded(entity);
    this.entitySetVersion++;
  }

  private handleLocalEntityRemoved(entity: Entity, deferEntitySetChange: boolean): void {
    this.cache.handleEntityRemoved(entity);
    if (!deferEntitySetChange) this.entitySetVersion++;
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
    return this.serverTargets.getOrCreate(id);
  }

  private collectProjectileReflectionIds(
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
    resizeServerTargetTurrets(target, 0);
    target.updatedAtMs = now;
  }

  private applyProjectileVelocityUpdateFields(
    id: EntityId,
    qposX: number,
    qposY: number,
    qposZ: number,
    qvelX: number,
    qvelY: number,
    qvelZ: number,
    targetEntityId: EntityId | null,
    clearHomingTarget: boolean,
    now: number,
    reflectedProjectileIds: Set<EntityId> | null,
  ): void {
    const entity = this.entities.get(id);
    if (entity === undefined || entity.projectile === null) return;

    const x = deqProjPos(qposX);
    const y = deqProjPos(qposY);
    const z = deqProjPos(qposZ);
    const velocityX = deqVel(qvelX);
    const velocityY = deqVel(qvelY);
    const velocityZ = deqVel(qvelZ);
    const shouldSmoothRocket =
      entity.projectile.config.shotProfile.runtime.isRocketLike === true &&
      (reflectedProjectileIds === null || !reflectedProjectileIds.has(id));
    if (shouldSmoothRocket) {
      this.writeRocketVelocityTarget(id, x, y, z, velocityX, velocityY, velocityZ, now);
    } else {
      entity.transform.x = x;
      entity.transform.y = y;
      entity.transform.z = z;
      entity.projectile.velocityX = velocityX;
      entity.projectile.velocityY = velocityY;
      entity.projectile.velocityZ = velocityZ;
      if (this.serverTargets.has(id)) this.serverTargets.delete(id);
    }
    if (targetEntityId !== null) {
      entity.projectile.homingTargetId = targetEntityId;
    } else if (clearHomingTarget) {
      entity.projectile.homingTargetId = NO_ENTITY_ID;
    }
    if (shouldSmoothRocket) {
      this.projectileStore.markVelocityTargetUpdateActive(entity, id);
    } else {
      this.projectileStore.markVelocityUpdateActive(entity, id);
    }
  }

  private applyProjectileWireSourceDespawns(
    source: ProjectileSnapshotWireSource | undefined,
  ): boolean {
    if (source === undefined) return false;
    const rows = source.despawns;
    if (rows.count === 0) return false;
    const values = rows.values;
    for (let i = 0; i < rows.count; i++) {
      this.deleteEntityLocalState(values[i] as EntityId);
    }
    return true;
  }

  private applyProjectileWireSourceVelocityUpdates(
    source: ProjectileSnapshotWireSource | undefined,
    now: number,
    reflectedProjectileIds: Set<EntityId> | null,
  ): boolean {
    if (source === undefined) return false;
    const rows = source.velocityUpdates;
    if (rows.count === 0) return false;
    const values = rows.values;
    for (let i = 0; i < rows.count; i++) {
      const base = i * PROJECTILE_VELOCITY_WIRE_STRIDE;
      const targetEntityId = values[base + 8];
      this.applyProjectileVelocityUpdateFields(
        values[base + 0] as EntityId,
        values[base + 1],
        values[base + 2],
        values[base + 3],
        values[base + 4],
        values[base + 5],
        values[base + 6],
        targetEntityId > 0 ? targetEntityId as EntityId : null,
        values[base + 7] !== 0,
        now,
        reflectedProjectileIds,
      );
    }
    return true;
  }

  private applyProjectileWireSourceBeamUpdates(
    source: ProjectileSnapshotWireSource | undefined,
    now: number,
  ): boolean {
    if (source === undefined) return false;
    const rows = source.beamUpdates;
    if (rows.count === 0) return false;
    const headers = rows.values;
    const pointValues = source.beamPoints.values;
    let pointOffset = 0;
    for (let i = 0; i < rows.count; i++) {
      const base = i * PROJECTILE_BEAM_UPDATE_WIRE_STRIDE;
      const flags = headers[base + 1];
      const pointCount = Math.max(0, headers[base + 3]) | 0;
      if (pointOffset + pointCount > source.beamPoints.count) return i > 0;
      let endpointDamageable: boolean | null;
      if ((flags & PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_TRUE) !== 0) {
        endpointDamageable = true;
      } else if ((flags & PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_FALSE) !== 0) {
        endpointDamageable = false;
      } else {
        endpointDamageable = null;
      }
      this.projectileStore.applyBeamUpdateWireFields(
        headers[base + 0] as EntityId,
        (flags & PROJECTILE_BEAM_UPDATE_FLAG_OBSTRUCTION_T) !== 0
          ? headers[base + 2]
          : null,
        endpointDamageable,
        pointValues,
        pointOffset,
        pointCount,
        now,
      );
      pointOffset += pointCount;
    }
    return true;
  }

  private copyNetworkTurretsToTarget(
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
        target.turrets[i].shieldRange = turrets[i].currentShieldRange ?? null;
      }
      return true;
    }
    if (isFull) resizeServerTargetTurrets(target, 0);
    return false;
  }

  private copyWireUnitTurretsToTarget(
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
      targetTurret.shieldRange = rows[rowBase + 8] !== 0 ? rows[rowBase + 9] : null;
      if (i >= entityTurretLimit || entityTurrets === undefined) continue;
      const entityTurret = entityTurrets[i];
      if (rows[rowBase + 10] !== 0) {
        entityTurret.target = null;
        entityTurret.state = 'idle';
        entityTurret.shield = null;
        continue;
      }
      entityTurret.target = rows[rowBase + 6] !== 0 ? (rows[rowBase + 7] | 0) as EntityId : null;
      entityTurret.state = codeToTurretState(rows[rowBase + 5]);
    }
    return true;
  }

  private deleteEntityLocalState(id: EntityId, deferEntitySetChange = false): boolean {
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

  private markSnapshotRemovalsApplied(changed: boolean): void {
    if (changed) this.entitySetVersion++;
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

  /** A beam's rendered polyline moved this frame. Beam-directed ray
   *  turrets (turretBarrelFollowsBeam) are posed from that polyline by the
   *  turret-pose passes, and the building renderer only re-poses dirty
   *  rows — a beam tower whose aim is pinned to zero on the wire never
   *  dirties through snapshots while its beam sweeps. Dirty the emitting
   *  host's building row so the pose pass reads the fresh beam direction
   *  this same frame. Units re-pose every frame and need no mark. */
  private markBeamHostRenderDirty(beamEntity: Entity): void {
    const proj = beamEntity.projectile;
    if (proj === null) return;
    this.markBuildingRenderDirty(proj.sourceEntityId);
    const ss = proj.shotSource;
    if (ss !== undefined && ss !== null) {
      this.markBuildingRenderDirty(ss.sourceHostEntityId);
      this.markBuildingRenderDirty(ss.sourceRootEntityId);
    }
  }

  private markBuildingRenderDirty(id: EntityId): void {
    if (!id) return;
    const entity = this.entities.get(id);
    if (entity !== undefined && entity.building !== null) {
      this.dirtyBuildingRenderIds.add(id);
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

  private snapshotChangesOwnership(
    entity: Entity,
    server: NetworkServerSnapshotEntity,
  ): boolean {
    // Ownership transfer (capture) moves the entity between per-player
    // cache buckets, so it still needs a full cache rebuild.
    return entity.ownership !== null && entity.ownership.playerId !== server.playerId;
  }

  private snapshotMayAffectHealthBarCacheMembership(
    entity: Entity,
    server: NetworkServerSnapshotEntity,
  ): boolean {
    const cf = server.changedFields;
    return (entity.unit !== null || entity.building !== null) &&
      (cf == null || (cf & (ENTITY_CHANGED_HP | ENTITY_CHANGED_BUILDING)) !== 0);
  }

  private healthBarCacheMembership(entity: Entity): boolean {
    if (entity.unit !== null) return this.unitHealthBarCacheMembership(entity);
    if (entity.building !== null) return this.buildingHealthBarCacheMembership(entity);
    return false;
  }

  private snapshotAffectsRenderSpatialIndex(server: NetworkServerSnapshotEntity): boolean {
    const changedFields = server.changedFields;
    return changedFields == null || (changedFields & ENTITY_CHANGED_POS) !== 0;
  }

  private snapshotIsUnitMotionOnly(
    entity: Entity,
    server: NetworkServerSnapshotEntity,
  ): boolean {
    if (server.type !== 'unit' || entity.unit === null) return false;
    const changedFields = server.changedFields;
    if (changedFields == null || changedFields === 0) return false;
    if ((changedFields & ~CLIENT_UNIT_MOTION_DELTA_FIELDS) !== 0) return false;
    return entity.ownership !== null && entity.ownership.playerId === server.playerId;
  }

  private renderSlotMatchesSnapshotOwner(
    id: EntityId,
    playerId: PlayerId,
    expectedKind: number,
  ): boolean {
    const slot = this.renderEntityState.getSlot(id);
    if (slot === undefined) return false;
    const views = this.renderEntityState.getViews();
    return views.kind[slot] === expectedKind && views.ownerIds[slot] === playerId;
  }

  private canApplyBasicTransformTypedDeltaWireRow(
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

  private applyBasicTransformTypedDeltaWireRow(
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

  private tryApplyBasicTypedDeltaWireRow(
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
          const dx = existing.transform.x - x;
          const dy = existing.transform.y - y;
          const dz = existing.transform.z - z;
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

  private canApplyBasicTransformTypedDeltaSource(
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

  private applyBasicTransformTypedDeltaSource(
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

  private tryApplyUnitTypedDeltaWireRow(
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

  private tryApplyUnitTypedDeltaWireRowAt(
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
      if (existing.builder !== null && values[base + 38] !== 0) {
        existing.builder.lowPriority = false;
        existing.builder.currentBuildTarget = values[base + 39] === 0
          ? values[base + 40] as EntityId
          : NO_ENTITY_ID;
      }
    }
    if (hasFactoryFields) {
      if (existing.factory === null || values[base + 64] === 0) return false;
      existing.factory.carrierSpawnEnabled = values[base + 65] !== 0;
    }

    const refreshTurretsNow = copiedTurretRows && !deferPredictedTurretRenderRefresh;
    if (refreshHealth || refreshTurretsNow) {
      this.refreshRenderableEntityStateSnapshotDelta(
        existing,
        refreshHealth,
        refreshTurretsNow,
        hasBuildFields,
      );
    }

    if (hasMotionFields || copiedTurretRows) {
      this.activeEntityPredictionIds.add(id);
      this.dirtyUnitRenderIds.add(id);
    }
    return true;
  }

  private tryApplyUnitHotMotionTypedDeltaWireRow(
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

  private canApplyUnitMetadataTypedDeltaWireRow(
    source: EntitySnapshotWireSource,
    entityIndex: number,
  ): boolean {
    const rowIndex = source.rowIndices[entityIndex];
    if (rowIndex < 0 || rowIndex >= source.unitRows.count) return false;
    const values = source.unitRows.values;
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

  private applyUnitHpBuildTypedFields(
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

  private applyUnitMetadataTypedDeltaWireRow(
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

  private canApplyBuildingMetadataTypedDeltaWireRow(
    source: EntitySnapshotWireSource,
    entityIndex: number,
  ): boolean {
    const rowIndex = source.rowIndices[entityIndex];
    if (rowIndex < 0 || rowIndex >= source.buildingRows.count) return false;
    const values = source.buildingRows.values;
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

  private applyBuildingHpBuildTypedFields(
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

  private readFactoryWaypointFromWire(
    source: EntitySnapshotWireSource,
    offset: number,
  ): FactoryDefaultWaypoint | null {
    if (offset < 0 || offset >= source.waypointRows.count) return null;
    const values = source.waypointRows.values;
    const base = offset * ENTITY_SNAPSHOT_WIRE_WAYPOINT_STRIDE;
    const typeSlot = values[base + 4] | 0;
    const type = source.waypointStrings[typeSlot];
    if (type !== 'move' && type !== 'fight' && type !== 'patrol') return null;
    return {
      x: values[base + 0],
      y: values[base + 1],
      z: values[base + 2] !== 0 ? values[base + 3] : null,
      type,
    };
  }

  private applyBuildingFactoryTypedFields(
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
    const rally = this.readFactoryWaypointFromWire(source, rallyOffset);
    if (rally === null) return false;
    factory.rallyX = rally.x;
    factory.rallyY = rally.y;
    factory.rallyZ = rally.z;
    factory.rallyType = rally.type;

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
        const waypoint = this.readFactoryWaypointFromWire(source, routeOffset + i);
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

  private applyBuildingMetadataTypedDeltaWireRow(
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

  private canApplyMetadataTypedDeltaSource(
    source: EntitySnapshotWireSource,
    entities: readonly (NetworkServerSnapshotEntity | undefined)[],
  ): boolean {
    const count = source.count;
    if (count === 0 || count !== entities.length) return false;
    if (
      source.basicRows.count !== 0 ||
      source.actionRows.count !== 0 ||
      source.turretRows.count !== 0 ||
      source.factorySelectedUnitRows.count !== 0 ||
      source.waypointRows.count !== 0
    ) {
      return false;
    }

    let unitRowCount = 0;
    let buildingRowCount = 0;
    for (let entityIndex = 0; entityIndex < count; entityIndex++) {
      if (entities[entityIndex] !== undefined) return false;
      switch (source.kinds[entityIndex]) {
        case ENTITY_SNAPSHOT_WIRE_KIND_UNIT:
          unitRowCount++;
          if (!this.canApplyUnitMetadataTypedDeltaWireRow(source, entityIndex)) return false;
          break;
        case ENTITY_SNAPSHOT_WIRE_KIND_BUILDING:
          buildingRowCount++;
          if (!this.canApplyBuildingMetadataTypedDeltaWireRow(source, entityIndex)) return false;
          break;
        default:
          return false;
      }
    }
    return unitRowCount === source.unitRows.count &&
      buildingRowCount === source.buildingRows.count;
  }

  private applyMetadataTypedDeltaSource(source: EntitySnapshotWireSource): void {
    const unitValues = source.unitRows.values;
    const buildingValues = source.buildingRows.values;
    for (let entityIndex = 0; entityIndex < source.count; entityIndex++) {
      const rowIndex = source.rowIndices[entityIndex];
      switch (source.kinds[entityIndex]) {
        case ENTITY_SNAPSHOT_WIRE_KIND_UNIT: {
          const base = rowIndex * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
          this.applyUnitMetadataTypedDeltaWireRow(
            unitValues,
            base,
            unitValues[base + 7] | 0,
          );
          break;
        }
        case ENTITY_SNAPSHOT_WIRE_KIND_BUILDING: {
          const base = rowIndex * ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE;
          this.applyBuildingMetadataTypedDeltaWireRow(
            buildingValues,
            base,
            buildingValues[base + 7] | 0,
          );
          break;
        }
      }
    }
  }

  private tryApplyTypedPlaceholderDeltaSource(
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

  private canApplyUnitHotMotionTypedPlaceholderSource(source: EntitySnapshotWireSource): boolean {
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

  private applyUnitHotMotionTypedPlaceholderSource(
    source: EntitySnapshotWireSource,
    now: number,
  ): void {
    this.applyUnitHotMotionTypedRows(source.unitRows.values, source.unitRows.count, now);
  }

  private applyUnitHotMotionTypedRows(
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

  private applyTypedPlaceholderDeltaSource(
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

  private wireRowsOfKindAreTypedPlaceholders(
    source: EntitySnapshotWireSource,
    kind: number,
    rowCount: number,
  ): boolean {
    if (rowCount === 0) return false;
    if (source.typedPlaceholderRows < rowCount) return false;
    let matchedRows = 0;
    const placeholderIndices = source.typedPlaceholderEntityIndices;
    for (let i = 0; i < source.typedPlaceholderRows; i++) {
      const entityIndex = placeholderIndices[i];
      if (source.kinds[entityIndex] !== kind) continue;
      matchedRows++;
    }
    return matchedRows === rowCount;
  }

  private applyMixedTypedPlaceholderRows(
    source: EntitySnapshotWireSource,
    now: number,
    deferPredictedTurretRenderRefresh: boolean,
    applyStats: ClientSnapshotApplyStats,
  ): boolean {
    if (source.typedPlaceholderRows === 0) return false;

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

  private tryApplyBuildingTypedDeltaWireRow(
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

  private tryApplyBuildingTypedDeltaWireRowAt(
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

    const refreshTurretsNow = copiedTurretRows && !deferPredictedTurretRenderRefresh;
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

  private recordWireMotionCorrectionStats(
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
    const localUnit = existing.unit;
    if (localUnit !== null && (changedFields & ENTITY_CHANGED_VEL) !== 0) {
      const dvx = (localUnit.velocityX ?? 0) - deqVel(values[base + 10]);
      const dvy = (localUnit.velocityY ?? 0) - deqVel(values[base + 11]);
      const dvz = (localUnit.velocityZ ?? 0) - deqVel(values[base + 12]);
      const velocityDelta = Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz);
      applyStats.correction.velocityCount++;
      applyStats.correction.totalVelocityDelta += velocityDelta;
      if (velocityDelta > applyStats.correction.maxVelocityDelta) {
        applyStats.correction.maxVelocityDelta = velocityDelta;
      }
    }
  }

  private unitHealthBarCacheMembership(entity: Entity): boolean {
    const unit = entity.unit;
    if (!unit) return false;
    // Mirror EntityCacheManager's cachedDamagedUnits/cachedHudEntities
    // bucket condition exactly (hp > 0 so a freshly-spawned 0-hp shell is
    // not counted as "damaged" — it rides build-in-progress instead) so
    // this predicate is a faithful membership-change detector.
    return (unit.hp > 0 && unit.hp < unit.maxHp) ||
      isBuildInProgress(entity.buildable);
  }

  private buildingHealthBarCacheMembership(entity: Entity): boolean {
    const building = entity.building;
    if (!building) return false;
    // Mirror EntityCacheManager's cachedHealthBarBuildings bucket exactly.
    return (building.hp > 0 && building.hp < building.maxHp) ||
      isBuildInProgress(entity.buildable);
  }

  private rebuildCachesIfNeeded(): void {
    this.cache.rebuildIfNeeded(this.entities);
  }

  /**
   * Apply received network state — store server targets, snap non-visual state.
   * Visual blending toward these targets happens in applyPrediction() each frame.
   */
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
        let appliedTypedDelta = false;
        if (typedEntityWireSource !== undefined) {
          switch (typedEntityWireSource.kinds[entityIndex]) {
            case ENTITY_SNAPSHOT_WIRE_KIND_BASIC:
              appliedTypedDelta = this.tryApplyBasicTypedDeltaWireRow(
                typedEntityWireSource,
                entityIndex,
                now,
                collectCorrectionStats,
                applyStats,
              );
              break;
            case ENTITY_SNAPSHOT_WIRE_KIND_UNIT:
              appliedTypedDelta = this.tryApplyUnitTypedDeltaWireRow(
                typedEntityWireSource,
                entityIndex,
                now,
                collectCorrectionStats,
                deferPredictedTurretRenderRefresh,
                applyStats,
              );
              break;
            case ENTITY_SNAPSHOT_WIRE_KIND_BUILDING:
              appliedTypedDelta = this.tryApplyBuildingTypedDeltaWireRow(
                typedEntityWireSource,
                entityIndex,
                now,
                deferPredictedTurretRenderRefresh,
              );
              break;
          }
        }
        if (appliedTypedDelta) {
          continue;
        }

        const netEntity = state.entities[entityIndex];
        if (netEntity === undefined) continue;
        const cf = netEntity.changedFields;
        const isFull = cf == null;
        // Towers ride the static-entity wire shape (no velocity, has
        // turrets through server.building.turrets), so isBuildingUpdate
        // gates the static branch for both.
        const isBuildingUpdate = netEntity.type === 'building' || netEntity.type === 'tower';
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
          // Full-state lockstep snapshots create entities immediately. The
          // changedFields guard only protects old sparse fixtures/tools.
          if (netEntity.changedFields != null) continue;

          const newEntity = createEntityFromNetwork(netEntity);
          if (newEntity) {
            if (newEntity.selectable && this.selectionState.has(newEntity.id)) {
              newEntity.selectable.selected = true;
            }
            this.entities.set(netEntity.id, newEntity);
            this.handleLocalEntityAdded(newEntity);
            this.refreshRenderableEntityStateAndSpatialIndex(newEntity);
            this.markEntityPredictionActive(newEntity);
            this.refreshPredictionSupportSurfaceProvider(newEntity);
            this.renderLifecycleDirtyIds.add(netEntity.id);
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
            this.refreshPredictionSupportSurfaceProvider(existing);
          }
          this.markNetworkEntityPredictionActive(netEntity, existing);
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
      this._serverIds.clear();
      for (let entityIndex = 0; entityIndex < state.entities.length; entityIndex++) {
        const netEntity = state.entities[entityIndex];
        if (netEntity !== undefined) {
          this._serverIds.add(netEntity.id);
          continue;
        }
        if (typedEntityWireSource !== undefined) {
          const id = typedEntityWireRowId(typedEntityWireSource, entityIndex);
          if (id !== null) this._serverIds.add(id);
        }
      }
      const removeIds = this.renderEntityState.collectEntityIdsMissingFrom(
        this._serverIds,
        this._fullReconcileRemoveIds,
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
      const directProjectileSource = getActiveProjectileSnapshotWireSource(projectiles);
      const directProjectileRows =
        projectileWireSourceHasDirectlyConsumableRows(directProjectileSource);
      const packedProjectiles = directProjectileRows
        ? undefined
        : getPackedProjectileSnapshotWire(projectiles);
      const appliedDirectSpawns = directProjectileRows
        ? forEachProjectileWireSourceSpawnFromSource(
            directProjectileSource,
            this.directProjectileSpawnScratch,
            (spawn) => {
              if (this.projectileStore.projectileSpawns.shouldSmooth(spawn)) {
                this.projectileStore.projectileSpawns.enqueue(spawn, now);
                return;
              }
              this.projectileStore.applySpawn(spawn);
            },
          )
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

      // Process projectile despawn events (after spawns, so same-snapshot spawn+despawn works)
      const appliedDirectDespawns = directProjectileRows
        ? this.applyProjectileWireSourceDespawns(directProjectileSource)
        : false;
      const appliedPackedDespawns = !appliedDirectDespawns && packedProjectiles !== undefined
        ? forEachPackedProjectileDespawn(
            packedProjectiles,
            (id) => this.deleteEntityLocalState(id as EntityId),
          )
        : false;
      const despawns = appliedDirectDespawns || appliedPackedDespawns
        ? undefined
        : projectiles.despawns;
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
      const appliedDirectVelocityUpdates = directProjectileRows
        ? this.applyProjectileWireSourceVelocityUpdates(
            directProjectileSource,
            now,
            reflectedProjectileIds,
          )
        : false;
      const appliedPackedVelocityUpdates = !appliedDirectVelocityUpdates && packedProjectiles !== undefined
        ? forEachPackedProjectileVelocityUpdate(
            packedProjectiles,
            (
              id,
              qposX,
              qposY,
              qposZ,
              qvelX,
              qvelY,
              qvelZ,
              targetEntityId,
              clearHomingTarget,
            ) => this.applyProjectileVelocityUpdateFields(
              id as EntityId,
              qposX,
              qposY,
              qposZ,
              qvelX,
              qvelY,
              qvelZ,
              targetEntityId as EntityId | null,
              clearHomingTarget,
              now,
              reflectedProjectileIds,
            ),
          )
        : false;
      const velocityUpdates = appliedDirectVelocityUpdates || appliedPackedVelocityUpdates
        ? undefined
        : projectiles.velocityUpdates;
      if (velocityUpdates !== undefined && velocityUpdates !== null) {
        for (const vu of velocityUpdates) {
          this.applyProjectileVelocityUpdateFields(
            vu.id,
            vu.pos.x,
            vu.pos.y,
            vu.pos.z,
            vu.velocity.x,
            vu.velocity.y,
            vu.velocity.z,
            vu.targetEntityId,
            vu.clearHomingTarget === true,
            now,
            reflectedProjectileIds,
          );
        }
      }
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
    // it as a forced trail stamp on the next frame. The velocityUpdate
    // above already snapped the head to one-tick-past-bounce; this puts
    // the actual bounce point on the projectile so the trail kinks
    // exactly at the shield surface instead of one tick past it. Reflection
    // velocity updates still snap above; ordinary rocket corrections use an
    // EMA target instead. Audio event pos is unquantized f64.
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

  /**
   * Called every frame. Two steps:
   * 1. Predict: advance positions from last-seen velocity
   * 2. Drift: EMA blend position/velocity/rotation toward server targets
   */
  applyPrediction(deltaMs: number): ClientPredictionTargetAgeStats {
    const stats = this.predictionStepper.apply(deltaMs);
    this.refreshPredictedRenderStateAndSpatialIndex();
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
    this.rebuildCachesIfNeeded();
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

  getRenderEntityStateSlot(id: EntityId): number | undefined {
    return this.renderEntityState.getSlot(id);
  }

  getRenderTurretStateRows(id: EntityId): ClientRenderTurretHostRows | undefined {
    const slot = this.renderEntityState.getSlot(id);
    return slot !== undefined ? this.renderTurretState.hostRows(slot) : undefined;
  }

  assertRenderEntityStateParity(id: EntityId): void {
    const entity = this.entities.get(id);
    if (entity === undefined) {
      throw new Error(`[client render entity state] missing entity ${id}`);
    }
    this.renderEntityState.assertParity(entity);
    const slot = this.renderEntityState.getSlot(id);
    if (slot !== undefined) this.renderTurretState.assertParity(entity, slot);
  }

  collectScopedRenderEntities(
    bounds: FootprintBounds,
    outUnits: Entity[],
    outBuildings: Entity[],
    hoveredEntity: Entity | null,
    renderScope: ViewportFootprint,
  ): void {
    const selectedIds = this.selectionState.get();
    const hasExceptions = hoveredEntity !== null || selectedIds.size > 0;
    const included = hasExceptions ? this.scopedRenderIncludedIds : null;
    if (included !== null) included.clear();
    const unitSlots = this.scopedRenderUnitSlots;
    const buildingSlots = this.scopedRenderBuildingSlots;
    const unitRowSlots = this.scopedRenderUnitRowSlots;
    const buildingRowSlots = this.scopedRenderBuildingRowSlots;
    this.renderSpatialIndex.queryFilteredSlots(
      bounds,
      unitSlots,
      buildingSlots,
      (slot) => this.slotInRenderScope3D(slot, renderScope),
    );
    outUnits.length = 0;
    outBuildings.length = 0;
    unitRowSlots.length = 0;
    buildingRowSlots.length = 0;
    this.resolveScopedRenderSlots(
      unitSlots,
      outUnits,
      unitRowSlots,
      included,
      CLIENT_RENDER_ENTITY_KIND_UNIT,
    );
    this.resolveScopedRenderSlots(
      buildingSlots,
      outBuildings,
      buildingRowSlots,
      included,
      CLIENT_RENDER_ENTITY_KIND_BUILDING,
    );

    if (included === null) return;
    if (hoveredEntity !== null) {
      this.pushScopedRenderException(
        hoveredEntity,
        outUnits,
        outBuildings,
        unitRowSlots,
        buildingRowSlots,
        included,
      );
    }
    for (const id of selectedIds) {
      const entity = this.entities.get(id);
      if (entity !== undefined) {
        this.pushScopedRenderException(
          entity,
          outUnits,
          outBuildings,
          unitRowSlots,
          buildingRowSlots,
          included,
        );
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
      this.populateUnitRenderRows3D(units, options, out);
      if (options.isEntityFarLod !== undefined) {
        this.populateBuildingRenderRows3D(buildings, options, out);
      } else {
        this.populateQueuedBuildingRenderRows3D(options, out);
      }
      if (options.includeBodyHud) {
        this.populateBodyHudPacket3D(this.getHudEntities(), options.hoveredEntity, options, out);
      }
      if (options.includeBodyNames) {
        this.populateBodyNamePacket3D(this.getUnitsAndBuildings(), options, out);
      }
      if (options.includeShields) {
        this.populateShieldPacket3D(this.getShieldUnits(), renderScope, options, out);
      }
      if (options.includeContactShadows) {
        this.populateContactShadowPacket3D(units, buildings, renderScope, options, out);
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
      options.hoveredEntity,
      renderScope,
    );

    const unitRowSlots = this.scopedRenderUnitRowSlots;
    const buildingRowSlots = this.scopedRenderBuildingRowSlots;
    let hoveredBodyHudPushed = false;
    for (let i = 0; i < units.length; i++) {
      const entity = units[i];
      const farLod = this.entityUsesFarLod3D(entity, options);
      this.pushUnitRenderKnownSlot3D(entity, unitRowSlots[i] ?? -1, farLod, out);
      if (
        !this.entityEmissionUsesFarLod3D(entity, options, 'bodyHud') &&
        options.includeBodyHud &&
        this.entityNeedsBodyHud3D(entity)
      ) {
        const forceVisible = entity === options.hoveredEntity;
        if (forceVisible) hoveredBodyHudPushed = true;
        this.pushBodyHudEntity3D(entity, forceVisible, options, out);
      }
      if (
        !this.entityEmissionUsesFarLod3D(entity, options, 'bodyNames') &&
        options.includeBodyNames
      ) {
        this.pushBodyNamesForEntity3D(entity, options, out);
      }
      if (
        options.includeShields &&
        entity.unit !== null &&
        entity.combat !== null &&
        !this.entityEmissionUsesFarLod3D(entity, options, 'shieldFields')
      ) {
        this.pushShieldUnit3D(entity, renderScope, out);
      }
    }
    for (let i = 0; i < buildings.length; i++) {
      const entity = buildings[i];
      const farLod = this.entityUsesFarLod3D(entity, options);
      this.pushBuildingRenderKnownSlot3D(entity, buildingRowSlots[i] ?? -1, farLod, out);
      if (
        !this.entityEmissionUsesFarLod3D(entity, options, 'bodyHud') &&
        options.includeBodyHud &&
        this.entityNeedsBodyHud3D(entity)
      ) {
        const forceVisible = entity === options.hoveredEntity;
        if (forceVisible) hoveredBodyHudPushed = true;
        this.pushBodyHudEntity3D(entity, forceVisible, options, out);
      }
      if (
        !this.entityEmissionUsesFarLod3D(entity, options, 'bodyNames') &&
        options.includeBodyNames
      ) {
        this.pushBodyNamesForEntity3D(entity, options, out);
      }
    }

    if (
      options.includeBodyHud &&
      options.hoveredEntity !== null &&
      !hoveredBodyHudPushed &&
      !this.entityEmissionUsesFarLod3D(options.hoveredEntity, options, 'bodyHud')
    ) {
      this.pushBodyHudEntity3D(options.hoveredEntity, true, options, out);
    }
    if (options.includeContactShadows) {
      this.populateContactShadowPacket3D(units, buildings, renderScope, options, out);
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
    this.renderEntityState.clearDirtySlots();
    this.renderTurretState.clearDirtyHostSlots();
  }

  private refreshRenderSpatialIndexBySlot(id: EntityId, slot: number | undefined): void {
    if (slot !== undefined) {
      this.renderSpatialIndex.updateSlot(this.renderEntityState.getViews(), slot);
    } else {
      this.renderSpatialIndex.remove(id);
    }
  }

  private refreshRenderableEntityStateAndSpatialIndex(entity: Entity): void {
    const slot = this.refreshRenderableEntityState(entity);
    if (slot !== undefined) {
      this.renderSpatialIndex.updateSlot(this.renderEntityState.getViews(), slot);
    } else {
      this.renderSpatialIndex.remove(entity.id);
    }
  }

  private refreshRenderableEntityStateFromSnapshot(
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

  private refreshRenderableEntityStateSnapshotDelta(
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

  private refreshRenderableEntityState(entity: Entity): number | undefined {
    const slot = this.renderEntityState.refreshEntity(entity);
    if (slot !== undefined) this.renderTurretState.refreshHost(entity, slot);
    return slot;
  }

  private refreshRenderEntityStateById(id: EntityId): number | undefined {
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

  private refreshAllRenderableEntityStates(): void {
    for (const entity of this.entities.values()) {
      if (entity.unit !== null || entity.building !== null) {
        const slot = this.renderEntityState.refreshEntity(entity);
        if (slot !== undefined) this.renderTurretState.refreshHost(entity, slot);
      }
    }
  }

  private getOrRefreshRenderEntityStateSlot(entity: Entity): number | undefined {
    const existing = this.renderEntityState.getSlot(entity.id);
    if (existing !== undefined) return existing;
    const slot = this.renderEntityState.refreshEntity(entity);
    if (slot !== undefined) this.renderTurretState.refreshHost(entity, slot);
    return slot;
  }

  private refreshPredictedRenderStateAndSpatialIndex(): void {
    for (const id of this.activeEntityPredictionIds) {
      this.refreshRenderSpatialIndexBySlot(id, this.refreshRenderEntityStateById(id));
    }
    for (const id of this.dirtyUnitRenderIds) {
      if (this.activeEntityPredictionIds.has(id)) continue;
      this.refreshRenderSpatialIndexBySlot(id, this.refreshRenderEntityStateById(id));
    }
    for (const id of this.dirtyBuildingRenderIds) {
      if (!this.activeEntityPredictionIds.has(id)) this.refreshRenderEntityStateById(id);
    }
    for (const id of this.renderLifecycleDirtyIds) {
      if (
        this.activeEntityPredictionIds.has(id) ||
        this.dirtyUnitRenderIds.has(id) ||
        this.dirtyBuildingRenderIds.has(id)
      ) {
        continue;
      }
      this.refreshRenderEntityStateById(id);
    }
  }

  private pushScopedRenderException(
    entity: Entity,
    outUnits: Entity[],
    outBuildings: Entity[],
    outUnitSlots: number[],
    outBuildingSlots: number[],
    included: Set<EntityId>,
  ): void {
    if (included.has(entity.id)) return;
    if (entity.unit !== null) {
      outUnits.push(entity);
      outUnitSlots.push(this.renderEntityState.getSlot(entity.id) ?? -1);
      included.add(entity.id);
    } else if (entity.building !== null) {
      outBuildings.push(entity);
      outBuildingSlots.push(this.renderEntityState.getSlot(entity.id) ?? -1);
      included.add(entity.id);
    }
  }

  private resolveScopedRenderSlots(
    slots: readonly number[],
    out: Entity[],
    outSlots: number[],
    included: Set<EntityId> | null,
    expectedKind: number,
  ): void {
    const views = this.renderEntityState.getViews();
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (views.kind[slot] !== expectedKind) continue;
      const entityId = views.entityIds[slot] as EntityId;
      if (included !== null && included.has(entityId)) continue;
      const entity = this.entities.get(entityId);
      if (entity === undefined) continue;
      if (
        (expectedKind === CLIENT_RENDER_ENTITY_KIND_UNIT && entity.unit === null) ||
        (expectedKind === CLIENT_RENDER_ENTITY_KIND_BUILDING && entity.building === null)
      ) {
        continue;
      }
      out.push(entity);
      outSlots.push(slot);
      if (included !== null) included.add(entityId);
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

  private slotInRenderScope3D(slot: number, renderScope: ViewportFootprint): boolean {
    const views = this.renderEntityState.getViews();
    if (
      views.kind[slot] === CLIENT_RENDER_ENTITY_KIND_UNIT ||
      views.kind[slot] === CLIENT_RENDER_ENTITY_KIND_BUILDING
    ) {
      return renderScope.inScope(
        views.x[slot],
        views.y[slot],
        views.renderScopePadding[slot],
      );
    }
    return false;
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
    options: ClientViewRenderPacketOptions3D,
    out: ClientViewRenderEntityPackets3D,
  ): void {
    for (let i = 0; i < units.length; i++) {
      const entity = units[i];
      this.pushUnitRenderRow3D(entity, this.entityUsesFarLod3D(entity, options), out);
    }
  }

  private populateBuildingRenderRows3D(
    buildings: readonly Entity[],
    options: ClientViewRenderPacketOptions3D,
    out: ClientViewRenderEntityPackets3D,
  ): void {
    for (let i = 0; i < buildings.length; i++) {
      const entity = buildings[i];
      this.pushBuildingRenderRow3D(entity, this.entityUsesFarLod3D(entity, options), out);
    }
  }

  private populateQueuedBuildingRenderRows3D(
    options: ClientViewRenderPacketOptions3D,
    out: ClientViewRenderEntityPackets3D,
  ): void {
    for (const id of this.activeEntityPredictionIds) {
      const entity = this.entities.get(id);
      if (entity !== undefined && entity.building !== null) {
        this.pushBuildingRenderRow3D(entity, this.entityUsesFarLod3D(entity, options), out);
      }
    }
    for (const id of this.dirtyBuildingRenderIds) {
      if (this.activeEntityPredictionIds.has(id)) continue;
      const entity = this.entities.get(id);
      if (entity !== undefined && entity.building !== null) {
        this.pushBuildingRenderRow3D(entity, this.entityUsesFarLod3D(entity, options), out);
      }
    }
    for (const id of this.renderLifecycleDirtyIds) {
      if (this.activeEntityPredictionIds.has(id) || this.dirtyBuildingRenderIds.has(id)) continue;
      const entity = this.entities.get(id);
      if (entity !== undefined && entity.building !== null) {
        this.pushBuildingRenderRow3D(entity, this.entityUsesFarLod3D(entity, options), out);
      }
    }
  }

  private pushUnitRenderRow3D(
    entity: Entity,
    farLod: boolean,
    out: ClientViewRenderEntityPackets3D,
  ): void {
    const id = entity.id;
    const slot = this.getOrRefreshRenderEntityStateSlot(entity);
    const activePrediction = this.activeEntityPredictionIds.has(id);
    const renderDirty = this.dirtyUnitRenderIds.has(id);
    const lifecycleDirty = this.renderLifecycleDirtyIds.has(id);
    if (slot !== undefined) {
      out.unitRows.pushEntityState(
        entity,
        this.renderEntityState.getViews(),
        slot,
        this.renderTurretState,
        activePrediction,
        renderDirty,
        lifecycleDirty,
        farLod,
      );
    } else {
      out.unitRows.pushEntity(
        entity,
        activePrediction,
        renderDirty,
        lifecycleDirty,
        farLod,
      );
    }
  }

  private pushUnitRenderKnownSlot3D(
    entity: Entity,
    slot: number,
    farLod: boolean,
    out: ClientViewRenderEntityPackets3D,
  ): void {
    const views = this.renderEntityState.getViews();
    const id = entity.id;
    const activePrediction = this.activeEntityPredictionIds.has(id);
    const renderDirty = this.dirtyUnitRenderIds.has(id);
    const lifecycleDirty = this.renderLifecycleDirtyIds.has(id);
    if (
      slot >= 0 &&
      views.kind[slot] === CLIENT_RENDER_ENTITY_KIND_UNIT &&
      views.entityIds[slot] === id
    ) {
      out.unitRows.pushEntityState(
        entity,
        views,
        slot,
        this.renderTurretState,
        activePrediction,
        renderDirty,
        lifecycleDirty,
        farLod,
      );
      return;
    }
    this.pushUnitRenderRow3D(entity, farLod, out);
  }

  private pushBuildingRenderRow3D(
    entity: Entity,
    farLod: boolean,
    out: ClientViewRenderEntityPackets3D,
  ): void {
    const id = entity.id;
    const slot = this.getOrRefreshRenderEntityStateSlot(entity);
    const activePrediction = this.activeEntityPredictionIds.has(id);
    const renderDirty = this.dirtyBuildingRenderIds.has(id);
    const lifecycleDirty = this.renderLifecycleDirtyIds.has(id);
    if (slot !== undefined) {
      out.buildingRows.pushEntityState(
        entity,
        this.renderEntityState.getViews(),
        slot,
        this.renderTurretState,
        activePrediction,
        renderDirty,
        lifecycleDirty,
        farLod,
      );
    } else {
      out.buildingRows.pushEntity(
        entity,
        activePrediction,
        renderDirty,
        lifecycleDirty,
        farLod,
      );
    }
  }

  private pushBuildingRenderKnownSlot3D(
    entity: Entity,
    slot: number,
    farLod: boolean,
    out: ClientViewRenderEntityPackets3D,
  ): void {
    const views = this.renderEntityState.getViews();
    const id = entity.id;
    const activePrediction = this.activeEntityPredictionIds.has(id);
    const renderDirty = this.dirtyBuildingRenderIds.has(id);
    const lifecycleDirty = this.renderLifecycleDirtyIds.has(id);
    if (
      slot >= 0 &&
      views.kind[slot] === CLIENT_RENDER_ENTITY_KIND_BUILDING &&
      views.entityIds[slot] === id
    ) {
      out.buildingRows.pushEntityState(
        entity,
        views,
        slot,
        this.renderTurretState,
        activePrediction,
        renderDirty,
        lifecycleDirty,
        farLod,
      );
      return;
    }
    this.pushBuildingRenderRow3D(entity, farLod, out);
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
      if (this.entityEmissionUsesFarLod3D(entity, options, 'bodyHud')) continue;
      const forceVisible = entity === hoveredEntity;
      if (forceVisible) hoveredBodyHudPushed = true;
      this.pushBodyHudEntity3D(entity, forceVisible, options, out);
    }
    if (
      hoveredEntity !== null &&
      !hoveredBodyHudPushed &&
      !this.entityEmissionUsesFarLod3D(hoveredEntity, options, 'bodyHud')
    ) {
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
    if (this.entityEmissionUsesFarLod3D(entity, options, 'bodyHud')) return;

    const type = this.hudTypeOf3D(entity);
    const slot = this.getOrRefreshRenderEntityStateSlot(entity);
    if (slot !== undefined) {
      const views = this.renderEntityState.getViews();
      const kind = views.kind[slot];
      if (
        kind === CLIENT_RENDER_ENTITY_KIND_UNIT ||
        kind === CLIENT_RENDER_ENTITY_KIND_BUILDING
      ) {
        const stateFlags = views.flags[slot];
        const selected = (stateFlags & CLIENT_RENDER_ENTITY_FLAG_SELECTED) !== 0;
        const buildInProgress =
          (stateFlags & CLIENT_RENDER_ENTITY_FLAG_BUILD_IN_PROGRESS) !== 0;
        const hp = views.hp[slot];
        const maxHp = views.maxHp[slot];
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
          buildInProgress,
        );
        const showHp = maxHp > 0 && (showHealth || forceVisible)
          && (buildInProgress || hp > 0);
        const showBuildBars = showBuild && buildInProgress;
        if (!showHp && !showBuildBars) return;

        out.bodyHud.pushRow(
          views.entityIds[slot],
          views.x[slot],
          views.hudBarsY[slot],
          views.y[slot],
          views.bodyHudWidth[slot],
          maxHp > 0 ? hp / maxHp : 0,
          buildInProgress ? views.buildEnergyRatio[slot] : 0,
          buildInProgress ? views.buildMetalRatio[slot] : 0,
          showHp,
          showBuildBars,
        );
        return;
      }
    }

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
      unit !== null ? unit.radius.other * 2 : building!.width,
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
      const entity = entities[i];
      if (!this.entityEmissionUsesFarLod3D(entity, options, 'bodyNames')) {
        this.pushBodyNamesForEntity3D(entity, options, out);
      }
    }
  }

  private pushBodyNamesForEntity3D(
    entity: Entity,
    options: ClientViewRenderPacketOptions3D,
    out: ClientViewRenderEntityPackets3D,
  ): void {
    if (this.entityEmissionUsesFarLod3D(entity, options, 'bodyNames')) return;
    const type = this.hudTypeOf3D(entity);
    const nameToggle = options.getEntityHudToggle(type, 'name');
    const slot = this.getOrRefreshRenderEntityStateSlot(entity);
    const views = slot !== undefined ? this.renderEntityState.getViews() : undefined;
    const hasStateRow = slot !== undefined && views !== undefined && (
      views.kind[slot] === CLIENT_RENDER_ENTITY_KIND_UNIT ||
      views.kind[slot] === CLIENT_RENDER_ENTITY_KIND_BUILDING
    );
    let labelX = entity.transform.x;
    let labelZ = entity.transform.y;
    let bodyNameY = entity.unit !== null
      ? getUnitHudNameY(entity)
      : getBuildingHudNameY(entity);
    if (hasStateRow) {
      labelX = views.x[slot];
      labelZ = views.y[slot];
      bodyNameY = views.hudNameY[slot];
    }
    const bodyName = resolveEntityDisplayName(
      entity,
      nameToggle,
      options.selectionHudMode,
    );
    if (bodyName !== null) {
      out.pieceNames.push(
        entity.id,
        PIECE_TAG_BODY,
        labelX,
        bodyNameY,
        labelZ,
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
        labelX,
        bodyNameY + NAME_LABEL_OWNER_Y_OFFSET,
        labelZ,
        ownerName,
        'owner',
      );
    }
  }

  private populateShieldPacket3D(
    units: readonly Entity[],
    renderScope: ViewportFootprint,
    options: ClientViewRenderPacketOptions3D,
    out: ClientViewRenderEntityPackets3D,
  ): void {
    for (let i = 0; i < units.length; i++) {
      if (!this.entityEmissionUsesFarLod3D(units[i], options, 'shieldFields')) {
        this.pushShieldUnit3D(units[i], renderScope, out);
      }
    }
  }

  private pushShieldUnit3D(
    entity: Entity,
    renderScope: ViewportFootprint,
    out: ClientViewRenderEntityPackets3D,
  ): void {
    const slot = this.getOrRefreshRenderEntityStateSlot(entity);
    const views = this.renderEntityState.getViews();
    if (slot !== undefined && views.kind[slot] === CLIENT_RENDER_ENTITY_KIND_UNIT) {
      out.shields.pushUnitTurretState(
        views,
        slot,
        this.renderTurretState.hostRows(slot),
        renderScope,
      );
    } else {
      out.shields.pushUnit(entity, renderScope);
    }
  }

  private populateContactShadowPacket3D(
    units: readonly Entity[],
    buildings: readonly Entity[],
    renderScope: ViewportFootprint,
    options: ClientViewRenderPacketOptions3D,
    out: ClientViewRenderEntityPackets3D,
  ): void {
    const mapWidth = this.getMapWidth();
    const mapHeight = this.getMapHeight();
    let views = this.renderEntityState.getViews();
    for (let i = 0; i < units.length; i++) {
      const entity = units[i];
      if (this.entityEmissionUsesFarLod3D(entity, options, 'contactShadows')) continue;
      const slot = this.getOrRefreshRenderEntityStateSlot(entity);
      views = this.renderEntityState.getViews();
      if (slot !== undefined && views.kind[slot] === CLIENT_RENDER_ENTITY_KIND_UNIT) {
        out.contactShadows.pushUnitState(
          views.entityIds[slot],
          views.x[slot],
          views.y[slot],
          views.z[slot],
          views.hp[slot],
          views.radiusHitbox[slot],
          Math.max(1, views.bodyCenterHeight[slot] || views.radiusOther[slot]),
          mapWidth,
          mapHeight,
          renderScope,
        );
      } else {
        out.contactShadows.pushUnit(entity, mapWidth, mapHeight, renderScope);
      }
    }
    for (let i = 0; i < buildings.length; i++) {
      const entity = buildings[i];
      if (this.entityEmissionUsesFarLod3D(entity, options, 'contactShadows')) continue;
      const slot = this.getOrRefreshRenderEntityStateSlot(entity);
      views = this.renderEntityState.getViews();
      if (slot !== undefined && views.kind[slot] === CLIENT_RENDER_ENTITY_KIND_BUILDING) {
        out.contactShadows.pushBuildingState(
          views.x[slot],
          views.y[slot],
          views.hp[slot],
          views.contactShadowWidth[slot],
          views.contactShadowDepth[slot],
          renderScope,
        );
      } else {
        out.contactShadows.pushBuilding(entity, renderScope);
      }
    }
  }

  private populateGroundPrintPacket3D(
    units: readonly Entity[],
    options: ClientViewRenderPacketOptions3D,
    out: ClientViewRenderEntityPackets3D,
  ): void {
    const mapWidth = this.getMapWidth();
    const mapHeight = this.getMapHeight();
    let views = this.renderEntityState.getViews();
    for (let i = 0; i < units.length; i++) {
      const entity = units[i];
      if (this.entityEmissionUsesFarLod3D(entity, options, 'groundPrints')) continue;
      const slot = this.getOrRefreshRenderEntityStateSlot(entity);
      views = this.renderEntityState.getViews();
      if (slot !== undefined && views.kind[slot] === CLIENT_RENDER_ENTITY_KIND_UNIT) {
        const entityId = views.entityIds[slot] as EntityId;
        const loc = options.getGroundPrintLocomotionMesh(entityId);
        const grounded = loc?.type === 'legs'
          ? loc.visualGrounded
          : this.groundPrintGroundedFromState(slot, mapWidth, mapHeight);
        out.groundPrints.pushRow(
          entityId,
          views.x[slot],
          views.y[slot],
          grounded,
        );
      } else {
        out.groundPrints.pushUnit(
          entity,
          options.getGroundPrintLocomotionMesh,
          mapWidth,
          mapHeight,
        );
      }
    }
  }

  private groundPrintGroundedFromState(
    slot: number,
    mapWidth: number,
    mapHeight: number,
  ): boolean {
    const views = this.renderEntityState.getViews();
    if (views.groundContactEnabled[slot] === 0) return false;
    const x = views.x[slot];
    const y = views.y[slot];
    const z = views.z[slot];
    const groundY = getLocomotionSurfaceHeight(
      x,
      y,
      mapWidth,
      mapHeight,
      views.entityIds[slot] as EntityId,
    );
    const penetration = groundY - (z - views.bodyCenterHeight[slot]);
    return isUnitGroundPenetrationInContact(penetration);
  }

  private entityUsesFarLod3D(
    entity: Entity,
    options: ClientViewRenderPacketOptions3D,
  ): boolean {
    return options.isEntityFarLod?.(entity) === true;
  }

  private entityEmissionUsesFarLod3D(
    entity: Entity,
    options: ClientViewRenderPacketOptions3D,
    emission: EntityLodEmission3D,
  ): boolean {
    return options.isEntityEmissionFarLod?.(entity, emission)
      ?? this.entityUsesFarLod3D(entity, options);
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
    this.rebuildCachesIfNeeded();
    return this.cache.getProjectiles();
  }

  getTravelingProjectiles(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getTravelingProjectiles();
  }

  getSmokeTrailProjectiles(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getSmokeTrailProjectiles();
  }

  getLineProjectiles(): Entity[] {
    this.rebuildCachesIfNeeded();
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
    this.refreshAllRenderableEntityStates();
  }

  getSelectedIds(): Set<EntityId> {
    return this.selectionState.get();
  }

  selectEntity(id: EntityId): void {
    this.selectionState.select(id);
    this.refreshRenderEntityStateById(id);
  }

  deselectEntity(id: EntityId): void {
    this.selectionState.deselect(id);
    this.refreshRenderEntityStateById(id);
  }

  clearSelection(): void {
    const hadSelection = this.selectionState.get().size > 0;
    this.selectionState.clear();
    if (hadSelection) this.refreshAllRenderableEntityStates();
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
    this.projectileStore.clear();
    this.entities.clear();
    this.serverTargets.clear();
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
    this.renderEntityState.clear();
    this.renderTurretState.clear();
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
