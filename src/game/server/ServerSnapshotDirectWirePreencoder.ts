import type { GamePhase } from '../../types/network';
import type { TerrainBuildabilityGrid, TerrainTileMap } from '../../types/terrain';
import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotGridCell,
  NetworkServerSnapshotMeta,
} from '../network/NetworkTypes';
import type { SnapshotWirePayload } from '../network/SnapshotWirePayload';
import { writeAudioEventWireRowsDirect } from '../network/stateSerializerAudio';
import { writeEconomySnapshotWireRowsDirect } from '../network/stateSerializerEconomy';
import {
  appendBasicEntityWireRowDirectFromState,
  appendBuildingHotEntityWireRowDirectFromState,
  appendEntitySnapshotWireRowDirect,
  appendUnitMotionEntityWireRowDirectFromState,
  canUseTypedDeltaPlaceholder,
  entityPrivateSnapshotRequiresDto,
  registerEntitySnapshotWireSource,
  resetEntitySnapshotPool,
  serializeEntitySnapshot,
} from '../network/stateSerializerEntities';
import { writeGridSnapshotWireRowsDirect } from '../network/stateSerializerGrid';
import { writeMinimapSnapshotWireRowsDirect } from '../network/stateSerializerMinimap';
import { writeProjectileSnapshotWireRowsDirect } from '../network/stateSerializerProjectiles';
import { writeResourceMovementWireRowsDirect } from '../network/stateSerializerResourceMovements';
import { writeSprayTargetWireRowsDirect } from '../network/stateSerializerSpray';
import {
  writeScanPulseWireRowsDirect,
  type SnapshotVisibility,
} from '../network/stateSerializerVisibility';
import type {
  SerializerAudioOverride,
  SerializerMinimapOverride,
  SerializerSprayOverride,
} from '../network/stateSerializer';
import {
  encodeNetworkSnapshotWithRustFallback,
  isRustSnapshotWireEnabled,
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
  ProjectileVelocityUpdateEvent,
  SimEvent,
} from '../sim/combat';
import { getSimWasm } from '../sim-wasm/init';
import { entitySlotRegistry } from '../sim/EntitySlotRegistry';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import type { RemovedSnapshotEntity, WorldState } from '../sim/WorldState';
import {
  ENTITY_BASIC_TRANSFORM_DELTA_FIELDS,
  ENTITY_MOTION_DELTA_FIELDS,
  ENTITY_UNIT_SLAB_DELTA_FIELDS,
  shouldDeferToSparseEntityMotionDelta,
} from './snapshotMotionDeltaPolicy';

const ENABLE_DIRECT_RUST_SNAPSHOT_WIRE = isRustSnapshotWireEnabled();

type DirectSerializedListenerSnapshot = {
  state: NetworkServerSnapshot;
  wirePayload: SnapshotWirePayload;
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
  projectileVelocityUpdates: ProjectileVelocityUpdateEvent[] | undefined;
  gridCells: NetworkServerSnapshotGridCell[] | undefined;
  gridSearchCells: NetworkServerSnapshotGridCell[] | undefined;
  gridCellSize: number | undefined;
  emitProjectileDetailFields: boolean;
  audioOverride: SerializerAudioOverride | undefined;
  sprayOverride: SerializerSprayOverride | undefined;
  minimapOverride: SerializerMinimapOverride | undefined;
  terrain: TerrainTileMap | undefined;
  buildability: TerrainBuildabilityGrid | undefined;
  serverMeta: NetworkServerSnapshotMeta;
  materializationStages: SnapshotMaterializationStageDurations | undefined;
};

type ServerSnapshotSparseDeltaDirectWireInput = {
  world: WorldState;
  visibility: SnapshotVisibility;
  motionCandidateIds: readonly EntityId[];
  audioEvents: SimEvent[] | undefined;
  projectileSpawns: ProjectileSpawnEvent[] | undefined;
  projectileDespawns: ProjectileDespawnEvent[] | undefined;
  projectileVelocityUpdates: ProjectileVelocityUpdateEvent[] | undefined;
  materializationStages: SnapshotMaterializationStageDurations | undefined;
};

type ServerSnapshotRichDeltaDirectWireInput = {
  world: WorldState;
  removedEntities: readonly RemovedSnapshotEntity[];
  recipientPlayerId: PlayerId | undefined;
  visibility: SnapshotVisibility;
  previousVisibleEntityIds: ReadonlySet<EntityId>;
  currentVisibleEntityIds: ReadonlySet<EntityId> | undefined;
  currentVisibleEntityIdList: readonly EntityId[] | undefined;
  dirtyIds: readonly EntityId[];
  dirtyFields: readonly number[];
  dirtySlots: readonly number[];
  gamePhase: GamePhase;
  winnerId: PlayerId | undefined;
  sprayTargets: SprayTarget[] | undefined;
  audioEvents: SimEvent[] | undefined;
  projectileSpawns: ProjectileSpawnEvent[] | undefined;
  projectileDespawns: ProjectileDespawnEvent[] | undefined;
  projectileVelocityUpdates: ProjectileVelocityUpdateEvent[] | undefined;
  gridCells: NetworkServerSnapshotGridCell[] | undefined;
  gridSearchCells: NetworkServerSnapshotGridCell[] | undefined;
  gridCellSize: number | undefined;
  audioOverride: SerializerAudioOverride | undefined;
  sprayOverride: SerializerSprayOverride | undefined;
  minimapOverride: SerializerMinimapOverride | undefined;
  serverMeta: NetworkServerSnapshotMeta;
  materializationStages: SnapshotMaterializationStageDurations | undefined;
};

const _directGameState: NonNullable<NetworkServerSnapshot['gameState']> = {
  phase: 'battle',
  winnerId: undefined,
};

function acceptsSerializedEntity(
  entity: Entity,
  visibility: SnapshotVisibility,
): boolean {
  return isSerializedEntityKind(entity) &&
    (!visibility.isFiltered || visibility.isEntityVisible(entity));
}

function isSerializedEntityKind(entity: Entity): boolean {
  return (
    entity.type === 'unit' ||
    entity.type === 'building' ||
    entity.type === 'tower'
  );
}

export class ServerSnapshotDirectWirePreencoder {
  private readonly entityPlaceholders: NetworkServerSnapshot['entities'] = [];
  private readonly minimapPlaceholders: NonNullable<NetworkServerSnapshot['minimapEntities']> = [];
  private readonly sprayPlaceholders: NonNullable<NetworkServerSnapshot['sprayTargets']> = [];
  private readonly scanPulsePlaceholders: NonNullable<NetworkServerSnapshot['scanPulses']> = [];
  private readonly resourceMovementPlaceholders: NonNullable<NetworkServerSnapshot['resourceMovements']> = [];
  private readonly audioEventPlaceholders: NonNullable<NetworkServerSnapshot['audioEvents']> = [];
  private readonly gridCellPlaceholders: NetworkServerSnapshotGridCell[] = [];
  private readonly gridSearchCellPlaceholders: NetworkServerSnapshotGridCell[] = [];
  private readonly economyPlaceholder = {} as NetworkServerSnapshot['economy'];
  private readonly removedEntityIds: number[] = [];
  private readonly removedEntityIdSet = new IndexedEntityIdSet();
  private readonly emittedDeltaEntityIds = new IndexedEntityIdSet();
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
    shroud: undefined,
    projectiles: undefined,
    grid: undefined,
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

  tryEncode(input: ServerSnapshotDirectWireInput): DirectSerializedListenerSnapshot | undefined {
    if (!ENABLE_DIRECT_RUST_SNAPSHOT_WIRE) return undefined;
    if (getSimWasm() === undefined) return undefined;

    const state = this.materializeWireState(input);
    let stageStart = performance.now();
    const encoded = encodeNetworkSnapshotWithRustFallback(state as NetworkServerSnapshotWire);
    const encodeMs = performance.now() - stageStart;
    if (input.materializationStages !== undefined) {
      addSnapshotMaterializationStageFromStart(
        input.materializationStages,
        'wireEncode',
        stageStart,
      );
    }
    if (encoded === null) return undefined;
    return {
      state,
      wirePayload: {
        bytes: encoded.bytes,
        encodeMs,
        encoderKind: 'rust',
        materializationKind: 'direct',
        rustEntityCount: encoded.rustEntityCount,
        rawEntityCount: encoded.rawEntityCount,
        rawTopLevelKeys: encoded.rawTopLevelKeys.length > 0
          ? [...encoded.rawTopLevelKeys]
          : undefined,
      },
    };
  }

  tryEncodeSparseDelta(
    input: ServerSnapshotSparseDeltaDirectWireInput,
  ): DirectSerializedListenerSnapshot | undefined {
    if (!ENABLE_DIRECT_RUST_SNAPSHOT_WIRE) return undefined;
    if (getSimWasm() === undefined) return undefined;

    const state = this.materializeSparseDeltaWireState(input);
    if (state === undefined) return undefined;

    const stageStart = performance.now();
    const encoded = encodeNetworkSnapshotWithRustFallback(state as NetworkServerSnapshotWire);
    const encodeMs = performance.now() - stageStart;
    if (input.materializationStages !== undefined) {
      addSnapshotMaterializationStageFromStart(
        input.materializationStages,
        'wireEncode',
        stageStart,
      );
    }
    if (encoded === null) return undefined;
    return {
      state,
      wirePayload: {
        bytes: encoded.bytes,
        encodeMs,
        encoderKind: 'rust',
        materializationKind: 'direct',
        rustEntityCount: encoded.rustEntityCount,
        rawEntityCount: encoded.rawEntityCount,
        rawTopLevelKeys: encoded.rawTopLevelKeys.length > 0
          ? [...encoded.rawTopLevelKeys]
          : undefined,
      },
    };
  }

  tryEncodeRichDelta(
    input: ServerSnapshotRichDeltaDirectWireInput,
  ): DirectSerializedListenerSnapshot | undefined {
    if (!ENABLE_DIRECT_RUST_SNAPSHOT_WIRE) return undefined;
    if (getSimWasm() === undefined) return undefined;

    this.visibleBaselineAddedIds.length = 0;
    this.visibleBaselineRemovedIds.length = 0;
    const state = this.materializeRichDeltaWireState(input);
    if (state === undefined) return undefined;

    const stageStart = performance.now();
    const encoded = encodeNetworkSnapshotWithRustFallback(state as NetworkServerSnapshotWire);
    const encodeMs = performance.now() - stageStart;
    if (input.materializationStages !== undefined) {
      addSnapshotMaterializationStageFromStart(
        input.materializationStages,
        'wireEncode',
        stageStart,
      );
    }
    if (encoded === null) return undefined;
    const includeVisibleBaselineDeltas = input.currentVisibleEntityIds !== undefined;
    return {
      state,
      wirePayload: {
        bytes: encoded.bytes,
        encodeMs,
        encoderKind: 'rust',
        materializationKind: 'direct',
        rustEntityCount: encoded.rustEntityCount,
        rawEntityCount: encoded.rawEntityCount,
        rawTopLevelKeys: encoded.rawTopLevelKeys.length > 0
          ? [...encoded.rawTopLevelKeys]
          : undefined,
      },
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

    let netMinimapEntities: NetworkServerSnapshot['minimapEntities'];
    if (input.minimapOverride !== undefined) {
      netMinimapEntities = input.minimapOverride.value;
    } else {
      stageStart = performance.now();
      netMinimapEntities = writeMinimapSnapshotWireRowsDirect(
        input.world,
        input.visibility,
        this.minimapPlaceholders,
      );
      if (stages !== undefined) {
        addSnapshotMaterializationStageFromStart(stages, 'minimap', stageStart);
      }
    }
    stageStart = performance.now();
    const netEconomy = writeEconomySnapshotWireRowsDirect(
      input.world.playerCount,
      input.recipientPlayerId,
      this.economyPlaceholder,
    );
    if (stages !== undefined) {
      addSnapshotMaterializationStageFromStart(stages, 'economy', stageStart);
    }
    stageStart = performance.now();
    const netResourceMovements = writeResourceMovementWireRowsDirect(
      input.world,
      input.visibility,
      this.resourceMovementPlaceholders,
    );
    if (stages !== undefined) {
      addSnapshotMaterializationStageFromStart(stages, 'resources', stageStart);
    }
    let netSprayTargets: NetworkServerSnapshot['sprayTargets'];
    if (input.sprayOverride !== undefined) {
      netSprayTargets = input.sprayOverride.value;
    } else {
      stageStart = performance.now();
      netSprayTargets = writeSprayTargetWireRowsDirect(
        input.sprayTargets,
        input.visibility,
        this.sprayPlaceholders,
      );
      if (stages !== undefined) {
        addSnapshotMaterializationStageFromStart(stages, 'spray', stageStart);
      }
    }
    let netAudioEvents: NetworkServerSnapshot['audioEvents'];
    if (input.audioOverride !== undefined) {
      netAudioEvents = input.audioOverride.value;
    } else {
      stageStart = performance.now();
      netAudioEvents = writeAudioEventWireRowsDirect(
        input.audioEvents,
        input.visibility,
        this.audioEventPlaceholders,
      );
      if (stages !== undefined) {
        addSnapshotMaterializationStageFromStart(stages, 'audio', stageStart);
      }
    }
    stageStart = performance.now();
    const netScanPulses = writeScanPulseWireRowsDirect(
      input.world,
      input.visibility,
      this.scanPulsePlaceholders,
    );
    if (stages !== undefined) {
      addSnapshotMaterializationStageFromStart(stages, 'scanPulses', stageStart);
    }
    stageStart = performance.now();
    const netProjectiles = writeProjectileSnapshotWireRowsDirect({
      world: input.world,
      fullStateResync: true,
      visibility: input.visibility,
      emitBeamUpdates: input.emitProjectileDetailFields,
      projectileSpawns: input.projectileSpawns,
      projectileDespawns: input.projectileDespawns,
      projectileVelocityUpdates: input.projectileVelocityUpdates,
    });
    if (stages !== undefined) {
      addSnapshotMaterializationStageFromStart(stages, 'projectiles', stageStart);
    }
    stageStart = performance.now();
    const netGrid = writeGridSnapshotWireRowsDirect(
      input.gridCells,
      input.gridSearchCells,
      input.gridCellSize,
      this.gridCellPlaceholders,
      this.gridSearchCellPlaceholders,
    );
    if (stages !== undefined) {
      addSnapshotMaterializationStageFromStart(stages, 'grid', stageStart);
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
    state.minimapEntities = netMinimapEntities;
    state.economy = netEconomy;
    state.resourceMovements = netResourceMovements;
    state.sprayTargets = netSprayTargets;
    state.audioEvents = netAudioEvents;
    state.scanPulses = netScanPulses;
    state.shroud = undefined;
    state.projectiles = netProjectiles;
    state.grid = netGrid;
    state.serverMeta = input.serverMeta;
    state.terrain = input.terrain;
    state.buildability = input.buildability;
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

  private materializeSparseDeltaWireState(
    input: ServerSnapshotSparseDeltaDirectWireInput,
  ): NetworkServerSnapshot | undefined {
    const stages = input.materializationStages;
    let stageStart = performance.now();
    const entityCount = this.writeSparseEntityMotionRows(input);
    if (entityCount < 0) return undefined;
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
      projectileVelocityUpdates: input.projectileVelocityUpdates,
    });
    if (stages !== undefined) {
      addSnapshotMaterializationStageFromStart(stages, 'projectiles', stageStart);
    }

    stageStart = performance.now();
    const netAudioEvents = writeAudioEventWireRowsDirect(
      input.audioEvents,
      input.visibility,
      this.audioEventPlaceholders,
    );
    if (stages !== undefined) {
      addSnapshotMaterializationStageFromStart(stages, 'audio', stageStart);
    }

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
    state.shroud = undefined;
    state.projectiles = netProjectiles;
    state.grid = undefined;
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

    let netMinimapEntities: NetworkServerSnapshot['minimapEntities'];
    if (input.minimapOverride !== undefined) {
      netMinimapEntities = input.minimapOverride.value;
    } else {
      stageStart = performance.now();
      netMinimapEntities = writeMinimapSnapshotWireRowsDirect(
        input.world,
        input.visibility,
        this.minimapPlaceholders,
      );
      if (stages !== undefined) {
        addSnapshotMaterializationStageFromStart(stages, 'minimap', stageStart);
      }
    }

    stageStart = performance.now();
    const netEconomy = writeEconomySnapshotWireRowsDirect(
      input.world.playerCount,
      input.recipientPlayerId,
      this.economyPlaceholder,
    );
    if (stages !== undefined) {
      addSnapshotMaterializationStageFromStart(stages, 'economy', stageStart);
    }

    stageStart = performance.now();
    const netResourceMovements = writeResourceMovementWireRowsDirect(
      input.world,
      input.visibility,
      this.resourceMovementPlaceholders,
    );
    if (stages !== undefined) {
      addSnapshotMaterializationStageFromStart(stages, 'resources', stageStart);
    }

    let netSprayTargets: NetworkServerSnapshot['sprayTargets'];
    if (input.sprayOverride !== undefined) {
      netSprayTargets = input.sprayOverride.value;
    } else {
      stageStart = performance.now();
      netSprayTargets = writeSprayTargetWireRowsDirect(
        input.sprayTargets,
        input.visibility,
        this.sprayPlaceholders,
      );
      if (stages !== undefined) {
        addSnapshotMaterializationStageFromStart(stages, 'spray', stageStart);
      }
    }

    let netAudioEvents: NetworkServerSnapshot['audioEvents'];
    if (input.audioOverride !== undefined) {
      netAudioEvents = input.audioOverride.value;
    } else {
      stageStart = performance.now();
      netAudioEvents = writeAudioEventWireRowsDirect(
        input.audioEvents,
        input.visibility,
        this.audioEventPlaceholders,
      );
      if (stages !== undefined) {
        addSnapshotMaterializationStageFromStart(stages, 'audio', stageStart);
      }
    }

    stageStart = performance.now();
    const netScanPulses = writeScanPulseWireRowsDirect(
      input.world,
      input.visibility,
      this.scanPulsePlaceholders,
    );
    if (stages !== undefined) {
      addSnapshotMaterializationStageFromStart(stages, 'scanPulses', stageStart);
    }

    const hasLiveLineProjectiles = input.world.getLineProjectiles().length > 0;
    const hasProjectileEvents =
      hasLiveLineProjectiles ||
      (
        input.projectileSpawns !== undefined &&
        input.projectileDespawns !== undefined &&
        input.projectileVelocityUpdates !== undefined &&
        (
          input.projectileSpawns.length > 0 ||
          input.projectileDespawns.length > 0 ||
          input.projectileVelocityUpdates.length > 0
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
            projectileVelocityUpdates: input.projectileVelocityUpdates,
          });
          if (stages !== undefined) {
            addSnapshotMaterializationStageFromStart(stages, 'projectiles', stageStart);
          }
          return rows;
        })()
      : undefined;

    stageStart = performance.now();
    const netGrid = writeGridSnapshotWireRowsDirect(
      input.gridCells,
      input.gridSearchCells,
      input.gridCellSize,
      this.gridCellPlaceholders,
      this.gridSearchCellPlaceholders,
    );
    if (stages !== undefined) {
      addSnapshotMaterializationStageFromStart(stages, 'grid', stageStart);
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
    state.entityDeltaOnly = true;
    state.projectileDeltaOnly = undefined;
    state.minimapEntities = netMinimapEntities;
    state.economy = netEconomy;
    state.resourceMovements = netResourceMovements;
    state.sprayTargets = netSprayTargets;
    state.audioEvents = netAudioEvents;
    state.scanPulses = netScanPulses;
    state.shroud = undefined;
    state.projectiles = netProjectiles;
    state.grid = netGrid;
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
      let entityCount = 0;
      for (let i = 0; i < visibleEntityIds.length; i++) {
        const entity = input.world.getEntity(visibleEntityIds[i]);
        if (!entity || !isSerializedEntityKind(entity)) continue;
        if (!this.writeEntityRow(entityCount, entity, undefined, input.world, input.visibility)) continue;
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
        entityCount++;
      }
    }
    return entityCount;
  }

  private writeSparseEntityMotionRows(
    input: ServerSnapshotSparseDeltaDirectWireInput,
  ): number {
    resetEntitySnapshotPool();
    let entityCount = 0;
    const ids = input.motionCandidateIds;
    const visibleEntityIds = input.visibility.getVisibleEntityIdSet();
    const entityViews = entitySlotRegistry.getViews();
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (visibleEntityIds !== undefined && !visibleEntityIds.has(id)) continue;
      if (this.tryAppendUnitSlabDeltaRowFromState(id, ENTITY_MOTION_DELTA_FIELDS, entityViews)) {
        entityCount++;
        continue;
      }
      const entity = input.world.getEntity(id);
      if (!entity || !acceptsSerializedEntity(entity, input.visibility)) continue;
      if (!this.writeEntityRow(
        entityCount,
        entity,
        ENTITY_MOTION_DELTA_FIELDS,
        input.world,
        input.visibility,
        canUseTypedDeltaPlaceholder(entity, ENTITY_MOTION_DELTA_FIELDS),
      )) continue;
      entityCount++;
    }
    return entityCount;
  }

  private tryAppendUnitSlabDeltaRowFromState(
    id: EntityId,
    changedFields: number,
    entityViews = entitySlotRegistry.getViews(),
    slot = -1,
  ): boolean {
    if (changedFields === 0 || (changedFields & ~ENTITY_UNIT_SLAB_DELTA_FIELDS) !== 0) {
      return false;
    }
    if (entityViews === null) return false;
    let resolvedSlot = slot;
    if (
      resolvedSlot < 0 ||
      resolvedSlot >= entityViews.capacity ||
      entityViews.entityId[resolvedSlot] !== id
    ) {
      resolvedSlot = entitySlotRegistry.getSlot(id);
    }
    if (
      resolvedSlot < 0 ||
      resolvedSlot >= entityViews.capacity ||
      entityViews.entityId[resolvedSlot] !== id
    ) {
      return false;
    }
    return appendUnitMotionEntityWireRowDirectFromState(entityViews, resolvedSlot, changedFields);
  }

  private tryAppendBuildingSlabDeltaRowFromState(
    id: EntityId,
    changedFields: number,
    entityViews = entitySlotRegistry.getViews(),
    slot = -1,
  ): boolean {
    if (entityViews === null) return false;
    let resolvedSlot = slot;
    if (
      resolvedSlot < 0 ||
      resolvedSlot >= entityViews.capacity ||
      entityViews.entityId[resolvedSlot] !== id
    ) {
      resolvedSlot = entitySlotRegistry.getSlot(id);
    }
    if (
      resolvedSlot < 0 ||
      resolvedSlot >= entityViews.capacity ||
      entityViews.entityId[resolvedSlot] !== id
    ) {
      return false;
    }
    if ((changedFields & ~ENTITY_BASIC_TRANSFORM_DELTA_FIELDS) === 0) {
      return appendBasicEntityWireRowDirectFromState(entityViews, resolvedSlot, changedFields);
    }
    return appendBuildingHotEntityWireRowDirectFromState(entityViews, resolvedSlot, changedFields);
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
          this.shouldDeferDirtyEntityToSparseMotion(input.world, id, changedFields)
        ) {
          continue;
        }
        if (
          changedFields !== undefined &&
          (this.tryAppendUnitSlabDeltaRowFromState(id, changedFields, entityViews, slot) ||
            this.tryAppendBuildingSlabDeltaRowFromState(id, changedFields, entityViews, slot))
        ) {
          emittedIds.add(id);
          entityCount++;
          continue;
        }
        const entity = input.world.getEntity(id);
        if (!entity || !acceptsSerializedEntity(entity, input.visibility)) continue;
        if (!this.writeEntityRow(
          entityCount,
          entity,
          changedFields,
          input.world,
          input.visibility,
          changedFields !== undefined && canUseTypedDeltaPlaceholder(entity, changedFields),
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
      for (let i = 0; i < currentVisibleEntityIdList.length; i++) {
        const id = currentVisibleEntityIdList[i];
        if (input.previousVisibleEntityIds.has(id)) continue;
        this.visibleBaselineAddedIds.push(id);
        const entity = input.world.getEntity(id);
        if (!entity || !isSerializedEntityKind(entity)) continue;
        if (!this.writeEntityRow(entityCount, entity, undefined, input.world, input.visibility)) continue;
        emittedIds.add(id);
        entityCount++;
      }
    } else {
      for (const id of currentVisibleEntityIds) {
        if (input.previousVisibleEntityIds.has(id)) continue;
        this.visibleBaselineAddedIds.push(id);
        const entity = input.world.getEntity(id);
        if (!entity || !isSerializedEntityKind(entity)) continue;
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
      if (this.shouldDeferDirtyEntityToSparseMotion(input.world, id, input.dirtyFields[i])) continue;
      if (
        this.tryAppendUnitSlabDeltaRowFromState(id, input.dirtyFields[i], entityViews, slot) ||
        this.tryAppendBuildingSlabDeltaRowFromState(id, input.dirtyFields[i], entityViews, slot)
      ) {
        emittedIds.add(id);
        entityCount++;
        continue;
      }
      const entity = input.world.getEntity(id);
      if (!entity || !isSerializedEntityKind(entity)) continue;
      if (!this.writeEntityRow(
        entityCount,
        entity,
        input.dirtyFields[i],
        input.world,
        input.visibility,
        canUseTypedDeltaPlaceholder(entity, input.dirtyFields[i]),
      )) continue;
      emittedIds.add(id);
      entityCount++;
    }

    emittedIds.clear();
    return entityCount;
  }

  private shouldDeferDirtyEntityToSparseMotion(
    world: WorldState,
    id: EntityId,
    changedFields: number,
  ): boolean {
    const entity = world.getEntity(id);
    return entity !== undefined && shouldDeferToSparseEntityMotionDelta(entity, changedFields);
  }

  private writeRichDeltaRemovedIds(input: ServerSnapshotRichDeltaDirectWireInput): void {
    const removedIds = this.removedEntityIds;
    const removedIdSet = this.removedEntityIdSet;
    removedIds.length = 0;
    removedIdSet.clear();

    const pushRemoved = (id: EntityId): void => {
      if (removedIdSet.has(id)) return;
      removedIdSet.add(id);
      removedIds.push(id);
    };

    for (let i = 0; i < input.removedEntities.length; i++) {
      const record = input.removedEntities[i];
      if (!input.visibility.isFiltered || input.visibility.shouldSendRemoval(record)) {
        pushRemoved(record.id);
      }
    }

    if (input.currentVisibleEntityIds !== undefined) {
      for (const id of input.previousVisibleEntityIds) {
        if (!input.currentVisibleEntityIds.has(id)) {
          pushRemoved(id);
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
