import { encode as msgpackEncode } from '@msgpack/msgpack';
import type { Command } from '../../sim/commands';
import type {
  GameConnection,
  GameOverCallback,
  SimEventCallback,
  SnapshotCallback,
} from '../../server/GameConnection';
import type { NetworkServerSnapshot } from '../../network/NetworkTypes';
import type { NetworkServerSnapshotEntity } from '../../network/NetworkTypes';
import { SnapshotBuffer } from './SnapshotBuffer';
import { ENTITY_CHANGED_POS } from '../../../types/network';
import { decodeNetworkSnapshot } from '../../network/snapshotWireCodec';
import {
  getPackedProjectileSnapshotWire,
  packProjectilesForWire,
} from '../../network/snapshotProjectileWirePack';
import {
  ENTITY_SNAPSHOT_WIRE_KIND_UNIT,
  ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE,
  getEntitySnapshotWireSource,
  registerEntitySnapshotWireSource,
  type EntitySnapshotWireSource,
} from '../../network/stateSerializerEntities';
import {
  createFloat64WireRows,
  createUint32WireRows,
  reserveFloat64WireRows,
} from '../../network/snapshotWireRows';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[snapshot buffer contract] ${message}`);
  }
}

type FakeConnectionHarness = {
  connection: GameConnection;
  emitSnapshot(state: NetworkServerSnapshot): void;
  hasSnapshotCallback(): boolean;
};

function createUnitEntity(
  id: number,
  x: number,
  changedFields: number | null,
): NetworkServerSnapshotEntity {
  return {
    id,
    type: 'unit',
    playerId: 1,
    changedFields,
    pos: { x, y: 0, z: 0 },
    rotation: changedFields === null ? 0 : null,
    unit: null,
    building: null,
  };
}

function createSparseDecodedMotionUnitEntity(id: number, x: number): NetworkServerSnapshotEntity {
  const entity = createUnitEntity(id, x, ENTITY_CHANGED_POS);
  entity.unit = {
    velocity: { x: 7, y: 0, z: 0 },
  } as NetworkServerSnapshotEntity['unit'];
  return entity;
}

function createEmptyEntityWireSource(): EntitySnapshotWireSource {
  return {
    kinds: [],
    rowIndices: [],
    basicRows: createFloat64WireRows(),
    unitRows: createFloat64WireRows(),
    buildingRows: createFloat64WireRows(),
    actionRows: createFloat64WireRows(),
    actionStrings: [],
    turretRows: createFloat64WireRows(),
    factorySelectedUnitRows: createUint32WireRows(),
    waypointRows: createFloat64WireRows(),
    waypointStrings: [],
  };
}

function attachTypedUnitMotionSource(
  entities: NetworkServerSnapshotEntity[],
  id: number,
  x: number,
  changedFields: number | null = ENTITY_CHANGED_POS,
): EntitySnapshotWireSource {
  const source = createEmptyEntityWireSource();
  const rowIndex = reserveFloat64WireRows(source.unitRows, 1, ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE);
  const base = rowIndex * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
  const values = source.unitRows.values;
  values[base + 0] = id;
  values[base + 1] = x;
  values[base + 2] = 0;
  values[base + 3] = 0;
  values[base + 4] = 0;
  values[base + 5] = 1;
  values[base + 6] = changedFields === null ? 0 : 1;
  values[base + 7] = changedFields ?? 0;
  source.kinds.push(ENTITY_SNAPSHOT_WIRE_KIND_UNIT);
  source.rowIndices.push(rowIndex);
  registerEntitySnapshotWireSource(entities, source);
  return source;
}

function createSnapshot(
  tick: number,
  despawnIds: readonly number[],
  entities: NetworkServerSnapshotEntity[] = [],
): NetworkServerSnapshot {
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
    projectiles: {
      spawns: undefined,
      despawns: despawnIds.map((id) => ({ id })),
      velocityUpdates: undefined,
      beamUpdates: undefined,
    },
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

function createFakeConnection(): FakeConnectionHarness {
  let snapshotCallback: SnapshotCallback | null = null;
  const connection: GameConnection = {
    sendCommand(_command: Command): void {},
    markClientReady(): void {},
    onSnapshot(callback: SnapshotCallback): () => void {
      snapshotCallback = callback;
      return () => {
        if (snapshotCallback === callback) snapshotCallback = null;
      };
    },
    clearSnapshotCallback(): void {
      snapshotCallback = null;
    },
    onSimEvent(_callback: SimEventCallback): void {},
    onGameOver(_callback: GameOverCallback): void {},
    disconnect(): void {
      snapshotCallback = null;
    },
  };
  return {
    connection,
    emitSnapshot(state: NetworkServerSnapshot): void {
      snapshotCallback?.(state);
    },
    hasSnapshotCallback(): boolean {
      return snapshotCallback !== null;
    },
  };
}

export function runSnapshotBufferContractTest(): void {
  const buffer = new SnapshotBuffer();
  const fake = createFakeConnection();
  buffer.attach(fake.connection);
  assertContract(fake.hasSnapshotCallback(), 'attach must install a snapshot callback');

  fake.emitSnapshot(createSnapshot(1, [10, 10, 11]));
  const diagnostics = buffer.getDiagnostics();
  assertContract(
    diagnostics.bufferedDespawns === 2,
    'despawn buffer must keep one entry per projectile id',
  );
  assertContract(
    diagnostics.coalescedDespawns === 1,
    'despawn diagnostics must count coalesced duplicate ids',
  );

  const consumed = buffer.consume();
  const despawns = consumed?.projectiles?.despawns ?? [];
  assertContract(consumed !== null, 'consume must return the pending snapshot');
  assertContract(despawns.length === 2, 'consume must emit coalesced despawns only');
  assertContract(despawns[0].id === 10, 'first despawn id must survive');
  assertContract(despawns[1].id === 11, 'second despawn id must survive');

  fake.emitSnapshot(createSnapshot(3, []));
  const delta = createSnapshot(4, [20]);
  delta.projectileDeltaOnly = true;
  fake.emitSnapshot(delta);
  const consumedWithDelta = buffer.consume();
  assertContract(
    consumedWithDelta?.tick === 3,
    'projectile delta must not replace a pending full snapshot',
  );
  assertContract(
    consumedWithDelta?.projectiles?.despawns?.some((despawn) => despawn.id === 20) === true,
    'projectile delta events must merge into the pending full snapshot',
  );

  fake.emitSnapshot(createSnapshot(5, [], [createUnitEntity(30, 100, null)]));
  const motionDelta = createSnapshot(6, [], [createUnitEntity(30, 250, ENTITY_CHANGED_POS)]);
  motionDelta.entityDeltaOnly = true;
  fake.emitSnapshot(motionDelta);
  const consumedWithMotionDelta = buffer.consume();
  assertContract(
    consumedWithMotionDelta?.tick === 5,
    'entity motion delta must not replace a pending full snapshot',
  );
  assertContract(
    consumedWithMotionDelta?.entities[0]?.changedFields === null,
    'entity motion delta must preserve the pending full entity row shape',
  );
  assertContract(
    consumedWithMotionDelta?.entities[0]?.pos?.x === 250,
    'entity motion delta must patch the pending full entity pose',
  );

  fake.emitSnapshot(createSnapshot(6, [], [createUnitEntity(40, 100, null)]));
  const visibilityDelta = createSnapshot(7, [], [createUnitEntity(41, 500, null)]);
  visibilityDelta.entityDeltaOnly = true;
  visibilityDelta.removedEntityIds = [40];
  fake.emitSnapshot(visibilityDelta);
  const consumedWithVisibilityDelta = buffer.consume();
  assertContract(
    consumedWithVisibilityDelta?.entities.some((entity) => entity.id === 41) === true,
    'entity delta full rows must append newly visible entities to pending full snapshots',
  );
  assertContract(
    consumedWithVisibilityDelta?.entities.some((entity) => entity.id === 40) === false,
    'entity delta removals must prune pending full snapshot rows',
  );

  const typedEntities = [createSparseDecodedMotionUnitEntity(50, 123)];
  const typedSnapshot = createSnapshot(8, [], typedEntities);
  const originalSource = attachTypedUnitMotionSource(typedEntities, 50, 123);
  fake.emitSnapshot(typedSnapshot);
  originalSource.unitRows.values[1] = 999;
  const consumedTypedClone = buffer.consume();
  assertContract(consumedTypedClone !== null, 'typed snapshot clone must be consumable');
  const clonedSource = getEntitySnapshotWireSource(consumedTypedClone.entities);
  assertContract(clonedSource !== undefined, 'typed entity wire source must survive snapshot clone');
  assertContract(clonedSource !== originalSource, 'typed entity wire source clone must not alias original source');
  const clonedRowIndex = clonedSource.rowIndices[0];
  assertContract(
    clonedSource.unitRows.values[clonedRowIndex * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE + 1] === 123,
    'typed entity wire rows must be copied before the server source buffer is reused',
  );

  fake.emitSnapshot(createSnapshot(9, [], [createSparseDecodedMotionUnitEntity(51, 77)]));
  const consumedUntypedClone = buffer.consume();
  assertContract(consumedUntypedClone !== null, 'untyped snapshot clone must be consumable');
  assertContract(
    getEntitySnapshotWireSource(consumedUntypedClone.entities) === undefined,
    'untyped snapshot clone must clear stale typed entity wire source metadata',
  );

  const typedFullEntities = [createUnitEntity(60, 100, null)];
  const typedFullSnapshot = createSnapshot(10, [], typedFullEntities);
  attachTypedUnitMotionSource(typedFullEntities, 60, 100, null);
  fake.emitSnapshot(typedFullSnapshot);
  const typedMotionDelta = createSnapshot(11, [], [createUnitEntity(60, 250, ENTITY_CHANGED_POS)]);
  typedMotionDelta.entityDeltaOnly = true;
  fake.emitSnapshot(typedMotionDelta);
  const consumedTypedMerge = buffer.consume();
  assertContract(
    consumedTypedMerge?.entities[0]?.pos?.x === 250,
    'typed pending snapshot must still receive merged entity motion deltas',
  );
  assertContract(
    consumedTypedMerge !== null &&
      getEntitySnapshotWireSource(consumedTypedMerge.entities) === undefined,
    'merged entity deltas must invalidate cloned typed entity wire source metadata',
  );

  const sparseMotionDelta = createSnapshot(7, [], [createSparseDecodedMotionUnitEntity(31, 300)]);
  sparseMotionDelta.entityDeltaOnly = true;
  fake.emitSnapshot(sparseMotionDelta);
  const consumedSparseMotionDelta = buffer.consume();
  assertContract(
    consumedSparseMotionDelta?.entityDeltaOnly === true,
    'entity motion delta must be consumable when no full snapshot is pending',
  );
  assertContract(
    consumedSparseMotionDelta?.entities[0]?.unit?.velocity?.x === 7,
    'sparse decoded unit motion fields must survive snapshot cloning',
  );

  const manyEntities: NetworkServerSnapshotEntity[] = [];
  for (let i = 0; i < 128; i++) {
    manyEntities.push(createUnitEntity(1000 + i, i, null));
  }
  fake.emitSnapshot(createSnapshot(8, [], manyEntities));
  const manyDeltas: NetworkServerSnapshotEntity[] = [];
  for (let i = 0; i < 40; i++) {
    manyDeltas.push(createUnitEntity(1000 + i, 5000 + i, ENTITY_CHANGED_POS));
  }
  manyDeltas.push(createUnitEntity(2000, 7000, null));
  const indexedMergeDelta = createSnapshot(9, [], manyDeltas);
  indexedMergeDelta.entityDeltaOnly = true;
  indexedMergeDelta.removedEntityIds = [];
  for (let i = 0; i < 40; i++) indexedMergeDelta.removedEntityIds.push(1080 + i);
  fake.emitSnapshot(indexedMergeDelta);
  const consumedIndexedMerge = buffer.consume();
  assertContract(
    consumedIndexedMerge?.entities.find((entity) => entity.id === 1005)?.pos?.x === 5005,
    'indexed entity delta merge must patch existing pending rows',
  );
  assertContract(
    consumedIndexedMerge?.entities.some((entity) => entity.id === 2000 && entity.pos?.x === 7000) === true,
    'indexed entity delta merge must append newly visible full rows',
  );
  assertContract(
    consumedIndexedMerge?.entities.some((entity) => entity.id === 1090) === false,
    'indexed entity delta merge must prune removed pending rows',
  );

  const packedProjectileDelta = createSnapshot(10, [60, 60, 61]);
  packedProjectileDelta.projectileDeltaOnly = true;
  packedProjectileDelta.projectiles!.velocityUpdates = [{
    id: 70,
    pos: { x: 100, y: 200, z: 300 },
    velocity: { x: 10, y: 20, z: 30 },
    targetEntityId: 88,
    clearHomingTarget: null,
  }];
  const packedProjectiles = packProjectilesForWire(packedProjectileDelta.projectiles);
  assertContract(packedProjectiles !== undefined, 'packed projectile delta fixture must pack');
  const decodedPackedDelta = decodeNetworkSnapshot(
    msgpackEncode({
      ...packedProjectileDelta,
      projectiles: packedProjectiles,
    }, { ignoreUndefined: true }),
    { packedProjectileDeltas: 'metadata-only' },
  );
  assertContract(
    decodedPackedDelta.projectiles?.despawns === undefined &&
      decodedPackedDelta.projectiles?.velocityUpdates === undefined,
    'metadata-only decode must skip projectile despawn and velocity DTO arrays',
  );
  assertContract(
    getPackedProjectileSnapshotWire(decodedPackedDelta.projectiles) !== undefined,
    'metadata-only decode must retain packed projectile metadata',
  );
  fake.emitSnapshot(decodedPackedDelta);
  const consumedPackedDelta = buffer.consume();
  const packedDespawns = consumedPackedDelta?.projectiles?.despawns ?? [];
  const packedVelocityUpdates = consumedPackedDelta?.projectiles?.velocityUpdates ?? [];
  assertContract(
    packedDespawns.length === 2 &&
      packedDespawns.some((despawn) => despawn.id === 60) &&
      packedDespawns.some((despawn) => despawn.id === 61),
    'snapshot buffer must coalesce packed metadata-only despawns',
  );
  assertContract(
    packedVelocityUpdates.length === 1 &&
      packedVelocityUpdates[0].id === 70 &&
      packedVelocityUpdates[0].pos.x === 100 &&
      packedVelocityUpdates[0].velocity.z === 30 &&
      packedVelocityUpdates[0].targetEntityId === 88,
    'snapshot buffer must materialize packed metadata-only velocity updates on consume',
  );

  buffer.clear();
  assertContract(!fake.hasSnapshotCallback(), 'clear must detach the snapshot callback');
  fake.emitSnapshot(createSnapshot(2, [12]));
  assertContract(
    buffer.consume() === null,
    'detached buffer must not accept snapshots after clear',
  );
}
