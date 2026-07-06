import type { WorldState } from '../sim/WorldState';
import type { RemovedSnapshotEntity } from '../sim/WorldState';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import { entitySlotRegistry } from '../sim/EntitySlotRegistry';
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
import type {
  ProjectileDespawnEvent,
  ProjectileSpawnEvent,
  ProjectileVelocityUpdateEvent,
} from '../sim/combat';
import type { GamePhase } from '../../types/network';
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
  addSnapshotMaterializationStageFromStart,
  type SnapshotMaterializationStageDurations,
} from './snapshotMaterializationMetadata';

const _entityBuf: NetworkServerSnapshotEntity[] = [];
const _removedIdsBuf: number[] = [];
const _dirtyEntityIdsBuf: EntityId[] = [];
const _dirtyEntityFieldsBuf: number[] = [];
registerEntitySnapshotWireSource(_entityBuf);

const _gameStateBuf: NonNullable<NetworkServerSnapshot['gameState']> = {
  phase: 'battle',
  winnerId: undefined,
};

const _snapshotBuf: NetworkServerSnapshot = {
  tick: 0,
  entities: _entityBuf,
  entityDeltaOnly: undefined,
  projectileDeltaOnly: undefined,
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
  removedEntityIds: undefined,
  visibilityFiltered: undefined,
  visionPlayerMask: undefined,
};

export type SerializeGameStateOptions = {
  trackingKey: string | number | undefined;
  removedEntityIds: readonly EntityId[] | undefined;
  removedEntities: readonly RemovedSnapshotEntity[] | undefined;
  recipientPlayerId: PlayerId | undefined;
  visibility: SnapshotVisibility | undefined;
  audioOverride: SerializerAudioOverride | undefined;
  sprayOverride: SerializerSprayOverride | undefined;
  minimapOverride: SerializerMinimapOverride | undefined;
  emitProjectileDetailFields: boolean | undefined;
  materializationStages: SnapshotMaterializationStageDurations | undefined;
};

const DEFAULT_SERIALIZE_GAME_STATE_OPTIONS: SerializeGameStateOptions = {
  trackingKey: undefined,
  removedEntityIds: undefined,
  removedEntities: undefined,
  recipientPlayerId: undefined,
  visibility: undefined,
  audioOverride: undefined,
  sprayOverride: undefined,
  minimapOverride: undefined,
  emitProjectileDetailFields: undefined,
  materializationStages: undefined,
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

function isSerializableSnapshotEntity(entity: Entity): boolean {
  return entity.type === 'unit' || entity.type === 'building' || entity.type === 'tower';
}

function acceptsSerializedEntity(entity: Entity, visibility: SnapshotVisibility): boolean {
  return isSerializableSnapshotEntity(entity) &&
    (!visibility.isFiltered || visibility.isEntityVisible(entity));
}

function appendRemovedEntityIds(
  world: WorldState,
  visibility: SnapshotVisibility,
  options: SerializeGameStateOptions,
): void {
  if (options.removedEntities !== undefined) {
    const records: readonly RemovedSnapshotEntity[] = options.removedEntities;
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (!visibility.isFiltered || visibility.shouldSendRemoval(record)) {
        _removedIdsBuf.push(record.id);
      }
    }
    return;
  }
  if (options.removedEntityIds !== undefined) {
    for (let i = 0; i < options.removedEntityIds.length; i++) {
      _removedIdsBuf.push(options.removedEntityIds[i]);
    }
    return;
  }
  world.drainRemovedSnapshotEntityIds(_removedIdsBuf);
}

function appendFullEntityRows(
  world: WorldState,
  visibility: SnapshotVisibility,
): void {
  let write = _entityBuf.length;
  const visibleEntityIds = visibility.getVisibleEntityIds();
  if (visibleEntityIds !== undefined) {
    const visibleEntitySlots = visibility.getVisibleEntitySlots();
    for (let i = 0; i < visibleEntityIds.length; i++) {
      const entity = resolveSnapshotEntityFromVisibleSlot(
        world,
        visibleEntityIds[i],
        visibleEntitySlots !== undefined ? visibleEntitySlots[i] : -1,
      );
      if (!entity || !isSerializableSnapshotEntity(entity)) continue;
      const netEntity = serializeEntitySnapshot(entity, undefined, world, visibility);
      if (netEntity !== null) _entityBuf[write++] = netEntity;
    }
    _entityBuf.length = write;
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
      if (!acceptsSerializedEntity(entity, visibility)) continue;
      const netEntity = serializeEntitySnapshot(entity, undefined, world, visibility);
      if (netEntity !== null) _entityBuf[write++] = netEntity;
    }
  }
  _entityBuf.length = write;
}

function resolveSnapshotEntityFromVisibleSlot(
  world: WorldState,
  id: EntityId,
  slot: number,
): Entity | undefined {
  if (slot >= 0) {
    const entity = entitySlotRegistry.resolveSlot(slot);
    if (entity !== undefined && entity.id === id) return entity;
  }
  return world.getEntity(id);
}

// Serialize the full WorldState to the renderer presentation format.
export function serializeGameState(
  world: WorldState,
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
  const recipientPlayerId = options.recipientPlayerId;
  const visibility = options.visibility ?? SnapshotVisibility.forRecipient(world, recipientPlayerId);
  const tick = world.getTick();
  const stages = options.materializationStages;

  resetEntitySnapshotPool();
  _entityBuf.length = 0;
  _removedIdsBuf.length = 0;

  let stageStart = performance.now();
  appendRemovedEntityIds(world, visibility, options);
  appendFullEntityRows(world, visibility);
  if (stages !== undefined) {
    addSnapshotMaterializationStageFromStart(stages, 'entityDtos', stageStart);
  }

  // Full-state snapshots do not consume dirty records, but direct callers
  // still need the world's per-tick dirty buffer drained.
  world.drainSnapshotDirtyEntities(_dirtyEntityIdsBuf, _dirtyEntityFieldsBuf);

  let netMinimapEntities: NetworkServerSnapshot['minimapEntities'];
  if (options.minimapOverride !== undefined) {
    netMinimapEntities = options.minimapOverride.value;
  } else {
    stageStart = performance.now();
    netMinimapEntities = serializeMinimapSnapshotEntities(
      world,
      visibility,
      options.trackingKey,
    );
    if (stages !== undefined) {
      addSnapshotMaterializationStageFromStart(stages, 'minimap', stageStart);
    }
  }

  stageStart = performance.now();
  const netEconomy = serializeEconomySnapshot(world.playerCount, recipientPlayerId);
  if (stages !== undefined) {
    addSnapshotMaterializationStageFromStart(stages, 'economy', stageStart);
  }
  stageStart = performance.now();
  const netResourceMovements = serializeResourceMovements(world, visibility);
  if (stages !== undefined) {
    addSnapshotMaterializationStageFromStart(stages, 'resources', stageStart);
  }

  let netSprayTargets: NetworkServerSnapshot['sprayTargets'];
  if (options.sprayOverride !== undefined) {
    netSprayTargets = options.sprayOverride.value;
  } else {
    stageStart = performance.now();
    netSprayTargets = serializeSprayTargets(sprayTargets, visibility, options.trackingKey);
    if (stages !== undefined) {
      addSnapshotMaterializationStageFromStart(stages, 'spray', stageStart);
    }
  }

  let netAudioEvents: NetworkServerSnapshot['audioEvents'];
  if (options.audioOverride !== undefined) {
    netAudioEvents = options.audioOverride.value;
  } else {
    stageStart = performance.now();
    netAudioEvents = serializeAudioEvents(audioEvents, visibility, options.trackingKey);
    if (stages !== undefined) {
      addSnapshotMaterializationStageFromStart(stages, 'audio', stageStart);
    }
  }

  stageStart = performance.now();
  const netScanPulses = serializeScanPulses(world, visibility);
  if (stages !== undefined) {
    addSnapshotMaterializationStageFromStart(stages, 'scanPulses', stageStart);
  }
  const netShroud = undefined;

  stageStart = performance.now();
  const netProjectiles = serializeProjectileSnapshot({
    world,
    fullStateResync: true,
    visibility,
    emitBeamUpdates: options.emitProjectileDetailFields !== false,
    projectileSpawns,
    projectileDespawns,
    projectileVelocityUpdates,
  });
  if (stages !== undefined) {
    addSnapshotMaterializationStageFromStart(stages, 'projectiles', stageStart);
  }

  stageStart = performance.now();
  const netGrid = serializeGridSnapshot(gridCells, gridSearchCells, gridCellSize);
  if (stages !== undefined) {
    addSnapshotMaterializationStageFromStart(stages, 'grid', stageStart);
  }

  stageStart = performance.now();
  _gameStateBuf.phase = gamePhase;
  _gameStateBuf.winnerId = winnerId;
  if (stages !== undefined) {
    addSnapshotMaterializationStageFromStart(stages, 'gameState', stageStart);
  }

  _snapshotBuf.tick = tick;
  _snapshotBuf.entityDeltaOnly = undefined;
  _snapshotBuf.projectileDeltaOnly = undefined;
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
  _snapshotBuf.removedEntityIds = _removedIdsBuf.length > 0 ? _removedIdsBuf : undefined;
  _snapshotBuf.visibilityFiltered = visibility.isFiltered ? true : undefined;
  _snapshotBuf.visionPlayerMask = visibility.hasRecipient
    ? visibility.getVisionPlayerMask()
    : undefined;

  return _snapshotBuf;
}
