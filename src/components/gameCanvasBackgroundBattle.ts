import { nextTick, type Ref } from 'vue';
import type { BackgroundBattleState } from '../game/lobby/LobbyManager';
import type { GameScene } from '../game/createGame';
import type { PlayerId } from '../game/sim/types';
import type { BattleMode } from '../battleBarConfig';
import { waitForSceneAndBind } from './gameSceneBindings';

type LobbyManagerModule = typeof import('../game/lobby/LobbyManager');
let lobbyManagerModule: LobbyManagerModule | null = null;
let lobbyManagerModulePromise: Promise<LobbyManagerModule> | null = null;

function loadLobbyManager(): Promise<LobbyManagerModule> {
  if (lobbyManagerModule !== null) return Promise.resolve(lobbyManagerModule);
  lobbyManagerModulePromise ??= import('../game/lobby/LobbyManager').then((module) => {
    lobbyManagerModule = module;
    return module;
  });
  return lobbyManagerModulePromise;
}

async function waitForLoadingOverlayPaint(): Promise<void> {
  await nextTick();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      window.setTimeout(resolve, 0);
    });
  });
}

type BackgroundBattleOptions = {
  backgroundContainerRef: Ref<HTMLDivElement | null>;
  getLocalIpAddress: () => string;
  getBattleMode: () => BattleMode;
  getPreviewPlayerIds: () => PlayerId[] | undefined;
  getPreviewLocalPlayerId: () => PlayerId | undefined;
  getPlayerClientEnabled: () => boolean;
  onLoadingProgress: (progress: number, phase?: string) => void;
  bindSceneUi: (scene: GameScene) => void;
  onRendererWarmupChange: (warming: boolean) => void;
  onStarted: (battle: BackgroundBattleState) => void;
  onStopped: () => void;
};

const BACKGROUND_LOAD_PROGRESS = {
  start: 0,
  overlayPainted: 0.06,
  settingsLoaded: 0.1,
  battleCreated: 0.76,
  sceneCreated: 0.78,
  sceneBound: 0.82,
  firstSnapshot: 0.88,
  shaderWarmup: 0.95,
  done: 1,
} as const;

export function useGameCanvasBackgroundBattle({
  backgroundContainerRef,
  getLocalIpAddress,
  getBattleMode,
  getPreviewPlayerIds,
  getPreviewLocalPlayerId,
  getPlayerClientEnabled,
  onLoadingProgress,
  bindSceneUi,
  onRendererWarmupChange,
  onStarted,
  onStopped,
}: BackgroundBattleOptions): {
  getBackgroundBattle: () => BackgroundBattleState | null;
  startBackgroundBattle: () => Promise<void>;
  stopBackgroundBattle: () => void;
  waitForBackgroundBattleIdle: () => Promise<void>;
} {
  let backgroundBattle: BackgroundBattleState | null = null;
  let backgroundBattleGen = 0;
  let checkBgSceneInterval: ReturnType<typeof setInterval> | null = null;
  // Superseded starts still need to finish and destroy their server/renderer
  // before the next start can acquire the singleton slots.
  let backgroundBattleStartTail: Promise<void> = Promise.resolve();

  async function reportLoadingProgress(progress: number, phase: string): Promise<void> {
    onLoadingProgress(progress, phase);
    await waitForLoadingOverlayPaint();
  }

  function clearBackgroundSceneWait(): void {
    if (!checkBgSceneInterval) return;
    clearInterval(checkBgSceneInterval);
    checkBgSceneInterval = null;
  }

  function destroyCurrentBackgroundBattle(): boolean {
    clearBackgroundSceneWait();
    if (backgroundBattle) {
      if (lobbyManagerModule === null) {
        throw new Error('Background battle runtime missing during destroy');
      }
      lobbyManagerModule.destroyBackgroundBattle(backgroundBattle);
      backgroundBattle = null;
      onStopped();
      return true;
    }
    return false;
  }

  function stopBackgroundBattle(): void {
    backgroundBattleGen++;
    const destroyed = destroyCurrentBackgroundBattle();
    onRendererWarmupChange(false);
    if (!destroyed) onStopped();
  }

  async function waitForBackgroundBattleIdle(): Promise<void> {
    await backgroundBattleStartTail;
  }

  async function startBackgroundBattle(): Promise<void> {
    const myGen = ++backgroundBattleGen;
    destroyCurrentBackgroundBattle();
    const previousStart = backgroundBattleStartTail;

    const runStart = async (): Promise<void> => {
      try {
        if (!backgroundContainerRef.value) {
          onRendererWarmupChange(false);
          await previousStart;
          return;
        }
        await reportLoadingProgress(BACKGROUND_LOAD_PROGRESS.start, 'Preparing battle');
        onRendererWarmupChange(getPlayerClientEnabled());
        await waitForLoadingOverlayPaint();
        await previousStart;
        if (myGen !== backgroundBattleGen || !backgroundContainerRef.value) {
          onRendererWarmupChange(false);
          return;
        }
        await reportLoadingProgress(BACKGROUND_LOAD_PROGRESS.overlayPainted, 'Preparing loading screen');
        if (myGen !== backgroundBattleGen || !backgroundContainerRef.value) {
          onRendererWarmupChange(false);
          return;
        }
        await reportLoadingProgress(BACKGROUND_LOAD_PROGRESS.settingsLoaded, 'Loading battle settings');
        const lobbyManager = await loadLobbyManager();
        if (myGen !== backgroundBattleGen || !backgroundContainerRef.value) {
          onRendererWarmupChange(false);
          return;
        }
        let createdBattle: BackgroundBattleState | null = null;
        let startupReadyPending = false;
        const handleStartupReady = () => {
          if (myGen !== backgroundBattleGen) return;
          if (createdBattle === null || backgroundBattle !== createdBattle) {
            startupReadyPending = true;
            return;
          }
          startupReadyPending = false;
          onLoadingProgress(BACKGROUND_LOAD_PROGRESS.firstSnapshot, 'Applying first snapshot');
        };
        const battle = await lobbyManager.createBackgroundBattle(
          backgroundContainerRef.value,
          getLocalIpAddress(),
          getBattleMode(),
          getPreviewPlayerIds(),
          getPreviewLocalPlayerId(),
          (warming) => {
            onLoadingProgress(
              warming
                ? BACKGROUND_LOAD_PROGRESS.shaderWarmup
                : BACKGROUND_LOAD_PROGRESS.done,
              warming ? 'Warming shaders' : 'Ready',
            );
            onRendererWarmupChange(warming && getPlayerClientEnabled());
          },
          (progress, phase) => reportLoadingProgress(
            BACKGROUND_LOAD_PROGRESS.settingsLoaded +
              progress * (BACKGROUND_LOAD_PROGRESS.battleCreated - BACKGROUND_LOAD_PROGRESS.settingsLoaded),
            phase ?? 'Creating battle',
          ),
          handleStartupReady,
        );
        if (myGen !== backgroundBattleGen) {
          lobbyManager.destroyBackgroundBattle(battle);
          onRendererWarmupChange(false);
          return;
        }
        createdBattle = battle;
        backgroundBattle = battle;
        if (startupReadyPending) handleStartupReady();
        await reportLoadingProgress(BACKGROUND_LOAD_PROGRESS.sceneCreated, 'Creating 3D scene');
        if (myGen !== backgroundBattleGen || backgroundBattle !== battle) {
          if (backgroundBattle === battle) {
            lobbyManager.destroyBackgroundBattle(battle);
            backgroundBattle = null;
          }
          onRendererWarmupChange(false);
          return;
        }
        onStarted(battle);

        checkBgSceneInterval = waitForSceneAndBind(
          () => backgroundBattle?.gameInstance?.getScene(),
          (bgScene) => {
            checkBgSceneInterval = null;
            if (myGen !== backgroundBattleGen || backgroundBattle !== battle) return;
            onLoadingProgress(BACKGROUND_LOAD_PROGRESS.sceneBound, 'Binding game UI');
            bgScene.setClientRenderEnabled(getPlayerClientEnabled());
            bindSceneUi(bgScene);
          },
        );
      } catch (err) {
        if (myGen !== backgroundBattleGen) return;
        console.error('[lobby] Failed to start background battle:', err);
        onRendererWarmupChange(false);
      }
    };

    const startPromise = runStart();
    backgroundBattleStartTail = startPromise;
    await startPromise;
  }

  return {
    getBackgroundBattle: () => backgroundBattle,
    startBackgroundBattle,
    stopBackgroundBattle,
    waitForBackgroundBattleIdle,
  };
}
