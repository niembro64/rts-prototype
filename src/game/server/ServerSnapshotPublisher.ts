import { SNAPSHOT_CONFIG } from '../../config';
import { getSimSignalStates } from '../sim/simQuality';
import { getTiltEmaMode } from '../sim/unitTilt';
import type { WorldState } from '../sim/WorldState';
import type { RemovedSnapshotEntity } from '../sim/WorldState';
import type { Simulation } from '../sim/Simulation';
import type { PlayerId, EntityId } from '../sim/types';
import type { NetworkServerSnapshot } from '../network/NetworkTypes';
import { captureSnapshotEntityStates, serializeGameState } from '../network/stateSerializer';
import type {
  SerializeGameStateOptions,
  SnapshotAoiBounds,
} from '../network/stateSerializer';
import {
  createSnapshotVisibilityCache,
  getOrBuildVisibility,
} from '../network/stateSerializerVisibility';
import type { TerrainBuildabilityGrid, TerrainTileMap } from '@/types/terrain';
import type { SnapshotCallback } from './GameConnection';
import type { CaptureSystem } from '../sim/CaptureSystem';
import type { ServerDebugGridPublisher } from './ServerDebugGridPublisher';
import { ServerSnapshotMetaBuilder } from './ServerSnapshotMetaBuilder';

export type SnapshotListenerEntry = {
  callback: SnapshotCallback;
  playerId?: PlayerId;
  trackingKey: string;
  deltaTrackingKey: string;
  aoi?: SnapshotAoiBounds;
  forceKeyframe?: boolean;
  staticTerrainSent?: boolean;
};

export type ServerSnapshotPublisherInput = {
  world: WorldState;
  simulation: Simulation;
  captureSystem: CaptureSystem;
  debugGridPublisher: ServerDebugGridPublisher;
  listeners: readonly SnapshotListenerEntry[];
  terrainTileMap: TerrainTileMap;
  terrainBuildabilityGrid: TerrainBuildabilityGrid;
  tpsAvg: number;
  tpsLow: number;
  tickRateHz: number;
  userTickRateHz: number;
  maxSnapshotsDisplay: number | 'none';
  keyframeRatioDisplay: number | 'ALL' | 'NONE';
  keyframeRatio: number;
  ipAddress: string;
  backgroundMode: boolean;
  backgroundAllowedTypes: ReadonlySet<string>;
  tickMsAvg: number;
  tickMsHi: number;
  tickMsInitialized: boolean;
  simQuality: string;
  effectiveSimQuality: string;
};

export class ServerSnapshotPublisher {
  private readonly metaBuilder = new ServerSnapshotMetaBuilder();
  private readonly dirtyIdsBuf: EntityId[] = [];
  private readonly dirtyFieldsBuf: number[] = [];
  private readonly removedIdsBuf: EntityId[] = [];
  private readonly removedEntitiesBuf: RemovedSnapshotEntity[] = [];
  private isFirstSnapshot = true;
  private snapshotCounter = 0;

  reset(): void {
    this.isFirstSnapshot = true;
    this.snapshotCounter = 0;
  }

  forceNextKeyframe(): void {
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

    const isDelta = this.resolveSnapshotDelta(input.keyframeRatio);

    this.dirtyIdsBuf.length = 0;
    this.dirtyFieldsBuf.length = 0;
    this.removedIdsBuf.length = 0;
    this.removedEntitiesBuf.length = 0;
    input.world.drainSnapshotDirtyEntities(this.dirtyIdsBuf, this.dirtyFieldsBuf);
    input.world.drainRemovedSnapshotEntities(this.removedEntitiesBuf);
    for (let i = 0; i < this.removedEntitiesBuf.length; i++) {
      this.removedIdsBuf.push(this.removedEntitiesBuf[i].id);
    }

    const captureTiles = input.captureSystem.consumeSnapshot(isDelta);
    const wind = input.simulation.getWindState();
    const serverMeta = this.metaBuilder.build({
      tickAvg: input.tpsAvg,
      tickLow: input.tpsLow,
      tickRateHz: input.tickRateHz,
      tickTargetHz: input.userTickRateHz,
      snapshotRate: input.maxSnapshotsDisplay,
      keyframeRatio: input.keyframeRatioDisplay,
      ipAddress: input.ipAddress,
      gridEnabled: input.debugGridPublisher.isEnabled(),
      allowedUnits: input.backgroundMode ? input.backgroundAllowedTypes : undefined,
      maxUnits: input.world.maxTotalUnits,
      unitCount: input.world.getUnits().length,
      mirrorsEnabled: input.world.mirrorsEnabled,
      forceFieldsEnabled: input.world.forceFieldsEnabled,
      forceFieldReflectionMode: input.world.forceFieldReflectionMode,
      fogOfWarEnabled: input.world.fogOfWarEnabled,
      tickMsAvg: input.tickMsAvg,
      tickMsHi: input.tickMsHi,
      tickMsInitialized: input.tickMsInitialized,
      simQuality: input.simQuality,
      effectiveSimQuality: input.effectiveSimQuality,
      simSignals: getSimSignalStates(),
      wind,
      tiltEmaMode: getTiltEmaMode(),
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
    captureSnapshotEntityStates(input.world, isDelta, this.dirtyIdsBuf);

    // Share one SnapshotVisibility per team across the listener loop
    // (issues.txt FOW-OPT-01). Two teammates merge the same set of
    // ally vision sources into the same spatial hash; without this
    // we'd rebuild the same structure once per listener.
    const visibilityCache = createSnapshotVisibilityCache();

    const serializeForListener = (listener: SnapshotListenerEntry): NetworkServerSnapshot => {
      const forceKeyframe = listener.forceKeyframe === true;
      const listenerIsDelta = isDelta && !forceKeyframe;
      const aoiRefreshKeyframe = isDelta && forceKeyframe;
      listener.forceKeyframe = false;
      const visibility = getOrBuildVisibility(input.world, listener.playerId, visibilityCache);
      const serializeOptions: SerializeGameStateOptions = {
        trackingKey: listener.deltaTrackingKey,
        dirtyEntityIds: this.dirtyIdsBuf,
        dirtyEntityFields: this.dirtyFieldsBuf,
        removedEntityIds: this.removedIdsBuf,
        removedEntities: this.removedEntitiesBuf,
        recipientPlayerId: listener.playerId,
        aoi: listener.aoi,
        visibility,
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

      state.capture = captureTiles.length > 0
        ? { tiles: captureTiles, cellSize: input.captureSystem.getCellSize() }
        : undefined;
      // AOI movement can force a recipient-only full entity snapshot.
      // Terrain/buildability are static after battle start. Keep the
      // initial seed, then avoid resending those large blobs on AOI
      // refreshes or regular AOI-scoped full keyframes.
      const shouldSendStaticTerrain =
        !listenerIsDelta &&
        !aoiRefreshKeyframe &&
        (listener.aoi === undefined || listener.staticTerrainSent !== true);
      state.terrain = shouldSendStaticTerrain ? input.terrainTileMap : undefined;
      state.buildability = shouldSendStaticTerrain
        ? input.terrainBuildabilityGrid
        : undefined;
      if (shouldSendStaticTerrain) listener.staticTerrainSent = true;
      state.serverMeta = serverMeta;
      return state;
    };

    let sharedGlobalState: NetworkServerSnapshot | undefined;
    for (const listener of input.listeners) {
      if (listener.playerId !== undefined) continue;
      if (!sharedGlobalState) sharedGlobalState = serializeForListener(listener);
      listener.callback(sharedGlobalState);
    }

    for (const listener of input.listeners) {
      if (listener.playerId === undefined) continue;
      listener.callback(serializeForListener(listener));
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
}
