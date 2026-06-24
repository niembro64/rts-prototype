import { nextTick, type Ref } from 'vue';
import type { GameScene } from '../game/createGame';
import type { NetworkManager, NetworkRole } from '../game/network/NetworkManager';
import type { GameConnection } from '../game/server/GameConnection';
import type { GameServer } from '../game/server/GameServer';
import type { PlayerId } from '../game/sim/types';
import type { CameraFovDegrees } from '../types/client';
import type { BattleHandoff } from '../types/network';
import { setPlayerClientRenderEnabled } from './gameCanvasChromeState';
import type { GameCanvasForegroundGame } from './gameCanvasForegroundGame';
import type { GameCanvasForegroundSceneBinding } from './gameCanvasForegroundSceneBinding';
import type { RealBattleBackendRuntime } from './gameCanvasRealBattleStartup';
import type { GameCanvasRealBattleLifecycle } from './gameCanvasRealBattleLifecycle';

async function waitForLoadingOverlayPaint(): Promise<void> {
  await nextTick();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      window.setTimeout(resolve, 0);
    });
  });
}

type StartRealBattleWithPlayersOptions = {
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
  waitForBackgroundBattleIdle: () => Promise<void>;
  getCurrentServer: () => GameServer | null;
  setCurrentServer: (server: GameServer | null) => void;
  setActiveConnection: (connection: GameConnection | null) => void;
  setBattleStartTime: (time: number) => void;
  lookupPlayerName: (playerId: PlayerId) => string | null;
  battleHandoff?: BattleHandoff;
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
  const startGen = options.lifecycle.beginStart();
  options.foregroundSceneBinding.clear();
  options.setBattleStartTime(Date.now());
  if (options.networkRole.value !== null) {
    options.localPlayerId.value = options.network.getLocalPlayerId();
    options.activePlayer.value = options.localPlayerId.value;
  }

  let ownedBackend: RealBattleBackendRuntime | null = null;
  let registeredServer: GameServer | null = null;
  let registeredConnection: GameConnection | null = null;
  let foregroundCreated = false;

  function cleanupOwnedStartResources(clearRegisteredRefs: boolean): void {
    if (clearRegisteredRefs) {
      options.foregroundSceneBinding.clear();
      if (foregroundCreated) {
        options.foregroundGame.destroy();
        foregroundCreated = false;
      }
    }
    if (clearRegisteredRefs && registeredConnection !== null) {
      options.setActiveConnection(null);
      registeredConnection = null;
    }
    const backend = ownedBackend;
    ownedBackend = null;
    if (backend !== null) {
      const server = backend.server;
      if (server !== null && options.getCurrentServer() === server) {
        if (registeredServer === server) {
          options.setCurrentServer(null);
          registeredServer = null;
        }
      }
      backend.stop();
    }
    if (clearRegisteredRefs) options.hasServer.value = false;
    if (clearRegisteredRefs) options.battleLoading.value = false;
  }

  function shouldAbortStart(): boolean {
    const current = options.lifecycle.isCurrentStart(startGen);
    if (current && options.gameStarted.value && options.containerRef.value) return false;
    cleanupOwnedStartResources(current);
    return true;
  }

  options.stopBackgroundBattle();
  // A preview start may still be inside GameServer.create()/createGame().
  // Wait for its generation cleanup before foreground startup claims slots.
  await options.waitForBackgroundBattleIdle();
  if (shouldAbortStart()) return;

  await reportLoadingProgress(REAL_BATTLE_LOAD_PROGRESS.start, 'Preparing battle');
  if (shouldAbortStart()) return;

  options.lifecycle.setStartTimeout(setTimeout(async () => {
    options.lifecycle.markStartTimeoutFired();
    if (shouldAbortStart()) return;
    await waitForLoadingOverlayPaint();
    if (shouldAbortStart()) return;
    await reportLoadingProgress(REAL_BATTLE_LOAD_PROGRESS.overlayPainted, 'Preparing loading screen');
    if (shouldAbortStart()) return;

    const rectContainer = options.containerRef.value;
    if (!rectContainer) {
      cleanupOwnedStartResources(true);
      return;
    }
    const rect = rectContainer.getBoundingClientRect();
    let gameConnection: GameConnection;
    const realBattleStartup = await import('./gameCanvasRealBattleStartup');
    if (shouldAbortStart()) return;
    const realBattleTerrain = realBattleStartup.loadAndApplyRealBattleTerrain();
    await reportLoadingProgress(REAL_BATTLE_LOAD_PROGRESS.terrainLoaded, 'Loading terrain settings');
    if (shouldAbortStart()) return;

    const backend = await realBattleStartup.createRealBattleBackend({
      playerIds,
      aiPlayerIds,
      terrain: realBattleTerrain,
      networkRole: options.networkRole.value,
      localPlayerId: options.localPlayerId.value,
      localIpAddress: options.localIpAddress.value,
      network: options.network,
      battleHandoff: options.battleHandoff,
      onLoadingProgress: (progress, phase) => reportLoadingProgress(
        REAL_BATTLE_LOAD_PROGRESS.terrainLoaded +
          progress *
            (REAL_BATTLE_LOAD_PROGRESS.serverReady - REAL_BATTLE_LOAD_PROGRESS.terrainLoaded),
        phase ?? 'Starting server',
      ),
    });
    ownedBackend = backend;
    if (shouldAbortStart()) return;

    const createdServer = backend.server;
    if (createdServer !== null) {
      await reportLoadingProgress(REAL_BATTLE_LOAD_PROGRESS.serverReady, 'Server ready');
      if (shouldAbortStart()) return;

      options.setCurrentServer(createdServer);
      registeredServer = createdServer;
    }

    options.setActiveConnection(backend.gameConnection);
    registeredConnection = backend.gameConnection;
    gameConnection = backend.gameConnection;

    backend.start();
    options.hasServer.value = createdServer !== null || backend.ownsServer === true;
    await reportLoadingProgress(
      REAL_BATTLE_LOAD_PROGRESS.connectionReady,
      createdServer !== null ? 'Connecting local player' : 'Connecting to host',
    );
    if (shouldAbortStart()) return;

    const container = options.containerRef.value;
    if (!container) {
      cleanupOwnedStartResources(true);
      return;
    }

    let startupReady = false;
    let rendererWarmupDone = !options.playerClientEnabled.value;
    const maybeFinishLoading = () => {
      if (
        options.lifecycle.isCurrentStart(startGen) &&
        options.gameStarted.value &&
        startupReady &&
        rendererWarmupDone
      ) {
        options.onLoadingProgress(REAL_BATTLE_LOAD_PROGRESS.done, 'Ready');
        options.battleLoading.value = false;
      }
    };

    const gameInstance = await options.foregroundGame.create({
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
      perimeterMagnitude: realBattleTerrain.terrainRuntimeConfig.perimeterMagnitude,
      backgroundMode: false,
      lookupPlayerName: options.lookupPlayerName,
      onRendererWarmupChange: (warming) => {
        if (!options.lifecycle.isCurrentStart(startGen) || !options.gameStarted.value) return;
        if (warming) {
          options.onLoadingProgress(REAL_BATTLE_LOAD_PROGRESS.shaderWarmup, 'Warming shaders');
        } else if (startupReady) {
          options.onLoadingProgress(REAL_BATTLE_LOAD_PROGRESS.done, 'Ready');
        }
        rendererWarmupDone = !warming;
        maybeFinishLoading();
      },
      onStartupReady: () => {
        if (!options.lifecycle.isCurrentStart(startGen) || !options.gameStarted.value) return;
        startupReady = true;
        options.onLoadingProgress(
          rendererWarmupDone
            ? REAL_BATTLE_LOAD_PROGRESS.done
            : REAL_BATTLE_LOAD_PROGRESS.firstSnapshot,
          rendererWarmupDone ? 'Ready' : 'Applying first snapshot',
        );
        maybeFinishLoading();
      },
    });
    foregroundCreated = true;
    setPlayerClientRenderEnabled(gameInstance, options.playerClientEnabled.value);
    gameInstance.app.setCameraFovDegrees(options.cameraFovDegrees.value);
    if (options.battleLoading.value) {
      await reportLoadingProgress(REAL_BATTLE_LOAD_PROGRESS.sceneCreated, 'Creating 3D scene');
    }
    if (shouldAbortStart()) return;

    options.foregroundSceneBinding.bind(
      () => options.foregroundGame.getScene(),
      (readyScene) => {
        if (!options.lifecycle.isCurrentStart(startGen) || !options.gameStarted.value) return;
        readyScene.setClientRenderEnabled(options.playerClientEnabled.value);
        options.bindSceneUi(readyScene);
      },
    );
  }, 100));
}
