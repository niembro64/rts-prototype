import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotEntity,
} from '../network/NetworkTypes';
import { NetworkSnapshotTransport } from '../network/NetworkSnapshotTransport';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[snapshot lifecycle contract] ${message}`);
  }
}

function createEntity(id: number): NetworkServerSnapshotEntity {
  return {
    id,
    type: 'unit',
    pos: { x: id, y: id * 2, z: 0 },
    rotation: 0,
    playerId: 1,
    changedFields: null,
    unit: null,
    building: null,
  };
}

function createSnapshot(entityCount: number): NetworkServerSnapshot {
  const entities: NetworkServerSnapshotEntity[] = [];
  for (let i = 0; i < entityCount; i++) {
    entities.push(createEntity(1000 + i));
  }
  return {
    tick: 1,
    entities,
    minimapEntities: undefined,
    economy: {},
    resourceMovements: undefined,
    sprayTargets: undefined,
    audioEvents: undefined,
    scanPulses: undefined,
    shroud: undefined,
    projectiles: {
      spawns: undefined,
      despawns: [{ id: 4001 }, { id: 4002 }],
      velocityUpdates: undefined,
      beamUpdates: undefined,
    },
    gameState: undefined,
    serverMeta: undefined,
    grid: undefined,
    terrain: undefined,
    buildability: undefined,
    isDelta: false,
    visibilityFiltered: undefined,
    visionPlayerMask: undefined,
    removedEntityIds: [3001, 3002],
  };
}

function assertRetainedGraphCleared(
  counts: ReturnType<NetworkSnapshotTransport['getPendingCloneRetainedCounts']>,
  label: string,
): void {
  assertContract(counts.entities === 0, `${label} retained entities must be released`);
  assertContract(
    counts.projectileDespawns === 0,
    `${label} retained projectile despawns must be released`,
  );
  assertContract(
    counts.removedEntityIds === 0,
    `${label} retained removed ids must be released`,
  );
}

function runTransportResetClearsPendingClone(): void {
  const transport = new NetworkSnapshotTransport();
  transport.storePendingState(createSnapshot(3));
  const retainedBeforeReset = transport.getPendingCloneRetainedCounts();
  assertContract(
    retainedBeforeReset.entities === 3,
    'transport setup must retain cloned entities before reset',
  );
  assertContract(
    retainedBeforeReset.projectileDespawns === 2,
    'transport setup must retain cloned projectile despawns before reset',
  );
  transport.reset();
  assertRetainedGraphCleared(
    transport.getPendingCloneRetainedCounts(),
    'NetworkSnapshotTransport.reset()',
  );
}

export function runSnapshotLifecycleContractTest(): void {
  runTransportResetClearsPendingClone();
}
