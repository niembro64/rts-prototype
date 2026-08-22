import type { GamePhase } from '../../types/network';
import type { TerrainBuildabilityGrid, TerrainTileMap } from '../../types/terrain';
import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotMeta,
} from '../network/NetworkTypes';
import type { SnapshotWirePayload } from '../network/SnapshotWirePayload';
import {
  appendEntitySnapshotWireRowDirect,
  canUseTypedDeltaPlaceholder,
  entityPrivateSnapshotRequiresDto,
  registerEntitySnapshotWireSource,
  resetEntitySnapshotPool,
  serializeEntitySnapshot,
} from '../network/stateSerializerEntities';
import { writeProjectileSnapshotWireRowsDirect } from '../network/stateSerializerProjectiles';
import type { SnapshotVisibility } from '../network/stateSerializerVisibility';
import type {
  SerializerAudioOverride,
  SerializerMinimapOverride,
  SerializerSprayOverride,
} from '../network/stateSerializer';
import {
  acceptsSerializedEntity,
  isSerializableSnapshotEntity,
} from '../network/snapshotEntityVisibility';
import { appendUnique } from '../collections';
import {
  encodeNetworkSnapshotWithRust,
} from '../network/snapshotRustWireEncoder';
import { IndexedEntityIdSet } from '../network/IndexedEntityIdCollections';
import {
  addSnapshotMaterializationStageFromStart,
  type SnapshotMaterializationStageDurations,
} from '../network/snapshotMaterializationMetadata';
import type { NetworkServerSnapshotWire } from '../network/snapshotWireTypes';
import type { SprayTarget } from '../sim/commanderAbilities';
import type {
  ProjectileDespawnEvent,
  ProjectileSpawnEvent,
  ProjectileMotionUpdateEvent,
  SimEvent,
} from '../sim/combat';
import { getSimWasm } from '../sim-wasm/init';
import { entitySlotRegistry } from '../sim/EntitySlotRegistry';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import type { RemovedSnapshotEntity, WorldState } from '../sim/WorldState';
import {
  tryAppendBuildingSlabDeltaRowFromState,
  tryAppendUnitSlabDeltaRowFromState,
} from './snapshotSlabDeltaRows';
import { resolveEntityFromSlotOrWorld } from '../sim/entitySlotResolution';
import {
  materializeSnapshotAudioEvents,
  materializeSnapshotSupplementals,
  type DirectSnapshotDelivery,
  type SnapshotSupplementalBuffers,
} from './ServerSnapshotSupplementalMaterializer';

type DirectSerializedListenerSnapshot = {
  state: NetworkServerSnapshot;
  wirePayload: SnapshotWirePayload | undefined;
  visibleEntityIds?: readonly EntityId[];
  visibleBaselineAddedIds?: readonly EntityId[];
  visibleBaselineRemovedIds?: readonly EntityId[];
};

type ServerSnapshotDirectWireInput = {
  world: WorldState;
  removedEntities: readonly RemovedSnapshotEntity[] | undefined;
  recipientPlayerId: PlayerId | undefined;
  visibility: SnapshotVisibility;
  gamePhase: GamePhase;
  winnerId: PlayerId | undefined;
  sprayTargets: SprayTarget[] | undefined;
  audioEvents: SimEvent[] | undefined;
  projectileSpawns: ProjectileSpawnEvent[] | undefined;
  projectileDespawns: ProjectileDespawnEvent[] | undefined;
  projectileMotionUpdates: ProjectileMotionUpdateEvent[] | undefined;
  emitProjectileDetailFields: boolean;
  audioOverride: SerializerAudioOverride | undefined;
  sprayOverride: SerializerSprayOverride | undefined;
  minimapOverride: SerializerMinimapOverride | undefined;
  terrain: TerrainTileMap | undefined;
  buildability: TerrainBuildabilityGrid | undefined;
  serverMeta: NetworkServerSnapshotMeta;
  materializationStages: SnapshotMaterializationStageDurations | undefined;
  delivery: DirectSnapshotDelivery;
};

type ServerSnapshotSparseDeltaDirectWireInput = {
  world: WorldState;
  visibility: SnapshotVisibility;
  audioEvents: SimEvent[] | undefined;
  projectileSpawns: ProjectileSpawnEvent[] | undefined;
  projectileDespawns: ProjectileDespawnEvent[] | undefined;
  projectileMotionUpdates: ProjectileMotionUpdateEvent[] | undefined;
  materializationStages: SnapshotMaterializationStageDurations | undefined;
  delivery: DirectSnapshotDelivery;
};

type ServerSnapshotRichDeltaDirectWireInput = {
  world: WorldState;
  removedEntities: readonly RemovedSnapshotEntity[];
  recipientPlayerId: PlayerId | undefined;
  visibility: SnapshotVisibility;
  previousVisibleEntityIds: ReadonlySet<EntityId>;
  currentVisibleEntityIds: ReadonlySet<EntityId> | undefined;
  currentVisibleEntityIdList: readonly EntityId[] | undefined;
  currentVisibleEntitySlots: readonly number[] | undefined;
  dirtyIds: readonly EntityId[];
  dirtyFields: readonly number[];
  dirtySlots: readonly number[];
  gamePhase: GamePhase;
  winnerId: PlayerId | undefined;
  sprayTargets: SprayTarget[] | undefined;
  audioEvents: SimEvent[] | undefined;
  projectileSpawns: ProjectileSpawnEvent[] | undefined;
  projectileDespawns: ProjectileDespawnEvent[] | undefined;
  projectileMotionUpdates: ProjectileMotionUpdateEvent[] | undefined;
  audioOverride: SerializerAudioOverride | undefined;
  sprayOverride: SerializerSprayOverride | undefined;
  minimapOverride: SerializerMinimapOverride | undefined;
  serverMeta: NetworkServerSnapshotMeta;
  materializationStages: SnapshotMaterializationStageDurations | undefined;
  delivery: DirectSnapshotDelivery;
};

const _directGameState: NonNullable<NetworkServerSnapshot['gameState']> = {
  phase: 'battle',
  winnerId: undefined,
};

export class ServerSnapshotDirectWirePreencoder {
  private readonly entityPlaceholders: NetworkServerSnapshot['entities'] = [];
  private readonly minimapPlaceholders: NonNullable<NetworkServerSnapshot['minimapEntities']> = [];
  private readonly sprayPlaceholders: NonNullable<NetworkServerSnapshot['sprayTargets']> = [];
  private readonly scanPulsePlaceholders: NonNullable<NetworkServerSnapshot['scanPulses']> = [];
  private readonly resourceMovementPlaceholders: NonNullable<NetworkServerSnapshot['resourceMovements']> = [];
  private readonly audioEventPlaceholders: NonNullable<NetworkServerSnapshot['audioEvents']> = [];
  private readonly economyPlaceholder = {} as NetworkServerSnapshot['economy'];
  private readonly supplementalBuffers: SnapshotSupplementalBuffers = {
    minimap: this.minimapPlaceholders,
    economy: this.economyPlaceholder,
    resourceMovements: this.resourceMovementPlaceholders,
    sprayTargets: this.sprayPlaceholders,
    audioEvents: this.audioEventPlaceholders,
    scanPulses: this.scanPulsePlaceholders,
  };
  private readonly removedEntityIds: number[] = [];
  private readonly removedEntityIdSet = new IndexedEntityIdSet();
  private readonly emittedDeltaEntityIds = new IndexedEntityIdSet();
  private readonly fullVisibleEntityIds: EntityId[] = [];
  private readonly visibleBaselineAddedIds: EntityId[] = [];
  private readonly visibleBaselineRemovedIds: EntityId[] = [];
  private readonly state: NetworkServerSnapshot = {
    tick: 0,
    entities: this.entityPlaceholders,
    entityDeltaOnly: undefined,
    projectileDeltaOnly: undefined,
    minimapEntities: undefined,
    economy: {} as NetworkServerSnapshot['economy'],
    resourceMovements: undefined,
    sprayTargets: undefined,
    audioEvents: undefined,
    scanPulses: undefined,
    projectiles: undefined,
    serverMeta: undefined,
    terrain: undefined,
    buildability: undefined,
    gameState: _directGameState,
    removedEntityIds: undefined,
    visibilityFiltered: undefined,
    visionPlayerMask: undefined,
  };

  private writeEntityRow(
    index: number,
    entity: Entity,
    changedFields: number | undefined,
    world: WorldState,
    visibility: SnapshotVisibility,
    typedPlaceholder = false,
  ): boolean {
    if (entityPrivateSnapshotRequiresDto(entity, changedFields, visibility)) {
      const row = serializeEntitySnapshot(entity, changedFields, world, visibility);
      if (row === null) return false;
      this.entityPlaceholders[index] = row;
      return true;
    }
    this.entityPlaceholders[index] = undefined as unknown as NetworkServerSnapshot['entities'][number];
    appendEntitySnapshotWireRowDirect(
      entity,
      changedFields,
      world,
      visibility,
      typedPlaceholder,
    );
    return true;
  }

  private encodeDirectWirePayload(
    state: NetworkServerSnapshot,
    materializationStages: SnapshotMaterializationStageDurations | undefined,
  ): SnapshotWirePayload | undefined {
    const stageStart = performance.now();
    const encoded = encodeNetworkSnapshotWithRust(state as NetworkServerSnapshotWire);
    const encodeMs = performance.now() - stageStart;
    if (materializationStages !== undefined) {
      addSnapshotMaterializationStageFromStart(
        materializationStages,
        'wireEncode',
        stageStart,
      );
    }
    if (encoded === null) return undefined;
    return {
      bytes: encoded.bytes,
      encodeMs,
      encoderKind: 'rust',
      materializationKind: 'direct',
      rustEntityCount: encoded.rustEntityCount,
      rawEntityCount: encoded.rawEntityCount,
      rawTopLevelKeys: encoded.rawTopLevelKeys.length > 0
        ? [...encoded.rawTopLevelKeys]
        : undefined,
    };
  }

  tryEncode(input: ServerSnapshotDirectWireInput): DirectSerializedListenerSnapshot | undefined {
    if (getSimWasm() === undefined) return undefined;

    this.fullVisibleEntityIds.length = 0;
    const state = this.materializeWireState(input);
    const wirePayload = input.delivery.preencodeWire
      ? this.encodeDirectWirePayload(state, input.materializationStages)
      : undefined;
    if (input.delivery.preencodeWire && wirePayload === undefined) return undefined;
    return {
      state,
      wirePayload,
      visibleEntityIds: this.fullVisibleEntityIds,
    };
  }

  tryEncodeSparseDelta(
    input: ServerSnapshotSparseDeltaDirectWireInput,
  ): DirectSerializedListenerSnapshot | undefined {
    if (getSimWasm() === undefined) return undefined;

    const state = this.materializeSparseDeltaWireState(input);
    if (state === undefined) return undefined;

    const wirePayload = input.delivery.preencodeWire
      ? this.encodeDirectWirePayload(state, input.materializationStages)
      : undefined;
    if (input.delivery.preencodeWire && wirePayload === undefined) return undefined;
    return { state, wirePayload };
  }

  tryEncodeRichDelta(
    input: ServerSnapshotRichDeltaDirectWireInput,
  ): DirectSerializedListenerSnapshot | undefined {
    if (getSimWasm() === undefined) return undefined;

    this.visibleBaselineAddedIds.length = 0;
    this.visibleBaselineRemovedIds.length = 0;
    const state = this.materializeRichDeltaWireState(input);
    if (state === undefined) return undefined;

    const wirePayload = input.delivery.preencodeWire
      ? this.encodeDirectWirePayload(state, input.materializationStages)
      : undefined;
    if (input.delivery.preencodeWire && wirePayload === undefined) return undefined;
    const includeVisibleBaselineDeltas = input.currentVisibleEntityIds !== undefined;
    return {
      state,
      wirePayload,
      visibleBaselineAddedIds: includeVisibleBaselineDeltas
        ? this.visibleBaselineAddedIds
        : undefined,
      visibleBaselineRemovedIds: includeVisibleBaselineDeltas
        ? this.visibleBaselineRemovedIds
        : undefined,
    };
  }

  private materializeWireState(input: ServerSnapshotDirectWireInput): NetworkServerSnapshot {
    const stages = input.materializationStages;
    let stageStart = performance.now();
    const entityCount = this.writeEntityRows(input);
    if (stages !== undefined) {
      addSnapshotMaterializationStageFromStart(stages, 'entityDtos', stageStart);
    }
    this.entityPlaceholders.length = entityCount;
    registerEntitySnapshotWireSource(this.entityPlaceholders);

    const supplementals = materializeSnapshotSupplementals({
      world: input.world,
      recipientPlayerId: input.recipientPlayerId,
      visibility: input.visibility,
      sprayTargets: input.sprayTargets,
      audioEvents: input.audioEvents,
      audioOverride: input.audioOverride,
      sprayOverride: input.sprayOverride,
      minimapOverride: input.minimapOverride,
      delivery: input.delivery,
      stages,
      buffers: this.supplementalBuffers,
    });
    stageStart = performance.now();
    const netProjectiles = writeProjectileSnapshotWireRowsDirect({
      world: input.world,
      fullStateResync: true,
      visibility: input.visibility,
      emitBeamUpdates: input.emitProjectileDetailFields,
      projectileSpawns: input.projectileSpawns,
      projectileDespawns: input.projectileDespawns,
      projectileMotionUpdates: input.projectileMotionUpdates,
    });
    if (stages !== undefined) {
      addSnapshotMaterializationStageFromStart(stages, 'projectiles', stageStart);
    }
    stageStart = performance.now();
    _directGameState.phase = input.gamePhase;
    _directGameState.winnerId = input.winnerId;
    if (stages !== undefined) {
      addSnapshotMaterializationStageFromStart(stages, 'gameState', stageStart);
    }

    const state = this.state;
    state.tick = input.world.getTick();
    state.entities = this.entityPlaceholders;
    state.minimapEntities = supplementals.minimapEntities;
    state.economy = supplementals.economy;
    state.resourceMovements = supplementals.resourceMovements;
    state.sprayTargets = supplementals.sprayTargets;
    state.audioEvents = supplementals.audioEvents;
    state.scanPulses = supplementals.scanPulses;
    state.projectiles = netProjectiles;
    state.serverMeta = input.serverMeta;
    state.terrain = input.terrain;
    state.buildability = input.buildability;
    state.gameState = _directGameState;
    state.removedEntityIds = this.removedEntityIds.length > 0
      ? this.removedEntityIds
      : undefined;
    // `state` is reused across emissions, and the delta paths stamp these
    // flags. A full snapshot MUST clear them (the DTO serializer does the
    // same): a leaked `entityDeltaOnly: true` disables the client's
    // absence-based full-snapshot reconcile, which is the unfiltered
    // (spectator) listener's ONLY way to shed entities whose removal
    // records were lost — dead units would stay on its screen forever.
    state.entityDeltaOnly = undefined;
    state.projectileDeltaOnly = undefined;
    state.visibilityFiltered = input.visibility.isFiltered ? true : undefined;
    state.visionPlayerMask = input.visibility.hasRecipient
      ? input.visibility.getVisionPlayerMask()
      : undefined;
    return state;
  }

  private materializeSparseDeltaWireState(
    input: ServerSnapshotSparseDeltaDirectWireInput,
  ): NetworkServerSnapshot | undefined {
    const stages = input.materializationStages;
    let stageStart = performance.now();
    const entityCount = 0;
    if (stages !== undefined) {
      addSnapshotMaterializationStageFromStart(stages, 'entityDtos', stageStart);
    }
    this.entityPlaceholders.length = entityCount;
    registerEntitySnapshotWireSource(this.entityPlaceholders);

    stageStart = performance.now();
    const netProjectiles = writeProjectileSnapshotWireRowsDirect({
      world: input.world,
      fullStateResync: false,
      visibility: input.visibility,
      emitBeamUpdates: true,
      projectileSpawns: input.projectileSpawns,
      projectileDespawns: input.projectileDespawns,
      projectileMotionUpdates: input.projectileMotionUpdates,
    });
    if (stages !== undefined) {
      addSnapshotMaterializationStageFromStart(stages, 'projectiles', stageStart);
    }

    const netAudioEvents = materializeSnapshotAudioEvents({
      audioEvents: input.audioEvents,
      visibility: input.visibility,
      audioOverride: undefined,
      delivery: input.delivery,
      stages,
      buffers: this.supplementalBuffers,
    });

    if (entityCount === 0 && netProjectiles === undefined && netAudioEvents === undefined) {
      return undefined;
    }

    const state = this.state;
    state.tick = input.world.getTick();
    state.entities = this.entityPlaceholders;
    state.entityDeltaOnly = entityCount > 0 ? true : undefined;
    state.projectileDeltaOnly = entityCount > 0 ? undefined : true;
    state.minimapEntities = undefined;
    state.economy = this.economyPlaceholder;
    state.resourceMovements = undefined;
    state.sprayTargets = undefined;
    state.audioEvents = netAudioEvents;
    state.scanPulses = undefined;
    state.projectiles = netProjectiles;
    state.serverMeta = undefined;
    state.terrain = undefined;
    state.buildability = undefined;
    state.gameState = undefined;
    state.removedEntityIds = undefined;
    state.visibilityFiltered = undefined;
    state.visionPlayerMask = undefined;
    return state;
  }

  private materializeRichDeltaWireState(
    input: ServerSnapshotRichDeltaDirectWireInput,
  ): NetworkServerSnapshot | undefined {
    const stages = input.materializationStages;
    let stageStart = performance.now();
    const entityCount = this.writeRichDeltaEntityRows(input);
    if (entityCount < 0) return undefined;
    this.writeRichDeltaRemovedIds(input);
    if (stages !== undefined) {
      addSnapshotMaterializationStageFromStart(stages, 'entityDtos', stageStart);
    }
    this.entityPlaceholders.length = entityCount;
    registerEntitySnapshotWireSource(this.entityPlaceholders);

    const supplementals = materializeSnapshotSupplementals({
      world: input.world,
      recipientPlayerId: input.recipientPlayerId,
      visibility: input.visibility,
      sprayTargets: input.sprayTargets,
      audioEvents: input.audioEvents,
      audioOverride: input.audioOverride,
      sprayOverride: input.sprayOverride,
      minimapOverride: input.minimapOverride,
      delivery: input.delivery,
      stages,
      buffers: this.supplementalBuffers,
    });

    const hasLiveLineProjectiles = input.world.getLineProjectiles().length > 0;
    const hasProjectileEvents =
      hasLiveLineProjectiles ||
      (
        input.projectileSpawns !== undefined &&
        input.projectileDespawns !== undefined &&
        input.projectileMotionUpdates !== undefined &&
        (
          input.projectileSpawns.length > 0 ||
          input.projectileDespawns.length > 0 ||
          input.projectileMotionUpdates.length > 0
        )
      );
    const netProjectiles = hasProjectileEvents
      ? (() => {
          stageStart = performance.now();
          const rows = writeProjectileSnapshotWireRowsDirect({
            world: input.world,
            fullStateResync: false,
            visibility: input.visibility,
            emitBeamUpdates: true,
            projectileSpawns: input.projectileSpawns,
            projectileDespawns: input.projectileDespawns,
            projectileMotionUpdates: input.projectileMotionUpdates,
          });
          if (stages !== undefined) {
            addSnapshotMaterializationStageFromStart(stages, 'projectiles', stageStart);
          }
          return rows;
        })()
      : undefined;

    stageStart = performance.now();
    _directGameState.phase = input.gamePhase;
    _directGameState.winnerId = input.winnerId;
    if (stages !== undefined) {
      addSnapshotMaterializationStageFromStart(stages, 'gameState', stageStart);
    }

    const state = this.state;
    state.tick = input.world.getTick();
    state.entities = this.entityPlaceholders;
    state.entityDeltaOnly = true;
    state.projectileDeltaOnly = undefined;
    state.minimapEntities = supplementals.minimapEntities;
    state.economy = supplementals.economy;
    state.resourceMovements = supplementals.resourceMovements;
    state.sprayTargets = supplementals.sprayTargets;
    state.audioEvents = supplementals.audioEvents;
    state.scanPulses = supplementals.scanPulses;
    state.projectiles = netProjectiles;
    state.serverMeta = input.serverMeta;
    state.terrain = undefined;
    state.buildability = undefined;
    state.gameState = _directGameState;
    state.removedEntityIds = this.removedEntityIds.length > 0
      ? this.removedEntityIds
      : undefined;
    state.visibilityFiltered = input.visibility.isFiltered ? true : undefined;
    state.visionPlayerMask = input.visibility.hasRecipient
      ? input.visibility.getVisionPlayerMask()
      : undefined;
    return state;
  }

  private writeEntityRows(input: ServerSnapshotDirectWireInput): number {
    resetEntitySnapshotPool();
    this.removedEntityIds.length = 0;
    if (input.removedEntities !== undefined) {
      this.processRemovedEntities(input.removedEntities, input.visibility);
    }

    const visibleEntityIds = input.visibility.getVisibleEntityIds();
    if (visibleEntityIds !== undefined) {
      const visibleEntitySlots = input.visibility.getVisibleEntitySlots();
      let entityCount = 0;
      for (let i = 0; i < visibleEntityIds.length; i++) {
        const entity = resolveEntityFromSlotOrWorld(
          input.world,
          visibleEntityIds[i],
          visibleEntitySlots !== undefined ? visibleEntitySlots[i] : -1,
        );
        if (!entity || !isSerializableSnapshotEntity(entity)) continue;
        if (!this.writeEntityRow(entityCount, entity, undefined, input.world, input.visibility)) continue;
        this.fullVisibleEntityIds.push(entity.id);
        entityCount++;
      }
      return entityCount;
    }

    let entityCount = 0;
    const sources: ReadonlyArray<readonly Entity[]> = [
      input.world.getUnits(),
      input.world.getBuildings(),
    ];
    for (let s = 0; s < sources.length; s++) {
      const source = sources[s];
      for (let i = 0; i < source.length; i++) {
        const entity = source[i];
        if (!acceptsSerializedEntity(entity, input.visibility)) continue;
        if (!this.writeEntityRow(entityCount, entity, undefined, input.world, input.visibility)) continue;
        this.fullVisibleEntityIds.push(entity.id);
        entityCount++;
      }
    }
    return entityCount;
  }

  private writeRichDeltaEntityRows(input: ServerSnapshotRichDeltaDirectWireInput): number {
    resetEntitySnapshotPool();
    const emittedIds = this.emittedDeltaEntityIds;
    emittedIds.clear();
    const entityViews = entitySlotRegistry.getViews();

    const currentVisibleEntityIds = input.currentVisibleEntityIds;
    if (currentVisibleEntityIds === undefined) {
      let entityCount = 0;
      for (let i = 0; i < input.dirtyIds.length; i++) {
        const id = input.dirtyIds[i];
        if (emittedIds.has(id)) continue;
        const changedFields = input.previousVisibleEntityIds.has(id) ? input.dirtyFields[i] : undefined;
        const slot = input.dirtySlots[i] ?? -1;
        if (
          changedFields !== undefined &&
          (tryAppendUnitSlabDeltaRowFromState(id, changedFields, entityViews, slot) ||
            tryAppendBuildingSlabDeltaRowFromState(id, changedFields, entityViews, slot))
        ) {
          emittedIds.add(id);
          entityCount++;
          continue;
        }
        const entity = resolveEntityFromSlotOrWorld(input.world, id, slot);
        if (!entity || !acceptsSerializedEntity(entity, input.visibility)) continue;
        if (!this.writeEntityRow(
          entityCount,
          entity,
          changedFields,
          input.world,
          input.visibility,
          changedFields !== undefined && canUseTypedDeltaPlaceholder(
            entity,
            changedFields,
            input.visibility,
          ),
        )) continue;
        emittedIds.add(id);
        entityCount++;
      }

      emittedIds.clear();
      return entityCount;
    }

    let entityCount = 0;
    const currentVisibleEntityIdList = input.currentVisibleEntityIdList;
    if (currentVisibleEntityIdList !== undefined) {
      const currentVisibleEntitySlots = input.currentVisibleEntitySlots;
      for (let i = 0; i < currentVisibleEntityIdList.length; i++) {
        const id = currentVisibleEntityIdList[i];
        if (input.previousVisibleEntityIds.has(id)) continue;
        this.visibleBaselineAddedIds.push(id);
        const entity = resolveEntityFromSlotOrWorld(
          input.world,
          id,
          currentVisibleEntitySlots !== undefined ? currentVisibleEntitySlots[i] : -1,
        );
        if (!entity || !isSerializableSnapshotEntity(entity)) continue;
        if (!this.writeEntityRow(entityCount, entity, undefined, input.world, input.visibility)) continue;
        emittedIds.add(id);
        entityCount++;
      }
    } else {
      for (const id of currentVisibleEntityIds) {
        if (input.previousVisibleEntityIds.has(id)) continue;
        this.visibleBaselineAddedIds.push(id);
        const entity = input.world.getEntity(id);
        if (!entity || !isSerializableSnapshotEntity(entity)) continue;
        if (!this.writeEntityRow(entityCount, entity, undefined, input.world, input.visibility)) continue;
        emittedIds.add(id);
        entityCount++;
      }
    }

    for (let i = 0; i < input.dirtyIds.length; i++) {
      const id = input.dirtyIds[i];
      if (emittedIds.has(id)) continue;
      if (!currentVisibleEntityIds.has(id)) continue;
      const slot = input.dirtySlots[i] ?? -1;
      if (
        tryAppendUnitSlabDeltaRowFromState(id, input.dirtyFields[i], entityViews, slot) ||
        tryAppendBuildingSlabDeltaRowFromState(id, input.dirtyFields[i], entityViews, slot)
      ) {
        emittedIds.add(id);
        entityCount++;
        continue;
      }
      const entity = resolveEntityFromSlotOrWorld(input.world, id, slot);
      if (!entity || !isSerializableSnapshotEntity(entity)) continue;
      if (!this.writeEntityRow(
        entityCount,
        entity,
        input.dirtyFields[i],
        input.world,
        input.visibility,
        canUseTypedDeltaPlaceholder(entity, input.dirtyFields[i], input.visibility),
      )) continue;
      emittedIds.add(id);
      entityCount++;
    }

    emittedIds.clear();
    return entityCount;
  }

  private writeRichDeltaRemovedIds(input: ServerSnapshotRichDeltaDirectWireInput): void {
    const removedIds = this.removedEntityIds;
    const removedIdSet = this.removedEntityIdSet;
    removedIds.length = 0;
    removedIdSet.clear();

    for (let i = 0; i < input.removedEntities.length; i++) {
      const record = input.removedEntities[i];
      if (!input.visibility.isFiltered || input.visibility.shouldSendRemoval(record)) {
        appendUnique(removedIds, removedIdSet, record.id);
      }
    }

    if (input.currentVisibleEntityIds !== undefined) {
      for (const id of input.previousVisibleEntityIds) {
        if (!input.currentVisibleEntityIds.has(id)) {
          appendUnique(removedIds, removedIdSet, id);
          this.visibleBaselineRemovedIds.push(id);
        }
      }
    }

    removedIdSet.clear();
  }

  private processRemovedEntities(
    records: readonly RemovedSnapshotEntity[],
    visibility: SnapshotVisibility,
  ): void {
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (!visibility.isFiltered || visibility.shouldSendRemoval(record)) {
        this.removedEntityIds.push(record.id);
      }
    }
  }
}
