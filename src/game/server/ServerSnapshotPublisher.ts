import { SNAPSHOT_CONFIG } from '../../config';
import { getSimSignalStates } from '../sim/simQuality';
import { getTiltEmaMode } from '../sim/unitTilt';
import type { WorldState } from '../sim/WorldState';
import type { RemovedSnapshotEntity } from '../sim/WorldState';
import type { Simulation } from '../sim/Simulation';
import type { PlayerId, EntityId } from '../sim/types';
import type { PredictionMode } from '@/types/client';
import type { NetworkServerSnapshot } from '../network/NetworkTypes';
import { captureSnapshotEntityStates, serializeGameState } from '../network/stateSerializer';
import type {
  SerializeGameStateOptions,
  SnapshotAoiBounds,
} from '../network/stateSerializer';
import {
  createSnapshotVisibilityCache,
  getOrBuildVisibility,
  serializeShroudPayload,
} from '../network/stateSerializerVisibility';
import { serializeAudioEvents } from '../network/stateSerializerAudio';
import { serializeSprayTargets } from '../network/stateSerializerSpray';
import { serializeMinimapSnapshotEntities } from '../network/stateSerializerMinimap';
import type {
  SerializerAudioOverride,
  SerializerMinimapOverride,
  SerializerSprayOverride,
} from '../network/stateSerializer';
import { computeTeamShroudVersionSum } from '../sim/shroudBitmap';
import type { NetworkServerSnapshotShroud } from '../../types/network';
import type { TerrainBuildabilityGrid, TerrainTileMap } from '@/types/terrain';
import type { SnapshotCallback } from './GameConnection';
import type { CaptureSystem } from '../sim/CaptureSystem';
import type { ServerDebugGridPublisher } from './ServerDebugGridPublisher';
import { ServerSnapshotMetaBuilder } from './ServerSnapshotMetaBuilder';

/** Per-emit cache slot for a team's shroud payload (issues.txt
 *  FOW-OPT-11). Two teammates on the same team always merge the
 *  same per-player bitmaps into the same packed wire payload, so
 *  building it once per team per emit replaces N builds with 1.
 *  versionSum is the cheap team-wide invalidation signal — cached
 *  on entry to avoid recomputing it for each teammate. payload is
 *  built lazily so the first teammate to *need* it triggers the OR
 *  + pack work; later teammates share the same Uint8Array. */
type ShroudPayloadCacheEntry = {
  versionSum: number;
  payload: NetworkServerSnapshotShroud | undefined;
  built: boolean;
};

export type SnapshotListenerEntry = {
  callback: SnapshotCallback;
  playerId?: PlayerId;
  trackingKey: string;
  deltaTrackingKey: string;
  aoi?: SnapshotAoiBounds;
  forceKeyframe?: boolean;
  staticTerrainSent?: boolean;
  /** Team shroud-version sum at the last keyframe where we shipped
   *  the shroud bitmap to this listener (issues.txt FOW-OPT-02).
   *  Compared against the live sum each keyframe to skip the
   *  multi-KB payload when no new cells were explored. */
  lastSentShroudVersionSum?: number;
  /** PLAYER CLIENT bar PREDICT mode this listener wants. Undefined =
   *  treat as 'acc' (full F=ma — every snapshot field always sent).
   *  When the client sets POS, the server zeroes velocity fields and
   *  drops movementAccel; when VEL, movementAccel is dropped. The
   *  client's local PREDICT integrator gate is the authoritative one
   *  for correctness — this is purely a bandwidth optimization. */
  predictionMode?: PredictionMode;
  /** Phase 10 D.3e — Rust-side snapshot baseline handle for this
   *  listener (u32 index into the WASM SnapshotBaselineRegistry).
   *  Allocated via sim.snapshotBaseline.create() on add, released
   *  via destroy() on remove. The mirror of the JS-side
   *  DeltaTrackingState.prevStates map for the same listener;
   *  populated per-tick by the (upcoming) capture pass. Undefined
   *  if the listener was registered before initSimWasm resolved. */
  snapshotBaselineHandle?: number;
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
    this.removedEntitiesBuf.length = 0;
    input.world.drainSnapshotDirtyEntities(this.dirtyIdsBuf, this.dirtyFieldsBuf);
    input.world.drainRemovedSnapshotEntities(this.removedEntitiesBuf);
    // FOW-OPT-21: removedEntities supersedes removedEntityIds in the
    // serializer — when both are present, the entity-records form
    // already covers every id with position metadata for the FOW-02b
    // ghost cleanup, so the parallel id array would be dead-loaded.
    // We only pass removedEntities below.

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
      forceFieldsBlockTargeting: input.world.forceFieldsBlockTargeting,
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

    // Per-team shroud cache (issues.txt FOW-OPT-11). One slot per
    // team-mask key; the build cost (OR ally bitmaps + bit-pack) runs
    // once per team per emit, then every teammate's listener reuses
    // the same packed Uint8Array.
    const shroudPayloadCache = new Map<string, ShroudPayloadCacheEntry>();

    // FOW-OPT-20: per-team output cache for the three team-uniform
    // serializers. The first teammate's serializeForListener call
    // fills the slot (which goes through that listener's per-listener
    // pool — see FOW-OPT-07 / snapshotPool.ts); subsequent teammates
    // hand back the same array reference. Admin / spectator listeners
    // (no team mask) fall through to fresh per-call serialization.
    // Minimap is keyed by team + aoi-enabled status because the output
    // collapses to `undefined` when aoi is unset; bundling both cohorts
    // into one slot would hand mismatched data to whichever teammate
    // arrived second.
    const teamAudioCache = new Map<string, SerializerAudioOverride>();
    const teamSprayCache = new Map<string, SerializerSprayOverride>();
    const teamMinimapCache = new Map<string, SerializerMinimapOverride>();

    const serializeForListener = (listener: SnapshotListenerEntry): NetworkServerSnapshot => {
      const forceKeyframe = listener.forceKeyframe === true;
      const listenerIsDelta = isDelta && !forceKeyframe;
      const aoiRefreshKeyframe = isDelta && forceKeyframe;
      listener.forceKeyframe = false;
      const visibility = getOrBuildVisibility(input.world, listener.playerId, visibilityCache);
      // FOW-OPT-20: look up (or fill) the team-shared audio / spray /
      // minimap payloads. The first teammate to hit each cache slot
      // triggers the underlying serializer using THIS listener's
      // pool; subsequent teammates pass the cached wrapper into
      // serializeGameState which short-circuits to the same value.
      const teamKey = visibility.teamMaskKey;
      let audioOverride: SerializerAudioOverride | undefined;
      let sprayOverride: SerializerSprayOverride | undefined;
      let minimapOverride: SerializerMinimapOverride | undefined;
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
        const minimapAoiEnabled = listener.aoi !== undefined;
        const minimapKey = `${teamKey}:${minimapAoiEnabled ? '1' : '0'}`;
        minimapOverride = teamMinimapCache.get(minimapKey);
        if (!minimapOverride) {
          minimapOverride = {
            value: serializeMinimapSnapshotEntities(
              input.world,
              minimapAoiEnabled,
              visibility,
              listener.deltaTrackingKey,
            ),
          };
          teamMinimapCache.set(minimapKey, minimapOverride);
        }
      }
      const serializeOptions: SerializeGameStateOptions = {
        trackingKey: listener.deltaTrackingKey,
        dirtyEntityIds: this.dirtyIdsBuf,
        dirtyEntityFields: this.dirtyFieldsBuf,
        removedEntities: this.removedEntitiesBuf,
        recipientPlayerId: listener.playerId,
        aoi: listener.aoi,
        visibility,
        audioOverride,
        sprayOverride,
        minimapOverride,
        predictionMode: listener.predictionMode,
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
      // FOW-11 shroud payload: ship only on keyframes, only when the
      // team's bitmap has new content since the last ship to this
      // listener (FOW-OPT-02). The version sum monotonically increases
      // whenever any allied player explores a new cell — when it
      // matches what we last sent, the merged bitmap is identical and
      // the client's local OR pass has kept it current. The actual
      // OR + pack work is deduplicated per team across teammates
      // (FOW-OPT-11) via shroudPayloadCache.
      state.shroud = undefined;
      if (
        !listenerIsDelta &&
        listener.playerId !== undefined &&
        input.world.fogOfWarEnabled
      ) {
        // FOW-OPT-21: read the team-mask key off the SnapshotVisibility
        // instance instead of recomputing it (which would walk
        // getAllies a second time per player listener).
        const teamKey = visibility.teamMaskKey;
        if (teamKey !== undefined) {
          let entry = shroudPayloadCache.get(teamKey);
          if (!entry) {
            entry = {
              versionSum: computeTeamShroudVersionSum(input.world, listener.playerId),
              payload: undefined,
              built: false,
            };
            shroudPayloadCache.set(teamKey, entry);
          }
          if (entry.versionSum !== listener.lastSentShroudVersionSum) {
            if (!entry.built) {
              entry.payload = entry.versionSum !== 0
                ? serializeShroudPayload(input.world, listener.playerId)
                : undefined;
              entry.built = true;
            }
            if (entry.payload) {
              state.shroud = entry.payload;
              listener.lastSentShroudVersionSum = entry.versionSum;
            }
          }
        }
      }
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
