import {
  buildCanonicalMatchInitialization,
  hashCanonicalMatchInitialization,
} from '../game/architecture/CanonicalMatchInitialization';
import type { NetworkServerSnapshot } from '../game/network/NetworkTypes';
import type { PlayerId } from '../game/sim/types';
import {
  createDeterministicLockstepBackend,
  type RealBattleStartupTerrain,
} from './gameCanvasRealBattleStartup';

function assertContract(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[deterministic lockstep backend contract] ${message}`);
  }
}

export async function runDeterministicLockstepBackendContractTest(): Promise<void> {
  assertInitializationHashMismatch();
  const terrain = createTerrain();
  const backend = await createDeterministicLockstepBackend({
    playerIds: [1 as PlayerId, 2 as PlayerId],
    aiPlayerIds: undefined,
    terrain,
    networkRole: null,
    localPlayerId: 1 as PlayerId,
    localIpAddress: 'contract',
    onLoadingProgress: undefined,
  });

  try {
    assertContract(backend.architecture === 'deterministic-lockstep', 'backend must be deterministic-lockstep');
    assertContract(backend.server !== null, 'lockstep backend must create a local server');
    const initialDiagnostics = backend.getDiagnostics();
    assertContract(
      initialDiagnostics.snapshotTruth === 'command-frame-stream-local-presentation',
      'lockstep diagnostics must report command-frame truth',
    );

    const snapshots: NetworkServerSnapshot[] = [];
    const unsubscribe = backend.gameConnection.onSnapshot((snapshot) => {
      snapshots.push(snapshot);
    });
    try {
      backend.start();
      backend.gameConnection.markClientReady();
      await waitMs(140);
      assertContract(snapshots.length > 0, 'lockstep backend must generate local render snapshots');
      assertContract(
        backend.getDiagnostics().lockstep?.nextFrame !== undefined &&
          backend.getDiagnostics().lockstep!.nextFrame > 0,
        'lockstep scheduler must advance local frames',
      );
      assertContract(
        backend.getDiagnostics().lockstepPerformanceBudget?.slowClientPolicy ===
          'stall-or-use-authoritative-server' &&
          (backend.getDiagnostics().lockstepSnapshotPerformance?.snapshotsEmitted ?? 0) > 0,
        'lockstep diagnostics must expose performance budget and snapshot timing',
      );

      const server = backend.server;
      assertContract(server !== null, 'lockstep local server must remain available');
      const commander = server.getLockstepSimulationCore().world.getCommander(1 as PlayerId);
      assertContract(commander !== undefined, 'player commander fixture must exist');
      backend.gameConnection.sendCommand({
        type: 'move',
        tick: 0,
        entityIds: [commander.id],
        targetX: commander.transform.x + 64,
        targetY: commander.transform.y,
        targetZ: commander.transform.z,
        waypointType: 'move',
        queue: false,
      });
      await waitMs(140);
      assertContract(
        backend.getDiagnostics().lockstep?.lastAdvancedFrame !== null,
        'lockstep backend must keep advancing after scheduled local input',
      );
    } finally {
      unsubscribe();
    }
  } finally {
    backend.stop();
  }
}

function assertInitializationHashMismatch(): void {
  const base = {
    gameId: 'contract-game',
    roomCode: 'CONTRACT',
    hostPlayerId: 1 as PlayerId,
    playerIds: [1 as PlayerId, 2 as PlayerId],
    aiPlayerIds: [],
    settings: {
      centerMagnitude: 0,
      dividersMagnitude: 0,
      terrainMapShape: 'circle' as const,
      terrainDTerrain: 0,
      metalDepositStep: 0,
      terrainDetail: 1,
      mapWidthLandCells: 9,
      mapLengthLandCells: 9,
      maxTotalUnits: 128,
      converterTax: 0,
    },
  };
  const first = hashCanonicalMatchInitialization(buildCanonicalMatchInitialization(base));
  const second = hashCanonicalMatchInitialization(buildCanonicalMatchInitialization({
    ...base,
    settings: {
      ...base.settings,
      converterTax: 0.25,
    },
  }));
  assertContract(first !== second, 'canonical initialization hash must catch config mismatches');
}

function createTerrain(): RealBattleStartupTerrain {
  return {
    terrainMapShape: 'circle',
    terrainRuntimeConfig: {
      centerMagnitude: 0,
      dividersMagnitude: 0,
      terrainDTerrain: 0,
      metalDepositStep: 0,
      terrainDetail: 1,
    },
    mapDimensions: {
      widthLandCells: 9,
      lengthLandCells: 9,
    },
    mapSize: {
      width: 9 * 128,
      height: 9 * 128,
    },
  };
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
