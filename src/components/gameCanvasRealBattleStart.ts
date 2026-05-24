import { nextTick, type Ref } from 'vue';
import type { GameScene } from '../game/createGame';
import type { NetworkManager, NetworkRole } from '../game/network/NetworkManager';
import type { GameConnection } from '../game/server/GameConnection';
import type { GameServer } from '../game/server/GameServer';
import type { PlayerId } from '../game/sim/types';
import type { CameraFovDegrees } from '../types/client';
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
  onLoadingProgress: (progress: number, phase?: string) => void;
  bindSceneUi: (scene: GameScene) => void;
};

const REAL_BATTLE_LOAD_PROGRESS = {
  start: 0,
  overlayPainted: 0.06,
  terrainLoaded: 0.12,
  serverReady: 0.54,
  connectionReady: 0.62,
  sceneCreated: 0.78,
  firstSnapshot: 0.88,
  shaderWarmup: 0.95,
  done: 1,
} as const;

export async function startRealBattleWithPlayers(
  playerIds: PlayerId[],
  aiPlayerIds: PlayerId[] | undefined,
  options: StartRealBattleWithPlayersOptions,
): Promise<void> {
  async function reportLoadingProgress(progress: number, phase: string): Promise<void> {
    options.onLoadingProgress(progress, phase);
    await waitForLoadingOverlayPaint();
  }

  options.showLobby.value = false;
  options.gameStarted.value = true;
  options.battleLoading.value = true;
  await reportLoadingProgress(REAL_BATTLE_LOAD_PROGRESS.start, 'Preparing battle');
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
    await reportLoadingProgress(REAL_BATTLE_LOAD_PROGRESS.overlayPainted, 'Preparing loading screen');

    const rect = options.containerRef.value.getBoundingClientRect();
    let gameConnection: GameConnection;
    const realBattleTerrain = loadAndApplyRealBattleTerrain();
    await reportLoadingProgress(REAL_BATTLE_LOAD_PROGRESS.terrainLoaded, 'Loading terrain settings');

    if (options.networkRole.value !== 'client') {
      const createdServer = await createRealBattleServer({
        playerIds,
        aiPlayerIds,
        terrain: realBattleTerrain,
        onLoadingProgress: (progress, phase) => reportLoadingProgress(
          REAL_BATTLE_LOAD_PROGRESS.terrainLoaded +
            progress *
              (REAL_BATTLE_LOAD_PROGRESS.serverReady - REAL_BATTLE_LOAD_PROGRESS.terrainLoaded),
          phase ?? 'Starting server',
        ),
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
      await reportLoadingProgress(REAL_BATTLE_LOAD_PROGRESS.serverReady, 'Server ready');

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
        options.networkRole.value === null ? 'local-offline' : 'player',
      );
      options.setActiveConnection(localConnection);
      gameConnection = localConnection;

      applySettingsAndStartRealBattleServer(createdServer, {
        ipAddress: options.localIpAddress.value,
      });
      if (options.networkRole.value === 'host') {
        options.lifecycle.scheduleRecoveryKeyframes(
          createdServer,
          startGen,
          options.getCurrentServer,
        );
      }
      options.hasServer.value = true;
      await reportLoadingProgress(REAL_BATTLE_LOAD_PROGRESS.connectionReady, 'Connecting local player');
    } else {
      const remoteConnection = createRemoteRealBattleConnection();
      options.setActiveConnection(remoteConnection);
      gameConnection = remoteConnection;
      await reportLoadingProgress(REAL_BATTLE_LOAD_PROGRESS.connectionReady, 'Connecting to host');
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
        options.onLoadingProgress(REAL_BATTLE_LOAD_PROGRESS.done, 'Ready');
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
      centerMagnitude: realBattleTerrain.terrainRuntimeConfig.centerMagnitude,
      dividersMagnitude: realBattleTerrain.terrainRuntimeConfig.dividersMagnitude,
      terrainMapShape: realBattleTerrain.terrainMapShape,
      backgroundMode: false,
      lookupPlayerName: options.lookupPlayerName,
      onRendererWarmupChange: (warming) => {
        if (warming) {
          options.onLoadingProgress(REAL_BATTLE_LOAD_PROGRESS.shaderWarmup, 'Warming shaders');
        } else if (startupReady) {
          options.onLoadingProgress(REAL_BATTLE_LOAD_PROGRESS.done, 'Ready');
        }
        rendererWarmupDone = !warming;
        maybeFinishLoading();
      },
    });
    await reportLoadingProgress(REAL_BATTLE_LOAD_PROGRESS.sceneCreated, 'Creating 3D scene');
    setPlayerClientRenderEnabled(gameInstance, options.playerClientEnabled.value);
    gameInstance.app.setCameraFovDegrees(options.cameraFovDegrees.value);
    const scene = gameInstance.getScene();
    if (scene) {
      scene.onStartupReady = () => {
        startupReady = true;
        options.onLoadingProgress(
          rendererWarmupDone
            ? REAL_BATTLE_LOAD_PROGRESS.done
            : REAL_BATTLE_LOAD_PROGRESS.firstSnapshot,
          rendererWarmupDone ? 'Ready' : 'Applying first snapshot',
        );
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
