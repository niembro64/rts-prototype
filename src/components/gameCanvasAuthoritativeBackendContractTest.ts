import type { NetworkServerSnapshot } from '../game/network/NetworkTypes';
import type { PlayerId } from '../game/sim/types';
import {
  createAuthoritativeServerBackend,
  type RealBattleStartupTerrain,
} from './gameCanvasRealBattleStartup';

function assertContract(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[authoritative backend contract] ${message}`);
  }
}

export async function runAuthoritativeBackendContractTest(): Promise<void> {
  const terrain = createTerrain();
  const backend = await createAuthoritativeServerBackend({
    playerIds: [1 as PlayerId, 2 as PlayerId],
    aiPlayerIds: undefined,
    terrain,
    networkRole: null,
    localPlayerId: 1 as PlayerId,
    localIpAddress: 'contract',
    onLoadingProgress: undefined,
  });

  try {
    assertContract(backend.architecture === 'authoritative-server', 'backend must be authoritative-server');
    assertContract(backend.server !== null, 'offline authoritative backend must create a local server');
    assertContract(backend.getDiagnostics().snapshotTruth === 'authoritative-server', 'diagnostics must report authoritative truth');

    const snapshots: NetworkServerSnapshot[] = [];
    const unsubscribe = backend.gameConnection.onSnapshot((snapshot) => {
      snapshots.push(snapshot);
    });
    try {
      backend.start();
      backend.gameConnection.markClientReady();
      await waitMs(80);
      assertContract(snapshots.length > 0, 'authoritative backend must emit local snapshots');

      const server = backend.server;
      assertContract(server !== null, 'server must remain available after start');
      const core = server.getLockstepSimulationCore();
      const ownCommander = core.world.getCommander(1 as PlayerId);
      const enemyCommander = core.world.getCommander(2 as PlayerId);
      assertContract(ownCommander !== undefined, 'player 1 commander fixture must exist');
      assertContract(enemyCommander !== undefined, 'player 2 commander fixture must exist');

      const beforeAuthorized = server.getReplayCommandCount();
      backend.gameConnection.sendCommand({
        type: 'move',
        tick: 0,
        entityIds: [ownCommander.id],
        targetX: ownCommander.transform.x + 64,
        targetY: ownCommander.transform.y,
        targetZ: ownCommander.transform.z,
        waypointType: 'move',
        queue: false,
      });
      assertContract(
        server.getReplayCommandCount() === beforeAuthorized + 1,
        'authorized local command must be accepted by authoritative backend',
      );

      const beforeUnauthorized = server.getReplayCommandCount();
      backend.gameConnection.sendCommand({
        type: 'move',
        tick: 0,
        entityIds: [enemyCommander.id],
        targetX: enemyCommander.transform.x + 64,
        targetY: enemyCommander.transform.y,
        targetZ: enemyCommander.transform.z,
        waypointType: 'move',
        queue: false,
      });
      assertContract(
        server.getReplayCommandCount() === beforeUnauthorized,
        'unauthorized local command must be rejected by authoritative backend',
      );

      server.requestSnapshotRecovery(1 as PlayerId, true);
      backend.gameConnection.sendCommand({ type: 'setPaused', tick: 0, paused: true });
      backend.gameConnection.sendCommand({ type: 'setPaused', tick: 0, paused: false });
    } finally {
      unsubscribe();
    }
  } finally {
    backend.stop();
  }
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
