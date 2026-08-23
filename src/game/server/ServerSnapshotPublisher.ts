import type { SnapshotRate, TickRate } from '../../types/server';
import { getUnitGroundNormalEmaMode } from '../sim/unitGroundNormal';
import type { WorldState } from '../sim/WorldState';
import type { RemovedSnapshotEntity } from '../sim/WorldState';
import type { Simulation } from '../sim/Simulation';
import type { Entity, PlayerId, EntityId } from '../sim/types';
import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotEntity,
  NetworkServerSnapshotMeta,
} from '../network/NetworkTypes';
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
import { IndexedEntityIdSet } from '../network/IndexedEntityIdCollections';
import { appendUnique } from '../collections';
import {
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
import { ServerSnapshotMetaBuilder } from './ServerSnapshotMetaBuilder';
import {
  ServerSnapshotWirePreencoder,
  type SerializedListenerSnapshot,
} from './ServerSnapshotWirePayload';
import { ServerSnapshotDirectWirePreencoder } from './ServerSnapshotDirectWirePreencoder';
import { entitySlotRegistry } from '../sim/EntitySlotRegistry';
import {
  tryAppendBuildingSlabDeltaRowFromState,
  tryAppendUnitSlabDeltaRowFromState,
} from './snapshotSlabDeltaRows';
import { resolveEntityFromSlotOrWorld } from '../sim/entitySlotResolution';

const NO_MINIMAP_OVERRIDE: SerializerMinimapOverride = { value: undefined };
const PROJECTILE_DELTA_EMPTY_ENTITIES: NetworkServerSnapshot['entities'] = [];
const PROJECTILE_DELTA_EMPTY_ECONOMY: NetworkServerSnapshot['economy'] = {};
function addMaterializationStage(
  stages: SnapshotMaterializationStageDurations,
  stage: SnapshotMaterializationStage,
  start: number,
): void {
  addSnapshotMaterializationStageFromStart(stages, stage, start);
}

/** Fetch a per-ally-team serialization, producing and timing it on first use.
 *
 *  Every listener on the same team shares one serialization of the audio,
 *  spray, and minimap payloads — that sharing is the entire point of the team
 *  caches, and it is why the stage timing is only charged on the miss. */
function memoTeamOverride<T>(
  cache: Map<string, T>,
  teamKey: string,
  stages: SnapshotMaterializationStageDurations,
  stage: SnapshotMaterializationStage,
  produce: () => T,
): T {
  const cached = cache.get(teamKey);
  if (cached !== undefined) return cached;
  const stageStart = performance.now();
  const created = produce();
  cache.set(teamKey, created);
  addMaterializationStage(stages, stage, stageStart);
  return created;
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
    (projectiles.motionUpdates?.length ?? 0) +
    (projectiles.beamUpdates?.length ?? 0)
  );
}

export type SnapshotListenerEntry = {
  callback: SnapshotCallback;
  playerId: PlayerId | undefined;
  trackingKey: string;
  cacheKey: string;
  preencodeWire: boolean;
  directMaterialization: boolean;
  /** See SnapshotListenerOptions.needsWireRows. */
  needsWireRows: boolean;
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

type DrainedSimulationFrame = {
  gamePhase: ReturnType<Simulation['getGamePhase']>;
  winnerId: PlayerId | undefined;
  sprayTargets: ReturnType<Simulation['getSprayTargets']>;
  audioEvents: ReturnType<Simulation['getAndClearEvents']>;
  projectileSpawns: ReturnType<Simulation['getAndClearProjectileSpawns']>;
  projectileDespawns: ReturnType<Simulation['getAndClearProjectileDespawns']>;
};

/** Take this tick's phase, winner, and queued events off the simulation.
 *
 *  The getAndClear* calls DRAIN their queues, so both publish paths have to
 *  make exactly this set of calls exactly once per tick: skip one and its
 *  events leak into the next snapshot, make one twice and they are lost. The
 *  sequence lives here so the full-emit and dirty-delta paths cannot diverge. */
/** Both threshold maps are written together by the
 *  setAutoConversionThresholds command, so the energy map's key set is
 *  the full set of players with non-default slider points. */
function buildAutoConversionThresholdsMeta(
  world: WorldState,
): NetworkServerSnapshotMeta['autoConversionThresholds'] {
  if (world.autoConversionEnergyAt.size === 0) return undefined;
  const playerIds: number[] = [];
  const energyAt: number[] = [];
  const metalAt: number[] = [];
  for (const playerId of world.autoConversionEnergyAt.keys()) {
    playerIds.push(playerId);
    energyAt.push(world.getAutoConversionEnergyAt(playerId));
    metalAt.push(world.getAutoConversionMetalAt(playerId));
  }
  return { playerIds, energyAt, metalAt };
}

function drainSimulationFrame(simulation: Simulation): DrainedSimulationFrame {
  const gamePhase = simulation.getGamePhase();
  return {
    gamePhase,
    winnerId: gamePhase === 'gameOver' ? simulation.getWinnerId() ?? undefined : undefined,
    sprayTargets: simulation.getSprayTargets(),
    audioEvents: simulation.getAndClearEvents(),
    projectileSpawns: simulation.getAndClearProjectileSpawns(),
    projectileDespawns: simulation.getAndClearProjectileDespawns(),
  };
}

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
          (entity.type === 'unit' || entity.type === 'building') &&
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
        (entity.type === 'unit' || entity.type === 'building')
      ) {
        baseline.add(entity.id);
      }
    }
    listener.hasVisibleEntityBaseline = true;
  }

  private buildServerMeta(
    input: ServerSnapshotPublisherInput,
    unitCount: number,
  ): NetworkServerSnapshotMeta {
    const wind = input.simulation.getWindState();
    const entityPoolStats = getEntitySnapshotPoolStats();
    return this.metaBuilder.build({
      tickAvg: input.tpsAvg,
      tickLow: input.tpsLow,
      tickRateHz: input.tickRateHz,
      snapshotRate: input.maxSnapshotsDisplay,
      ipAddress: input.ipAddress,
      allowedUnits: input.backgroundMode ? input.backgroundAllowedUnitBlueprintIds : undefined,
      maxUnits: input.world.entityCountCap,
      unitCount,
      turretShieldPanelsEnabled: input.world.turretShieldPanelsEnabled,
      turretShieldSpheresEnabled: input.world.turretShieldSpheresEnabled,
      forceFieldsVisible: input.world.forceFieldsVisible,
      shieldAwareTargetingPlayerMask: input.world.getShieldAwareTargetingPlayerMask(),
      shieldPowerPlayerMask: input.world.getShieldPowerPlayerMask(),
      shieldReflectionMode: input.world.shieldReflectionMode,
      fogOfWarEnabled: input.world.fogOfWarEnabled,
      converterTax: input.world.converterTax,
      autoConversionThresholds: buildAutoConversionThresholdsMeta(input.world),
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
  }

  emit(input: ServerSnapshotPublisherInput): void {
    const emitBaseStages = createSnapshotMaterializationStageDurations();
    const lifecycleStart = performance.now();
    const {
      gamePhase,
      winnerId,
      sprayTargets,
      audioEvents,
      projectileSpawns,
      projectileDespawns,
    } = drainSimulationFrame(input.simulation);
    // P0-01: motion updates are gone; adjacent Rust fixed-tick poses own
    // travelling-shot motion. Serializer/apply plumbing stays as the
    // recovery-format path but is never fed from live ticks.
    const projectileMotionUpdates = undefined;

    // Pairs with meta.units.max, which is the ENTITY count cap — so this
    // counts buildings too, or the readout reads under its own ceiling.
    const unitCount = input.world.getUnits().length + input.world.getBuildings().length;

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
    const serverMeta = this.buildServerMeta(input, unitCount);
    addMaterializationStage(emitBaseStages, 'meta', stageStart);

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
      if (listener.preencodeWire || listener.directMaterialization) {
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
          projectileMotionUpdates,
          emitProjectileDetailFields: true,
          audioOverride,
          sprayOverride,
          minimapOverride,
          terrain: shouldSendStaticTerrain ? input.terrainTileMap : undefined,
          buildability: shouldSendStaticTerrain ? input.terrainBuildabilityGrid : undefined,
          serverMeta,
          materializationStages: stages,
          delivery: {
            preencodeWire: listener.preencodeWire,
            materializeSupplementalDtos: listener.directMaterialization,
            needsWireRows: listener.needsWireRows,
            trackingKey: listener.cacheKey,
          },
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
        audioOverride = memoTeamOverride(teamAudioCache, teamKey, stages, 'audio', () => ({
          value: serializeAudioEvents(audioEvents, visibility, listener.cacheKey),
        }));
        sprayOverride = memoTeamOverride(teamSprayCache, teamKey, stages, 'spray', () => ({
          value: serializeSprayTargets(sprayTargets, visibility, listener.cacheKey),
        }));
        if (shouldEmitMinimap) {
          minimapOverride = memoTeamOverride(
            teamMinimapCache, teamKey, stages, 'minimap', () => ({
              value: serializeMinimapSnapshotEntities(
                input.world,
                visibility,
                listener.cacheKey,
              ),
            }),
          );
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
        projectileMotionUpdates,
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

    const sharedGlobalDynamicSnapshots: Array<SerializedListenerSnapshot | undefined> = [];
    const sharedGlobalStaticSnapshots: Array<SerializedListenerSnapshot | undefined> = [];
    for (const listener of input.listeners) {
      if (listener.playerId !== undefined) continue;
      // A directly consumed local snapshot carries materialized supplemental
      // DTOs, while a wire-only snapshot can retain typed placeholders. Keep
      // one shared global snapshot per representation so listener order never
      // hands a placeholder-only state to an in-process consumer.
      const representationIndex = listener.directMaterialization ? 1 : 0;
      if (this.listenerNeedsStaticMap(listener, input)) {
        let sharedGlobalStaticSnapshot = sharedGlobalStaticSnapshots[representationIndex];
        if (!sharedGlobalStaticSnapshot) {
          sharedGlobalStaticSnapshot = serializeForListener(listener);
          sharedGlobalStaticSnapshots[representationIndex] = sharedGlobalStaticSnapshot;
        } else {
          this.markListenerStaticMapSent(listener, input);
          // The reuse branch skips serializeForListener, which is where the
          // flag is normally cleared — without this, a second player-less
          // listener stays needs-full forever and forces a full emit every
          // frame.
          listener.needsFullState = false;
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
        let sharedGlobalDynamicSnapshot = sharedGlobalDynamicSnapshots[representationIndex];
        if (!sharedGlobalDynamicSnapshot) {
          sharedGlobalDynamicSnapshot = serializeForListener(listener);
          sharedGlobalDynamicSnapshots[representationIndex] = sharedGlobalDynamicSnapshot;
        } else {
          // Same clear as the static branch: reuse must not leave the
          // listener permanently needs-full.
          listener.needsFullState = false;
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
    const {
      gamePhase,
      winnerId,
      sprayTargets,
      audioEvents,
      projectileSpawns,
      projectileDespawns,
    } = drainSimulationFrame(input.simulation);
    // P0-01: motion updates are gone; adjacent Rust fixed-tick poses own
    // travelling-shot motion. Serializer/apply plumbing stays as the
    // recovery-format path but is never fed from live ticks.
    const projectileMotionUpdates = undefined;
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
    const hasProjectileEvents =
      projectileSpawns.length > 0 ||
      projectileDespawns.length > 0 ||
      hasLiveLineProjectiles;
    addMaterializationStage(emitBaseStages, 'lifecycleDrain', lifecycleStart);

    let stageStart = performance.now();
    // Pairs with meta.units.max, which is the ENTITY count cap — so this
    // counts buildings too, or the readout reads under its own ceiling.
    const unitCount = input.world.getUnits().length + input.world.getBuildings().length;
    const serverMeta = this.buildServerMeta(input, unitCount);
    addMaterializationStage(emitBaseStages, 'meta', stageStart);

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
      if (listener.preencodeWire || listener.directMaterialization) {
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
          projectileMotionUpdates,
          audioOverride: undefined,
          sprayOverride: undefined,
          minimapOverride: undefined,
          serverMeta,
          materializationStages: stages,
          delivery: {
            preencodeWire: listener.preencodeWire,
            materializeSupplementalDtos: listener.directMaterialization,
            needsWireRows: listener.needsWireRows,
            trackingKey: listener.cacheKey,
          },
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
        audioOverride = memoTeamOverride(teamAudioCache, teamKey, stages, 'audio', () => ({
          value: serializeAudioEvents(audioEvents, visibility, listener.cacheKey),
        }));
        sprayOverride = memoTeamOverride(teamSprayCache, teamKey, stages, 'spray', () => ({
          value: serializeSprayTargets(sprayTargets, visibility, listener.cacheKey),
        }));
        minimapOverride = memoTeamOverride(
          teamMinimapCache, teamKey, stages, 'minimap', () => ({
            value: serializeMinimapSnapshotEntities(
              input.world,
              visibility,
              listener.cacheKey,
            ),
          }),
        );
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
              projectileMotionUpdates,
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
        projectiles,
        gameState,
        serverMeta,
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
      const entity = resolveEntityFromSlotOrWorld(
        world,
        id,
        currentVisibleEntitySlots !== undefined ? currentVisibleEntitySlots[i] : -1,
      );
      if (
        entity === undefined ||
        (entity.type !== 'unit' && entity.type !== 'building')
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
      if (this.tryPushSlabDeltaEntityRowFromState(entities, id, dirtyFields[i], dirtySlots[i])) {
        emittedIds.add(id);
        continue;
      }
      const entity = resolveEntityFromSlotOrWorld(world, id, dirtySlots[i]);
      if (
        entity === undefined ||
        (entity.type !== 'unit' && entity.type !== 'building')
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
        this.tryPushSlabDeltaEntityRowFromState(entities, id, changedFields, dirtySlots[i])
      ) {
        emittedIds.add(id);
        continue;
      }
      const entity = resolveEntityFromSlotOrWorld(world, id, dirtySlots[i]);
      if (
        entity === undefined ||
        (entity.type !== 'unit' && entity.type !== 'building')
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

    for (let i = 0; i < removedEntities.length; i++) {
      const record = removedEntities[i];
      const wasPreviouslyVisible = previousVisibleEntityIds.has(record.id);
      if (wasPreviouslyVisible || visibility.shouldSendRemoval(record)) {
        appendUnique(removedIds, removedIdSet, record.id);
      }
      previousVisibleEntityIds.delete(record.id);
    }

    for (const id of previousVisibleEntityIds) {
      if (!currentVisibleEntityIds.has(id)) {
        appendUnique(removedIds, removedIdSet, id);
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

  emitProjectileDelta(input: ServerSnapshotPublisherInput): boolean {
    if (input.listeners.length === 0) return false;
    const emitBaseStages = createSnapshotMaterializationStageDurations();
    let stageStart = performance.now();
    const hasProjectilePresentationEvents = input.simulation.hasPendingProjectilePresentationEvents();
    const hasLiveLineProjectiles = input.world.getLineProjectiles().length > 0;
    addMaterializationStage(emitBaseStages, 'lifecycleDrain', stageStart);
    if (!hasProjectilePresentationEvents && !hasLiveLineProjectiles) return false;

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

    const hasProjectileEventsAfterDrain =
      (projectileSpawns?.length ?? 0) > 0 ||
      (projectileDespawns?.length ?? 0) > 0;
    const hasProjectilesAfterDrain = hasLiveLineProjectiles || hasProjectileEventsAfterDrain;
    const hasAudioAfterDrain = (audioEvents?.length ?? 0) > 0;
    if (!hasProjectilesAfterDrain && !hasAudioAfterDrain) {
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
      if (listener.preencodeWire || listener.directMaterialization) {
        const directSnapshot = this.directWirePreencoder.tryEncodeSparseDelta({
          world: input.world,
          visibility,
          audioEvents,
          projectileSpawns,
          projectileDespawns,
          projectileMotionUpdates: undefined,
          materializationStages: stages,
          delivery: {
            preencodeWire: listener.preencodeWire,
            materializeSupplementalDtos: listener.directMaterialization,
            needsWireRows: listener.needsWireRows,
            trackingKey: listener.cacheKey,
          },
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
              projectileMotionUpdates: undefined,
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
        projectiles === undefined &&
        netAudioEvents === undefined
      ) continue;
      const state: NetworkServerSnapshot = {
        tick: input.world.getTick(),
        entities: PROJECTILE_DELTA_EMPTY_ENTITIES,
        entityDeltaOnly: undefined,
        projectileDeltaOnly: true,
        minimapEntities: undefined,
        economy: PROJECTILE_DELTA_EMPTY_ECONOMY,
        resourceMovements: undefined,
        sprayTargets: undefined,
        audioEvents: netAudioEvents,
        scanPulses: undefined,
        projectiles,
        gameState: undefined,
        serverMeta: undefined,
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

  private tryPushSlabDeltaEntityRowFromState(
    entities: NetworkServerSnapshot['entities'],
    id: EntityId,
    changedFields: number,
    slot = -1,
  ): boolean {
    const entityViews = entitySlotRegistry.getViews();
    if (
      tryAppendUnitSlabDeltaRowFromState(id, changedFields, entityViews, slot) ||
      tryAppendBuildingSlabDeltaRowFromState(id, changedFields, entityViews, slot)
    ) {
      entities.push(undefined as unknown as NetworkServerSnapshotEntity);
      return true;
    }
    return false;
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
