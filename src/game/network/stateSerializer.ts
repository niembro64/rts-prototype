import type { WorldState } from '../sim/WorldState';
import type { RemovedSnapshotEntity } from '../sim/WorldState';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotEntity,
  NetworkServerSnapshotGridCell,
  NetworkServerSnapshotMinimapEntity,
  NetworkServerSnapshotSimEvent,
  NetworkServerSnapshotSprayTarget,
} from './NetworkManager';
import type { SprayTarget } from '../sim/commanderAbilities';
import type { SimEvent } from '../sim/combat';
import type { ProjectileSpawnEvent, ProjectileDespawnEvent, ProjectileVelocityUpdateEvent } from '../sim/combat';
import type { GamePhase } from '../../types/network';
import { SNAPSHOT_CONFIG } from '../../config';
import { serializeAudioEvents } from './stateSerializerAudio';
import { serializeEconomySnapshot } from './stateSerializerEconomy';
import {
  registerEntitySnapshotWireSource,
  resetEntitySnapshotPool,
  serializeEntitySnapshot,
} from './stateSerializerEntities';
import { serializeGridSnapshot } from './stateSerializerGrid';
import { serializeMinimapSnapshotEntities } from './stateSerializerMinimap';
import { serializeProjectileSnapshot } from './stateSerializerProjectiles';
import { serializeResourceMovements } from './stateSerializerResourceMovements';
import { serializeSprayTargets } from './stateSerializerSpray';
import {
  SnapshotVisibility,
  serializeScanPulses,
} from './stateSerializerVisibility';
import {
  SNAPSHOT_DIRTY_SHIELDS,
  copyPrevState,
  copySentPrevState,
  type DeltaTrackingState,
  type PrevEntityState,
  dirtyEntityFieldsBuf as _dirtyEntityFieldsBuf,
  dirtyEntityIdsBuf as _dirtyEntityIdsBuf,
  getDeltaTrackingState,
  getEntityDeltaChangedFields,
  getRustEntityDeltaChangedFields,
  getNextEntityState,
  getPrevState,
  removedEntityIdsBuf as _removedIdsBuf,
  SNAPSHOT_DETAIL_THROTTLED_FIELDS,
} from './stateSerializerEntityDelta';
import { spatialGrid } from '../sim/SpatialGrid';
import { getSimWasm, type SimWasm } from '../sim-wasm/init';

export {
  captureSnapshotEntityStates,
  resetDeltaTracking,
  resetDeltaTrackingForKey,
} from './stateSerializerEntityDelta';

/** Phase 10 D.3f — capture one entity's just-emitted state into the
 *  recipient's Rust-side snapshot baseline. `changedFields ===
 *  undefined` means full/new record; otherwise only the emitted field
 *  groups advance, mirroring copySentPrevState. The caller must have
 *  already populated the entity-meta + turret pools for this entity
 *  via D.3a's captureSnapshotEntityStates pass. */
function captureToRustBaseline(
  sim: SimWasm,
  handle: number,
  entity: Entity,
  next: PrevEntityState,
  tick: number,
  changedFields: number | undefined,
): void {
  const slot = spatialGrid.getSlot(entity.id);
  if (slot < 0) return;
  const baselineChangedFields = changedFields ?? 0xFFFF_FFFF;
  if (entity.type === 'unit') {
    sim.snapshotBaseline.captureUnitSlot(
      handle, slot, tick, baselineChangedFields,
      next.x, next.y, next.z, next.rotation,
      next.velocityX, next.velocityY, next.velocityZ,
      next.normalX, next.normalY, next.normalZ,
      next.actionCount, next.actionHash,
      next.isEngagedBits, next.targetBits,
    );
  } else if (entity.type === 'building' || entity.type === 'tower') {
    // Towers and buildings share the static baseline storage (no
    // velocity field, identical HP / build / combat / factory shape).
    // The TOWER vs BUILDING kind is reasserted at diff time so the
    // diff kernel's match arms can diverge later if the wire format
    // ever does.
    sim.snapshotBaseline.captureBuildingSlot(
      handle, slot, tick, baselineChangedFields,
      next.x, next.y, next.z, next.rotation,
      next.isEngagedBits, next.targetBits,
    );
  }
}

// Reusable arrays to avoid per-snapshot allocations
const _entityBuf: NetworkServerSnapshotEntity[] = [];
const _visibilityHiddenIdsBuf: EntityId[] = [];
const _deferredDetailEntityIdsBuf: EntityId[] = [];
registerEntitySnapshotWireSource(_entityBuf);

// Pre-allocated sub-objects for nested fields (avoids per-frame allocation)
const _gameStateBuf: NonNullable<NetworkServerSnapshot['gameState']> = {
  phase: 'battle',
  winnerId: undefined,
};

// Reusable snapshot object (avoids creating a new object literal every frame)
const _snapshotBuf: NetworkServerSnapshot = {
  tick: 0,
  entities: _entityBuf,
  minimapEntities: undefined,
  economy: serializeEconomySnapshot(0, undefined),
  resourceMovements: undefined,
  sprayTargets: undefined,
  audioEvents: undefined,
  scanPulses: undefined,
  shroud: undefined,
  projectiles: undefined,
  gameState: undefined,
  grid: undefined,
  serverMeta: undefined,
  terrain: undefined,
  buildability: undefined,
  isDelta: false,
  removedEntityIds: undefined,
  visibilityFiltered: undefined,
  visionPlayerMask: undefined,
};

export type SerializeGameStateOptions = {
  /**
   * Delta histories are per recipient so prev-state/removal bookkeeping
   * does not leak across players.
   */
  trackingKey: string | number | undefined;
  /** Phase 10 D.3f — Rust-side snapshot baseline handle for this
   *  recipient. When present, each emitted entity also gets captured
   *  into the WASM-side baseline so the (future) D.3g diff kernel
   *  can compute the next tick's mask from Rust state. */
  snapshotBaselineHandle: number | undefined;
  dirtyEntityIds: readonly EntityId[] | undefined;
  dirtyEntityFields: readonly number[] | undefined;
  removedEntityIds: readonly EntityId[] | undefined;
  removedEntities: readonly RemovedSnapshotEntity[] | undefined;
  /**
   * Recipient used for owner-aware diff resolution. Owned entities keep
   * baseline precision; observed entities can use coarser thresholds.
   */
  recipientPlayerId: PlayerId | undefined;
  visibility: SnapshotVisibility | undefined;
  /**
   * High-frequency visual detail fields can ride a lower cadence than
   * core movement. Defaults to true for direct serializeGameState
   * callers; ServerSnapshotPublisher sets it per emitted snapshot.
   */
  emitEntityDetailFields: boolean | undefined;
  /**
   * When the publisher has already built a team-shared output for this
   * recipient's team (FOW-OPT-20), pass the precomputed
   * value through the matching `*Override` and the per-piece
   * serializer call is skipped. Wrapping is intentional so a
   * present-but-undefined value (no audio events, empty spray array,
   * minimap disabled) is distinguishable from "no override supplied".
   */
  audioOverride: SerializerAudioOverride | undefined;
  sprayOverride: SerializerSprayOverride | undefined;
  minimapOverride: SerializerMinimapOverride | undefined;
  emitProjectileDetailFields: boolean | undefined;
};

const DEFAULT_SERIALIZE_GAME_STATE_OPTIONS: SerializeGameStateOptions = {
  trackingKey: undefined,
  snapshotBaselineHandle: undefined,
  dirtyEntityIds: undefined,
  dirtyEntityFields: undefined,
  removedEntityIds: undefined,
  removedEntities: undefined,
  recipientPlayerId: undefined,
  visibility: undefined,
  emitEntityDetailFields: undefined,
  audioOverride: undefined,
  sprayOverride: undefined,
  minimapOverride: undefined,
  emitProjectileDetailFields: undefined,
};

export type SerializerAudioOverride = {
  value: NetworkServerSnapshotSimEvent[] | undefined;
};

export type SerializerSprayOverride = {
  value: NetworkServerSnapshotSprayTarget[] | undefined;
};

export type SerializerMinimapOverride = {
  value: NetworkServerSnapshotMinimapEntity[] | undefined;
};

/** Entity acceptance gate for the per-recipient snapshot pass
 *  (FOW-OPT-13 — hoisted from a per-call closure to avoid
 *  allocating a fresh arrow function per recipient per snapshot). */
function acceptsSerializedEntity(
  entity: Entity,
  visibility: SnapshotVisibility,
): boolean {
  return (
    (entity.type === 'unit' || entity.type === 'building' || entity.type === 'tower') &&
    visibility.isEntityVisible(entity)
  );
}

/** Forget an entity from delta tracking, optionally emitting a removal
 *  on the wire (FOW-OPT-13 — hoisted closure). The removal
 *  is appended to the module-scope _removedIdsBuf which the active
 *  serializeGameState call drains at the end. */
function forgetTrackedEntity(
  tracking: DeltaTrackingState,
  id: EntityId,
  emitRemoval: boolean,
  baselineSim: SimWasm | undefined = undefined,
  baselineHandle: number | undefined = undefined,
): void {
  const wasVisible = tracking.prevEntityIds.delete(id);
  tracking.prevStates.delete(id);
  tracking.deferredDetailFields.delete(id);
  if (baselineSim !== undefined && baselineHandle !== undefined) {
    const slot = spatialGrid.getSlot(id);
    if (slot >= 0) baselineSim.snapshotBaseline.unsetSlot(baselineHandle, slot);
  }
  if (emitRemoval && wasVisible) {
    _removedIdsBuf.push(id);
  }
}

/** Apply the world's per-tick removal records to the recipient's
 *  delta-tracking bookkeeping (FOW-OPT-13 — hoisted closure). */
function processRemovedEntities(
  records: readonly RemovedSnapshotEntity[],
  tracking: DeltaTrackingState,
  visibility: SnapshotVisibility,
  baselineSim: SimWasm | undefined = undefined,
  baselineHandle: number | undefined = undefined,
): void {
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (visibility.shouldSendRemoval(record)) {
      forgetTrackedEntity(tracking, record.id, true, baselineSim, baselineHandle);
      continue;
    }
    if (!tracking.prevEntityIds.has(record.id)) {
      // Recipient never had this entity — nothing to send or
      // clean up.
      continue;
    }
    forgetTrackedEntity(tracking, record.id, true, baselineSim, baselineHandle);
  }
}

// Serialize WorldState to network format.
// When isDelta=true, only changed/new entities are included plus removedEntityIds.
// When isDelta=false (keyframe), all entities are included (same as before).
export function serializeGameState(
  world: WorldState,
  isDelta: boolean,
  gamePhase: GamePhase,
  winnerId: PlayerId | undefined = undefined,
  sprayTargets: SprayTarget[] | undefined = undefined,
  audioEvents: SimEvent[] | undefined = undefined,
  projectileSpawns: ProjectileSpawnEvent[] | undefined = undefined,
  projectileDespawns: ProjectileDespawnEvent[] | undefined = undefined,
  projectileVelocityUpdates: ProjectileVelocityUpdateEvent[] | undefined = undefined,
  gridCells: NetworkServerSnapshotGridCell[] | undefined = undefined,
  gridSearchCells: NetworkServerSnapshotGridCell[] | undefined = undefined,
  gridCellSize: number | undefined = undefined,
  options: SerializeGameStateOptions = DEFAULT_SERIALIZE_GAME_STATE_OPTIONS,
): NetworkServerSnapshot {
  const tracking = getDeltaTrackingState(options.trackingKey);
  const recipientPlayerId = options.recipientPlayerId;
  const visibility = options.visibility ?? SnapshotVisibility.forRecipient(world, recipientPlayerId);
  const tick = world.getTick();
  // Phase 10 D.3f — Rust-side baseline sync. Resolved once per
  // listener-tick; per-entity capture happens inside the emit loops
  // when both `sim` and `baselineHandle` are present.
  const baselineHandle = options.snapshotBaselineHandle;
  const baselineSim = baselineHandle === undefined ? undefined : getSimWasm();
  const emitEntityDetailFields = options.emitEntityDetailFields !== false;

  // Reset entity pool for this frame
  resetEntitySnapshotPool();
  _entityBuf.length = 0;
  _removedIdsBuf.length = 0;

  // Serialize units and buildings (projectiles handled via spawn/despawn events).
  // FOW-OPT-13: acceptsSerializedEntity / forgetTrackedEntity /
  // processRemovedEntities used to be per-call closures here; they're
  // now module-scope helpers with explicit params, dropping closure
  // allocations per serialize.
  const deltaEnabled = isDelta && SNAPSHOT_CONFIG.deltaSnapshotsEnabled;

  if (options.removedEntities !== undefined) {
    processRemovedEntities(options.removedEntities, tracking, visibility, baselineSim, baselineHandle);
  }

  if (deltaEnabled) {
    const removedIds = options.removedEntityIds;
    if (options.removedEntities !== undefined) {
      // Already filtered above with removal metadata.
    } else if (removedIds) {
      for (let i = 0; i < removedIds.length; i++) {
        forgetTrackedEntity(tracking, removedIds[i], true, baselineSim, baselineHandle);
      }
    } else {
      world.drainRemovedSnapshotEntityIds(_removedIdsBuf);
      for (const id of _removedIdsBuf) {
        tracking.prevEntityIds.delete(id);
        tracking.prevStates.delete(id);
        tracking.deferredDetailFields.delete(id);
        if (baselineSim !== undefined && baselineHandle !== undefined) {
          const slot = spatialGrid.getSlot(id);
          if (slot >= 0) baselineSim.snapshotBaseline.unsetSlot(baselineHandle, slot);
        }
      }
    }

    if (visibility.isFiltered) {
      _visibilityHiddenIdsBuf.length = 0;
      for (const id of tracking.prevEntityIds) {
        const entity = world.getEntity(id);
        if (!entity) continue;
        if (visibility.isEntityVisible(entity)) continue;
        _visibilityHiddenIdsBuf.push(id);
      }
      for (let i = 0; i < _visibilityHiddenIdsBuf.length; i++) {
        forgetTrackedEntity(tracking, _visibilityHiddenIdsBuf[i], true, baselineSim, baselineHandle);
      }
    }

    const dirtyIds = options.dirtyEntityIds;
    const dirtyFieldsList = options.dirtyEntityFields;
    if (dirtyIds === undefined) {
      world.drainSnapshotDirtyEntities(_dirtyEntityIdsBuf, _dirtyEntityFieldsBuf);
    }
    const sourceDirtyIds = dirtyIds ?? _dirtyEntityIdsBuf;
    const sourceDirtyFields = dirtyFieldsList ?? _dirtyEntityFieldsBuf;

    for (let i = 0; i < sourceDirtyIds.length; i++) {
      const entity = world.getEntity(sourceDirtyIds[i]);
      if (!entity || !acceptsSerializedEntity(entity, visibility)) continue;
      const dirtyFields = sourceDirtyFields[i] ?? 0;
      const prev = getPrevState(tracking, entity.id);
      const isNew = !tracking.prevEntityIds.has(entity.id);
      tracking.prevEntityIds.add(entity.id);
      const next = getNextEntityState(entity);
      const dirtyForcedFields = dirtyFields & SNAPSHOT_DIRTY_SHIELDS;
      const rustDeltaMask = !isNew && baselineHandle !== undefined
        ? getRustEntityDeltaChangedFields(entity, next, baselineHandle, world)
        : undefined;
      const rawDeltaMask = isNew
        ? 0
        : rustDeltaMask ?? getEntityDeltaChangedFields(entity, prev, next, world);
      let changedFields = isNew
        ? undefined
        : rawDeltaMask | dirtyForcedFields;
      if (changedFields !== undefined) {
        const pendingDetailFields = tracking.deferredDetailFields.get(entity.id) ?? 0;
        if (pendingDetailFields !== 0) {
          changedFields |= pendingDetailFields;
        }
        if (!emitEntityDetailFields) {
          const deferredFields = changedFields & SNAPSHOT_DETAIL_THROTTLED_FIELDS;
          if (deferredFields !== 0) {
            tracking.deferredDetailFields.set(entity.id, pendingDetailFields | deferredFields);
            changedFields &= ~SNAPSHOT_DETAIL_THROTTLED_FIELDS;
          }
        } else if (pendingDetailFields !== 0) {
          tracking.deferredDetailFields.delete(entity.id);
        }
      }
      if (isNew || changedFields! > 0) {
        const netEntity = serializeEntitySnapshot(entity, changedFields, world, visibility);
        if (netEntity) _entityBuf.push(netEntity);
        copySentPrevState(next, prev, changedFields);
        if (baselineSim !== undefined && baselineHandle !== undefined) {
          captureToRustBaseline(baselineSim, baselineHandle, entity, next, tick, changedFields);
        }
      }
    }

    if (emitEntityDetailFields && tracking.deferredDetailFields.size > 0) {
      _deferredDetailEntityIdsBuf.length = 0;
      for (const id of tracking.deferredDetailFields.keys()) {
        _deferredDetailEntityIdsBuf.push(id);
      }
      for (let i = 0; i < _deferredDetailEntityIdsBuf.length; i++) {
        const id = _deferredDetailEntityIdsBuf[i];
        const pendingDetailFields = tracking.deferredDetailFields.get(id) ?? 0;
        if (pendingDetailFields === 0) {
          tracking.deferredDetailFields.delete(id);
          continue;
        }
        const entity = world.getEntity(id);
        if (!entity) {
          tracking.deferredDetailFields.delete(id);
          continue;
        }
        if (!acceptsSerializedEntity(entity, visibility)) continue;

        const prev = getPrevState(tracking, entity.id);
        const isNew = !tracking.prevEntityIds.has(entity.id);
        tracking.prevEntityIds.add(entity.id);
        const next = getNextEntityState(entity);
        const rustDeltaMask = !isNew && baselineHandle !== undefined
          ? getRustEntityDeltaChangedFields(entity, next, baselineHandle, world)
          : undefined;
        const rawDeltaMask = isNew
          ? 0
          : rustDeltaMask ?? getEntityDeltaChangedFields(entity, prev, next, world);
        const changedFields = isNew
          ? undefined
          : rawDeltaMask | pendingDetailFields;
        if (isNew || changedFields! > 0) {
          const netEntity = serializeEntitySnapshot(entity, changedFields, world, visibility);
          if (netEntity) _entityBuf.push(netEntity);
          copySentPrevState(next, prev, changedFields);
          if (baselineSim !== undefined && baselineHandle !== undefined) {
            captureToRustBaseline(baselineSim, baselineHandle, entity, next, tick, changedFields);
          }
        }
        tracking.deferredDetailFields.delete(id);
      }
      _deferredDetailEntityIdsBuf.length = 0;
    }

    if (visibility.isFiltered) {
      const visibleEntityIds = visibility.getVisibleEntityIds();
      if (visibleEntityIds !== undefined) {
        for (let i = 0; i < visibleEntityIds.length; i++) {
          const entity = world.getEntity(visibleEntityIds[i]);
          if (!entity || tracking.prevEntityIds.has(entity.id)) continue;
          if (!acceptsSerializedEntity(entity, visibility)) continue;
          tracking.prevEntityIds.add(entity.id);
          const next = getNextEntityState(entity);
          const netEntity = serializeEntitySnapshot(entity, undefined, world, visibility);
          if (netEntity) _entityBuf.push(netEntity);
          const prev = getPrevState(tracking, entity.id);
          copyPrevState(next, prev);
          if (baselineSim !== undefined && baselineHandle !== undefined) {
            captureToRustBaseline(baselineSim, baselineHandle, entity, next, tick, undefined);
          }
        }
      } else {
        const visibilitySources: ReadonlyArray<readonly Entity[]> = [
          world.getUnits(),
          world.getBuildings(),
        ];
        for (let s = 0; s < visibilitySources.length; s++) {
          const source = visibilitySources[s];
          for (let i = 0; i < source.length; i++) {
            const entity = source[i];
            if (tracking.prevEntityIds.has(entity.id)) continue;
            if (!acceptsSerializedEntity(entity, visibility)) continue;
            tracking.prevEntityIds.add(entity.id);
            const next = getNextEntityState(entity);
            const netEntity = serializeEntitySnapshot(entity, undefined, world, visibility);
            if (netEntity) _entityBuf.push(netEntity);
            const prev = getPrevState(tracking, entity.id);
            copyPrevState(next, prev);
            if (baselineSim !== undefined && baselineHandle !== undefined) {
              captureToRustBaseline(baselineSim, baselineHandle, entity, next, tick, undefined);
            }
          }
        }
      }
    }
  } else {
    tracking.currentEntityIds.clear();
    tracking.deferredDetailFields.clear();
    // Keyframe: serialize every accepted unit + building. Both
    // categories take exactly the same path — pool an entry, capture
    // its prev state for delta tracking — so we walk both source
    // arrays through one body. Adding a new entity-shaped category
    // (e.g. future entity-like payloads) means appending one more source
    // here, not duplicating another loop.
    //
    const keyframeVisibleEntityIds = visibility.getVisibleEntityIds();
    if (keyframeVisibleEntityIds !== undefined) {
      for (let i = 0; i < keyframeVisibleEntityIds.length; i++) {
        const entity = world.getEntity(keyframeVisibleEntityIds[i]);
        if (!entity || !acceptsSerializedEntity(entity, visibility)) continue;
        tracking.currentEntityIds.add(entity.id);
        const netEntity = serializeEntitySnapshot(entity, undefined, world, visibility);
        if (netEntity) _entityBuf.push(netEntity);
        const prev = getPrevState(tracking, entity.id);
        const next = getNextEntityState(entity);
        copyPrevState(next, prev);
        if (baselineSim !== undefined && baselineHandle !== undefined) {
          captureToRustBaseline(baselineSim, baselineHandle, entity, next, tick, undefined);
        }
      }
    } else {
      const keyframeSources: ReadonlyArray<readonly Entity[]> = [
        world.getUnits(),
        world.getBuildings(),
      ];
      for (let s = 0; s < keyframeSources.length; s++) {
        const source = keyframeSources[s];
        for (let i = 0; i < source.length; i++) {
          const entity = source[i];
          if (!acceptsSerializedEntity(entity, visibility)) continue;
          tracking.currentEntityIds.add(entity.id);
          const netEntity = serializeEntitySnapshot(entity, undefined, world, visibility);
          if (netEntity) _entityBuf.push(netEntity);
          const prev = getPrevState(tracking, entity.id);
          const next = getNextEntityState(entity);
          copyPrevState(next, prev);
          if (baselineSim !== undefined && baselineHandle !== undefined) {
            captureToRustBaseline(baselineSim, baselineHandle, entity, next, tick, undefined);
          }
        }
      }
    }
    if (options.dirtyEntityIds === undefined) {
      world.drainSnapshotDirtyEntities(_dirtyEntityIdsBuf, _dirtyEntityFieldsBuf);
    }

    if (options.removedEntityIds === undefined && options.removedEntities === undefined) {
      world.drainRemovedSnapshotEntityIds(_removedIdsBuf);
    }

    // Update previous entity ID set for next frame
    tracking.prevEntityIds.clear();
    for (const id of tracking.currentEntityIds) {
      tracking.prevEntityIds.add(id);
    }
    // Clean up prevStates for entities that no longer exist after a keyframe.
    for (const id of tracking.prevStates.keys()) {
      if (!tracking.currentEntityIds.has(id)) {
        tracking.prevStates.delete(id);
        if (baselineSim !== undefined && baselineHandle !== undefined) {
          const slot = spatialGrid.getSlot(id);
          if (slot >= 0) baselineSim.snapshotBaseline.unsetSlot(baselineHandle, slot);
        }
      }
    }
  }

  // FOW-OPT-20: per-team caching of audio / spray / minimap output
  // lives in the publisher; when it has already built a buffer for
  // this listener's team it passes the result through `*Override`,
  // which short-circuits the per-listener serializer call below.
  // Each override wraps the value (which may itself be undefined for
  // "no events / no targets / minimap disabled") so an absent wrapper
  // is distinguishable from a present-but-undefined value.
  const netMinimapEntities = options.minimapOverride !== undefined
    ? options.minimapOverride.value
    : serializeMinimapSnapshotEntities(world, visibility, options.trackingKey);

  const netEconomy = serializeEconomySnapshot(world.playerCount, recipientPlayerId);

  const netResourceMovements = serializeResourceMovements(world, visibility);

  const netSprayTargets = options.sprayOverride !== undefined
    ? options.sprayOverride.value
    : serializeSprayTargets(sprayTargets, visibility, options.trackingKey);

  const netAudioEvents = options.audioOverride !== undefined
    ? options.audioOverride.value
    : serializeAudioEvents(audioEvents, visibility, options.trackingKey);

  const netScanPulses = serializeScanPulses(world, visibility);

  // Explored-history shroud rendering was removed; keep the legacy
  // wire slot empty.
  const netShroud = undefined;

  const netProjectiles = serializeProjectileSnapshot({
    world,
    deltaEnabled,
    visibility,
    emitBeamUpdates: options.emitProjectileDetailFields !== false,
    projectileSpawns,
    projectileDespawns,
    projectileVelocityUpdates,
  });

  const netGrid = serializeGridSnapshot(gridCells, gridSearchCells, gridCellSize);

  // Nest game state
  _gameStateBuf.phase = gamePhase;
  _gameStateBuf.winnerId = winnerId;

  // Reuse snapshot object
  _snapshotBuf.tick = tick;
  _snapshotBuf.entities = _entityBuf;
  _snapshotBuf.minimapEntities = netMinimapEntities;
  _snapshotBuf.economy = netEconomy;
  _snapshotBuf.resourceMovements = netResourceMovements;
  _snapshotBuf.sprayTargets = netSprayTargets;
  _snapshotBuf.audioEvents = netAudioEvents;
  _snapshotBuf.scanPulses = netScanPulses;
  _snapshotBuf.shroud = netShroud;
  _snapshotBuf.projectiles = netProjectiles;
  _snapshotBuf.gameState = _gameStateBuf;
  _snapshotBuf.grid = netGrid;
  _snapshotBuf.isDelta = deltaEnabled;
  _snapshotBuf.removedEntityIds = _removedIdsBuf.length > 0 ? _removedIdsBuf : undefined;
  _snapshotBuf.visibilityFiltered = visibility.isFiltered ? true : undefined;
  _snapshotBuf.visionPlayerMask = visibility.hasRecipient
    ? visibility.getVisionPlayerMask()
    : undefined;

  return _snapshotBuf;
}
