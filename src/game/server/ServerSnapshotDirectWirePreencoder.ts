import { SNAPSHOT_CONFIG } from '../../config';
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
  appendEntitySnapshotWireRowDirect,
  canAppendEntitySnapshotWireRowDirect,
  registerEntitySnapshotWireSource,
  resetEntitySnapshotPool,
} from '../network/stateSerializerEntities';
import {
  SNAPSHOT_DETAIL_THROTTLED_FIELDS,
  SNAPSHOT_DIRTY_SHIELDS,
  copyPrevState,
  copySentPrevState,
  getDeltaTrackingState,
  getEntityDeltaChangedFields,
  getNextEntityState,
  getPrevState,
  getRustEntityDeltaChangedFields,
  type DeltaTrackingState,
  type PrevEntityState,
} from '../network/stateSerializerEntityDelta';
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
import { encodeNetworkSnapshotWithRustFallback } from '../network/snapshotRustWireEncoder';
import type { NetworkServerSnapshotWire } from '../network/snapshotWireTypes';
import { spatialGrid } from '../sim/SpatialGrid';
import type { SprayTarget } from '../sim/commanderAbilities';
import type {
  ProjectileDespawnEvent,
  ProjectileSpawnEvent,
  ProjectileVelocityUpdateEvent,
  SimEvent,
} from '../sim/combat';
import { getSimWasm, type SimWasm } from '../sim-wasm/init';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import type { RemovedSnapshotEntity, WorldState } from '../sim/WorldState';

export type DirectSerializedListenerSnapshot = {
  state: NetworkServerSnapshot;
  wirePayload: SnapshotWirePayload;
};

export type ServerSnapshotDirectWireInput = {
  world: WorldState;
  trackingKey: string | number | undefined;
  snapshotBaselineHandle: number | undefined;
  dirtyEntityIds: readonly EntityId[] | undefined;
  dirtyEntityFields: readonly number[] | undefined;
  removedEntities: readonly RemovedSnapshotEntity[] | undefined;
  recipientPlayerId: PlayerId | undefined;
  visibility: SnapshotVisibility;
  isDelta: boolean;
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
  emitEntityDetailFields: boolean;
  emitProjectileDetailFields: boolean;
  audioOverride: SerializerAudioOverride | undefined;
  sprayOverride: SerializerSprayOverride | undefined;
  minimapOverride: SerializerMinimapOverride | undefined;
  terrain: TerrainTileMap | undefined;
  buildability: TerrainBuildabilityGrid | undefined;
  serverMeta: NetworkServerSnapshotMeta;
};

const _directGameState: NonNullable<NetworkServerSnapshot['gameState']> = {
  phase: 'battle',
  winnerId: undefined,
};

function acceptsSerializedEntity(
  entity: Entity,
  visibility: SnapshotVisibility,
): boolean {
  return (
    (entity.type === 'unit' || entity.type === 'building' || entity.type === 'tower') &&
    visibility.isEntityVisible(entity)
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
  private readonly visibilityHiddenIds: EntityId[] = [];
  private readonly deferredDetailEntityIds: EntityId[] = [];
  private readonly state: NetworkServerSnapshot = {
    tick: 0,
    entities: this.entityPlaceholders,
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
    isDelta: false,
    removedEntityIds: undefined,
    visibilityFiltered: undefined,
    visionPlayerMask: undefined,
  };

  tryEncode(input: ServerSnapshotDirectWireInput): DirectSerializedListenerSnapshot | undefined {
    const sim = getSimWasm();
    if (sim === undefined) return undefined;
    if (!this.canUseDirectEntityRows(input)) return undefined;

    const state = this.materializeWireState(input, sim);
    const encodeStart = performance.now();
    const encoded = encodeNetworkSnapshotWithRustFallback(state as NetworkServerSnapshotWire);
    if (encoded === null) return undefined;
    return {
      state,
      wirePayload: {
        bytes: encoded.bytes,
        encodeMs: performance.now() - encodeStart,
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

  private canUseDirectEntityRows(input: ServerSnapshotDirectWireInput): boolean {
    const visibility = input.visibility;
    const visibleEntityIds = visibility.getVisibleEntityIds();
    if (visibleEntityIds !== undefined) {
      for (let i = 0; i < visibleEntityIds.length; i++) {
        const entity = input.world.getEntity(visibleEntityIds[i]);
        if (!entity || !acceptsSerializedEntity(entity, visibility)) continue;
        if (!canAppendEntitySnapshotWireRowDirect(entity)) return false;
      }
      return true;
    }

    const sources: ReadonlyArray<readonly Entity[]> = [
      input.world.getUnits(),
      input.world.getBuildings(),
    ];
    for (let s = 0; s < sources.length; s++) {
      const source = sources[s];
      for (let i = 0; i < source.length; i++) {
        const entity = source[i];
        if (!acceptsSerializedEntity(entity, visibility)) continue;
        if (!canAppendEntitySnapshotWireRowDirect(entity)) return false;
      }
    }
    return true;
  }

  private materializeWireState(
    input: ServerSnapshotDirectWireInput,
    sim: SimWasm,
  ): NetworkServerSnapshot {
    const entityCount = this.writeEntityRows(input, sim);
    this.entityPlaceholders.length = entityCount;
    registerEntitySnapshotWireSource(this.entityPlaceholders);

    const netMinimapEntities = input.minimapOverride !== undefined
      ? input.minimapOverride.value
      : writeMinimapSnapshotWireRowsDirect(
          input.world,
          input.visibility,
          this.minimapPlaceholders,
        );
    const netEconomy = writeEconomySnapshotWireRowsDirect(
      input.world.playerCount,
      input.recipientPlayerId,
      this.economyPlaceholder,
    );
    const netResourceMovements = writeResourceMovementWireRowsDirect(
      input.world,
      input.visibility,
      this.resourceMovementPlaceholders,
    );
    const netSprayTargets = input.sprayOverride !== undefined
      ? input.sprayOverride.value
      : writeSprayTargetWireRowsDirect(
          input.sprayTargets,
          input.visibility,
          this.sprayPlaceholders,
        );
    const netAudioEvents = input.audioOverride !== undefined
      ? input.audioOverride.value
      : writeAudioEventWireRowsDirect(
          input.audioEvents,
          input.visibility,
          this.audioEventPlaceholders,
        );
    const netScanPulses = writeScanPulseWireRowsDirect(
      input.world,
      input.visibility,
      this.scanPulsePlaceholders,
    );
    const netProjectiles = writeProjectileSnapshotWireRowsDirect({
      world: input.world,
      deltaEnabled: input.isDelta && SNAPSHOT_CONFIG.deltaEnabled,
      visibility: input.visibility,
      emitBeamUpdates: input.emitProjectileDetailFields,
      projectileSpawns: input.projectileSpawns,
      projectileDespawns: input.projectileDespawns,
      projectileVelocityUpdates: input.projectileVelocityUpdates,
    });
    const netGrid = writeGridSnapshotWireRowsDirect(
      input.gridCells,
      input.gridSearchCells,
      input.gridCellSize,
      this.gridCellPlaceholders,
      this.gridSearchCellPlaceholders,
    );

    _directGameState.phase = input.gamePhase;
    _directGameState.winnerId = input.winnerId;

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
    state.isDelta = input.isDelta && SNAPSHOT_CONFIG.deltaEnabled;
    state.removedEntityIds = this.removedEntityIds.length > 0
      ? this.removedEntityIds
      : undefined;
    state.visibilityFiltered = input.visibility.isFiltered ? true : undefined;
    state.visionPlayerMask = input.visibility.hasRecipient
      ? input.visibility.getVisionPlayerMask()
      : undefined;
    return state;
  }

  private writeEntityRows(input: ServerSnapshotDirectWireInput, sim: SimWasm): number {
    resetEntitySnapshotPool();
    this.removedEntityIds.length = 0;
    const tracking = getDeltaTrackingState(input.trackingKey);
    const baselineHandle = input.snapshotBaselineHandle;
    const baselineSim = baselineHandle === undefined ? undefined : sim;
    const deltaEnabled = input.isDelta && SNAPSHOT_CONFIG.deltaEnabled;

    if (input.removedEntities !== undefined) {
      this.processRemovedEntities(
        input.removedEntities,
        tracking,
        input.visibility,
        baselineSim,
        baselineHandle,
      );
    }

    return deltaEnabled
      ? this.writeDeltaEntityRows(input, tracking, baselineSim, baselineHandle)
      : this.writeKeyframeEntityRows(input, tracking, baselineSim, baselineHandle);
  }

  private writeDeltaEntityRows(
    input: ServerSnapshotDirectWireInput,
    tracking: DeltaTrackingState,
    baselineSim: SimWasm | undefined,
    baselineHandle: number | undefined,
  ): number {
    let entityCount = 0;
    const visibility = input.visibility;

    if (visibility.isFiltered) {
      this.visibilityHiddenIds.length = 0;
      for (const id of tracking.prevEntityIds) {
        const entity = input.world.getEntity(id);
        if (!entity) continue;
        if (visibility.isEntityVisible(entity)) continue;
        this.visibilityHiddenIds.push(id);
      }
      for (let i = 0; i < this.visibilityHiddenIds.length; i++) {
        this.forgetTrackedEntity(
          tracking,
          this.visibilityHiddenIds[i],
          true,
          baselineSim,
          baselineHandle,
        );
      }
    }

    const dirtyIds = input.dirtyEntityIds ?? [];
    const dirtyFieldsList = input.dirtyEntityFields ?? [];
    for (let i = 0; i < dirtyIds.length; i++) {
      const entity = input.world.getEntity(dirtyIds[i]);
      if (!entity || !acceptsSerializedEntity(entity, visibility)) continue;
      const dirtyFields = dirtyFieldsList[i] ?? 0;
      const prev = getPrevState(tracking, entity.id);
      const isNew = !tracking.prevEntityIds.has(entity.id);
      const next = getNextEntityState(entity);
      const dirtyForcedFields = dirtyFields & SNAPSHOT_DIRTY_SHIELDS;
      const rustDeltaMask = !isNew && baselineHandle !== undefined
        ? getRustEntityDeltaChangedFields(entity, next, baselineHandle, input.world)
        : undefined;
      const rawDeltaMask = isNew
        ? 0
        : rustDeltaMask ?? getEntityDeltaChangedFields(entity, prev, next, input.world);
      let changedFields = isNew
        ? undefined
        : rawDeltaMask | dirtyForcedFields;
      if (changedFields !== undefined) {
        const pendingDetailFields = tracking.deferredDetailFields.get(entity.id) ?? 0;
        if (pendingDetailFields !== 0) changedFields |= pendingDetailFields;
        if (!input.emitEntityDetailFields) {
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
        tracking.prevEntityIds.add(entity.id);
        appendEntitySnapshotWireRowDirect(entity, changedFields, input.world, visibility);
        entityCount++;
        copySentPrevState(next, prev, changedFields);
        this.captureToRustBaseline(baselineSim, baselineHandle, entity, next, input.world.getTick(), changedFields);
      }
    }

    if (input.emitEntityDetailFields && tracking.deferredDetailFields.size > 0) {
      this.deferredDetailEntityIds.length = 0;
      for (const id of tracking.deferredDetailFields.keys()) {
        this.deferredDetailEntityIds.push(id);
      }
      for (let i = 0; i < this.deferredDetailEntityIds.length; i++) {
        const id = this.deferredDetailEntityIds[i];
        const pendingDetailFields = tracking.deferredDetailFields.get(id) ?? 0;
        if (pendingDetailFields === 0) {
          tracking.deferredDetailFields.delete(id);
          continue;
        }
        const entity = input.world.getEntity(id);
        if (!entity) {
          tracking.deferredDetailFields.delete(id);
          continue;
        }
        if (!acceptsSerializedEntity(entity, visibility)) continue;

        const prev = getPrevState(tracking, entity.id);
        const isNew = !tracking.prevEntityIds.has(entity.id);
        const next = getNextEntityState(entity);
        const rustDeltaMask = !isNew && baselineHandle !== undefined
          ? getRustEntityDeltaChangedFields(entity, next, baselineHandle, input.world)
          : undefined;
        const rawDeltaMask = isNew
          ? 0
          : rustDeltaMask ?? getEntityDeltaChangedFields(entity, prev, next, input.world);
        const changedFields = isNew
          ? undefined
          : rawDeltaMask | pendingDetailFields;
        if (isNew || changedFields! > 0) {
          tracking.prevEntityIds.add(entity.id);
          appendEntitySnapshotWireRowDirect(entity, changedFields, input.world, visibility);
          entityCount++;
          copySentPrevState(next, prev, changedFields);
          this.captureToRustBaseline(baselineSim, baselineHandle, entity, next, input.world.getTick(), changedFields);
        }
        tracking.deferredDetailFields.delete(id);
      }
      this.deferredDetailEntityIds.length = 0;
    }

    if (visibility.isFiltered) {
      const visibleEntityIds = visibility.getVisibleEntityIds();
      if (visibleEntityIds !== undefined) {
        for (let i = 0; i < visibleEntityIds.length; i++) {
          const entity = input.world.getEntity(visibleEntityIds[i]);
          if (!entity || tracking.prevEntityIds.has(entity.id)) continue;
          if (!acceptsSerializedEntity(entity, visibility)) continue;
          tracking.prevEntityIds.add(entity.id);
          const next = getNextEntityState(entity);
          appendEntitySnapshotWireRowDirect(entity, undefined, input.world, visibility);
          entityCount++;
          const prev = getPrevState(tracking, entity.id);
          copyPrevState(next, prev);
          this.captureToRustBaseline(baselineSim, baselineHandle, entity, next, input.world.getTick(), undefined);
        }
      } else {
        entityCount += this.writeVisibleNewEntitiesFromSources(
          input,
          tracking,
          baselineSim,
          baselineHandle,
        );
      }
    }

    return entityCount;
  }

  private writeVisibleNewEntitiesFromSources(
    input: ServerSnapshotDirectWireInput,
    tracking: DeltaTrackingState,
    baselineSim: SimWasm | undefined,
    baselineHandle: number | undefined,
  ): number {
    let entityCount = 0;
    const sources: ReadonlyArray<readonly Entity[]> = [
      input.world.getUnits(),
      input.world.getBuildings(),
    ];
    for (let s = 0; s < sources.length; s++) {
      const source = sources[s];
      for (let i = 0; i < source.length; i++) {
        const entity = source[i];
        if (tracking.prevEntityIds.has(entity.id)) continue;
        if (!acceptsSerializedEntity(entity, input.visibility)) continue;
        tracking.prevEntityIds.add(entity.id);
        const next = getNextEntityState(entity);
        appendEntitySnapshotWireRowDirect(entity, undefined, input.world, input.visibility);
        entityCount++;
        const prev = getPrevState(tracking, entity.id);
        copyPrevState(next, prev);
        this.captureToRustBaseline(baselineSim, baselineHandle, entity, next, input.world.getTick(), undefined);
      }
    }
    return entityCount;
  }

  private writeKeyframeEntityRows(
    input: ServerSnapshotDirectWireInput,
    tracking: DeltaTrackingState,
    baselineSim: SimWasm | undefined,
    baselineHandle: number | undefined,
  ): number {
    let entityCount = 0;
    tracking.currentEntityIds.clear();
    tracking.deferredDetailFields.clear();
    const visibleEntityIds = input.visibility.getVisibleEntityIds();
    if (visibleEntityIds !== undefined) {
      for (let i = 0; i < visibleEntityIds.length; i++) {
        const entity = input.world.getEntity(visibleEntityIds[i]);
        if (!entity || !acceptsSerializedEntity(entity, input.visibility)) continue;
        entityCount += this.writeKeyframeEntityRow(input, tracking, baselineSim, baselineHandle, entity);
      }
    } else {
      const sources: ReadonlyArray<readonly Entity[]> = [
        input.world.getUnits(),
        input.world.getBuildings(),
      ];
      for (let s = 0; s < sources.length; s++) {
        const source = sources[s];
        for (let i = 0; i < source.length; i++) {
          const entity = source[i];
          if (!acceptsSerializedEntity(entity, input.visibility)) continue;
          entityCount += this.writeKeyframeEntityRow(input, tracking, baselineSim, baselineHandle, entity);
        }
      }
    }

    tracking.prevEntityIds.clear();
    for (const id of tracking.currentEntityIds) {
      tracking.prevEntityIds.add(id);
    }
    for (const id of tracking.prevStates.keys()) {
      if (!tracking.currentEntityIds.has(id)) {
        tracking.prevStates.delete(id);
        if (baselineSim !== undefined && baselineHandle !== undefined) {
          const slot = spatialGrid.getSlot(id);
          if (slot >= 0) baselineSim.snapshotBaseline.unsetSlot(baselineHandle, slot);
        }
      }
    }
    return entityCount;
  }

  private writeKeyframeEntityRow(
    input: ServerSnapshotDirectWireInput,
    tracking: DeltaTrackingState,
    baselineSim: SimWasm | undefined,
    baselineHandle: number | undefined,
    entity: Entity,
  ): number {
    tracking.currentEntityIds.add(entity.id);
    appendEntitySnapshotWireRowDirect(entity, undefined, input.world, input.visibility);
    const prev = getPrevState(tracking, entity.id);
    const next = getNextEntityState(entity);
    copyPrevState(next, prev);
    this.captureToRustBaseline(baselineSim, baselineHandle, entity, next, input.world.getTick(), undefined);
    return 1;
  }

  private forgetTrackedEntity(
    tracking: DeltaTrackingState,
    id: EntityId,
    emitRemoval: boolean,
    baselineSim: SimWasm | undefined,
    baselineHandle: number | undefined,
  ): void {
    const wasVisible = tracking.prevEntityIds.delete(id);
    tracking.prevStates.delete(id);
    tracking.deferredDetailFields.delete(id);
    if (baselineSim !== undefined && baselineHandle !== undefined) {
      const slot = spatialGrid.getSlot(id);
      if (slot >= 0) baselineSim.snapshotBaseline.unsetSlot(baselineHandle, slot);
    }
    if (emitRemoval && wasVisible) this.removedEntityIds.push(id);
  }

  private processRemovedEntities(
    records: readonly RemovedSnapshotEntity[],
    tracking: DeltaTrackingState,
    visibility: SnapshotVisibility,
    baselineSim: SimWasm | undefined,
    baselineHandle: number | undefined,
  ): void {
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (visibility.shouldSendRemoval(record)) {
        this.forgetTrackedEntity(tracking, record.id, true, baselineSim, baselineHandle);
        continue;
      }
      if (!tracking.prevEntityIds.has(record.id)) continue;
      this.forgetTrackedEntity(tracking, record.id, true, baselineSim, baselineHandle);
    }
  }

  private captureToRustBaseline(
    sim: SimWasm | undefined,
    handle: number | undefined,
    entity: Entity,
    next: PrevEntityState,
    tick: number,
    changedFields: number | undefined,
  ): void {
    if (sim === undefined || handle === undefined) return;
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
      sim.snapshotBaseline.captureBuildingSlot(
        handle, slot, tick, baselineChangedFields,
        next.x, next.y, next.z, next.rotation,
        next.isEngagedBits, next.targetBits,
      );
    }
  }
}
