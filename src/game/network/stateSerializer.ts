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
  recipientPlayerId: PlayerId | undefined,
): boolean {
  if (!aoi) return true;
  // Keep owned entities authoritative even while the camera is away so
  // selections and queued orders do not evaporate as the user pans.
  if (
    recipientPlayerId !== undefined &&
    entity.ownership?.playerId === recipientPlayerId
  ) {
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
    isEntityInsideAoi(entity, aoi, recipientPlayerId) &&
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
        if (!isEntityInsideAoi(entity, aoi, recipientPlayerId)) {
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
        if (entity.type !== 'unit' && entity.type !== 'building') continue;
        if (!isEntityInsideAoi(entity, aoi, recipientPlayerId)) continue;
        if (!visibility.isEntityVisible(entity)) {
          _visibilityHiddenIdsBuf.push(id);
        }
      }
      for (let i = 0; i < _visibilityHiddenIdsBuf.length; i++) {
        // Fog hides the entity from the recipient — emit a removal so the
        // client drops it from its world. Once it re-enters vision the
        // "new entities not yet tracked" pass below will send it back as a
        // full entity snapshot.
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
        : getEntityDeltaChangedFields(entity, prev, next, recipientPlayerId) |
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
    }
  } else {
    tracking.currentEntityIds.clear();
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
