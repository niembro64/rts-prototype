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
import type { NetworkServerSnapshotWire } from '../network/snapshotWireTypes';
import type { SprayTarget } from '../sim/commanderAbilities';
import type {
  ProjectileDespawnEvent,
  ProjectileSpawnEvent,
  ProjectileVelocityUpdateEvent,
  SimEvent,
} from '../sim/combat';
import { getSimWasm } from '../sim-wasm/init';
import type { Entity, PlayerId } from '../sim/types';
import type { RemovedSnapshotEntity, WorldState } from '../sim/WorldState';

const ENABLE_DIRECT_RUST_SNAPSHOT_WIRE = isRustSnapshotWireEnabled();

type DirectSerializedListenerSnapshot = {
  state: NetworkServerSnapshot;
  wirePayload: SnapshotWirePayload;
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
    removedEntityIds: undefined,
    visibilityFiltered: undefined,
    visionPlayerMask: undefined,
  };

  tryEncode(input: ServerSnapshotDirectWireInput): DirectSerializedListenerSnapshot | undefined {
    if (!ENABLE_DIRECT_RUST_SNAPSHOT_WIRE) return undefined;
    if (getSimWasm() === undefined) return undefined;
    if (!this.canUseDirectEntityRows(input)) return undefined;

    const state = this.materializeWireState(input);
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

  private materializeWireState(input: ServerSnapshotDirectWireInput): NetworkServerSnapshot {
    const entityCount = this.writeEntityRows(input);
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
      fullStateResync: true,
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
        if (!entity || !acceptsSerializedEntity(entity, input.visibility)) continue;
        appendEntitySnapshotWireRowDirect(entity, undefined, input.world, input.visibility);
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
        appendEntitySnapshotWireRowDirect(entity, undefined, input.world, input.visibility);
        entityCount++;
      }
    }
    return entityCount;
  }

  private processRemovedEntities(
    records: readonly RemovedSnapshotEntity[],
    visibility: SnapshotVisibility,
  ): void {
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (visibility.shouldSendRemoval(record)) {
        this.removedEntityIds.push(record.id);
      }
    }
  }
}
