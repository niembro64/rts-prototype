import type { WorldState } from '../sim/WorldState';
import type { RemovedSnapshotEntity } from '../sim/WorldState';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import type { PredictionMode } from '@/types/client';
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
import {
  ENTITY_CHANGED_JUMP,
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_VEL,
} from '../../types/network';
import { SNAPSHOT_CONFIG } from '../../config';
import { serializeAudioEvents } from './stateSerializerAudio';
import { serializeEconomySnapshot } from './stateSerializerEconomy';
import { resetEntitySnapshotPool, serializeEntitySnapshot } from './stateSerializerEntities';
import { serializeGridSnapshot } from './stateSerializerGrid';
import { serializeMinimapSnapshotEntities } from './stateSerializerMinimap';
import { serializeProjectileSnapshot } from './stateSerializerProjectiles';
import { serializeSprayTargets } from './stateSerializerSpray';
import {
  SnapshotVisibility,
  serializeScanPulses,
} from './stateSerializerVisibility';
import {
  SNAPSHOT_DIRTY_FORCE_FIELDS,
  aoiRemovedEntityIdsBuf as _aoiRemovedIdsBuf,
  copyPrevState,
  type DeltaTrackingState,
  type PrevEntityState,
  dirtyEntityFieldsBuf as _dirtyEntityFieldsBuf,
  dirtyEntityIdsBuf as _dirtyEntityIdsBuf,
  getDeltaTrackingState,
  getEntityDeltaChangedFields,
  getNextEntityState,
  getPrevState,
  removedEntityIdsBuf as _removedIdsBuf,
} from './stateSerializerEntityDelta';
import { spatialGrid } from '../sim/SpatialGrid';
import { getSimWasm, type SimWasm } from '../sim-wasm/init';

export {
  captureSnapshotEntityStates,
  resetDeltaTracking,
  resetDeltaTrackingForKey,
} from './stateSerializerEntityDelta';

/** Phase 10 D.3f — capture one entity's just-emitted next state
 *  into the recipient's Rust-side snapshot baseline. Mirrors the
 *  JS-side copyPrevState that runs alongside it. The caller must
 *  have already populated the entity-meta + turret pools for this
 *  entity via D.3a's captureSnapshotEntityStates pass. */
function captureToRustBaseline(
  sim: SimWasm,
  handle: number,
  entity: Entity,
  next: PrevEntityState,
  tick: number,
): void {
  const slot = spatialGrid.getSlot(entity.id);
  if (slot < 0) return;
  if (entity.type === 'unit') {
    sim.snapshotBaseline.captureUnitSlot(
      handle, slot, tick,
      next.x, next.y, next.z, next.rotation,
      next.velocityX, next.velocityY, next.velocityZ,
      next.movementAccelX, next.movementAccelY, next.movementAccelZ,
      next.normalX, next.normalY, next.normalZ,
      next.actionCount, next.actionHash,
      next.isEngagedBits, next.targetBits,
    );
  } else if (entity.type === 'building') {
    sim.snapshotBaseline.captureBuildingSlot(
      handle, slot, tick,
      next.x, next.y, next.z, next.rotation,
    );
  }
}

// Reusable arrays to avoid per-snapshot allocations
const _entityBuf: NetworkServerSnapshotEntity[] = [];
const _visibilityHiddenIdsBuf: EntityId[] = [];
const _aoiCandidateUnits: Entity[] = [];
const _aoiCandidateBuildings: Entity[] = [];

// Upper bound for getAoiPadding across every entity shape: unit
// padding is 100; building padding is max(width, height) * 0.5 + 150
// (~250 for the largest buildings currently in the game). The spatial
// grid query rect is expanded by this so entities at the precise
// padded edge still appear in the candidate set; the exact per-entity
// pad check downstream (isEntityInsideAoi) culls them precisely.
const AOI_RECT_PADDING = 300;

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
  sprayTargets: undefined,
  audioEvents: undefined,
  projectiles: undefined,
  gameState: undefined,
  grid: undefined,
  isDelta: false,
  removedEntityIds: undefined,
  visibilityFiltered: undefined,
};

export type SerializeGameStateOptions = {
  /**
   * Delta histories are per recipient so prev-state/removal bookkeeping
   * does not leak across players.
   */
  trackingKey?: string | number;
  /** Phase 10 D.3f — Rust-side snapshot baseline handle for this
   *  recipient. When present, each emitted entity also gets captured
   *  into the WASM-side baseline so the (future) D.3g diff kernel
   *  can compute the next tick's mask from Rust state. */
  snapshotBaselineHandle?: number;
  dirtyEntityIds?: readonly EntityId[];
  dirtyEntityFields?: readonly number[];
  removedEntityIds?: readonly EntityId[];
  removedEntities?: readonly RemovedSnapshotEntity[];
  /**
   * Recipient used for owner-aware diff resolution. Owned entities keep
   * baseline precision; observed entities can use coarser thresholds.
   */
  recipientPlayerId?: PlayerId;
  aoi?: SnapshotAoiBounds;
  visibility?: SnapshotVisibility;
  /**
   * When the publisher has already built a team-shared output for this
   * recipient's team (issues.txt FOW-OPT-20), pass the precomputed
   * value through the matching `*Override` and the per-piece
   * serializer call is skipped. Wrapping is intentional so a
   * present-but-undefined value (no audio events, empty spray array,
   * minimap disabled) is distinguishable from "no override supplied".
   */
  audioOverride?: SerializerAudioOverride;
  sprayOverride?: SerializerSprayOverride;
  minimapOverride?: SerializerMinimapOverride;
  /** PLAYER CLIENT bar PREDICT mode this recipient has selected.
   *  Default 'acc' (every snapshot field always emitted). When 'pos'
   *  the serializer zeros velocity fields and drops movementAccel;
   *  when 'vel' it drops only movementAccel. The client's local
   *  PREDICT integrator gate is the authoritative one for correctness;
   *  this is purely a bandwidth optimization (per-recipient). */
  predictionMode?: PredictionMode;
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

export type SnapshotAoiBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

function getAoiPadding(entity: Entity): number {
  if (entity.unit) return 100;
  const building = entity.building;
  if (!building) return 100;
  return Math.max(building.width, building.height) * 0.5 + 150;
}

/** Entity acceptance gate for the per-recipient snapshot pass
 *  (issues.txt FOW-OPT-13 — hoisted from a per-call closure to avoid
 *  allocating a fresh arrow function per recipient per snapshot). */
function acceptsSerializedEntity(
  entity: Entity,
  aoi: SnapshotAoiBounds | undefined,
  visibility: SnapshotVisibility,
): boolean {
  return (
    (entity.type === 'unit' || entity.type === 'building') &&
    isEntityInsideAoi(entity, aoi, visibility) &&
    visibility.isEntityVisible(entity)
  );
}

/** Forget an entity from delta tracking, optionally emitting a removal
 *  on the wire (issues.txt FOW-OPT-13 — hoisted closure). The removal
 *  is appended to the module-scope _removedIdsBuf which the active
 *  serializeGameState call drains at the end. */
function forgetTrackedEntity(
  tracking: DeltaTrackingState,
  id: EntityId,
  emitRemoval: boolean,
): void {
  const wasVisible = tracking.prevEntityIds.delete(id);
  tracking.prevStates.delete(id);
  if (emitRemoval && wasVisible) {
    _removedIdsBuf.push(id);
  }
}

/** Apply the world's per-tick removal records to the recipient's
 *  delta-tracking bookkeeping (issues.txt FOW-OPT-13 — hoisted
 *  closure). For each removal: if the recipient could see it,
 *  emit + forget. Otherwise stash the dead position so the FOW-02b
 *  cleanup pass can drop the ghost when the recipient re-scouts. */
function processRemovedEntities(
  records: readonly RemovedSnapshotEntity[],
  tracking: DeltaTrackingState,
  visibility: SnapshotVisibility,
): void {
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (visibility.shouldSendRemoval(record)) {
      forgetTrackedEntity(tracking, record.id, true);
      tracking.ghostedBuildingPositions.delete(record.id);
      continue;
    }
    if (!tracking.prevEntityIds.has(record.id)) {
      // Recipient never had this entity — nothing to send or
      // clean up.
      continue;
    }
    if (record.type === 'building') {
      // Building died out of the recipient's vision but the client
      // has it as a ghost (issues.txt FOW-02b). Stash the death
      // position so the cleanup pass below can emit a removal once
      // the player's vision later confirms the building is gone.
      tracking.ghostedBuildingPositions.set(record.id, { x: record.x, y: record.y });
    } else {
      // Unit died out of the recipient's vision (issues.txt FOW-17).
      // Mobile units don't persist as ghosts — without an emitted
      // removal here the stale entity stays in prevEntityIds and on
      // the client at its last-seen position forever (mostly hidden
      // behind shroud, but a real memory leak per kill). Emit a
      // silent removal: the recipient already lost sight of this
      // unit, so the deletion looks the same as a move-out-of-vision
      // and no extra info leaks.
      forgetTrackedEntity(tracking, record.id, true);
    }
  }
}

function isEntityInsideAoi(
  entity: Entity,
  aoi: SnapshotAoiBounds | undefined,
  visibility: SnapshotVisibility | undefined,
): boolean {
  if (!aoi) return true;
  // Keep owned-or-allied entities authoritative even while the camera
  // is away so selections, queued orders, and team intel do not
  // evaporate as the user pans. FOW-06 broadens this from "recipient"
  // to "recipient or ally" via the shared visibility helper.
  if (visibility && visibility.isOwnedByRecipientOrAlly(entity.ownership?.playerId)) {
    return true;
  }
  const padding = getAoiPadding(entity);
  const x = entity.transform.x;
  const y = entity.transform.y;
  return (
    x >= aoi.minX - padding &&
    x <= aoi.maxX + padding &&
    y >= aoi.minY - padding &&
    y <= aoi.maxY + padding
  );
}

/** Pre-filter units + buildings by AoI rect via the spatial grid,
 *  augmented by per-player owned-or-ally entities (which bypass AoI).
 *  The per-listener entity sweeps used to walk world.getUnits() and
 *  world.getBuildings() in full and reject the ~95% outside the
 *  camera with the per-entity AABB test in isEntityInsideAoi. With
 *  10k entities and 4 listeners that's 80k entity touches per delta.
 *  Asking the grid for cells overlapping the (padded) AoI rect drops
 *  the foreign-entity walk to just the cells the camera actually sees;
 *  owned-or-ally entities are picked up via the per-player caches.
 *
 *  Buckets are disjoint by construction so callers never see a
 *  duplicate: the spatial-grid walk emits ONLY non-owned-or-ally
 *  entities, the per-player walk emits ONLY recipient + ally entities.
 *  Same union of accepted entities as the old full-world walk under
 *  isEntityInsideAoi, just with the bulk of the rejection moved into
 *  the spatial broadphase. */
function buildAoiCandidates(
  world: WorldState,
  aoi: SnapshotAoiBounds,
  visibility: SnapshotVisibility,
  recipientPlayerId: PlayerId | undefined,
): void {
  _aoiCandidateUnits.length = 0;
  _aoiCandidateBuildings.length = 0;

  const rect = spatialGrid.queryUnitsAndBuildingsInRect2D(
    aoi.minX - AOI_RECT_PADDING,
    aoi.maxX + AOI_RECT_PADDING,
    aoi.minY - AOI_RECT_PADDING,
    aoi.maxY + AOI_RECT_PADDING,
  );
  const rectUnits = rect.units;
  for (let i = 0; i < rectUnits.length; i++) {
    const u = rectUnits[i];
    if (visibility.isOwnedByRecipientOrAlly(u.ownership?.playerId)) continue;
    _aoiCandidateUnits.push(u);
  }
  const rectBuildings = rect.buildings;
  for (let i = 0; i < rectBuildings.length; i++) {
    const b = rectBuildings[i];
    if (visibility.isOwnedByRecipientOrAlly(b.ownership?.playerId)) continue;
    _aoiCandidateBuildings.push(b);
  }

  if (recipientPlayerId !== undefined) {
    const ownUnits = world.getUnitsByPlayer(recipientPlayerId);
    for (let i = 0; i < ownUnits.length; i++) _aoiCandidateUnits.push(ownUnits[i]);
    const ownBuildings = world.getBuildingsByPlayer(recipientPlayerId);
    for (let i = 0; i < ownBuildings.length; i++) _aoiCandidateBuildings.push(ownBuildings[i]);
    const allies = world.getAllies(recipientPlayerId);
    for (const allyId of allies) {
      const allyUnits = world.getUnitsByPlayer(allyId);
      for (let i = 0; i < allyUnits.length; i++) _aoiCandidateUnits.push(allyUnits[i]);
      const allyBuildings = world.getBuildingsByPlayer(allyId);
      for (let i = 0; i < allyBuildings.length; i++) _aoiCandidateBuildings.push(allyBuildings[i]);
    }
  }
}

// Serialize WorldState to network format.
// When isDelta=true, only changed/new entities are included plus removedEntityIds.
// When isDelta=false (keyframe), all entities are included (same as before).
export function serializeGameState(
  world: WorldState,
  isDelta: boolean,
  gamePhase: GamePhase,
  winnerId?: PlayerId,
  sprayTargets?: SprayTarget[],
  audioEvents?: SimEvent[],
  projectileSpawns?: ProjectileSpawnEvent[],
  projectileDespawns?: ProjectileDespawnEvent[],
  projectileVelocityUpdates?: ProjectileVelocityUpdateEvent[],
  gridCells?: NetworkServerSnapshotGridCell[],
  gridSearchCells?: NetworkServerSnapshotGridCell[],
  gridCellSize?: number,
  options?: SerializeGameStateOptions
): NetworkServerSnapshot {
  const tracking = getDeltaTrackingState(options?.trackingKey);
  const recipientPlayerId = options?.recipientPlayerId;
  const aoi = options?.aoi;
  const visibility = options?.visibility ?? SnapshotVisibility.forRecipient(world, recipientPlayerId);
  const predictionMode = options?.predictionMode ?? 'acc';
  const tick = world.getTick();
  // Phase 10 D.3f — Rust-side baseline sync. Resolved once per
  // listener-tick; per-entity capture happens inside the emit loops
  // when both `sim` and `baselineHandle` are present.
  const baselineHandle = options?.snapshotBaselineHandle;
  const baselineSim = baselineHandle === undefined ? undefined : getSimWasm();

  // Reset entity pool for this frame
  resetEntitySnapshotPool();
  _entityBuf.length = 0;
  _removedIdsBuf.length = 0;

  // Serialize units and buildings (projectiles handled via spawn/despawn events).
  // FOW-OPT-13: acceptsSerializedEntity / forgetTrackedEntity /
  // processRemovedEntities used to be per-call closures here; they're
  // now module-scope helpers that take (tracking, visibility, aoi)
  // as explicit params, dropping three closure allocations per
  // serialize.
  const deltaEnabled = isDelta && SNAPSHOT_CONFIG.deltaEnabled;

  if (options?.removedEntities) {
    processRemovedEntities(options.removedEntities, tracking, visibility);
  }

  if (deltaEnabled) {
    const removedIds = options?.removedEntityIds;
    if (options?.removedEntities) {
      // Already filtered above with removal metadata.
    } else if (removedIds) {
      for (let i = 0; i < removedIds.length; i++) {
        forgetTrackedEntity(tracking, removedIds[i], true);
      }
    } else {
      world.drainRemovedSnapshotEntityIds(_removedIdsBuf);
      for (const id of _removedIdsBuf) {
        tracking.prevEntityIds.delete(id);
        tracking.prevStates.delete(id);
      }
    }

    // Merged AoI + visibility cleanup. Both filters used to iterate
    // tracking.prevEntityIds independently — for a player with both
    // AoI and FOW that's two passes over the same set plus a redundant
    // AoI re-check in the visibility pass. One classifying loop now
    // handles it: each entity is checked against AoI first (when
    // active) and then, if it passes, against visibility (when active).
    const aoiActive = aoi !== undefined;
    const visibilityActive = visibility.isFiltered;
    if (aoiActive || visibilityActive) {
      if (aoiActive) _aoiRemovedIdsBuf.length = 0;
      if (visibilityActive) _visibilityHiddenIdsBuf.length = 0;
      for (const id of tracking.prevEntityIds) {
        const entity = world.getEntity(id);
        if (!entity) {
          // Missing entity. Pre-merge, the AoI pass pushed it to
          // _aoiRemovedIdsBuf only when visibility was inactive
          // (visibility-active cleanup is handled by the ghost-position
          // sweep further down). Keep the same gating here.
          if (aoiActive && !visibilityActive) _aoiRemovedIdsBuf.push(id);
          continue;
        }
        if (aoiActive) {
          if (entity.type !== 'unit' && entity.type !== 'building') {
            _aoiRemovedIdsBuf.push(id);
            continue;
          }
          if (!isEntityInsideAoi(entity, aoi, visibility)) {
            _aoiRemovedIdsBuf.push(id);
            continue;
          }
        }
        if (visibilityActive) {
          if (visibility.isEntityVisible(entity)) {
            // Re-entered vision: any ghost-position record from a
            // prior out-of-sight stretch is now stale. The dirty loop
            // below will resume normal delta updates against the
            // existing prevStates baseline (issues.txt FOW-02).
            tracking.ghostedBuildingPositions.delete(id);
            continue;
          }
          if (entity.type === 'unit') {
            // Mobile unit out of vision: drop the client's copy
            // entirely. A stale ghost at a no-longer-current position
            // would be a lie.
            _visibilityHiddenIdsBuf.push(id);
          } else if (entity.type === 'building') {
            // Static building out of vision: keep the client's
            // last-seen copy (FOW-02) AND record the position so a
            // future cleanup pass can drop the ghost once the player
            // re-scouts the area and either confirms the building is
            // still there (dirty loop handles it) or finds it gone
            // (FOW-02b cleanup below).
            if (!tracking.ghostedBuildingPositions.has(id)) {
              tracking.ghostedBuildingPositions.set(id, {
                x: entity.transform.x,
                y: entity.transform.y,
              });
            }
          }
        }
      }
      if (aoiActive) {
        for (let i = 0; i < _aoiRemovedIdsBuf.length; i++) {
          forgetTrackedEntity(tracking, _aoiRemovedIdsBuf[i], true);
        }
      }
      if (visibilityActive) {
        for (let i = 0; i < _visibilityHiddenIdsBuf.length; i++) {
          forgetTrackedEntity(tracking, _visibilityHiddenIdsBuf[i], true);
        }
      }
    }

    const dirtyIds = options?.dirtyEntityIds;
    const dirtyFieldsList = options?.dirtyEntityFields;
    if (!dirtyIds) {
      world.drainSnapshotDirtyEntities(_dirtyEntityIdsBuf, _dirtyEntityFieldsBuf);
    }
    const sourceDirtyIds = dirtyIds ?? _dirtyEntityIdsBuf;
    const sourceDirtyFields = dirtyFieldsList ?? _dirtyEntityFieldsBuf;

    for (let i = 0; i < sourceDirtyIds.length; i++) {
      const entity = world.getEntity(sourceDirtyIds[i]);
      if (!entity || !acceptsSerializedEntity(entity, aoi, visibility)) continue;
      const dirtyFields = sourceDirtyFields[i] ?? 0;
      const prev = getPrevState(tracking, entity.id);
      const isNew = !tracking.prevEntityIds.has(entity.id);
      tracking.prevEntityIds.add(entity.id);
      const next = getNextEntityState(entity);
      const dirtyForcedFields = dirtyFields & SNAPSHOT_DIRTY_FORCE_FIELDS;
      const jumpAnchorFields = (dirtyFields & ENTITY_CHANGED_JUMP)
        ? ENTITY_CHANGED_POS | ENTITY_CHANGED_VEL
        : 0;
      const changedFields = isNew
        ? undefined
        : getEntityDeltaChangedFields(entity, prev, next, visibility) |
          dirtyForcedFields |
          jumpAnchorFields;
      if (isNew || changedFields! > 0) {
        const netEntity = serializeEntitySnapshot(entity, changedFields, world, visibility, predictionMode);
        if (netEntity) _entityBuf.push(netEntity);
        copyPrevState(next, prev);
        if (baselineSim !== undefined && baselineHandle !== undefined) {
          captureToRustBaseline(baselineSim, baselineHandle, entity, next, tick);
        }
      }
    }

    if (visibility.isFiltered) {
      let visibilitySources: ReadonlyArray<readonly Entity[]>;
      if (aoi !== undefined) {
        // Spatial-broadphase: ask the grid for entities inside the
        // AoI rect, then re-attach owned-or-ally entities (which bypass
        // AoI and may sit anywhere on the map). The precise per-entity
        // pad + visibility check inside acceptsSerializedEntity below
        // still runs.
        buildAoiCandidates(world, aoi, visibility, recipientPlayerId);
        visibilitySources = [_aoiCandidateUnits, _aoiCandidateBuildings];
      } else {
        visibilitySources = [world.getUnits(), world.getBuildings()];
      }
      for (let s = 0; s < visibilitySources.length; s++) {
        const source = visibilitySources[s];
        for (let i = 0; i < source.length; i++) {
          const entity = source[i];
          if (tracking.prevEntityIds.has(entity.id)) continue;
          if (!acceptsSerializedEntity(entity, aoi, visibility)) continue;
          tracking.prevEntityIds.add(entity.id);
          const next = getNextEntityState(entity);
          const netEntity = serializeEntitySnapshot(entity, undefined, world, visibility, predictionMode);
          if (netEntity) _entityBuf.push(netEntity);
          const prev = getPrevState(tracking, entity.id);
          copyPrevState(next, prev);
          if (baselineSim !== undefined && baselineHandle !== undefined) {
            captureToRustBaseline(baselineSim, baselineHandle, entity, next, tick);
          }
        }
      }

      // FOW-02b dead-ghost cleanup: walk the per-recipient ghost
      // positions and emit removals for buildings that have since been
      // destroyed AND whose last-known position is now back in the
      // player's vision. The "still alive" entries are no-ops — they
      // got cleared from the map up in the visibility-hidden loop when
      // they returned to vision, or they stay ghosted while still out.
      if (tracking.ghostedBuildingPositions.size > 0) {
        for (const [id, pos] of tracking.ghostedBuildingPositions) {
          if (world.getEntity(id)) continue;
          if (!visibility.isPointVisible(pos.x, pos.y)) continue;
          if (tracking.prevEntityIds.delete(id)) {
            _removedIdsBuf.push(id);
          }
          tracking.prevStates.delete(id);
          tracking.ghostedBuildingPositions.delete(id);
        }
      }
    }
  } else {
    tracking.currentEntityIds.clear();
    // FOW-02b: a keyframe rebuilds tracking from scratch, so any
    // ghost-position records become stale (their ids are about to be
    // re-derived from the current visibility set or dropped). The
    // client also rebuilds its view from the keyframe, so on-screen
    // ghosts disappear with the data — no removal emit needed.
    tracking.ghostedBuildingPositions.clear();
    // Keyframe: serialize every accepted unit + building. Both
    // categories take exactly the same path — pool an entry, capture
    // its prev state for delta tracking — so we walk both source
    // arrays through one body. Adding a new entity-shaped category
    // (e.g. capture-tile entities) means appending one more source
    // here, not duplicating another loop.
    //
    // When the listener has an AoI, scope the source arrays via the
    // spatial grid the same way the delta visibility sweep does —
    // foreign entities by AoI-rect broadphase + owned-or-ally by
    // per-player cache. The precise rect + visibility filter inside
    // acceptsSerializedEntity still culls the candidate set.
    let keyframeSources: ReadonlyArray<readonly Entity[]>;
    if (aoi !== undefined) {
      buildAoiCandidates(world, aoi, visibility, recipientPlayerId);
      keyframeSources = [_aoiCandidateUnits, _aoiCandidateBuildings];
    } else {
      keyframeSources = [world.getUnits(), world.getBuildings()];
    }
    for (let s = 0; s < keyframeSources.length; s++) {
      const source = keyframeSources[s];
      for (let i = 0; i < source.length; i++) {
        const entity = source[i];
        if (!acceptsSerializedEntity(entity, aoi, visibility)) continue;
        tracking.currentEntityIds.add(entity.id);
        const netEntity = serializeEntitySnapshot(entity, undefined, world, visibility, predictionMode);
        if (netEntity) _entityBuf.push(netEntity);
        const prev = getPrevState(tracking, entity.id);
        const next = getNextEntityState(entity);
        copyPrevState(next, prev);
        if (baselineSim !== undefined && baselineHandle !== undefined) {
          captureToRustBaseline(baselineSim, baselineHandle, entity, next, tick);
        }
      }
    }
    if (!options?.dirtyEntityIds) {
      world.drainSnapshotDirtyEntities(_dirtyEntityIdsBuf, _dirtyEntityFieldsBuf);
    }

    if (!options?.removedEntityIds && !options?.removedEntities) {
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
  const netMinimapEntities = options?.minimapOverride
    ? options.minimapOverride.value
    : serializeMinimapSnapshotEntities(world, aoi !== undefined, visibility, options?.trackingKey);

  const netEconomy = serializeEconomySnapshot(world.playerCount, recipientPlayerId);

  const netSprayTargets = options?.sprayOverride
    ? options.sprayOverride.value
    : serializeSprayTargets(sprayTargets, visibility, options?.trackingKey);

  const netAudioEvents = options?.audioOverride
    ? options.audioOverride.value
    : serializeAudioEvents(audioEvents, visibility, options?.trackingKey);

  const netScanPulses = serializeScanPulses(world, visibility);

  // FOW-11 shroud payload is decided by the publisher — it owns the
  // per-listener "have I sent this yet" tracking for the FOW-OPT-02
  // skip-when-unchanged gate. Leave the slot undefined here; the
  // publisher overwrites it after this serialize call returns.
  const netShroud = undefined;

  const netProjectiles = serializeProjectileSnapshot({
    world,
    deltaEnabled,
    tick,
    visibility,
    projectileSpawns,
    projectileDespawns,
    projectileVelocityUpdates,
    predictionMode,
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

  return _snapshotBuf;
}
