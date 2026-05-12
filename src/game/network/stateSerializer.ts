import type { WorldState } from '../sim/WorldState';
import type { RemovedSnapshotEntity } from '../sim/WorldState';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import type { NetworkServerSnapshot, NetworkServerSnapshotEntity, NetworkServerSnapshotGridCell } from './NetworkManager';
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
import { SnapshotVisibility } from './stateSerializerVisibility';
import {
  SNAPSHOT_DIRTY_FORCE_FIELDS,
  aoiRemovedEntityIdsBuf as _aoiRemovedIdsBuf,
  copyPrevState,
  dirtyEntityFieldsBuf as _dirtyEntityFieldsBuf,
  dirtyEntityIdsBuf as _dirtyEntityIdsBuf,
  getDeltaTrackingState,
  getEntityDeltaChangedFields,
  getNextEntityState,
  getPrevState,
  removedEntityIdsBuf as _removedIdsBuf,
} from './stateSerializerEntityDelta';

export {
  captureSnapshotEntityStates,
  resetDeltaTracking,
  resetDeltaTrackingForKey,
} from './stateSerializerEntityDelta';

// Reusable arrays to avoid per-snapshot allocations
const _entityBuf: NetworkServerSnapshotEntity[] = [];
const _visibilityHiddenIdsBuf: EntityId[] = [];

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
  const tick = world.getTick();

  // Reset entity pool for this frame
  resetEntitySnapshotPool();
  _entityBuf.length = 0;
  _removedIdsBuf.length = 0;

  // Serialize units and buildings (projectiles handled via spawn/despawn events)
  const deltaEnabled = isDelta && SNAPSHOT_CONFIG.deltaEnabled;
  const acceptsEntity = (entity: Entity): boolean =>
    (entity.type === 'unit' || entity.type === 'building') &&
    isEntityInsideAoi(entity, aoi, visibility) &&
    visibility.isEntityVisible(entity);

  const forgetTrackedEntity = (id: EntityId, emitRemoval: boolean): void => {
    const wasVisible = tracking.prevEntityIds.delete(id);
    tracking.prevStates.delete(id);
    if (emitRemoval && wasVisible) {
      _removedIdsBuf.push(id);
    }
  };

  const processRemovedEntities = (records: readonly RemovedSnapshotEntity[]): void => {
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (visibility.shouldSendRemoval(record)) {
        forgetTrackedEntity(record.id, true);
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
        forgetTrackedEntity(record.id, true);
      }
    }
  };

  if (options?.removedEntities) {
    processRemovedEntities(options.removedEntities);
  }

  if (deltaEnabled) {
    const removedIds = options?.removedEntityIds;
    if (options?.removedEntities) {
      // Already filtered above with removal metadata.
    } else if (removedIds) {
      for (let i = 0; i < removedIds.length; i++) {
        forgetTrackedEntity(removedIds[i], true);
      }
    } else {
      world.drainRemovedSnapshotEntityIds(_removedIdsBuf);
      for (const id of _removedIdsBuf) {
        tracking.prevEntityIds.delete(id);
        tracking.prevStates.delete(id);
      }
    }

    if (aoi) {
      _aoiRemovedIdsBuf.length = 0;
      for (const id of tracking.prevEntityIds) {
        const entity = world.getEntity(id);
        if (!entity) {
          if (!visibility.isFiltered) _aoiRemovedIdsBuf.push(id);
          continue;
        }
        if (
          entity.type !== 'unit' &&
          entity.type !== 'building'
        ) {
          _aoiRemovedIdsBuf.push(id);
          continue;
        }
        if (!isEntityInsideAoi(entity, aoi, visibility)) {
          _aoiRemovedIdsBuf.push(id);
        }
      }
      for (let i = 0; i < _aoiRemovedIdsBuf.length; i++) {
        forgetTrackedEntity(_aoiRemovedIdsBuf[i], true);
      }
    }

    if (visibility.isFiltered) {
      _visibilityHiddenIdsBuf.length = 0;
      for (const id of tracking.prevEntityIds) {
        const entity = world.getEntity(id);
        if (!entity) continue;
        if (!isEntityInsideAoi(entity, aoi, visibility)) continue;
        if (visibility.isEntityVisible(entity)) {
          // Re-entered vision: any ghost-position record from a prior
          // out-of-sight stretch is now stale. The dirty loop below
          // will resume normal delta updates against the existing
          // prevStates baseline (issues.txt FOW-02).
          tracking.ghostedBuildingPositions.delete(id);
          continue;
        }
        if (entity.type === 'unit') {
          // Mobile unit out of vision: drop the client's copy entirely.
          // A stale ghost at a no-longer-current position would be a lie.
          _visibilityHiddenIdsBuf.push(id);
        } else if (entity.type === 'building') {
          // Static building out of vision: keep the client's last-seen
          // copy (FOW-02) AND record the position so a future cleanup
          // pass can drop the ghost once the player re-scouts the area
          // and either confirms the building is still there (dirty loop
          // handles it) or finds it gone (FOW-02b cleanup below).
          if (!tracking.ghostedBuildingPositions.has(id)) {
            tracking.ghostedBuildingPositions.set(id, {
              x: entity.transform.x,
              y: entity.transform.y,
            });
          }
        }
      }
      for (let i = 0; i < _visibilityHiddenIdsBuf.length; i++) {
        forgetTrackedEntity(_visibilityHiddenIdsBuf[i], true);
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
      if (!entity || !acceptsEntity(entity)) continue;
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
        const netEntity = serializeEntitySnapshot(entity, changedFields, world, visibility);
        if (netEntity) _entityBuf.push(netEntity);
        copyPrevState(next, prev);
      }
    }

    if (visibility.isFiltered) {
      const visibilitySources: ReadonlyArray<readonly Entity[]> = [
        world.getUnits(),
        world.getBuildings(),
      ];
      for (let s = 0; s < visibilitySources.length; s++) {
        const source = visibilitySources[s];
        for (let i = 0; i < source.length; i++) {
          const entity = source[i];
          if (tracking.prevEntityIds.has(entity.id)) continue;
          if (!acceptsEntity(entity)) continue;
          tracking.prevEntityIds.add(entity.id);
          const next = getNextEntityState(entity);
          const netEntity = serializeEntitySnapshot(entity, undefined, world, visibility);
          if (netEntity) _entityBuf.push(netEntity);
          const prev = getPrevState(tracking, entity.id);
          copyPrevState(next, prev);
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
    const keyframeSources: ReadonlyArray<readonly Entity[]> = [
      world.getUnits(),
      world.getBuildings(),
    ];
    for (let s = 0; s < keyframeSources.length; s++) {
      const source = keyframeSources[s];
      for (let i = 0; i < source.length; i++) {
        const entity = source[i];
        if (!acceptsEntity(entity)) continue;
        tracking.currentEntityIds.add(entity.id);
        const netEntity = serializeEntitySnapshot(entity, undefined, world, visibility);
        if (netEntity) _entityBuf.push(netEntity);
        const prev = getPrevState(tracking, entity.id);
        copyPrevState(getNextEntityState(entity), prev);
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

  const netMinimapEntities = serializeMinimapSnapshotEntities(world, aoi !== undefined, visibility);

  const netEconomy = serializeEconomySnapshot(world.playerCount, recipientPlayerId);

  const netSprayTargets = serializeSprayTargets(sprayTargets, visibility);

  const netAudioEvents = serializeAudioEvents(audioEvents, visibility);

  const netProjectiles = serializeProjectileSnapshot({
    world,
    deltaEnabled,
    tick,
    recipientPlayerId,
    visibility,
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
  _snapshotBuf.sprayTargets = netSprayTargets;
  _snapshotBuf.audioEvents = netAudioEvents;
  _snapshotBuf.projectiles = netProjectiles;
  _snapshotBuf.gameState = _gameStateBuf;
  _snapshotBuf.grid = netGrid;
  _snapshotBuf.isDelta = deltaEnabled;
  _snapshotBuf.removedEntityIds = _removedIdsBuf.length > 0 ? _removedIdsBuf : undefined;
  _snapshotBuf.visibilityFiltered = visibility.isFiltered ? true : undefined;

  return _snapshotBuf;
}
