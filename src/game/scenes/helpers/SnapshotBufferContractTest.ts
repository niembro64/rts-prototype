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

function assertContract(condition: boolean, message: string): void {
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

  buffer.clear();
  assertContract(!fake.hasSnapshotCallback(), 'clear must detach the snapshot callback');
  fake.emitSnapshot(createSnapshot(2, [12]));
  assertContract(
    buffer.consume() === null,
    'detached buffer must not accept snapshots after clear',
  );
}
