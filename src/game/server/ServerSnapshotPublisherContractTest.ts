import {
  ENTITY_CHANGED_NORMAL,
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_ROT,
  ENTITY_CHANGED_VEL,
} from '../../types/network';
import type { NetworkServerSnapshot } from '../network/NetworkTypes';
import { ClientViewState } from '../network/ClientViewState';
import {
  ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE,
  getEntitySnapshotWireSource,
  resetEntitySnapshotPool,
  serializeEntitySnapshot,
} from '../network/stateSerializerEntities';
import { IndexedEntityIdSet } from '../network/IndexedEntityIdCollections';
import { entitySlotRegistry } from '../sim/EntitySlotRegistry';
import type { Simulation } from '../sim/Simulation';
import type { PlayerId } from '../sim/types';
import { WorldState } from '../sim/WorldState';
import { ServerSnapshotPublisher, type SnapshotListenerEntry } from './ServerSnapshotPublisher';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[server snapshot publisher contract] ${message}`);
  }
}

function snapshot(tick: number, entities: NetworkServerSnapshot['entities']): NetworkServerSnapshot {
  return {
    tick,
    entities,
    entityDeltaOnly: undefined,
    projectileDeltaOnly: undefined,
    minimapEntities: undefined,
    economy: {},
    resourceMovements: undefined,
    sprayTargets: undefined,
    audioEvents: undefined,
    scanPulses: undefined,
    shroud: undefined,
    projectiles: undefined,
    gameState: undefined,
    serverMeta: undefined,
    grid: undefined,
    terrain: undefined,
    buildability: undefined,
    visibilityFiltered: undefined,
    visionPlayerMask: undefined,
    removedEntityIds: undefined,
  };
}

function createQuietSimulation(): Simulation {
  return {
    hasPendingProjectilePresentationEvents: () => false,
    getAndClearEvents: () => undefined,
    getAndClearProjectileSpawns: () => undefined,
    getAndClearProjectileDespawns: () => undefined,
    getAndClearProjectileVelocityUpdates: () => undefined,
  } as unknown as Simulation;
}

export function runServerSnapshotPublisherContractTest(): void {
  entitySlotRegistry.clear();
  const world = new WorldState(9902, 512, 512);
  world.playerCount = 2;
  const unit = world.createUnitFromBlueprint(120, 140, 1 as PlayerId, 'unitEagle');
  world.addEntity(unit);
  assertContract(unit.unit !== null, 'fixture unit must have a unit component');
  assertContract(unit.unit.locomotion.type === 'flying', 'fixture unit must be flying');

  resetEntitySnapshotPool();
  const fullEntity = serializeEntitySnapshot(unit, undefined, world);
  assertContract(fullEntity !== null && fullEntity !== undefined, 'fixture full entity must serialize');
  const client = new ClientViewState();
  client.applyNetworkState(snapshot(1, [fullEntity]));
  client.applyPrediction(16);
  client.consumeRenderDirties();

  unit.transform.x = 220;
  unit.transform.rotation = 0.75;
  unit.unit.velocityX = 12;
  unit.unit.velocityY = 4;
  world.refreshEntitySlotState(
    unit,
    ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT | ENTITY_CHANGED_VEL | ENTITY_CHANGED_NORMAL,
  );

  const capturedSnapshot: { value: NetworkServerSnapshot | null } = { value: null };
  const listener: SnapshotListenerEntry = {
    callback: (state) => {
      capturedSnapshot.value = state;
    },
    playerId: undefined,
    trackingKey: 'contract',
    cacheKey: 'contract',
    preencodeWire: false,
    lastStaticTerrainTileMap: undefined,
    lastStaticBuildabilityGrid: undefined,
    needsFullState: false,
    needsStatic: false,
    startupReady: true,
    hasVisibleEntityBaseline: false,
    visibleEntityIds: new IndexedEntityIdSet(),
  };
  const publisher = new ServerSnapshotPublisher();
  const emitted = publisher.emitProjectileDelta(
    {
      world,
      simulation: createQuietSimulation(),
      debugGridPublisher: {} as never,
      listeners: [listener],
      terrainTileMap: undefined as never,
      terrainBuildabilityGrid: undefined as never,
      tpsAvg: 30,
      tpsLow: 30,
      tickRateHz: 30,
      maxSnapshotsDisplay: 30,
      ipAddress: '127.0.0.1',
      backgroundMode: false,
      backgroundAllowedUnitBlueprintIds: new Set<string>(),
      tickMsAvg: 0,
      tickMsHi: 0,
      tickMsInitialized: true,
    },
    true,
  );

  assertContract(emitted, 'publisher must emit a sparse entity-motion delta');
  const captured = capturedSnapshot.value;
  assertContract(captured !== null, 'listener must receive the sparse delta');
  assertContract(captured.entityDeltaOnly === true, 'motion-only output must be an entity delta');
  assertContract(captured.entities.length === 1, 'motion-only output must contain one placeholder row');
  assertContract(captured.entities[0] === undefined, 'slab-backed motion delta must avoid DTO materialization');
  const source = getEntitySnapshotWireSource(captured.entities);
  assertContract(source !== undefined && source.count === 1, 'slab-backed motion delta must expose typed wire metadata');
  assertContract(
    source.unitRows.values[source.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE] === unit.id,
    'typed sparse motion row must identify the moving unit',
  );

  client.applyNetworkState(captured);
  for (let i = 0; i < 10; i++) client.applyPrediction(100);
  const clientEntity = client.getEntity(unit.id);
  assertContract(
    clientEntity !== undefined &&
      clientEntity.transform.x > 120,
    'client must apply slab-backed sparse motion deltas without DTO fallback',
  );
}
