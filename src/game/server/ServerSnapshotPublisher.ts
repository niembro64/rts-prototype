import { SNAPSHOT_CONFIG } from '../../config';
import { snapshotRateHz } from '../../serverBarConfig';
import type { KeyframeRatio, SnapshotRate, TickRate } from '../../types/server';
import { getUnitGroundNormalEmaMode } from '../sim/unitGroundNormal';
import type { WorldState } from '../sim/WorldState';
import type { RemovedSnapshotEntity } from '../sim/WorldState';
import type { Simulation } from '../sim/Simulation';
import type { PlayerId, EntityId } from '../sim/types';
import { captureSnapshotEntityStates, serializeGameState } from '../network/stateSerializer';
import type { SerializeGameStateOptions } from '../network/stateSerializer';
import {
  createSnapshotVisibilityCache,
  getOrBuildVisibility,
} from '../network/stateSerializerVisibility';
import { serializeAudioEvents } from '../network/stateSerializerAudio';
import { serializeSprayTargets } from '../network/stateSerializerSpray';
import { serializeMinimapSnapshotEntities } from '../network/stateSerializerMinimap';
import { getEntitySnapshotPoolStats } from '../network/stateSerializerEntities';
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

export type SnapshotListenerEntry = {
  callback: SnapshotCallback;
  playerId: PlayerId | undefined;
  trackingKey: string;
  deltaTrackingKey: string;
  preencodeWire: boolean;
  lastStaticTerrainTileMap: TerrainTileMap | undefined;
  lastStaticBuildabilityGrid: TerrainBuildabilityGrid | undefined;
  lastStaticResyncToken: number | undefined;
  /** Phase 10 D.3e — Rust-side snapshot baseline handle for this
   *  listener (u32 index into the WASM SnapshotBaselineRegistry).
   *  Allocated via sim.snapshotBaseline.create() on add, released
   *  via destroy() on remove. The mirror of the JS-side
   *  DeltaTrackingState.prevStates map for the same listener;
   *  populated per-tick by the serializer's baseline pass. Undefined
   *  if the listener was registered before initSimWasm resolved. */
  snapshotBaselineHandle: number | undefined;
};

export type ServerSnapshotPublisherInput = {
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
  keyframeRatioDisplay: KeyframeRatio;
  keyframeRatio: number;
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
  private isFirstSnapshot = true;
  private snapshotCounter = 0;
  private minimapSnapshotCounter = 0;
  private entityDetailSnapshotCounter = 0;
  private projectileDetailSnapshotCounter = 0;
  private staticResyncToken = 0;

  reset(): void {
    this.isFirstSnapshot = true;
    this.snapshotCounter = 0;
    this.minimapSnapshotCounter = 0;
    this.entityDetailSnapshotCounter = 0;
    this.projectileDetailSnapshotCounter = 0;
  }

  clear(): void {
    this.reset();
    this.dirtyIdsBuf.length = 0;
    this.dirtyFieldsBuf.length = 0;
    this.removedEntitiesBuf.length = 0;
    this.visibilityCache.clear();
    this.teamAudioCache.clear();
    this.teamSprayCache.clear();
    this.teamMinimapCache.clear();
  }

  forceNextKeyframe(includeStatic = false): void {
    if (includeStatic) this.staticResyncToken++;
    this.reset();
  }

  emit(input: ServerSnapshotPublisherInput): void {
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
    const isDelta = this.resolveSnapshotDelta(input.keyframeRatio);
    const emitMinimapOnDelta = isDelta
      ? this.resolveMinimapDeltaEmit(input.maxSnapshotsDisplay)
      : this.resolveMinimapKeyframeEmit();
    const emitEntityDetailsOnDelta = isDelta
      ? this.resolveEntityDetailDeltaEmit(input.maxSnapshotsDisplay)
      : this.resolveEntityDetailKeyframeEmit();
    const emitProjectileDetailsOnDelta = isDelta
      ? this.resolveProjectileDetailDeltaEmit(input.maxSnapshotsDisplay)
      : this.resolveProjectileDetailKeyframeEmit();

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

    const wind = input.simulation.getWindState();
    const entityPoolStats = getEntitySnapshotPoolStats();
    const serverMeta = this.metaBuilder.build({
      tickAvg: input.tpsAvg,
      tickLow: input.tpsLow,
      tickRateHz: input.tickRateHz,
      snapshotRate: input.maxSnapshotsDisplay,
      keyframeRatio: input.keyframeRatioDisplay,
      ipAddress: input.ipAddress,
      gridEnabled: input.debugGridPublisher.isEnabled(),
      allowedUnits: input.backgroundMode ? input.backgroundAllowedUnitBlueprintIds : undefined,
      maxUnits: input.world.maxTotalUnits,
      unitCount,
      turretShieldPanelsEnabled: input.world.turretShieldPanelsEnabled,
      turretShieldSpheresEnabled: input.world.turretShieldSpheresEnabled,
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

    const gridDebug = input.debugGridPublisher.refresh(performance.now(), input.world);
    const gridCells = gridDebug.cells;
    const gridSearchCells = gridDebug.searchCells;
    const gridCellSize = gridDebug.cellSize;

    // Recipient-independent entity capture: walk dirty (or all, on
    // keyframe) entities ONCE and stash the captured state for each
    // per-recipient serializeGameState below to read. With N player
    // listeners this avoids running captureEntityState N times per
    // entity. The serializer falls back to inline capture if the cache
    // is missed (covers any direct caller that didn't precapture).
    const hasListenerStaticBootstrap = this.hasListenerNeedingStaticMap(input);
    captureSnapshotEntityStates(
      input.world,
      isDelta && !hasListenerStaticBootstrap,
      this.dirtyIdsBuf,
    );

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
      const visibility = getOrBuildVisibility(input.world, listener.playerId, visibilityCache);
      const listenerNeedsStaticMap = this.listenerNeedsStaticMap(listener, input);
      const listenerIsDelta = isDelta && !listenerNeedsStaticMap;
      const shouldEmitMinimap = !listenerIsDelta || emitMinimapOnDelta;
      const shouldEmitEntityDetails = !listenerIsDelta || emitEntityDetailsOnDelta;
      const shouldSendStaticTerrain = !listenerIsDelta && listenerNeedsStaticMap;
      // FOW-OPT-20: team-uniform payload caches are deferred until
      // after the direct-wire attempt so successful remote preencodes
      // can write typed rows without materializing DTO arrays.
      const teamKey = visibility.teamMaskKey;
      let audioOverride: SerializerAudioOverride | undefined;
      let sprayOverride: SerializerSprayOverride | undefined;
      let minimapOverride: SerializerMinimapOverride | undefined = shouldEmitMinimap
        ? undefined
        : NO_MINIMAP_OVERRIDE;
      if (listener.preencodeWire) {
        const directSnapshot = this.directWirePreencoder.tryEncode({
          world: input.world,
          trackingKey: listener.deltaTrackingKey,
          snapshotBaselineHandle: listener.snapshotBaselineHandle,
          dirtyEntityIds: this.dirtyIdsBuf,
          dirtyEntityFields: this.dirtyFieldsBuf,
          removedEntities: this.removedEntitiesBuf,
          recipientPlayerId: listener.playerId,
          visibility,
          isDelta: listenerIsDelta,
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
          emitEntityDetailFields: shouldEmitEntityDetails,
          emitProjectileDetailFields: !listenerIsDelta || emitProjectileDetailsOnDelta,
          audioOverride,
          sprayOverride,
          minimapOverride,
          terrain: shouldSendStaticTerrain ? input.terrainTileMap : undefined,
          buildability: shouldSendStaticTerrain ? input.terrainBuildabilityGrid : undefined,
          serverMeta,
        });
        if (directSnapshot !== undefined) {
          if (shouldSendStaticTerrain) {
            this.markListenerStaticMapSent(listener, input);
          }
          return directSnapshot;
        }
      }
      if (teamKey !== undefined) {
        audioOverride = teamAudioCache.get(teamKey);
        if (!audioOverride) {
          audioOverride = {
            value: serializeAudioEvents(audioEvents, visibility, listener.deltaTrackingKey),
          };
          teamAudioCache.set(teamKey, audioOverride);
        }
        sprayOverride = teamSprayCache.get(teamKey);
        if (!sprayOverride) {
          sprayOverride = {
            value: serializeSprayTargets(sprayTargets, visibility, listener.deltaTrackingKey),
          };
          teamSprayCache.set(teamKey, sprayOverride);
        }
        if (shouldEmitMinimap) {
          minimapOverride = teamMinimapCache.get(teamKey);
          if (!minimapOverride) {
            minimapOverride = {
              value: serializeMinimapSnapshotEntities(
                input.world,
                visibility,
                listener.deltaTrackingKey,
              ),
            };
            teamMinimapCache.set(teamKey, minimapOverride);
          }
        }
      }
      const serializeOptions: SerializeGameStateOptions = {
        trackingKey: listener.deltaTrackingKey,
        snapshotBaselineHandle: listener.snapshotBaselineHandle,
        dirtyEntityIds: this.dirtyIdsBuf,
        dirtyEntityFields: this.dirtyFieldsBuf,
        removedEntityIds: undefined,
        removedEntities: this.removedEntitiesBuf,
        recipientPlayerId: listener.playerId,
        visibility,
        emitEntityDetailFields: shouldEmitEntityDetails,
        emitProjectileDetailFields: !listenerIsDelta || emitProjectileDetailsOnDelta,
        audioOverride,
        sprayOverride,
        minimapOverride,
      };
      const state = serializeGameState(
        input.world,
        listenerIsDelta,
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

      state.terrain = shouldSendStaticTerrain ? input.terrainTileMap : undefined;
      state.buildability = shouldSendStaticTerrain
        ? input.terrainBuildabilityGrid
        : undefined;
      if (shouldSendStaticTerrain) {
        this.markListenerStaticMapSent(listener, input);
      }
      state.serverMeta = serverMeta;
      return this.wirePreencoder.encodeIfRequested(state, listener.preencodeWire);
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
        }
        listener.callback(
          sharedGlobalStaticSnapshot.state,
          undefined,
          this.wirePreencoder.resolve(sharedGlobalStaticSnapshot, listener.preencodeWire),
        );
      } else {
        if (!sharedGlobalDynamicSnapshot) {
          sharedGlobalDynamicSnapshot = serializeForListener(listener);
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

  private resolveSnapshotDelta(keyframeRatio: number): boolean {
    if (this.isFirstSnapshot) {
      this.isFirstSnapshot = false;
      this.snapshotCounter = 0;
      return false;
    }
    if (!SNAPSHOT_CONFIG.deltaEnabled) return false;
    if (keyframeRatio >= 1) return false;
    if (keyframeRatio <= 0) return true;

    this.snapshotCounter++;
    const keyframeInterval = Math.round(1 / keyframeRatio);
    if (this.snapshotCounter >= keyframeInterval) {
      this.snapshotCounter = 0;
      return false;
    }
    return true;
  }

  private resolveMinimapDeltaEmit(snapshotRate: SnapshotRate): boolean {
    const targetHz = SNAPSHOT_CONFIG.minimapSnapshotRateHz;
    if (!Number.isFinite(targetHz) || targetHz <= 0) return false;
    const sourceHz = snapshotRateHz(snapshotRate);
    const interval = Math.max(1, Math.ceil(sourceHz / targetHz));
    this.minimapSnapshotCounter++;
    if (this.minimapSnapshotCounter < interval) return false;
    this.minimapSnapshotCounter = 0;
    return true;
  }

  private resolveMinimapKeyframeEmit(): boolean {
    this.minimapSnapshotCounter = 0;
    return true;
  }

  private resolveEntityDetailDeltaEmit(snapshotRate: SnapshotRate): boolean {
    const targetHz = SNAPSHOT_CONFIG.entityDetailSnapshotRateHz;
    if (!Number.isFinite(targetHz) || targetHz <= 0) return false;
    const sourceHz = snapshotRateHz(snapshotRate);
    const interval = Math.max(1, Math.ceil(sourceHz / targetHz));
    this.entityDetailSnapshotCounter++;
    if (this.entityDetailSnapshotCounter < interval) return false;
    this.entityDetailSnapshotCounter = 0;
    return true;
  }

  private resolveEntityDetailKeyframeEmit(): boolean {
    this.entityDetailSnapshotCounter = 0;
    return true;
  }

  private resolveProjectileDetailDeltaEmit(snapshotRate: SnapshotRate): boolean {
    const targetHz = SNAPSHOT_CONFIG.projectileDetailSnapshotRateHz;
    if (!Number.isFinite(targetHz) || targetHz <= 0) return false;
    const sourceHz = snapshotRateHz(snapshotRate);
    const interval = Math.max(1, Math.ceil(sourceHz / targetHz));
    this.projectileDetailSnapshotCounter++;
    if (this.projectileDetailSnapshotCounter < interval) return false;
    this.projectileDetailSnapshotCounter = 0;
    return true;
  }

  private resolveProjectileDetailKeyframeEmit(): boolean {
    this.projectileDetailSnapshotCounter = 0;
    return true;
  }

  private hasListenerNeedingStaticMap(input: ServerSnapshotPublisherInput): boolean {
    for (const listener of input.listeners) {
      if (this.listenerNeedsStaticMap(listener, input)) return true;
    }
    return false;
  }

  private listenerNeedsStaticMap(
    listener: SnapshotListenerEntry,
    input: ServerSnapshotPublisherInput,
  ): boolean {
    return listener.lastStaticTerrainTileMap !== input.terrainTileMap ||
      listener.lastStaticBuildabilityGrid !== input.terrainBuildabilityGrid ||
      listener.lastStaticResyncToken !== this.staticResyncToken;
  }

  private markListenerStaticMapSent(
    listener: SnapshotListenerEntry,
    input: ServerSnapshotPublisherInput,
  ): void {
    listener.lastStaticTerrainTileMap = input.terrainTileMap;
    listener.lastStaticBuildabilityGrid = input.terrainBuildabilityGrid;
    listener.lastStaticResyncToken = this.staticResyncToken;
  }
}
