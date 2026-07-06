import type { SnapshotRate, TickRate } from '../../types/server';
import { getUnitGroundNormalEmaMode } from '../sim/unitGroundNormal';
import type { WorldState } from '../sim/WorldState';
import type { RemovedSnapshotEntity } from '../sim/WorldState';
import type { Simulation } from '../sim/Simulation';
import type { Entity, PlayerId, EntityId } from '../sim/types';
import type { NetworkServerSnapshot, NetworkServerSnapshotEntity } from '../network/NetworkTypes';
import { serializeGameState } from '../network/stateSerializer';
import type { SerializeGameStateOptions } from '../network/stateSerializer';
import {
  createSnapshotVisibilityCache,
  getOrBuildVisibility,
  serializeScanPulses,
  type SnapshotVisibility,
} from '../network/stateSerializerVisibility';
import { serializeAudioEvents } from '../network/stateSerializerAudio';
import { serializeEconomySnapshot } from '../network/stateSerializerEconomy';
import { serializeSprayTargets } from '../network/stateSerializerSpray';
import { serializeMinimapSnapshotEntities } from '../network/stateSerializerMinimap';
import { serializeProjectileSnapshot } from '../network/stateSerializerProjectiles';
import { serializeResourceMovements } from '../network/stateSerializerResourceMovements';
import { serializeGridSnapshot } from '../network/stateSerializerGrid';
import { IndexedEntityIdSet } from '../network/IndexedEntityIdCollections';
import {
  appendBasicEntityWireRowDirectFromState,
  appendBuildingHotEntityWireRowDirectFromState,
  appendUnitMotionEntityWireRowDirectFromState,
  getEntitySnapshotPoolStats,
  registerEntitySnapshotWireSource,
  resetEntitySnapshotPool,
  serializeEntityDeltaSnapshot,
  serializeEntitySnapshot,
} from '../network/stateSerializerEntities';
import {
  addSnapshotMaterializationStageFromStart,
  copySnapshotMaterializationStageDurations,
  createSnapshotMaterializationStageDurations,
  setSnapshotMaterializationMetadata,
  snapshotEntityRowComposition,
  type SnapshotMaterializationKind,
  type SnapshotMaterializationStage,
  type SnapshotMaterializationStageDurations,
} from '../network/snapshotMaterializationMetadata';
import type {
  SerializerAudioOverride,
  SerializerMinimapOverride,
  SerializerSprayOverride,
} from '../network/stateSerializer';
import type { TerrainBuildabilityGrid, TerrainTileMap } from '@/types/terrain';
import type { SnapshotCallback } from './GameConnection';
import type { ServerDebugGridPublisher } from './ServerDebugGridPublisher';
import { ServerSnapshotMetaBuilder } from './ServerSnapshotMetaBuilder';
import {
  ServerSnapshotWirePreencoder,
  type SerializedListenerSnapshot,
} from './ServerSnapshotWirePayload';
import { ServerSnapshotDirectWirePreencoder } from './ServerSnapshotDirectWirePreencoder';
import { entitySlotRegistry, type EntityStateViews } from '../sim/EntitySlotRegistry';
import {
  ENTITY_STATE_KIND_UNIT,
  getSimWasm,
} from '../sim-wasm/init';
import {
  dirtyFieldsAreMotionOnly,
  ENTITY_BASIC_TRANSFORM_DELTA_FIELDS,
  ENTITY_MOTION_DELTA_FIELDS,
  ENTITY_UNIT_SLAB_DELTA_FIELDS,
  isEntityMotionDeltaCandidate,
  isEntityMotionDeltaCandidateSlot,
  shouldDeferToSparseEntityMotionDelta,
} from './snapshotMotionDeltaPolicy';

const NO_MINIMAP_OVERRIDE: SerializerMinimapOverride = { value: undefined };
const PROJECTILE_DELTA_EMPTY_ENTITIES: NetworkServerSnapshot['entities'] = [];
const PROJECTILE_DELTA_EMPTY_ECONOMY: NetworkServerSnapshot['economy'] = {};
const MOTION_CANDIDATE_SLOT_PACK_BASE = 1 << 20;
const MOTION_CANDIDATE_MARK_MAX = 0xffffffff;
function addMaterializationStage(
  stages: SnapshotMaterializationStageDurations,
  stage: SnapshotMaterializationStage,
  start: number,
): void {
  addSnapshotMaterializationStageFromStart(stages, stage, start);
}

function timeMaterializationStage<T>(
  stages: SnapshotMaterializationStageDurations,
  stage: SnapshotMaterializationStage,
  fn: () => T,
): T {
  const start = performance.now();
  const value = fn();
  addMaterializationStage(stages, stage, start);
  return value;
}

function snapshotProjectileRowCount(
  projectiles: NetworkServerSnapshot['projectiles'],
): number {
  if (projectiles === undefined) return 0;
  return (
    (projectiles.spawns?.length ?? 0) +
    (projectiles.despawns?.length ?? 0) +
    (projectiles.velocityUpdates?.length ?? 0) +
    (projectiles.beamUpdates?.length ?? 0)
  );
}

export type SnapshotListenerEntry = {
  callback: SnapshotCallback;
  playerId: PlayerId | undefined;
  trackingKey: string;
  cacheKey: string;
  preencodeWire: boolean;
  lastStaticTerrainTileMap: TerrainTileMap | undefined;
  lastStaticBuildabilityGrid: TerrainBuildabilityGrid | undefined;
  /** This listener asked for recovery. Dynamic state is already full
   *  every snapshot; this flag covers one packet worth of recovery
   *  bookkeeping and is then cleared. */
  needsFullState: boolean;
  /** This listener must also get the static terrain/buildability
   *  payload again — its static-carrying snapshot was dropped after
   *  being marked sent, or its client reported it never got one. */
  needsStatic: boolean;
  startupReady: boolean;
  hasVisibleEntityBaseline: boolean;
  visibleEntityIds: IndexedEntityIdSet;
};

type ServerSnapshotPublisherInput = {
  world: WorldState;
  simulation: Simulation;
  debugGridPublisher: ServerDebugGridPublisher;
  listeners: readonly SnapshotListenerEntry[];
  terrainTileMap: TerrainTileMap;
  terrainBuildabilityGrid: TerrainBuildabilityGrid;
  tpsAvg: number;
  tpsLow: number;
  tickRateHz: TickRate;
  maxSnapshotsDisplay: SnapshotRate;
  ipAddress: string;
  backgroundMode: boolean;
  backgroundAllowedUnitBlueprintIds: ReadonlySet<string>;
  tickMsAvg: number;
  tickMsHi: number;
  tickMsInitialized: boolean;
};

export class ServerSnapshotPublisher {
  private readonly metaBuilder = new ServerSnapshotMetaBuilder();
  private readonly wirePreencoder = new ServerSnapshotWirePreencoder();
  private readonly directWirePreencoder = new ServerSnapshotDirectWirePreencoder();
  private readonly dirtyIdsBuf: EntityId[] = [];
  private readonly dirtyFieldsBuf: number[] = [];
  private readonly dirtySlotsBuf: number[] = [];
  private readonly removedEntitiesBuf: RemovedSnapshotEntity[] = [];
  private readonly visibilityCache = createSnapshotVisibilityCache();
  private readonly teamAudioCache = new Map<string, SerializerAudioOverride>();
  private readonly teamSprayCache = new Map<string, SerializerSprayOverride>();
  private readonly teamMinimapCache = new Map<string, SerializerMinimapOverride>();
  private readonly deltaRemovedEntityIdsBuf: EntityId[] = [];
  private readonly deltaRemovedEntityIdSet = new IndexedEntityIdSet();
  private readonly deltaEntityIdSet = new IndexedEntityIdSet();
  private readonly entityMotionCandidateIdsBuf: EntityId[] = [];
  private readonly entityMotionCandidateSlotsBuf: number[] = [];
  private readonly entityMotionCandidatePackedBuf: number[] = [];
  private readonly entityMotionCandidateIdSet = new IndexedEntityIdSet();
  private entityMotionCandidateSlotScratch = new Uint32Array(1024);
  private entityMotionCandidateSlotMarks = new Uint32Array(1024);
  private entityMotionCandidateSlotMark = 1;
  private entityMotionCandidateSlotCount = 0;
  private readonly deferredEntityMotionIds = new IndexedEntityIdSet();
  reset(): void {}

  clear(): void {
    this.reset();
    this.dirtyIdsBuf.length = 0;
    this.dirtyFieldsBuf.length = 0;
    this.dirtySlotsBuf.length = 0;
    this.removedEntitiesBuf.length = 0;
    this.visibilityCache.clear();
    this.teamAudioCache.clear();
    this.teamSprayCache.clear();
    this.teamMinimapCache.clear();
    this.deltaRemovedEntityIdsBuf.length = 0;
    this.deltaRemovedEntityIdSet.clear();
    this.deltaEntityIdSet.clear();
    this.entityMotionCandidateIdsBuf.length = 0;
    this.entityMotionCandidateSlotsBuf.length = 0;
    this.entityMotionCandidatePackedBuf.length = 0;
    this.entityMotionCandidateIdSet.clear();
    this.deferredEntityMotionIds.clear();
  }

  hasEntityMotionDeltaCandidates(world: WorldState, simulation?: Simulation): boolean {
    return this.collectEntityMotionDeltaCandidates(
      world,
      this.entityMotionCandidateIdsBuf,
      this.entityMotionCandidateSlotsBuf,
      simulation,
      false,
    ) > 0;
  }

  private stampSnapshotMaterialization(
    state: NetworkServerSnapshot,
    kind: SnapshotMaterializationKind,
    listener: SnapshotListenerEntry,
    stages: SnapshotMaterializationStageDurations,
    startedAt: number,
    snapshot: SerializedListenerSnapshot,
  ): void {
    const finalStages = copySnapshotMaterializationStageDurations(stages);
    addMaterializationStage(finalStages, 'total', startedAt);
    const entityRowComposition = snapshotEntityRowComposition(state);
    setSnapshotMaterializationMetadata(state, {
      kind,
      tick: state.tick,
      listener: listener.trackingKey,
      playerId: listener.playerId ?? null,
      entityRows: state.entities.length,
      ...entityRowComposition,
      removedRows: state.removedEntityIds?.length ?? 0,
      projectileRows: snapshotProjectileRowCount(state.projectiles),
      directWire: snapshot.wirePayload?.materializationKind === 'direct',
      preencodedWire: snapshot.wirePayload !== undefined,
      stages: finalStages,
    });
  }

  private updateListenerVisibleBaseline(
    listener: SnapshotListenerEntry,
    world: WorldState,
    visibility: SnapshotVisibility,
  ): void {
    const baseline = listener.visibleEntityIds;
    const visibleEntityIds = visibility.getVisibleEntityIds();
    if (visibleEntityIds !== undefined) {
      this.copyVisibleIdsInto(baseline, visibleEntityIds);
    } else {
      this.collectCurrentVisibleEntityIds(world, visibility, baseline);
    }
    listener.hasVisibleEntityBaseline = true;
  }

  private updateListenerVisibleBaselineFromIds(
    listener: SnapshotListenerEntry,
    visibleEntityIds: readonly EntityId[] | undefined,
    world: WorldState,
    visibility: SnapshotVisibility,
  ): void {
    if (visibleEntityIds === undefined) {
      this.updateListenerVisibleBaseline(listener, world, visibility);
      return;
    }
    this.copyVisibleIdsInto(listener.visibleEntityIds, visibleEntityIds);
    listener.hasVisibleEntityBaseline = true;
  }

  private copyVisibleIdsInto(
    out: IndexedEntityIdSet,
    visibleEntityIds: readonly EntityId[],
  ): void {
    out.clear();
    for (let i = 0; i < visibleEntityIds.length; i++) out.add(visibleEntityIds[i]);
  }

  private collectCurrentVisibleEntityIds(
    world: WorldState,
    visibility: SnapshotVisibility,
    out: Set<EntityId>,
  ): void {
    out.clear();
    const visibleEntityIds = visibility.getVisibleEntityIds();
    if (visibleEntityIds !== undefined) {
      for (let i = 0; i < visibleEntityIds.length; i++) {
        out.add(visibleEntityIds[i]);
      }
      return;
    }
    const sources: ReadonlyArray<readonly Entity[]> = [
      world.getUnits(),
      world.getBuildings(),
    ];
    for (let s = 0; s < sources.length; s++) {
      const source = sources[s];
      for (let i = 0; i < source.length; i++) {
        const entity = source[i];
        if (
          (entity.type === 'unit' || entity.type === 'building' || entity.type === 'tower') &&
          (!visibility.isFiltered || visibility.isEntityVisible(entity))
        ) {
          out.add(entity.id);
        }
      }
    }
  }

  private updateUnfilteredVisibleBaseline(
    listener: SnapshotListenerEntry,
    world: WorldState,
    dirtyIds: readonly EntityId[],
    removedEntities: readonly RemovedSnapshotEntity[],
  ): void {
    const baseline = listener.visibleEntityIds;
    for (let i = 0; i < removedEntities.length; i++) {
      baseline.delete(removedEntities[i].id);
    }
    for (let i = 0; i < dirtyIds.length; i++) {
      const entity = world.getEntity(dirtyIds[i]);
      if (
        entity !== undefined &&
        (entity.type === 'unit' || entity.type === 'building' || entity.type === 'tower')
      ) {
        baseline.add(entity.id);
      }
    }
    listener.hasVisibleEntityBaseline = true;
  }

  emit(input: ServerSnapshotPublisherInput): void {
    const emitBaseStages = createSnapshotMaterializationStageDurations();
    const lifecycleStart = performance.now();
    const gamePhase = input.simulation.getGamePhase();
    const winnerId = gamePhase === 'gameOver'
      ? input.simulation.getWinnerId() ?? undefined
      : undefined;
    const sprayTargets = input.simulation.getSprayTargets();
    const audioEvents = input.simulation.getAndClearEvents();
    const projectileSpawns = input.simulation.getAndClearProjectileSpawns();
    const projectileDespawns = input.simulation.getAndClearProjectileDespawns();
    const projectileVelocityUpdates = input.simulation.getAndClearProjectileVelocityUpdates();

    const unitCount = input.world.getUnits().length;

    this.dirtyIdsBuf.length = 0;
    this.dirtyFieldsBuf.length = 0;
    this.dirtySlotsBuf.length = 0;
    this.removedEntitiesBuf.length = 0;
    input.world.drainSnapshotDirtyEntities(
      this.dirtyIdsBuf,
      this.dirtyFieldsBuf,
      this.dirtySlotsBuf,
    );
    input.world.drainRemovedSnapshotEntities(this.removedEntitiesBuf);
    // FOW-OPT-21: removedEntities supersedes removedEntityIds in the
    // serializer — when both are present, the entity-records form
    // already covers every id with position metadata for the FOW-02b
    // ghost cleanup, so the parallel id array would be dead-loaded.
    // We only pass removedEntities below.
    addMaterializationStage(emitBaseStages, 'lifecycleDrain', lifecycleStart);

    let stageStart = performance.now();
    const wind = input.simulation.getWindState();
    const entityPoolStats = getEntitySnapshotPoolStats();
    const serverMeta = this.metaBuilder.build({
      tickAvg: input.tpsAvg,
      tickLow: input.tpsLow,
      tickRateHz: input.tickRateHz,
      snapshotRate: input.maxSnapshotsDisplay,
      ipAddress: input.ipAddress,
      gridEnabled: input.debugGridPublisher.isEnabled(),
      allowedUnits: input.backgroundMode ? input.backgroundAllowedUnitBlueprintIds : undefined,
      maxUnits: input.world.maxTotalUnits,
      unitCount,
      turretShieldPanelsEnabled: input.world.turretShieldPanelsEnabled,
      turretShieldSpheresEnabled: input.world.turretShieldSpheresEnabled,
      forceFieldsVisible: input.world.forceFieldsVisible,
      shieldsObstructSight: input.world.shieldsObstructSight,
      shieldReflectionMode: input.world.shieldReflectionMode,
      fogOfWarEnabled: input.world.fogOfWarEnabled,
      converterTax: input.world.converterTax,
      tickMsAvg: input.tickMsAvg,
      tickMsHi: input.tickMsHi,
      tickMsInitialized: input.tickMsInitialized,
      wind,
      retainedPools: {
        entitySnapshots: {
          retained: entityPoolStats.retainedEntries,
          active: entityPoolStats.activeEntries,
          warm: entityPoolStats.warmEntries,
        },
      },
      unitGroundNormalEmaMode: getUnitGroundNormalEmaMode(),
    });
    addMaterializationStage(emitBaseStages, 'meta', stageStart);

    stageStart = performance.now();
    const gridDebug = input.debugGridPublisher.refresh(performance.now(), input.world);
    const gridCells = gridDebug.cells;
    const gridSearchCells = gridDebug.searchCells;
    const gridCellSize = gridDebug.cellSize;
    addMaterializationStage(emitBaseStages, 'grid', stageStart);

    // Share one SnapshotVisibility per team across the listener loop
    // (FOW-OPT-01). Two teammates merge the same set of
    // ally vision sources into the same spatial hash; without this
    // we'd rebuild the same structure once per listener.
    const visibilityCache = this.visibilityCache;
    visibilityCache.clear();

    // FOW-OPT-20: per-team output cache for the three team-uniform
    // serializers. The first teammate's serializeForListener call
    // fills the slot (which goes through that listener's per-listener
    // pool — see FOW-OPT-07 / snapshotPool.ts); subsequent teammates
    // hand back the same array reference. Admin / spectator listeners
    // (no team mask) fall through to fresh per-call serialization.
    const teamAudioCache = this.teamAudioCache;
    const teamSprayCache = this.teamSprayCache;
    const teamMinimapCache = this.teamMinimapCache;
    teamAudioCache.clear();
    teamSprayCache.clear();
    teamMinimapCache.clear();

    const serializeForListener = (listener: SnapshotListenerEntry): SerializedListenerSnapshot => {
      const listenerStartedAt = performance.now();
      const stages = copySnapshotMaterializationStageDurations(emitBaseStages);
      let stageStart = performance.now();
      const visibility = getOrBuildVisibility(input.world, listener.playerId, visibilityCache);
      addMaterializationStage(stages, 'visibility', stageStart);
      const listenerNeedsStaticMap = this.listenerNeedsStaticMap(listener, input);
      listener.needsFullState = false;
      const shouldEmitMinimap = true;
      const shouldSendStaticTerrain = listenerNeedsStaticMap;
      // FOW-OPT-20: team-uniform payload caches are deferred until
      // after the direct-wire attempt so typed snapshot rows can be
      // written without materializing DTO arrays.
      const teamKey = visibility.teamMaskKey;
      let audioOverride: SerializerAudioOverride | undefined;
      let sprayOverride: SerializerSprayOverride | undefined;
      let minimapOverride: SerializerMinimapOverride | undefined = shouldEmitMinimap
        ? undefined
        : NO_MINIMAP_OVERRIDE;
      if (listener.preencodeWire) {
        const directSnapshot = this.directWirePreencoder.tryEncode({
          world: input.world,
          removedEntities: this.removedEntitiesBuf,
          recipientPlayerId: listener.playerId,
          visibility,
          gamePhase,
          winnerId,
          sprayTargets,
          audioEvents,
          projectileSpawns,
          projectileDespawns,
          projectileVelocityUpdates,
          gridCells,
          gridSearchCells,
          gridCellSize,
          emitProjectileDetailFields: true,
          audioOverride,
          sprayOverride,
          minimapOverride,
          terrain: shouldSendStaticTerrain ? input.terrainTileMap : undefined,
          buildability: shouldSendStaticTerrain ? input.terrainBuildabilityGrid : undefined,
          serverMeta,
          materializationStages: stages,
        });
        if (directSnapshot !== undefined) {
          stageStart = performance.now();
          if (shouldSendStaticTerrain) {
            this.markListenerStaticMapSent(listener, input);
          }
          addMaterializationStage(stages, 'staticPayload', stageStart);
          stageStart = performance.now();
          this.updateListenerVisibleBaselineFromIds(
            listener,
            directSnapshot.visibleEntityIds,
            input.world,
            visibility,
          );
          addMaterializationStage(stages, 'visibility', stageStart);
          this.stampSnapshotMaterialization(
            directSnapshot.state,
            'rich-full',
            listener,
            stages,
            listenerStartedAt,
            directSnapshot,
          );
          return directSnapshot;
        }
      }
      if (teamKey !== undefined) {
        audioOverride = teamAudioCache.get(teamKey);
        if (!audioOverride) {
          stageStart = performance.now();
          audioOverride = {
            value: serializeAudioEvents(audioEvents, visibility, listener.cacheKey),
          };
          teamAudioCache.set(teamKey, audioOverride);
          addMaterializationStage(stages, 'audio', stageStart);
        }
        sprayOverride = teamSprayCache.get(teamKey);
        if (!sprayOverride) {
          stageStart = performance.now();
          sprayOverride = {
            value: serializeSprayTargets(sprayTargets, visibility, listener.cacheKey),
          };
          teamSprayCache.set(teamKey, sprayOverride);
          addMaterializationStage(stages, 'spray', stageStart);
        }
        if (shouldEmitMinimap) {
          minimapOverride = teamMinimapCache.get(teamKey);
          if (!minimapOverride) {
            stageStart = performance.now();
            minimapOverride = {
              value: serializeMinimapSnapshotEntities(
                input.world,
                visibility,
                listener.cacheKey,
              ),
            };
            teamMinimapCache.set(teamKey, minimapOverride);
            addMaterializationStage(stages, 'minimap', stageStart);
          }
        }
      }
      const serializeOptions: SerializeGameStateOptions = {
        trackingKey: listener.cacheKey,
        removedEntityIds: undefined,
        removedEntities: this.removedEntitiesBuf,
        recipientPlayerId: listener.playerId,
        visibility,
        emitProjectileDetailFields: true,
        audioOverride,
        sprayOverride,
        minimapOverride,
        materializationStages: stages,
      };
      const state = serializeGameState(
        input.world,
        gamePhase,
        winnerId,
        sprayTargets,
        audioEvents,
        projectileSpawns,
        projectileDespawns,
        projectileVelocityUpdates,
        gridCells,
        gridSearchCells,
        gridCellSize,
        serializeOptions,
      );

      stageStart = performance.now();
      state.terrain = shouldSendStaticTerrain ? input.terrainTileMap : undefined;
      state.buildability = shouldSendStaticTerrain
        ? input.terrainBuildabilityGrid
        : undefined;
      if (shouldSendStaticTerrain) {
        this.markListenerStaticMapSent(listener, input);
      }
      state.serverMeta = serverMeta;
      addMaterializationStage(stages, 'staticPayload', stageStart);
      stageStart = performance.now();
      this.updateListenerVisibleBaseline(listener, input.world, visibility);
      addMaterializationStage(stages, 'visibility', stageStart);
      stageStart = performance.now();
      const encoded = this.wirePreencoder.encodeIfRequested(state, listener.preencodeWire);
      addMaterializationStage(stages, 'wireEncode', stageStart);
      this.stampSnapshotMaterialization(
        state,
        'rich-full',
        listener,
        stages,
        listenerStartedAt,
        encoded,
      );
      return encoded;
    };

    let sharedGlobalDynamicSnapshot: SerializedListenerSnapshot | undefined;
    let sharedGlobalStaticSnapshot: SerializedListenerSnapshot | undefined;
    for (const listener of input.listeners) {
      if (listener.playerId !== undefined) continue;
      if (this.listenerNeedsStaticMap(listener, input)) {
        if (!sharedGlobalStaticSnapshot) {
          sharedGlobalStaticSnapshot = serializeForListener(listener);
        } else {
          this.markListenerStaticMapSent(listener, input);
          this.updateListenerVisibleBaseline(
            listener,
            input.world,
            getOrBuildVisibility(input.world, listener.playerId, visibilityCache),
          );
        }
        listener.callback(
          sharedGlobalStaticSnapshot.state,
          undefined,
          this.wirePreencoder.resolve(sharedGlobalStaticSnapshot, listener.preencodeWire),
        );
      } else {
        if (!sharedGlobalDynamicSnapshot) {
          sharedGlobalDynamicSnapshot = serializeForListener(listener);
        } else {
          this.updateListenerVisibleBaseline(
            listener,
            input.world,
            getOrBuildVisibility(input.world, listener.playerId, visibilityCache),
          );
        }
        listener.callback(
          sharedGlobalDynamicSnapshot.state,
          undefined,
          this.wirePreencoder.resolve(sharedGlobalDynamicSnapshot, listener.preencodeWire),
        );
      }
    }

    for (const listener of input.listeners) {
      if (listener.playerId === undefined) continue;
      const snapshot = serializeForListener(listener);
      listener.callback(snapshot.state, undefined, snapshot.wirePayload);
    }
  }

  emitLockstepPresentation(input: ServerSnapshotPublisherInput): boolean {
    if (input.listeners.length === 0) return false;
    for (let i = 0; i < input.listeners.length; i++) {
      const listener = input.listeners[i];
      if (
        !listener.startupReady ||
        listener.needsFullState ||
        this.listenerNeedsStaticMap(listener, input) ||
        !listener.hasVisibleEntityBaseline
      ) {
        this.emit(input);
        return true;
      }
    }
    return this.emitDirtyPresentationDelta(input);
  }

  private emitDirtyPresentationDelta(input: ServerSnapshotPublisherInput): boolean {
    const emitBaseStages = createSnapshotMaterializationStageDurations();
    const lifecycleStart = performance.now();
    const gamePhase = input.simulation.getGamePhase();
    const winnerId = gamePhase === 'gameOver'
      ? input.simulation.getWinnerId() ?? undefined
      : undefined;
    const sprayTargets = input.simulation.getSprayTargets();
    const audioEvents = input.simulation.getAndClearEvents();
    const projectileSpawns = input.simulation.getAndClearProjectileSpawns();
    const projectileDespawns = input.simulation.getAndClearProjectileDespawns();
    const projectileVelocityUpdates = input.simulation.getAndClearProjectileVelocityUpdates();
    const hasLiveLineProjectiles = input.world.getLineProjectiles().length > 0;

    this.dirtyIdsBuf.length = 0;
    this.dirtyFieldsBuf.length = 0;
    this.dirtySlotsBuf.length = 0;
    this.removedEntitiesBuf.length = 0;
    input.world.drainSnapshotDirtyEntities(
      this.dirtyIdsBuf,
      this.dirtyFieldsBuf,
      this.dirtySlotsBuf,
    );
    input.world.drainRemovedSnapshotEntities(this.removedEntitiesBuf);
    this.rememberDeferredDirtyEntityMotionRows(
      input.world,
      this.dirtyIdsBuf,
      this.dirtyFieldsBuf,
      this.dirtySlotsBuf,
    );

    const hasProjectileEvents =
      projectileSpawns.length > 0 ||
      projectileDespawns.length > 0 ||
      projectileVelocityUpdates.length > 0 ||
      hasLiveLineProjectiles;
    addMaterializationStage(emitBaseStages, 'lifecycleDrain', lifecycleStart);

    let stageStart = performance.now();
    const unitCount = input.world.getUnits().length;
    const entityPoolStats = getEntitySnapshotPoolStats();
    const serverMeta = this.metaBuilder.build({
      tickAvg: input.tpsAvg,
      tickLow: input.tpsLow,
      tickRateHz: input.tickRateHz,
      snapshotRate: input.maxSnapshotsDisplay,
      ipAddress: input.ipAddress,
      gridEnabled: input.debugGridPublisher.isEnabled(),
      allowedUnits: input.backgroundMode ? input.backgroundAllowedUnitBlueprintIds : undefined,
      maxUnits: input.world.maxTotalUnits,
      unitCount,
      turretShieldPanelsEnabled: input.world.turretShieldPanelsEnabled,
      turretShieldSpheresEnabled: input.world.turretShieldSpheresEnabled,
      forceFieldsVisible: input.world.forceFieldsVisible,
      shieldsObstructSight: input.world.shieldsObstructSight,
      shieldReflectionMode: input.world.shieldReflectionMode,
      fogOfWarEnabled: input.world.fogOfWarEnabled,
      converterTax: input.world.converterTax,
      tickMsAvg: input.tickMsAvg,
      tickMsHi: input.tickMsHi,
      tickMsInitialized: input.tickMsInitialized,
      wind: input.simulation.getWindState(),
      retainedPools: {
        entitySnapshots: {
          retained: entityPoolStats.retainedEntries,
          active: entityPoolStats.activeEntries,
          warm: entityPoolStats.warmEntries,
        },
      },
      unitGroundNormalEmaMode: getUnitGroundNormalEmaMode(),
    });
    addMaterializationStage(emitBaseStages, 'meta', stageStart);

    stageStart = performance.now();
    const gridDebug = input.debugGridPublisher.refresh(performance.now(), input.world);
    const gridCells = gridDebug.cells;
    const gridSearchCells = gridDebug.searchCells;
    const gridCellSize = gridDebug.cellSize;
    addMaterializationStage(emitBaseStages, 'grid', stageStart);

    const visibilityCache = this.visibilityCache;
    visibilityCache.clear();
    const teamAudioCache = this.teamAudioCache;
    const teamSprayCache = this.teamSprayCache;
    const teamMinimapCache = this.teamMinimapCache;
    teamAudioCache.clear();
    teamSprayCache.clear();
    teamMinimapCache.clear();

    let emitted = false;
    for (const listener of input.listeners) {
      const listenerStartedAt = performance.now();
      const stages = copySnapshotMaterializationStageDurations(emitBaseStages);
      let stageStart = performance.now();
      const visibility = getOrBuildVisibility(input.world, listener.playerId, visibilityCache);
      const currentVisible = visibility.getVisibleEntityIdSet();
      const currentVisibleList = currentVisible !== undefined
        ? visibility.getVisibleEntityIds()
        : undefined;
      const currentVisibleSlots = currentVisibleList !== undefined
        ? visibility.getVisibleEntitySlots()
        : undefined;
      addMaterializationStage(stages, 'visibility', stageStart);
      if (listener.preencodeWire) {
        const directSnapshot = this.directWirePreencoder.tryEncodeRichDelta({
          world: input.world,
          removedEntities: this.removedEntitiesBuf,
          recipientPlayerId: listener.playerId,
          visibility,
          previousVisibleEntityIds: listener.visibleEntityIds,
          currentVisibleEntityIds: currentVisible,
          currentVisibleEntityIdList: currentVisibleList,
          currentVisibleEntitySlots: currentVisibleSlots,
          dirtyIds: this.dirtyIdsBuf,
          dirtyFields: this.dirtyFieldsBuf,
          dirtySlots: this.dirtySlotsBuf,
          gamePhase,
          winnerId,
          sprayTargets,
          audioEvents,
          projectileSpawns,
          projectileDespawns,
          projectileVelocityUpdates,
          gridCells,
          gridSearchCells,
          gridCellSize,
          audioOverride: undefined,
          sprayOverride: undefined,
          minimapOverride: undefined,
          serverMeta,
          materializationStages: stages,
        });
        if (directSnapshot !== undefined) {
          stageStart = performance.now();
          if (currentVisible !== undefined) {
            this.applyVisibleBaselineDelta(
              listener,
              directSnapshot.visibleBaselineAddedIds,
              directSnapshot.visibleBaselineRemovedIds,
            );
          } else {
            this.updateUnfilteredVisibleBaseline(
              listener,
              input.world,
              this.dirtyIdsBuf,
              this.removedEntitiesBuf,
            );
          }
          addMaterializationStage(stages, 'visibility', stageStart);
          this.stampSnapshotMaterialization(
            directSnapshot.state,
            'rich-delta',
            listener,
            stages,
            listenerStartedAt,
            directSnapshot,
          );
          listener.callback(directSnapshot.state, undefined, directSnapshot.wirePayload);
          emitted = true;
          continue;
        }
      }
      stageStart = performance.now();
      const entities = currentVisible !== undefined
        ? this.serializeDirtyPresentationEntitiesAndAddVisibleBaseline(
            input.world,
            visibility,
            listener.visibleEntityIds,
            currentVisibleList!,
            currentVisibleSlots,
            currentVisible,
            this.dirtyIdsBuf,
            this.dirtyFieldsBuf,
            this.dirtySlotsBuf,
          )
        : this.serializeUnfilteredDirtyPresentationEntities(
            input.world,
            visibility,
            listener.visibleEntityIds,
            this.dirtyIdsBuf,
            this.dirtyFieldsBuf,
            this.dirtySlotsBuf,
          );
      const removedEntityIds = currentVisible !== undefined
        ? this.serializeDirtyPresentationRemovalsAndPruneVisibleBaseline(
            visibility,
            listener.visibleEntityIds,
            currentVisible,
            this.removedEntitiesBuf,
          )
        : this.serializeUnfilteredDirtyPresentationRemovals(
            this.removedEntitiesBuf,
          );
      addMaterializationStage(stages, 'entityDtos', stageStart);

      const teamKey = visibility.teamMaskKey;
      let audioOverride: SerializerAudioOverride | undefined;
      let sprayOverride: SerializerSprayOverride | undefined;
      let minimapOverride: SerializerMinimapOverride | undefined;
      if (teamKey !== undefined) {
        audioOverride = teamAudioCache.get(teamKey);
        if (!audioOverride) {
          stageStart = performance.now();
          audioOverride = {
            value: serializeAudioEvents(audioEvents, visibility, listener.cacheKey),
          };
          teamAudioCache.set(teamKey, audioOverride);
          addMaterializationStage(stages, 'audio', stageStart);
        }
        sprayOverride = teamSprayCache.get(teamKey);
        if (!sprayOverride) {
          stageStart = performance.now();
          sprayOverride = {
            value: serializeSprayTargets(sprayTargets, visibility, listener.cacheKey),
          };
          teamSprayCache.set(teamKey, sprayOverride);
          addMaterializationStage(stages, 'spray', stageStart);
        }
        minimapOverride = teamMinimapCache.get(teamKey);
        if (!minimapOverride) {
          stageStart = performance.now();
          minimapOverride = {
            value: serializeMinimapSnapshotEntities(
              input.world,
              visibility,
              listener.cacheKey,
            ),
          };
          teamMinimapCache.set(teamKey, minimapOverride);
          addMaterializationStage(stages, 'minimap', stageStart);
        }
      }

      const minimapEntities = minimapOverride !== undefined
        ? minimapOverride.value
        : timeMaterializationStage(
            stages,
            'minimap',
            () => serializeMinimapSnapshotEntities(input.world, visibility, listener.cacheKey),
          );
      const economy = timeMaterializationStage(
        stages,
        'economy',
        () => serializeEconomySnapshot(input.world.playerCount, listener.playerId),
      );
      const resourceMovements = timeMaterializationStage(
        stages,
        'resources',
        () => serializeResourceMovements(input.world, visibility),
      );
      const sprayTargetsForSnapshot = sprayOverride !== undefined
        ? sprayOverride.value
        : timeMaterializationStage(
            stages,
            'spray',
            () => serializeSprayTargets(sprayTargets, visibility, listener.cacheKey),
          );
      const audioEventsForSnapshot = audioOverride !== undefined
        ? audioOverride.value
        : timeMaterializationStage(
            stages,
            'audio',
            () => serializeAudioEvents(audioEvents, visibility, listener.cacheKey),
          );
      const scanPulses = timeMaterializationStage(
        stages,
        'scanPulses',
        () => serializeScanPulses(input.world, visibility),
      );
      const projectiles = hasProjectileEvents
        ? timeMaterializationStage(
            stages,
            'projectiles',
            () => serializeProjectileSnapshot({
              world: input.world,
              fullStateResync: false,
              visibility,
              emitBeamUpdates: true,
              projectileSpawns,
              projectileDespawns,
              projectileVelocityUpdates,
            }),
          )
        : undefined;
      const gameState = timeMaterializationStage(
        stages,
        'gameState',
        () => ({
          phase: gamePhase,
          winnerId,
        }),
      );
      const grid = timeMaterializationStage(
        stages,
        'grid',
        () => serializeGridSnapshot(gridCells, gridSearchCells, gridCellSize),
      );

      const state: NetworkServerSnapshot = {
        tick: input.world.getTick(),
        entities,
        entityDeltaOnly: true,
        projectileDeltaOnly: undefined,
        minimapEntities,
        economy,
        resourceMovements,
        sprayTargets: sprayTargetsForSnapshot,
        audioEvents: audioEventsForSnapshot,
        scanPulses,
        shroud: undefined,
        projectiles,
        gameState,
        serverMeta,
        grid,
        terrain: undefined,
        buildability: undefined,
        removedEntityIds,
        visibilityFiltered: visibility.isFiltered ? true : undefined,
        visionPlayerMask: visibility.hasRecipient
          ? visibility.getVisionPlayerMask()
          : undefined,
      };

      stageStart = performance.now();
      if (currentVisible !== undefined) {
        listener.hasVisibleEntityBaseline = true;
      } else {
        this.updateUnfilteredVisibleBaseline(
          listener,
          input.world,
          this.dirtyIdsBuf,
          this.removedEntitiesBuf,
        );
      }
      addMaterializationStage(stages, 'visibility', stageStart);
      stageStart = performance.now();
      const encoded = this.wirePreencoder.encodeIfRequested(state, listener.preencodeWire);
      addMaterializationStage(stages, 'wireEncode', stageStart);
      this.stampSnapshotMaterialization(
        state,
        'rich-delta',
        listener,
        stages,
        listenerStartedAt,
        encoded,
      );
      listener.callback(state, undefined, encoded.wirePayload);
      emitted = true;
    }
    return emitted;
  }

  private serializeDirtyPresentationEntitiesAndAddVisibleBaseline(
    world: WorldState,
    visibility: SnapshotVisibility,
    previousVisibleEntityIds: Set<EntityId>,
    currentVisibleEntityIds: readonly EntityId[],
    currentVisibleEntitySlots: readonly number[] | undefined,
    currentVisibleEntityIdSet: ReadonlySet<EntityId>,
    dirtyIds: readonly EntityId[],
    dirtyFields: readonly number[],
    dirtySlots: readonly number[],
  ): NetworkServerSnapshot['entities'] {
    resetEntitySnapshotPool();
    const entities: NetworkServerSnapshot['entities'] = [];
    registerEntitySnapshotWireSource(entities);
    const emittedIds = this.deltaEntityIdSet;
    emittedIds.clear();

    for (let i = 0; i < currentVisibleEntityIds.length; i++) {
      const id = currentVisibleEntityIds[i];
      if (previousVisibleEntityIds.has(id)) continue;
      const entity = this.resolveSnapshotEntityFromSlot(
        world,
        id,
        currentVisibleEntitySlots !== undefined ? currentVisibleEntitySlots[i] : -1,
      );
      if (
        entity === undefined ||
        (entity.type !== 'unit' && entity.type !== 'building' && entity.type !== 'tower')
      ) continue;
      const netEntity = serializeEntitySnapshot(entity, undefined, world, visibility);
      if (netEntity !== null) {
        entities.push(netEntity);
        emittedIds.add(id);
        previousVisibleEntityIds.add(id);
      }
    }

    for (let i = 0; i < dirtyIds.length; i++) {
      const id = dirtyIds[i];
      if (emittedIds.has(id)) continue;
      if (!currentVisibleEntityIdSet.has(id)) continue;
      if (
        this.shouldDeferDirtyEntityToSparseMotion(
          world,
          id,
          dirtyFields[i],
          dirtySlots[i],
        )
      ) continue;
      if (this.tryPushSlabDeltaEntityRowFromState(entities, id, dirtyFields[i], dirtySlots[i])) {
        emittedIds.add(id);
        continue;
      }
      const entity = this.resolveSnapshotEntityFromSlot(world, id, dirtySlots[i]);
      if (
        entity === undefined ||
        (entity.type !== 'unit' && entity.type !== 'building' && entity.type !== 'tower')
      ) continue;
      const netEntity = serializeEntityDeltaSnapshot(entity, dirtyFields[i], world, visibility);
      if (netEntity !== null) {
        entities.push(netEntity as NetworkServerSnapshotEntity);
        emittedIds.add(id);
      }
    }

    emittedIds.clear();
    return entities;
  }

  private resolveSnapshotEntityFromSlot(
    world: WorldState,
    id: EntityId,
    slot: number,
  ): Entity | undefined {
    if (slot >= 0) {
      const entity = entitySlotRegistry.resolveSlot(slot);
      if (entity !== undefined && entity.id === id) return entity;
    }
    return world.getEntity(id);
  }

  private serializeUnfilteredDirtyPresentationEntities(
    world: WorldState,
    visibility: SnapshotVisibility,
    previousVisibleEntityIds: ReadonlySet<EntityId>,
    dirtyIds: readonly EntityId[],
    dirtyFields: readonly number[],
    dirtySlots: readonly number[],
  ): NetworkServerSnapshot['entities'] {
    resetEntitySnapshotPool();
    const entities: NetworkServerSnapshot['entities'] = [];
    registerEntitySnapshotWireSource(entities);
    const emittedIds = this.deltaEntityIdSet;
    emittedIds.clear();

    for (let i = 0; i < dirtyIds.length; i++) {
      const id = dirtyIds[i];
      if (emittedIds.has(id)) continue;
      const changedFields = previousVisibleEntityIds.has(id) ? dirtyFields[i] : undefined;
      if (
        changedFields !== undefined &&
        this.shouldDeferDirtyEntityToSparseMotion(
          world,
          id,
          changedFields,
          dirtySlots[i],
        )
      ) {
        continue;
      }
      if (
        changedFields !== undefined &&
        this.tryPushSlabDeltaEntityRowFromState(entities, id, changedFields, dirtySlots[i])
      ) {
        emittedIds.add(id);
        continue;
      }
      const entity = this.resolveSnapshotEntityFromSlot(world, id, dirtySlots[i]);
      if (
        entity === undefined ||
        (entity.type !== 'unit' && entity.type !== 'building' && entity.type !== 'tower')
      ) continue;
      const netEntity = changedFields !== undefined
        ? serializeEntityDeltaSnapshot(entity, changedFields, world, visibility)
        : serializeEntitySnapshot(entity, undefined, world, visibility);
      if (netEntity !== null) {
        entities.push(netEntity as NetworkServerSnapshotEntity);
        emittedIds.add(id);
      }
    }

    emittedIds.clear();
    return entities;
  }

  private serializeDirtyPresentationRemovalsAndPruneVisibleBaseline(
    visibility: SnapshotVisibility,
    previousVisibleEntityIds: Set<EntityId>,
    currentVisibleEntityIds: ReadonlySet<EntityId>,
    removedEntities: readonly RemovedSnapshotEntity[],
  ): NetworkServerSnapshot['removedEntityIds'] {
    const removedIds = this.deltaRemovedEntityIdsBuf;
    const removedIdSet = this.deltaRemovedEntityIdSet;
    removedIds.length = 0;
    removedIdSet.clear();

    const pushRemoved = (id: EntityId): void => {
      if (removedIdSet.has(id)) return;
      removedIdSet.add(id);
      removedIds.push(id);
    };

    for (let i = 0; i < removedEntities.length; i++) {
      const record = removedEntities[i];
      const wasPreviouslyVisible = previousVisibleEntityIds.has(record.id);
      if (wasPreviouslyVisible || visibility.shouldSendRemoval(record)) pushRemoved(record.id);
      previousVisibleEntityIds.delete(record.id);
    }

    for (const id of previousVisibleEntityIds) {
      if (!currentVisibleEntityIds.has(id)) {
        pushRemoved(id);
        previousVisibleEntityIds.delete(id);
      }
    }

    removedIdSet.clear();
    return removedIds.length > 0 ? removedIds : undefined;
  }

  private serializeUnfilteredDirtyPresentationRemovals(
    removedEntities: readonly RemovedSnapshotEntity[],
  ): NetworkServerSnapshot['removedEntityIds'] {
    const removedIds = this.deltaRemovedEntityIdsBuf;
    const removedIdSet = this.deltaRemovedEntityIdSet;
    removedIds.length = 0;
    removedIdSet.clear();

    for (let i = 0; i < removedEntities.length; i++) {
      const record = removedEntities[i];
      if (removedIdSet.has(record.id)) continue;
      removedIdSet.add(record.id);
      removedIds.push(record.id);
    }

    removedIdSet.clear();
    return removedIds.length > 0 ? removedIds : undefined;
  }

  private applyVisibleBaselineDelta(
    listener: SnapshotListenerEntry,
    addedIds: readonly EntityId[] | undefined,
    removedIds: readonly EntityId[] | undefined,
  ): void {
    const baseline = listener.visibleEntityIds;
    if (removedIds !== undefined) {
      for (let i = 0; i < removedIds.length; i++) baseline.delete(removedIds[i]);
    }
    if (addedIds !== undefined) {
      for (let i = 0; i < addedIds.length; i++) baseline.add(addedIds[i]);
    }
    listener.hasVisibleEntityBaseline = true;
  }

  private shouldDeferDirtyEntityToSparseMotion(
    world: WorldState,
    id: EntityId,
    changedFields: number,
    slot = -1,
    entityViews: EntityStateViews | null = entitySlotRegistry.getViews(),
  ): boolean {
    if (!dirtyFieldsAreMotionOnly(changedFields)) return false;
    let resolvedSlot = slot;
    if (
      entityViews !== null &&
      (
        resolvedSlot < 0 ||
        resolvedSlot >= entityViews.capacity ||
        entityViews.entityId[resolvedSlot] !== id
      )
    ) {
      resolvedSlot = entitySlotRegistry.getSlot(id);
    }
    if (isEntityMotionDeltaCandidateSlot(entityViews, resolvedSlot, id)) {
      this.deferredEntityMotionIds.add(id);
      return true;
    }
    const entity = this.resolveSnapshotEntityFromSlot(world, id, resolvedSlot);
    if (entity === undefined || !shouldDeferToSparseEntityMotionDelta(entity, changedFields)) {
      return false;
    }
    this.deferredEntityMotionIds.add(id);
    return true;
  }

  private rememberDeferredDirtyEntityMotionRows(
    world: WorldState,
    dirtyIds: readonly EntityId[],
    dirtyFields: readonly number[],
    dirtySlots: readonly number[],
  ): void {
    const entityViews = entitySlotRegistry.getViews();
    for (let i = 0; i < dirtyIds.length; i++) {
      this.shouldDeferDirtyEntityToSparseMotion(
        world,
        dirtyIds[i],
        dirtyFields[i],
        dirtySlots[i],
        entityViews,
      );
    }
  }

  emitProjectileDelta(
    input: ServerSnapshotPublisherInput,
    includeEntityMotionDeltas = true,
  ): boolean {
    if (input.listeners.length === 0) return false;
    const emitBaseStages = createSnapshotMaterializationStageDurations();
    let stageStart = performance.now();
    const hasProjectilePresentationEvents = input.simulation.hasPendingProjectilePresentationEvents();
    const hasLiveLineProjectiles = input.world.getLineProjectiles().length > 0;
    addMaterializationStage(emitBaseStages, 'lifecycleDrain', stageStart);
    const motionCandidateIds = this.entityMotionCandidateIdsBuf;
    const motionCandidateSlots = this.entityMotionCandidateSlotsBuf;
    let hasEntityMotionDeltas = false;
    if (includeEntityMotionDeltas) {
      stageStart = performance.now();
      hasEntityMotionDeltas =
        this.collectEntityMotionDeltaCandidates(
          input.world,
          motionCandidateIds,
          motionCandidateSlots,
          input.simulation,
          true,
        ) > 0;
      addMaterializationStage(emitBaseStages, 'entityDtos', stageStart);
    } else {
      motionCandidateIds.length = 0;
      motionCandidateSlots.length = 0;
    }
    if (!hasProjectilePresentationEvents && !hasLiveLineProjectiles && !hasEntityMotionDeltas) return false;

    stageStart = performance.now();
    const audioEvents = hasProjectilePresentationEvents
      ? input.simulation.getAndClearEvents()
      : undefined;
    const projectileSpawns = hasProjectilePresentationEvents
      ? input.simulation.getAndClearProjectileSpawns()
      : undefined;
    const projectileDespawns = hasProjectilePresentationEvents
      ? input.simulation.getAndClearProjectileDespawns()
      : undefined;
    const projectileVelocityUpdates = hasProjectilePresentationEvents
      ? input.simulation.getAndClearProjectileVelocityUpdates()
      : undefined;
    const hasProjectileEventsAfterDrain =
      projectileSpawns !== undefined &&
      projectileDespawns !== undefined &&
      projectileVelocityUpdates !== undefined &&
      (
        projectileSpawns.length > 0 ||
        projectileDespawns.length > 0 ||
        projectileVelocityUpdates.length > 0
      );
    const hasProjectilesAfterDrain = hasLiveLineProjectiles || hasProjectileEventsAfterDrain;
    if (!hasProjectilesAfterDrain && !hasEntityMotionDeltas) {
      return false;
    }
    addMaterializationStage(emitBaseStages, 'lifecycleDrain', stageStart);

    const visibilityCache = this.visibilityCache;
    visibilityCache.clear();
    let emitted = false;
    for (const listener of input.listeners) {
      const listenerStartedAt = performance.now();
      const stages = copySnapshotMaterializationStageDurations(emitBaseStages);
      let stageStart = performance.now();
      const visibility = getOrBuildVisibility(input.world, listener.playerId, visibilityCache);
      addMaterializationStage(stages, 'visibility', stageStart);
      if (listener.preencodeWire) {
        const directSnapshot = this.directWirePreencoder.tryEncodeSparseDelta({
          world: input.world,
          visibility,
          motionCandidateIds,
          motionCandidateSlots,
          audioEvents,
          projectileSpawns,
          projectileDespawns,
          projectileVelocityUpdates,
          materializationStages: stages,
        });
        if (directSnapshot !== undefined) {
          this.stampSnapshotMaterialization(
            directSnapshot.state,
            'sparse-delta',
            listener,
            stages,
            listenerStartedAt,
            directSnapshot,
          );
          listener.callback(directSnapshot.state, undefined, directSnapshot.wirePayload);
          emitted = true;
          continue;
        }
      }
      const motionEntities = hasEntityMotionDeltas
        ? timeMaterializationStage(
            stages,
            'entityDtos',
            () => this.serializeEntityMotionDelta(
              input.world,
              visibility,
              motionCandidateIds,
              motionCandidateSlots,
            ),
          )
        : undefined;
      const projectiles = hasProjectilesAfterDrain
        ? timeMaterializationStage(
            stages,
            'projectiles',
            () => serializeProjectileSnapshot({
              world: input.world,
              fullStateResync: false,
              visibility,
              emitBeamUpdates: true,
              projectileSpawns,
              projectileDespawns,
              projectileVelocityUpdates,
            }),
          )
        : undefined;
      const netAudioEvents = audioEvents !== undefined
        ? timeMaterializationStage(
            stages,
            'audio',
            () => serializeAudioEvents(audioEvents, visibility, listener.cacheKey),
          )
        : undefined;
      if (
        motionEntities === undefined &&
        projectiles === undefined &&
        netAudioEvents === undefined
      ) continue;
      const hasMotionEntities = motionEntities !== undefined && motionEntities.length > 0;
      const state: NetworkServerSnapshot = {
        tick: input.world.getTick(),
        entities: motionEntities ?? PROJECTILE_DELTA_EMPTY_ENTITIES,
        entityDeltaOnly: hasMotionEntities ? true : undefined,
        projectileDeltaOnly: hasMotionEntities ? undefined : true,
        minimapEntities: undefined,
        economy: PROJECTILE_DELTA_EMPTY_ECONOMY,
        resourceMovements: undefined,
        sprayTargets: undefined,
        audioEvents: netAudioEvents,
        scanPulses: undefined,
        shroud: undefined,
        projectiles,
        gameState: undefined,
        serverMeta: undefined,
        grid: undefined,
        terrain: undefined,
        buildability: undefined,
        visibilityFiltered: undefined,
        visionPlayerMask: undefined,
        removedEntityIds: undefined,
      };
      stageStart = performance.now();
      const encoded = this.wirePreencoder.encodeIfRequested(state, listener.preencodeWire);
      addMaterializationStage(stages, 'wireEncode', stageStart);
      this.stampSnapshotMaterialization(
        state,
        'sparse-delta',
        listener,
        stages,
        listenerStartedAt,
        encoded,
      );
      listener.callback(state, undefined, encoded.wirePayload);
      emitted = true;
    }
    return emitted;
  }

  private serializeEntityMotionDelta(
    world: WorldState,
    visibility: SnapshotVisibility,
    candidateIds: readonly EntityId[],
    candidateSlots: readonly number[],
  ): NetworkServerSnapshot['entities'] | undefined {
    resetEntitySnapshotPool();
    const entities: NetworkServerSnapshot['entities'] = [];
    registerEntitySnapshotWireSource(entities);
    const visibleEntityIds = visibility.getVisibleEntityIdSet();
    const entityViews = entitySlotRegistry.getViews();
    for (let i = 0; i < candidateIds.length; i++) {
      const id = candidateIds[i];
      if (visibleEntityIds !== undefined && !visibleEntityIds.has(id)) continue;
      if (
        this.tryAppendUnitSlabDeltaRowFromState(
          id,
          ENTITY_MOTION_DELTA_FIELDS,
          entityViews,
          candidateSlots[i] ?? -1,
        )
      ) {
        entities.push(undefined as unknown as NetworkServerSnapshotEntity);
        continue;
      }
      const entity = this.resolveSnapshotEntityFromSlot(world, id, candidateSlots[i] ?? -1);
      if (entity === undefined) continue;
      if (visibility.isFiltered && !visibility.isEntityVisible(entity)) continue;
      const netEntity = serializeEntityDeltaSnapshot(
        entity,
        ENTITY_MOTION_DELTA_FIELDS,
        world,
        visibility,
      );
      if (netEntity !== null) entities.push(netEntity as NetworkServerSnapshotEntity);
    }
    return entities.length > 0 ? entities : undefined;
  }

  private tryPushSlabDeltaEntityRowFromState(
    entities: NetworkServerSnapshot['entities'],
    id: EntityId,
    changedFields: number,
    slot = -1,
  ): boolean {
    const entityViews = entitySlotRegistry.getViews();
    if (
      this.tryAppendUnitSlabDeltaRowFromState(id, changedFields, entityViews, slot) ||
      this.tryAppendBuildingSlabDeltaRowFromState(id, changedFields, entityViews, slot)
    ) {
      entities.push(undefined as unknown as NetworkServerSnapshotEntity);
      return true;
    }
    return false;
  }

  private tryAppendUnitSlabDeltaRowFromState(
    id: EntityId,
    changedFields: number,
    entityViews: EntityStateViews | null,
    slot = -1,
  ): boolean {
    if (changedFields === 0 || (changedFields & ~ENTITY_UNIT_SLAB_DELTA_FIELDS) !== 0) {
      return false;
    }
    if (entityViews === null) return false;
    let resolvedSlot = slot;
    if (
      resolvedSlot < 0 ||
      resolvedSlot >= entityViews.capacity ||
      entityViews.entityId[resolvedSlot] !== id
    ) {
      resolvedSlot = entitySlotRegistry.getSlot(id);
    }
    if (
      resolvedSlot < 0 ||
      resolvedSlot >= entityViews.capacity ||
      entityViews.entityId[resolvedSlot] !== id
    ) {
      return false;
    }
    return appendUnitMotionEntityWireRowDirectFromState(
      entityViews,
      resolvedSlot,
      changedFields,
    );
  }

  private tryAppendBuildingSlabDeltaRowFromState(
    id: EntityId,
    changedFields: number,
    entityViews: EntityStateViews | null,
    slot = -1,
  ): boolean {
    if (entityViews === null) return false;
    let resolvedSlot = slot;
    if (
      resolvedSlot < 0 ||
      resolvedSlot >= entityViews.capacity ||
      entityViews.entityId[resolvedSlot] !== id
    ) {
      resolvedSlot = entitySlotRegistry.getSlot(id);
    }
    if (
      resolvedSlot < 0 ||
      resolvedSlot >= entityViews.capacity ||
      entityViews.entityId[resolvedSlot] !== id
    ) {
      return false;
    }
    if ((changedFields & ~ENTITY_BASIC_TRANSFORM_DELTA_FIELDS) === 0) {
      return appendBasicEntityWireRowDirectFromState(entityViews, resolvedSlot, changedFields);
    }
    return appendBuildingHotEntityWireRowDirectFromState(entityViews, resolvedSlot, changedFields);
  }

  private collectEntityMotionDeltaCandidates(
    world: WorldState,
    out: EntityId[],
    outSlots: number[],
    simulation?: Simulation,
    drainDeferredMotion = false,
  ): number {
    const slotNativeCount = this.collectEntityMotionDeltaCandidatesFromSlots(
      world,
      out,
      outSlots,
      simulation,
      drainDeferredMotion,
    );
    if (slotNativeCount >= 0) return slotNativeCount;

    return this.collectEntityMotionDeltaCandidatesFromEntities(
      world,
      out,
      outSlots,
      simulation,
      drainDeferredMotion,
    );
  }

  private collectEntityMotionDeltaCandidatesFromEntities(
    world: WorldState,
    out: EntityId[],
    outSlots: number[],
    simulation?: Simulation,
    drainDeferredMotion = false,
  ): number {
    out.length = 0;
    outSlots.length = 0;
    const packed = this.entityMotionCandidatePackedBuf;
    packed.length = 0;
    const seen = this.entityMotionCandidateIdSet;
    seen.clear();
    const entityViews = entitySlotRegistry.getViews();
    const pushCandidate = (id: EntityId, slot: number): void => {
      if (seen.has(id)) return;
      seen.add(id);
      packed.push(id * MOTION_CANDIDATE_SLOT_PACK_BASE + slot + 1);
    };

    for (const id of this.deferredEntityMotionIds) {
      const entity = world.getEntity(id);
      if (entity === undefined || entity.unit === null || entity.unit.hp <= 0) continue;
      pushCandidate(id, entitySlotRegistry.getEntitySlot(entity));
    }
    if (drainDeferredMotion) this.deferredEntityMotionIds.clear();
    const movingUnits = simulation?.getMovingUnits();
    if (movingUnits !== undefined) {
      const movingUnitSlots = simulation?.getMovingUnitSlots();
      for (let i = 0; i < movingUnits.length; i++) {
        const entity = movingUnits[i];
        const slot = movingUnitSlots?.[i] ?? entitySlotRegistry.getEntitySlot(entity);
        if (
          !this.isEntityMotionDeltaCandidateFromState(
            entity,
            entityViews,
            slot,
          ) ||
          seen.has(entity.id)
        ) {
          continue;
        }
        pushCandidate(entity.id, slot);
      }
    }

    const flyingUnits = world.getFlyingUnits();
    for (let i = 0; i < flyingUnits.length; i++) {
      const entity = flyingUnits[i];
      const slot = entitySlotRegistry.getEntitySlot(entity);
      if (!this.isEntityMotionDeltaCandidateFromState(entity, entityViews, slot) || seen.has(entity.id)) {
        continue;
      }
      pushCandidate(entity.id, slot);
    }
    seen.clear();
    packed.sort((a, b) => a - b);
    for (let i = 0; i < packed.length; i++) {
      const value = packed[i];
      out.push(Math.floor(value / MOTION_CANDIDATE_SLOT_PACK_BASE) as EntityId);
      outSlots.push((value % MOTION_CANDIDATE_SLOT_PACK_BASE) - 1);
    }
    packed.length = 0;
    return out.length;
  }

  private collectEntityMotionDeltaCandidatesFromSlots(
    world: WorldState,
    out: EntityId[],
    outSlots: number[],
    simulation?: Simulation,
    drainDeferredMotion = false,
  ): number {
    const sim = getSimWasm();
    const entityViews = entitySlotRegistry.getViews();
    if (sim === undefined || entityViews === null) return -1;

    out.length = 0;
    outSlots.length = 0;
    this.beginEntityMotionCandidateSlotMarkFrame();

    for (const id of this.deferredEntityMotionIds) {
      const slot = entitySlotRegistry.getSlot(id);
      if (this.slotHasLiveUnit(entityViews, slot, id)) {
        this.pushEntityMotionCandidateSlot(slot);
        continue;
      }
      const entity = world.getEntity(id);
      if (entity === undefined || entity.unit === null || entity.unit.hp <= 0) continue;
      const entitySlot = entitySlotRegistry.getEntitySlot(entity);
      if (
        entitySlot < 0 ||
        entitySlot >= entityViews.capacity ||
        entityViews.entityId[entitySlot] !== id
      ) {
        return -1;
      }
      this.pushEntityMotionCandidateSlot(entitySlot);
    }
    const movingUnitSlots = simulation?.getMovingUnitSlots();
    if (movingUnitSlots !== undefined) {
      for (let i = 0; i < movingUnitSlots.length; i++) {
        const slot = movingUnitSlots[i];
        if (slot < 0 || slot >= entityViews.capacity) return -1;
        const id = entityViews.entityId[slot] as EntityId;
        if (id < 0) return -1;
        if (this.slotIsMotionCandidate(entityViews, slot, id)) {
          this.pushEntityMotionCandidateSlot(slot);
        }
      }
    }

    const flyingUnitSlots = world.getFlyingUnitSlots();
    for (let i = 0; i < flyingUnitSlots.length; i++) {
      const slot = flyingUnitSlots[i];
      if (slot < 0 || slot >= entityViews.capacity) return -1;
      const id = entityViews.entityId[slot] as EntityId;
      if (id < 0) return -1;
      if (this.slotIsMotionCandidate(entityViews, slot, id)) {
        this.pushEntityMotionCandidateSlot(slot);
      }
    }

    const count = this.entityMotionCandidateSlotCount;
    if (count === 0) {
      if (drainDeferredMotion) this.deferredEntityMotionIds.clear();
      return 0;
    }
    const slots = this.entityMotionCandidateSlotScratch.subarray(0, count);
    sim.entityState.sortSlotsByEntityId(slots);
    for (let i = 0; i < count; i++) {
      const slot = slots[i];
      const id = entityViews.entityId[slot] as EntityId;
      if (id < 0) continue;
      out.push(id);
      outSlots.push(slot);
    }
    if (drainDeferredMotion) this.deferredEntityMotionIds.clear();
    return out.length;
  }

  private slotHasLiveUnit(
    views: EntityStateViews,
    slot: number,
    entityId: EntityId,
  ): boolean {
    return slot >= 0 &&
      slot < views.capacity &&
      views.entityId[slot] === entityId &&
      views.kind[slot] === ENTITY_STATE_KIND_UNIT &&
      views.hp[slot] > 0;
  }

  private slotIsMotionCandidate(
    views: EntityStateViews,
    slot: number,
    entityId: EntityId,
  ): boolean {
    return isEntityMotionDeltaCandidateSlot(views, slot, entityId);
  }

  private beginEntityMotionCandidateSlotMarkFrame(): void {
    this.entityMotionCandidateSlotCount = 0;
    if (this.entityMotionCandidateSlotMark >= MOTION_CANDIDATE_MARK_MAX) {
      this.entityMotionCandidateSlotMarks.fill(0);
      this.entityMotionCandidateSlotMark = 1;
      return;
    }
    this.entityMotionCandidateSlotMark++;
  }

  private pushEntityMotionCandidateSlot(slot: number): void {
    if (slot < 0 || !Number.isInteger(slot)) return;
    if (slot >= this.entityMotionCandidateSlotMarks.length) {
      let cap = this.entityMotionCandidateSlotMarks.length;
      while (cap <= slot) cap *= 2;
      const next = new Uint32Array(cap);
      next.set(this.entityMotionCandidateSlotMarks);
      this.entityMotionCandidateSlotMarks = next;
    }
    if (this.entityMotionCandidateSlotMarks[slot] === this.entityMotionCandidateSlotMark) {
      return;
    }
    this.entityMotionCandidateSlotMarks[slot] = this.entityMotionCandidateSlotMark;
    const count = this.entityMotionCandidateSlotCount;
    if (count >= this.entityMotionCandidateSlotScratch.length) {
      const next = new Uint32Array(this.entityMotionCandidateSlotScratch.length * 2);
      next.set(this.entityMotionCandidateSlotScratch);
      this.entityMotionCandidateSlotScratch = next;
    }
    this.entityMotionCandidateSlotScratch[count] = slot;
    this.entityMotionCandidateSlotCount = count + 1;
  }

  private isEntityMotionDeltaCandidateFromState(
    entity: Entity,
    entityViews: EntityStateViews | null,
    slot = entitySlotRegistry.getEntitySlot(entity),
  ): boolean {
    return isEntityMotionDeltaCandidateSlot(entityViews, slot, entity.id) ||
      isEntityMotionDeltaCandidate(entity);
  }

  private listenerNeedsStaticMap(
    listener: SnapshotListenerEntry,
    input: ServerSnapshotPublisherInput,
  ): boolean {
    return !listener.startupReady ||
      listener.needsStatic ||
      listener.lastStaticTerrainTileMap !== input.terrainTileMap ||
      listener.lastStaticBuildabilityGrid !== input.terrainBuildabilityGrid;
  }

  private markListenerStaticMapSent(
    listener: SnapshotListenerEntry,
    input: ServerSnapshotPublisherInput,
  ): void {
    listener.lastStaticTerrainTileMap = input.terrainTileMap;
    listener.lastStaticBuildabilityGrid = input.terrainBuildabilityGrid;
    listener.needsStatic = false;
  }
}
