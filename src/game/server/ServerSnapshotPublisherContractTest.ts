import {
  ENTITY_CHANGED_HP,
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
    getAndClearEvents: () => [],
    getAndClearProjectileSpawns: () => [],
    getAndClearProjectileDespawns: () => [],
    getAndClearProjectileVelocityUpdates: () => [],
    getGamePhase: () => 'battle',
    getWinnerId: () => null,
    getSprayTargets: () => [],
    getWindState: () => ({ x: 0, y: 0, z: 0, speed: 0, angle: 0 }),
  } as unknown as Simulation;
}

function createPublisherInput(world: WorldState, listener: SnapshotListenerEntry) {
  return {
    world,
    simulation: createQuietSimulation(),
    debugGridPublisher: {
      isEnabled: () => false,
      refresh: () => ({
        cells: undefined,
        searchCells: undefined,
        cellSize: undefined,
      }),
    } as never,
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
  };
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
    createPublisherInput(world, listener),
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

  const drainIds: number[] = [];
  const drainFields: number[] = [];
  world.drainSnapshotDirtyEntities(drainIds, drainFields);
  listener.visibleEntityIds.clear();
  listener.visibleEntityIds.add(unit.id);
  listener.hasVisibleEntityBaseline = true;
  const capturedRichSnapshot: { value: NetworkServerSnapshot | null } = { value: null };
  listener.callback = (state) => {
    capturedRichSnapshot.value = state;
  };

  unit.unit.hp = 55;
  world.markSnapshotDirty(unit.id, ENTITY_CHANGED_HP);
  const richEmitted = publisher.emitLockstepPresentation(
    createPublisherInput(world, listener),
  );

  assertContract(richEmitted, 'publisher must emit a rich dirty presentation delta');
  const richCaptured = capturedRichSnapshot.value;
  assertContract(richCaptured !== null, 'listener must receive the rich dirty delta');
  assertContract(richCaptured.entityDeltaOnly === true, 'rich dirty output must be an entity delta');
  assertContract(richCaptured.entities.length === 1, 'rich dirty output must contain one entity row');
  assertContract(
    richCaptured.entities[0] === undefined,
    'slab-backed rich unit HP delta must avoid DTO materialization',
  );
  const richSource = getEntitySnapshotWireSource(richCaptured.entities);
  assertContract(
    richSource !== undefined && richSource.count === 1,
    'slab-backed rich unit HP delta must expose typed wire metadata',
  );
  const richUnitBase = richSource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
  assertContract(
    richSource.unitRows.values[richUnitBase + 0] === unit.id &&
      richSource.unitRows.values[richUnitBase + 7] === ENTITY_CHANGED_HP &&
      richSource.unitRows.values[richUnitBase + 8] === 55,
    'typed rich unit HP row must come from canonical slab hot fields',
  );

  client.applyNetworkState(richCaptured);
  assertContract(
    client.getEntity(unit.id)?.unit?.hp === 55,
    'client must apply slab-backed rich unit HP deltas without DTO fallback',
  );
}
