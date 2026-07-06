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
import { createProjectileConfigFromTurret } from '../sim/projectileConfigs';
import type { Simulation } from '../sim/Simulation';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import { getTurretConfig } from '../sim/turretConfigs';
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

function createQuietSimulation(movingUnits: readonly Entity[] = []): Simulation {
  const movingUnitSlots = movingUnits.map((entity) => entitySlotRegistry.getEntitySlot(entity));
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
    getMovingUnits: () => movingUnits,
    getMovingUnitSlots: () => movingUnitSlots,
  } as unknown as Simulation;
}

function createPublisherInput(
  world: WorldState,
  listener: SnapshotListenerEntry,
  movingUnits: readonly Entity[] = [],
) {
  return {
    world,
    simulation: createQuietSimulation(movingUnits),
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

function createListener(
  callback: SnapshotListenerEntry['callback'],
  visibleIds: readonly EntityId[] = [],
  preencodeWire = false,
): SnapshotListenerEntry {
  const visibleEntityIds = new IndexedEntityIdSet();
  for (let i = 0; i < visibleIds.length; i++) visibleEntityIds.add(visibleIds[i]);
  return {
    callback,
    playerId: undefined,
    trackingKey: 'contract',
    cacheKey: 'contract',
    preencodeWire,
    lastStaticTerrainTileMap: undefined,
    lastStaticBuildabilityGrid: undefined,
    needsFullState: false,
    needsStatic: false,
    startupReady: true,
    hasVisibleEntityBaseline: visibleIds.length > 0,
    visibleEntityIds,
  };
}

function assertReflectedBeamUpdate(
  state: NetworkServerSnapshot,
  beamId: EntityId,
  reflectorId: EntityId,
  messagePrefix: string,
): void {
  const updates = state.projectiles?.beamUpdates;
  assertContract(
    updates !== undefined && updates.length === 1,
    `${messagePrefix} must emit one beam update`,
  );
  const update = updates[0];
  assertContract(update.id === beamId, `${messagePrefix} beam update must identify the live beam`);
  assertContract(update.points.length === 3, `${messagePrefix} must preserve reflected beam vertices`);
  assertContract(
    update.points[1].reflectorEntityId === reflectorId &&
      update.points[1].reflectorKind === 'shield' &&
      update.points[1].reflectorPlayerId === 2,
    `${messagePrefix} must preserve reflector metadata`,
  );
  assertContract(
    update.points[2].x === 240 &&
      update.points[2].y === 130 &&
      update.points[2].z === 14,
    `${messagePrefix} must preserve the current beam endpoint`,
  );
}

export function runServerSnapshotPublisherContractTest(): void {
  entitySlotRegistry.clear();
  const startupWorld = new WorldState(9901, 512, 512);
  startupWorld.playerCount = 2;
  const startupBuilder = startupWorld.createUnitFromBlueprint(96, 112, 1 as PlayerId, 'unitConstructionDrone');
  const startupFighter = startupWorld.createUnitFromBlueprint(160, 176, 1 as PlayerId, 'unitEagle');
  assertContract(startupBuilder.builder !== null, 'startup builder fixture must have builder state');
  startupBuilder.builder.lowPriority = true;
  startupWorld.addEntity(startupBuilder);
  startupWorld.addEntity(startupFighter);
  const capturedStartup: {
    state: NetworkServerSnapshot | null;
    wirePayloadKind: string | undefined;
  } = { state: null, wirePayloadKind: undefined };
  const startupListener = createListener((state, _releaseSnapshot, wirePayload) => {
    capturedStartup.state = state;
    capturedStartup.wirePayloadKind = wirePayload?.materializationKind;
  }, [], true);
  new ServerSnapshotPublisher().emit(createPublisherInput(startupWorld, startupListener));
  const startupSnapshot = capturedStartup.state;
  assertContract(startupSnapshot !== null, 'preencoded startup snapshot must be emitted');
  const startupSource = getEntitySnapshotWireSource(startupSnapshot.entities);
  assertContract(
    startupSource !== undefined &&
      startupSource.count === startupSnapshot.entities.length &&
      startupSource.rawEntityRows <= 1 &&
      startupSource.typedEntityRows === startupSnapshot.entities.length - startupSource.rawEntityRows &&
      startupSource.typedEntityRows >= 1,
    'preencoded startup snapshot must align compact typed rows with any private DTO fallback rows',
  );
  assertContract(
    capturedStartup.wirePayloadKind === undefined || capturedStartup.wirePayloadKind === 'direct',
    'preencoded startup snapshot must not crash or fall back to malformed mixed entity metadata',
  );

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

  const capturedDeferredRichSnapshot: { value: NetworkServerSnapshot | null } = { value: null };
  listener.callback = (state) => {
    capturedDeferredRichSnapshot.value = state;
  };

  unit.transform.x = 260;
  unit.transform.rotation = 1.1;
  unit.unit.velocityX = 18;
  unit.unit.velocityY = 3;
  world.refreshEntitySlotState(
    unit,
    ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT | ENTITY_CHANGED_VEL | ENTITY_CHANGED_NORMAL,
  );

  const deferredRichEmitted = publisher.emitLockstepPresentation(
    createPublisherInput(world, listener),
  );
  assertContract(deferredRichEmitted, 'publisher must still emit rich deltas with only deferred motion rows');
  const deferredRich = capturedDeferredRichSnapshot.value;
  assertContract(deferredRich !== null, 'listener must receive deferred-motion rich delta');
  assertContract(deferredRich.entityDeltaOnly === true, 'deferred-motion rich output must remain an entity delta envelope');
  assertContract(
    deferredRich.entities.length === 0,
    'rich dirty output must defer motion-only flying rows to the sparse motion channel',
  );

  const capturedDeferredSparseSnapshot: { value: NetworkServerSnapshot | null } = { value: null };
  listener.callback = (state) => {
    capturedDeferredSparseSnapshot.value = state;
  };
  const deferredSparseEmitted = publisher.emitProjectileDelta(
    createPublisherInput(world, listener),
    true,
  );
  assertContract(deferredSparseEmitted, 'publisher must emit sparse motion after rich defers motion-only rows');
  const deferredSparse = capturedDeferredSparseSnapshot.value;
  assertContract(deferredSparse !== null, 'listener must receive sparse motion after rich deferral');
  assertContract(deferredSparse.entityDeltaOnly === true, 'deferred sparse motion output must be an entity delta');
  assertContract(deferredSparse.entities.length === 1, 'deferred sparse motion output must contain one row');
  assertContract(
    deferredSparse.entities[0] === undefined,
    'deferred sparse motion row must stay DTO-free',
  );
  const deferredSparseSource = getEntitySnapshotWireSource(deferredSparse.entities);
  assertContract(
    deferredSparseSource !== undefined &&
      deferredSparseSource.count === 1 &&
      deferredSparseSource.unitRows.values[
        deferredSparseSource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE
      ] === unit.id,
    'sparse motion channel must carry the row deferred by rich presentation',
  );
  client.applyNetworkState(deferredSparse);
  for (let i = 0; i < 10; i++) client.applyPrediction(100);
  assertContract(
    (client.getEntity(unit.id)?.transform.x ?? 0) > 220,
    'client must apply sparse motion after rich presentation defers the row',
  );

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

  entitySlotRegistry.clear();
  const groundWorld = new WorldState(9903, 512, 512);
  groundWorld.playerCount = 2;
  const groundUnit = groundWorld.createUnitFromBlueprint(80, 90, 1 as PlayerId, 'unitJackal');
  groundWorld.addEntity(groundUnit);
  assertContract(groundUnit.unit !== null, 'ground fixture unit must have a unit component');
  assertContract(groundUnit.unit.locomotion.type !== 'flying', 'ground fixture unit must not be flying');

  resetEntitySnapshotPool();
  const groundFullEntity = serializeEntitySnapshot(groundUnit, undefined, groundWorld);
  assertContract(groundFullEntity !== null && groundFullEntity !== undefined, 'ground fixture must serialize');
  const groundClient = new ClientViewState();
  groundClient.applyNetworkState(snapshot(1, [groundFullEntity]));
  groundClient.applyPrediction(16);
  groundClient.consumeRenderDirties();

  const groundDrainIds: number[] = [];
  const groundDrainFields: number[] = [];
  groundWorld.drainSnapshotDirtyEntities(groundDrainIds, groundDrainFields);
  const groundPublisher = new ServerSnapshotPublisher();

  const capturedGroundMovingSparse: { value: NetworkServerSnapshot | null } = { value: null };
  let groundListener = createListener(
    (state) => {
      capturedGroundMovingSparse.value = state;
    },
    [groundUnit.id],
  );

  groundUnit.transform.x = 150;
  groundUnit.transform.rotation = 0.45;
  groundUnit.unit.velocityX = 7;
  groundUnit.unit.velocityY = 2;
  groundWorld.refreshEntitySlotState(
    groundUnit,
    ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT | ENTITY_CHANGED_VEL | ENTITY_CHANGED_NORMAL,
  );

  const movingGroundSparseEmitted = groundPublisher.emitProjectileDelta(
    createPublisherInput(groundWorld, groundListener, [groundUnit]),
    true,
  );
  assertContract(movingGroundSparseEmitted, 'publisher must emit sparse motion for moving ground units');
  const movingGroundSparse = capturedGroundMovingSparse.value;
  assertContract(movingGroundSparse !== null, 'listener must receive moving ground sparse motion');
  const movingGroundSparseSource = getEntitySnapshotWireSource(movingGroundSparse.entities);
  assertContract(
    movingGroundSparseSource !== undefined &&
      movingGroundSparseSource.count === 1 &&
      movingGroundSparseSource.unitRows.values[
        movingGroundSparseSource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE
      ] === groundUnit.id,
    'moving ground sparse motion must use the typed unit row path',
  );

  groundWorld.drainSnapshotDirtyEntities(groundDrainIds, groundDrainFields);
  const capturedGroundDeferredRich: { value: NetworkServerSnapshot | null } = { value: null };
  groundListener = createListener(
    (state) => {
      capturedGroundDeferredRich.value = state;
    },
    [groundUnit.id],
  );

  groundUnit.transform.x = 210;
  groundUnit.transform.rotation = 0.9;
  groundUnit.unit.velocityX = 9;
  groundUnit.unit.velocityY = 1;
  groundWorld.refreshEntitySlotState(
    groundUnit,
    ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT | ENTITY_CHANGED_VEL | ENTITY_CHANGED_NORMAL,
  );

  const groundRichEmitted = groundPublisher.emitLockstepPresentation(
    createPublisherInput(groundWorld, groundListener),
  );
  assertContract(groundRichEmitted, 'publisher must emit a rich envelope for deferred ground motion');
  const groundDeferredRich = capturedGroundDeferredRich.value;
  assertContract(groundDeferredRich !== null, 'listener must receive deferred ground rich envelope');
  assertContract(
    groundDeferredRich.entities.length === 0,
    'rich dirty output must defer motion-only ground rows to the sparse motion channel',
  );
  groundUnit.unit.velocityX = 0;
  groundUnit.unit.velocityY = 0;

  const capturedGroundDeferredSparse: { value: NetworkServerSnapshot | null } = { value: null };
  groundListener.callback = (state) => {
    capturedGroundDeferredSparse.value = state;
  };
  const groundDeferredSparseEmitted = groundPublisher.emitProjectileDelta(
    createPublisherInput(groundWorld, groundListener),
    true,
  );
  assertContract(
    groundDeferredSparseEmitted,
    'publisher must emit pending deferred ground motion without a moving-unit source',
  );
  const groundDeferredSparse = capturedGroundDeferredSparse.value;
  assertContract(groundDeferredSparse !== null, 'listener must receive pending deferred ground sparse motion');
  const groundDeferredSparseSource = getEntitySnapshotWireSource(groundDeferredSparse.entities);
  assertContract(
    groundDeferredSparseSource !== undefined &&
      groundDeferredSparseSource.count === 1 &&
      groundDeferredSparseSource.unitRows.values[
        groundDeferredSparseSource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE
      ] === groundUnit.id,
    'pending deferred ground sparse motion must stay typed and DTO-free',
  );
  groundClient.applyNetworkState(groundDeferredSparse);
  for (let i = 0; i < 10; i++) groundClient.applyPrediction(100);
  assertContract(
    (groundClient.getEntity(groundUnit.id)?.transform.x ?? 0) > 180,
    'client must apply pending deferred ground sparse motion',
  );

  entitySlotRegistry.clear();
  const beamWorld = new WorldState(9904, 512, 512);
  beamWorld.playerCount = 2;
  const beamSource = beamWorld.createUnitFromBlueprint(40, 50, 1 as PlayerId, 'unitJackal');
  const reflector = beamWorld.createUnitFromBlueprint(170, 90, 2 as PlayerId, 'unitJackal');
  beamWorld.addEntity(beamSource);
  beamWorld.addEntity(reflector);
  const beamConfig = createProjectileConfigFromTurret(getTurretConfig('turretBeam'));
  const beam = beamWorld.createBeam(
    40,
    50,
    14,
    240,
    130,
    1 as PlayerId,
    beamSource.id,
    beamConfig,
    'beam',
  );
  beamWorld.addEntity(beam);
  assertContract(
    beam.projectile !== null && beam.projectile.points !== null,
    'fixture beam must have editable beam points',
  );
  const points = beam.projectile.points;
  points.length = 0;
  points.push(
    {
      x: 40,
      y: 50,
      z: 14,
      vx: 0,
      vy: 0,
      vz: 0,
      reflectorEntityId: null,
      reflectorKind: null,
      reflectorPlayerId: null,
      normalX: null,
      normalY: null,
      normalZ: null,
    },
    {
      x: 170,
      y: 90,
      z: 14,
      vx: 3,
      vy: 2,
      vz: 0,
      reflectorEntityId: reflector.id,
      reflectorKind: 'shield',
      reflectorPlayerId: 2 as PlayerId,
      normalX: -1,
      normalY: 0,
      normalZ: 0,
    },
    {
      x: 240,
      y: 130,
      z: 14,
      vx: 3,
      vy: 2,
      vz: 0,
      reflectorEntityId: null,
      reflectorKind: null,
      reflectorPlayerId: null,
      normalX: null,
      normalY: null,
      normalZ: null,
    },
  );

  const beamDrainIds: number[] = [];
  const beamDrainFields: number[] = [];
  beamWorld.drainSnapshotDirtyEntities(beamDrainIds, beamDrainFields);

  const beamPublisher = new ServerSnapshotPublisher();
  const capturedBeamSparse: { value: NetworkServerSnapshot | null } = { value: null };
  const beamSparseListener = createListener((state) => {
    capturedBeamSparse.value = state;
  });
  const beamSparseEmitted = beamPublisher.emitProjectileDelta(
    createPublisherInput(beamWorld, beamSparseListener),
    false,
  );
  assertContract(
    beamSparseEmitted,
    'publisher must emit sparse projectile deltas for live beams without pending projectile events',
  );
  const beamSparse = capturedBeamSparse.value;
  assertContract(beamSparse !== null, 'listener must receive live-beam sparse delta');
  assertContract(
    beamSparse.projectileDeltaOnly === true,
    'live-beam sparse delta without entity rows must be projectile-only',
  );
  assertReflectedBeamUpdate(
    beamSparse,
    beam.id,
    reflector.id,
    'live-beam sparse delta',
  );

  const capturedBeamRich: { value: NetworkServerSnapshot | null } = { value: null };
  const beamRichListener = createListener((state) => {
    capturedBeamRich.value = state;
  }, [beam.id]);
  const beamRichEmitted = beamPublisher.emitLockstepPresentation(
    createPublisherInput(beamWorld, beamRichListener),
  );
  assertContract(
    beamRichEmitted,
    'publisher must include live beam paths in rich deltas without pending projectile events',
  );
  const beamRich = capturedBeamRich.value;
  assertContract(beamRich !== null, 'listener must receive live-beam rich delta');
  assertReflectedBeamUpdate(
    beamRich,
    beam.id,
    reflector.id,
    'live-beam rich delta',
  );
}
