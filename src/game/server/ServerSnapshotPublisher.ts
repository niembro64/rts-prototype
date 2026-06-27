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
  type SnapshotVisibility,
} from '../network/stateSerializerVisibility';
import { serializeAudioEvents } from '../network/stateSerializerAudio';
import { serializeSprayTargets } from '../network/stateSerializerSpray';
import { serializeMinimapSnapshotEntities } from '../network/stateSerializerMinimap';
import { serializeProjectileSnapshot } from '../network/stateSerializerProjectiles';
import {
  getEntitySnapshotPoolStats,
  resetEntitySnapshotPool,
  serializeEntitySnapshot,
} from '../network/stateSerializerEntities';
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
  }

  hasEntityMotionDeltaCandidates(world: WorldState): boolean {
    const units = world.getUnits();
    for (let i = 0; i < units.length; i++) {
      if (isEntityMotionDeltaCandidate(units[i])) return true;
    }
    return false;
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

    const gridDebug = input.debugGridPublisher.refresh(performance.now(), input.world);
    const gridCells = gridDebug.cells;
    const gridSearchCells = gridDebug.searchCells;
    const gridCellSize = gridDebug.cellSize;

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
            value: serializeAudioEvents(audioEvents, visibility, listener.cacheKey),
          };
          teamAudioCache.set(teamKey, audioOverride);
        }
        sprayOverride = teamSprayCache.get(teamKey);
        if (!sprayOverride) {
          sprayOverride = {
            value: serializeSprayTargets(sprayTargets, visibility, listener.cacheKey),
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
                listener.cacheKey,
              ),
            };
            teamMinimapCache.set(teamKey, minimapOverride);
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

  emitProjectileDelta(input: ServerSnapshotPublisherInput): boolean {
    if (input.listeners.length === 0) return false;
    const hasProjectilePresentationEvents = input.simulation.hasPendingProjectilePresentationEvents();
    const hasEntityMotionDeltas = this.hasEntityMotionDeltaCandidates(input.world);
    if (!hasProjectilePresentationEvents && !hasEntityMotionDeltas) return false;

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

    const visibilityCache = this.visibilityCache;
    visibilityCache.clear();
    let emitted = false;
    for (const listener of input.listeners) {
      const visibility = getOrBuildVisibility(input.world, listener.playerId, visibilityCache);
      const motionEntities = hasEntityMotionDeltas
        ? this.serializeEntityMotionDelta(input.world, visibility)
        : undefined;
      const projectiles = hasProjectilesAfterDrain
        ? serializeProjectileSnapshot({
            world: input.world,
            fullStateResync: false,
            visibility,
            emitBeamUpdates: false,
            projectileSpawns,
            projectileDespawns,
            projectileVelocityUpdates,
          })
        : undefined;
      const netAudioEvents = audioEvents !== undefined
        ? serializeAudioEvents(audioEvents, visibility, listener.cacheKey)
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
      const encoded = this.wirePreencoder.encodeIfRequested(state, listener.preencodeWire);
      listener.callback(state, undefined, encoded.wirePayload);
      emitted = true;
    }
    return emitted;
  }

  private serializeEntityMotionDelta(
    world: WorldState,
    visibility: SnapshotVisibility,
  ): NetworkServerSnapshot['entities'] | undefined {
    resetEntitySnapshotPool();
    const entities: NetworkServerSnapshot['entities'] = [];
    const units = world.getUnits();
    for (let i = 0; i < units.length; i++) {
      const entity = units[i];
      if (!isEntityMotionDeltaCandidate(entity)) continue;
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
