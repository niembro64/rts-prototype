import { nextTick, type Ref } from 'vue';
import type { GameScene } from '../game/createGame';
import type { NetworkManager, NetworkRole } from '../game/network/NetworkManager';
import type { GameConnection } from '../game/server/GameConnection';
import type { GameServer } from '../game/server/GameServer';
import type { PlayerId } from '../game/sim/types';
import type { CameraFovDegrees } from '../types/client';
import type { ServerSimQuality, ServerSimSignalStates } from '../types/serverSimLod';
import { setPlayerClientRenderEnabled } from './gameCanvasChromeState';
import type { GameCanvasForegroundGame } from './gameCanvasForegroundGame';
import type { GameCanvasForegroundSceneBinding } from './gameCanvasForegroundSceneBinding';
import type { GameCanvasRealBattleLifecycle } from './gameCanvasRealBattleLifecycle';
import {
  applySettingsAndStartRealBattleServer,
  createLocalRealBattleConnection,
  createRealBattleServer,
  createRemoteRealBattleConnection,
  loadAndApplyRealBattleTerrain,
} from './gameCanvasRealBattleStartup';

async function waitForLoadingOverlayPaint(): Promise<void> {
  await nextTick();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      window.setTimeout(resolve, 0);
    });
  });
}

export type StartRealBattleWithPlayersOptions = {
  containerRef: Ref<HTMLDivElement | null>;
  showLobby: Ref<boolean>;
  gameStarted: Ref<boolean>;
  battleLoading: Ref<boolean>;
  activePlayer: Ref<PlayerId>;
  localPlayerId: Ref<PlayerId>;
  networkRole: Ref<NetworkRole | null>;
  playerClientEnabled: Ref<boolean>;
  cameraFovDegrees: Ref<CameraFovDegrees>;
  localIpAddress: Ref<string>;
  serverSimQuality: Ref<ServerSimQuality>;
  serverSignalStates: Ref<ServerSimSignalStates>;
  hasServer: Ref<boolean>;
  network: NetworkManager;
  lifecycle: GameCanvasRealBattleLifecycle;
  foregroundGame: GameCanvasForegroundGame;
  foregroundSceneBinding: GameCanvasForegroundSceneBinding;
  stopBackgroundBattle: () => void;
  getCurrentServer: () => GameServer | null;
  setCurrentServer: (server: GameServer | null) => void;
  setActiveConnection: (connection: GameConnection | null) => void;
  setBattleStartTime: (time: number) => void;
  lookupPlayerName: (playerId: PlayerId) => string | null;
  bindSceneUi: (scene: GameScene) => void;
};

export async function startRealBattleWithPlayers(
  playerIds: PlayerId[],
  aiPlayerIds: PlayerId[] | undefined,
  options: StartRealBattleWithPlayersOptions,
): Promise<void> {
  options.showLobby.value = false;
  options.gameStarted.value = true;
  options.battleLoading.value = true;
  options.setBattleStartTime(Date.now());
  if (options.networkRole.value !== null) {
    options.localPlayerId.value = options.network.getLocalPlayerId();
    options.activePlayer.value = options.localPlayerId.value;
  }

  options.stopBackgroundBattle();
  const startGen = options.lifecycle.beginStart();

  options.lifecycle.setStartTimeout(setTimeout(async () => {
    options.lifecycle.markStartTimeoutFired();
    if (!options.lifecycle.isCurrentStart(startGen) || !options.containerRef.value) {
      options.battleLoading.value = false;
      return;
    }
    await waitForLoadingOverlayPaint();
    if (!options.lifecycle.isCurrentStart(startGen) || !options.containerRef.value) {
      options.battleLoading.value = false;
      return;
    }

    const rect = options.containerRef.value.getBoundingClientRect();
    let gameConnection: GameConnection;
    const realBattleTerrain = loadAndApplyRealBattleTerrain();

    if (options.networkRole.value !== 'client') {
      const createdServer = await createRealBattleServer({
        playerIds,
        aiPlayerIds,
        terrain: realBattleTerrain,
      });
      if (
        !options.lifecycle.isCurrentStart(startGen) ||
        !options.gameStarted.value ||
        !options.containerRef.value
      ) {
        createdServer.stop();
        options.battleLoading.value = false;
        return;
      }

      options.lifecycle.clearSnapshotListeners(options.getCurrentServer());
      options.setCurrentServer(createdServer);

      if (options.networkRole.value === 'host') {
        options.lifecycle.bindHostNetwork(
          createdServer,
          options.network,
          options.getCurrentServer,
        );
      }

      const localConnection = createLocalRealBattleConnection(
        createdServer,
        options.localPlayerId.value,
      );
      options.setActiveConnection(localConnection);
      gameConnection = localConnection;

      applySettingsAndStartRealBattleServer(createdServer, {
        ipAddress: options.localIpAddress.value,
        simQuality: options.serverSimQuality.value,
        simSignalStates: options.serverSignalStates.value,
      });
      if (options.networkRole.value === 'host') {
        options.lifecycle.scheduleRecoveryKeyframes(
          createdServer,
          startGen,
          options.getCurrentServer,
        );
      }
      options.hasServer.value = true;
    } else {
      const remoteConnection = createRemoteRealBattleConnection();
      options.setActiveConnection(remoteConnection);
      gameConnection = remoteConnection;
    }

    const container = options.containerRef.value;
    if (!container) {
      options.battleLoading.value = false;
      return;
    }

    let startupReady = false;
    let rendererWarmupDone = !options.playerClientEnabled.value;
    const maybeFinishLoading = () => {
      if (
        options.lifecycle.isCurrentStart(startGen) &&
        startupReady &&
        rendererWarmupDone
      ) {
        options.battleLoading.value = false;
      }
    };

    const gameInstance = options.foregroundGame.create({
      parent: container,
      width: rect.width || window.innerWidth,
      height: rect.height || window.innerHeight,
      playerIds,
      localPlayerId: options.localPlayerId.value,
      gameConnection,
      mapWidth: realBattleTerrain.mapSize.width,
      mapHeight: realBattleTerrain.mapSize.height,
      terrainCenter: realBattleTerrain.terrainCenter,
      terrainDividers: realBattleTerrain.terrainDividers,
      terrainMapShape: realBattleTerrain.terrainMapShape,
      backgroundMode: false,
      lookupPlayerName: options.lookupPlayerName,
      onRendererWarmupChange: (warming) => {
        rendererWarmupDone = !warming;
        maybeFinishLoading();
      },
    });
    setPlayerClientRenderEnabled(gameInstance, options.playerClientEnabled.value);
    gameInstance.app.setCameraFovDegrees(options.cameraFovDegrees.value);
    const scene = gameInstance.getScene();
    if (scene) {
      scene.onStartupReady = () => {
        startupReady = true;
        maybeFinishLoading();
      };
    }

    options.foregroundSceneBinding.bind(
      () => options.foregroundGame.getScene(),
      (readyScene) => {
        readyScene.setClientRenderEnabled(options.playerClientEnabled.value);
        options.bindSceneUi(readyScene);
      },
    );
  }, 100));
}
