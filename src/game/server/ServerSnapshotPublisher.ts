import type { SnapshotRate, TickRate } from '../../types/server';
import { getUnitGroundNormalEmaMode } from '../sim/unitGroundNormal';
import type { WorldState } from '../sim/WorldState';
import type { RemovedSnapshotEntity } from '../sim/WorldState';
import type { Simulation } from '../sim/Simulation';
import type { Entity, PlayerId, EntityId } from '../sim/types';
import type { NetworkServerSnapshot } from '../network/NetworkTypes';
import { serializeGameState } from '../network/stateSerializer';
import type { SerializeGameStateOptions } from '../network/stateSerializer';
import {
  ENTITY_CHANGED_NORMAL,
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_ROT,
  ENTITY_CHANGED_VEL,
} from '../../types/network';
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
import {
  getEntitySnapshotPoolStats,
  registerEntitySnapshotWireSource,
  resetEntitySnapshotPool,
  serializeEntitySnapshot,
} from '../network/stateSerializerEntities';
import {
  addSnapshotMaterializationStageFromStart,
  copySnapshotMaterializationStageDurations,
  createSnapshotMaterializationStageDurations,
  setSnapshotMaterializationMetadata,
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

const NO_MINIMAP_OVERRIDE: SerializerMinimapOverride = { value: undefined };
const PROJECTILE_DELTA_EMPTY_ENTITIES: NetworkServerSnapshot['entities'] = [];
const PROJECTILE_DELTA_EMPTY_ECONOMY: NetworkServerSnapshot['economy'] = {};
const ENTITY_MOTION_DELTA_FIELDS =
  ENTITY_CHANGED_POS |
  ENTITY_CHANGED_ROT |
  ENTITY_CHANGED_VEL |
  ENTITY_CHANGED_NORMAL;
const ENTITY_MOTION_SPEED_EPSILON_SQ = 0.01 * 0.01;
const ENTITY_MOTION_ANGULAR_EPSILON_SQ = 0.0001 * 0.0001;

function isEntityMotionDeltaCandidate(entity: Entity): boolean {
  const unit = entity.unit;
  if (unit === null || unit.hp <= 0 || unit.locomotion.type !== 'flying') return false;
  const vx = unit.velocityX ?? 0;
  const vy = unit.velocityY ?? 0;
  const vz = unit.velocityZ ?? 0;
  if (vx * vx + vy * vy + vz * vz > ENTITY_MOTION_SPEED_EPSILON_SQ) return true;
  const av = unit.angularVelocity3;
  if (av === null) return false;
  return av.x * av.x + av.y * av.y + av.z * av.z > ENTITY_MOTION_ANGULAR_EPSILON_SQ;
}

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
  visibleEntityIds: Set<EntityId>;
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
  private readonly removedEntitiesBuf: RemovedSnapshotEntity[] = [];
  private readonly visibilityCache = createSnapshotVisibilityCache();
  private readonly teamAudioCache = new Map<string, SerializerAudioOverride>();
  private readonly teamSprayCache = new Map<string, SerializerSprayOverride>();
  private readonly teamMinimapCache = new Map<string, SerializerMinimapOverride>();
  private readonly deltaRemovedEntityIdsBuf: EntityId[] = [];
  private readonly deltaRemovedEntityIdSet = new Set<EntityId>();
  private readonly deltaEntityIdSet = new Set<EntityId>();
  private readonly entityMotionCandidateIdsBuf: EntityId[] = [];
  reset(): void {}

  clear(): void {
    this.reset();
    this.dirtyIdsBuf.length = 0;
    this.dirtyFieldsBuf.length = 0;
    this.removedEntitiesBuf.length = 0;
    this.visibilityCache.clear();
    this.teamAudioCache.clear();
    this.teamSprayCache.clear();
    this.teamMinimapCache.clear();
    this.deltaRemovedEntityIdsBuf.length = 0;
    this.deltaRemovedEntityIdSet.clear();
    this.deltaEntityIdSet.clear();
    this.entityMotionCandidateIdsBuf.length = 0;
  }

  hasEntityMotionDeltaCandidates(world: WorldState): boolean {
    return this.collectEntityMotionDeltaCandidates(world, this.entityMotionCandidateIdsBuf) > 0;
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
    setSnapshotMaterializationMetadata(state, {
      kind,
      tick: state.tick,
      listener: listener.trackingKey,
      playerId: listener.playerId ?? null,
      entityRows: state.entities.length,
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
    const visibleEntityIdSet = visibility.getVisibleEntityIdSet();
    if (visibleEntityIdSet !== undefined) {
      this.copyVisibleIdsInto(baseline, visibleEntityIdSet);
    } else {
      this.collectCurrentVisibleEntityIds(world, visibility, baseline);
    }
    listener.hasVisibleEntityBaseline = true;
  }

  private copyVisibleIdsInto(
    out: Set<EntityId>,
    visibleEntityIds: Iterable<EntityId>,
  ): void {
    out.clear();
    for (const id of visibleEntityIds) out.add(id);
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
          visibility.isEntityVisible(entity)
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
    this.removedEntitiesBuf.length = 0;
    input.world.drainSnapshotDirtyEntities(this.dirtyIdsBuf, this.dirtyFieldsBuf);
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
          this.updateListenerVisibleBaseline(listener, input.world, visibility);
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

    this.dirtyIdsBuf.length = 0;
    this.dirtyFieldsBuf.length = 0;
    this.removedEntitiesBuf.length = 0;
    input.world.drainSnapshotDirtyEntities(this.dirtyIdsBuf, this.dirtyFieldsBuf);
    input.world.drainRemovedSnapshotEntities(this.removedEntitiesBuf);

    const hasProjectileEvents =
      projectileSpawns.length > 0 ||
      projectileDespawns.length > 0 ||
      projectileVelocityUpdates.length > 0;
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
      addMaterializationStage(stages, 'visibility', stageStart);
      if (listener.preencodeWire) {
        const directSnapshot = this.directWirePreencoder.tryEncodeRichDelta({
          world: input.world,
          removedEntities: this.removedEntitiesBuf,
          recipientPlayerId: listener.playerId,
          visibility,
          previousVisibleEntityIds: listener.visibleEntityIds,
          currentVisibleEntityIds: currentVisible,
          dirtyIds: this.dirtyIdsBuf,
          dirtyFields: this.dirtyFieldsBuf,
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
            this.copyVisibleBaseline(listener, currentVisible);
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
        ? this.serializeDirtyPresentationEntities(
            input.world,
            visibility,
            listener.visibleEntityIds,
            currentVisible,
            this.dirtyIdsBuf,
            this.dirtyFieldsBuf,
          )
        : this.serializeUnfilteredDirtyPresentationEntities(
            input.world,
            visibility,
            listener.visibleEntityIds,
            this.dirtyIdsBuf,
            this.dirtyFieldsBuf,
          );
      const removedEntityIds = currentVisible !== undefined
        ? this.serializeDirtyPresentationRemovals(
            visibility,
            listener.visibleEntityIds,
            currentVisible,
            this.removedEntitiesBuf,
          )
        : this.serializeUnfilteredDirtyPresentationRemovals(
            visibility,
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
              emitBeamUpdates: false,
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
        this.copyVisibleBaseline(listener, currentVisible);
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

  private serializeDirtyPresentationEntities(
    world: WorldState,
    visibility: SnapshotVisibility,
    previousVisibleEntityIds: ReadonlySet<EntityId>,
    currentVisibleEntityIds: ReadonlySet<EntityId>,
    dirtyIds: readonly EntityId[],
    dirtyFields: readonly number[],
  ): NetworkServerSnapshot['entities'] {
    resetEntitySnapshotPool();
    const entities: NetworkServerSnapshot['entities'] = [];
    registerEntitySnapshotWireSource(entities);
    const emittedIds = this.deltaEntityIdSet;
    emittedIds.clear();

    for (const id of currentVisibleEntityIds) {
      if (previousVisibleEntityIds.has(id)) continue;
      const entity = world.getEntity(id);
      if (
        entity === undefined ||
        (entity.type !== 'unit' && entity.type !== 'building' && entity.type !== 'tower')
      ) continue;
      const netEntity = serializeEntitySnapshot(entity, undefined, world, visibility);
      if (netEntity !== null) {
        entities.push(netEntity);
        emittedIds.add(id);
      }
    }

    for (let i = 0; i < dirtyIds.length; i++) {
      const id = dirtyIds[i];
      if (emittedIds.has(id)) continue;
      if (!previousVisibleEntityIds.has(id) || !currentVisibleEntityIds.has(id)) continue;
      const entity = world.getEntity(id);
      if (
        entity === undefined ||
        (entity.type !== 'unit' && entity.type !== 'building' && entity.type !== 'tower')
      ) continue;
      const netEntity = serializeEntitySnapshot(entity, dirtyFields[i], world, visibility);
      if (netEntity !== null) {
        entities.push(netEntity);
        emittedIds.add(id);
      }
    }

    emittedIds.clear();
    return entities;
  }

  private serializeUnfilteredDirtyPresentationEntities(
    world: WorldState,
    visibility: SnapshotVisibility,
    previousVisibleEntityIds: ReadonlySet<EntityId>,
    dirtyIds: readonly EntityId[],
    dirtyFields: readonly number[],
  ): NetworkServerSnapshot['entities'] {
    resetEntitySnapshotPool();
    const entities: NetworkServerSnapshot['entities'] = [];
    registerEntitySnapshotWireSource(entities);
    const emittedIds = this.deltaEntityIdSet;
    emittedIds.clear();

    for (let i = 0; i < dirtyIds.length; i++) {
      const id = dirtyIds[i];
      if (emittedIds.has(id)) continue;
      const entity = world.getEntity(id);
      if (
        entity === undefined ||
        (entity.type !== 'unit' && entity.type !== 'building' && entity.type !== 'tower')
      ) continue;
      const netEntity = serializeEntitySnapshot(
        entity,
        previousVisibleEntityIds.has(id) ? dirtyFields[i] : undefined,
        world,
        visibility,
      );
      if (netEntity !== null) {
        entities.push(netEntity);
        emittedIds.add(id);
      }
    }

    emittedIds.clear();
    return entities;
  }

  private serializeDirtyPresentationRemovals(
    visibility: SnapshotVisibility,
    previousVisibleEntityIds: ReadonlySet<EntityId>,
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
      if (visibility.shouldSendRemoval(record)) pushRemoved(record.id);
    }

    for (const id of previousVisibleEntityIds) {
      if (!currentVisibleEntityIds.has(id)) pushRemoved(id);
    }

    removedIdSet.clear();
    return removedIds.length > 0 ? removedIds : undefined;
  }

  private serializeUnfilteredDirtyPresentationRemovals(
    visibility: SnapshotVisibility,
    removedEntities: readonly RemovedSnapshotEntity[],
  ): NetworkServerSnapshot['removedEntityIds'] {
    const removedIds = this.deltaRemovedEntityIdsBuf;
    const removedIdSet = this.deltaRemovedEntityIdSet;
    removedIds.length = 0;
    removedIdSet.clear();

    for (let i = 0; i < removedEntities.length; i++) {
      const record = removedEntities[i];
      if (!visibility.shouldSendRemoval(record) || removedIdSet.has(record.id)) continue;
      removedIdSet.add(record.id);
      removedIds.push(record.id);
    }

    removedIdSet.clear();
    return removedIds.length > 0 ? removedIds : undefined;
  }

  private copyVisibleBaseline(
    listener: SnapshotListenerEntry,
    currentVisibleEntityIds: ReadonlySet<EntityId>,
  ): void {
    const baseline = listener.visibleEntityIds;
    baseline.clear();
    for (const id of currentVisibleEntityIds) baseline.add(id);
    listener.hasVisibleEntityBaseline = true;
  }

  emitProjectileDelta(
    input: ServerSnapshotPublisherInput,
    includeEntityMotionDeltas = true,
  ): boolean {
    if (input.listeners.length === 0) return false;
    const emitBaseStages = createSnapshotMaterializationStageDurations();
    let stageStart = performance.now();
    const hasProjectilePresentationEvents = input.simulation.hasPendingProjectilePresentationEvents();
    addMaterializationStage(emitBaseStages, 'lifecycleDrain', stageStart);
    const motionCandidateIds = this.entityMotionCandidateIdsBuf;
    let hasEntityMotionDeltas = false;
    if (includeEntityMotionDeltas) {
      stageStart = performance.now();
      hasEntityMotionDeltas =
        this.collectEntityMotionDeltaCandidates(input.world, motionCandidateIds) > 0;
      addMaterializationStage(emitBaseStages, 'entityDtos', stageStart);
    } else {
      motionCandidateIds.length = 0;
    }
    if (!hasProjectilePresentationEvents && !hasEntityMotionDeltas) return false;

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
    const hasProjectilesAfterDrain =
      projectileSpawns !== undefined &&
      projectileDespawns !== undefined &&
      projectileVelocityUpdates !== undefined &&
      (
        projectileSpawns.length > 0 ||
        projectileDespawns.length > 0 ||
        projectileVelocityUpdates.length > 0
      );
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
            () => this.serializeEntityMotionDelta(input.world, visibility, motionCandidateIds),
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
              emitBeamUpdates: false,
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
  ): NetworkServerSnapshot['entities'] | undefined {
    resetEntitySnapshotPool();
    const entities: NetworkServerSnapshot['entities'] = [];
    registerEntitySnapshotWireSource(entities);
    for (let i = 0; i < candidateIds.length; i++) {
      const entity = world.getEntity(candidateIds[i]);
      if (entity === undefined) continue;
      if (!visibility.isEntityVisible(entity)) continue;
      const netEntity = serializeEntitySnapshot(
        entity,
        ENTITY_MOTION_DELTA_FIELDS,
        world,
        visibility,
      );
      if (netEntity !== null) entities.push(netEntity);
    }
    return entities.length > 0 ? entities : undefined;
  }

  private collectEntityMotionDeltaCandidates(
    world: WorldState,
    out: EntityId[],
  ): number {
    out.length = 0;
    const units = world.getUnits();
    for (let i = 0; i < units.length; i++) {
      const entity = units[i];
      if (isEntityMotionDeltaCandidate(entity)) out.push(entity.id);
    }
    return out.length;
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
