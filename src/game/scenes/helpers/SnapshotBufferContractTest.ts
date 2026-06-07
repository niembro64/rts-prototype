import type { Command } from '../../sim/commands';
import type {
  GameConnection,
  GameOverCallback,
  SimEventCallback,
  SnapshotCallback,
} from '../../server/GameConnection';
import type { NetworkServerSnapshot } from '../../network/NetworkTypes';
import { SnapshotBuffer } from './SnapshotBuffer';

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

function createSnapshot(tick: number, despawnIds: readonly number[]): NetworkServerSnapshot {
  return {
    tick,
    entities: [],
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
    isDelta: true,
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

  buffer.clear();
  assertContract(!fake.hasSnapshotCallback(), 'clear must detach the snapshot callback');
  fake.emitSnapshot(createSnapshot(2, [12]));
  assertContract(
    buffer.consume() === null,
    'detached buffer must not accept snapshots after clear',
  );
}
