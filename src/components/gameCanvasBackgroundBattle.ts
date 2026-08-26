import type { Ref } from 'vue';
import type { BackgroundBattleState, LobbyPreviewSides } from '../game/lobby/LobbyManager';
import type { GameScene } from '../game/createGame';
import type { PlayerId } from '../game/sim/types';
import type { BattleMode } from '../battleBarConfig';
import { waitForSceneAndBind } from './gameSceneBindings';
import { waitForLoadingOverlayPaint } from './loadingOverlayPaint';
import { prewarmEntityPreviewImages } from './entityPreviewThumbnails';

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

type BackgroundBattleOptions = {
  backgroundContainerRef: Ref<HTMLDivElement | null>;
  /** Whether the stage is free. The preview/demo battle must never race a
   *  FOREGROUND battle (live or booting) for the sim/renderer singletons —
   *  and the racers are real: nextTick-queued restarts from lobby-settings
   *  and roster changes land here mid-transition all the time. Checked on
   *  entry AND after every await, because the answer changes mid-flight. */
  canRunBackgroundBattle: () => boolean;
  getLocalIpAddress: () => string;
  getBattleMode: () => BattleMode;
  getPreviewPlayerIds: () => PlayerId[] | undefined;
  getPreviewLocalPlayerId: () => PlayerId | undefined;
  /** The game room's sides for its preview (undefined for the solo demo,
   *  which authors its own seats per side). */
  getPreviewSides: () => LobbyPreviewSides | undefined;
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
  previewImages: 0.18,
  battleCreated: 0.76,
  sceneCreated: 0.78,
  sceneBound: 0.82,
  firstSnapshot: 0.88,
  shaderWarmup: 0.95,
  done: 1,
} as const;

export function useGameCanvasBackgroundBattle({
  backgroundContainerRef,
  canRunBackgroundBattle,
  getLocalIpAddress,
  getBattleMode,
  getPreviewPlayerIds,
  getPreviewLocalPlayerId,
  getPreviewSides,
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
    if (!canRunBackgroundBattle()) {
      // Refused, not deferred: the foreground battle owns the stage. The
      // next legitimate transition (return to lobby, leave) queues its own
      // start, so a refused one has nobody to answer to.
      return;
    }
    const myGen = ++backgroundBattleGen;
    destroyCurrentBackgroundBattle();
    const previousStart = backgroundBattleStartTail;

    const superseded = (): boolean =>
      myGen !== backgroundBattleGen ||
      !backgroundContainerRef.value ||
      !canRunBackgroundBattle();

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
        if (superseded()) {
          onRendererWarmupChange(false);
          return;
        }
        await reportLoadingProgress(BACKGROUND_LOAD_PROGRESS.overlayPainted, 'Preparing loading screen');
        if (superseded()) {
          onRendererWarmupChange(false);
          return;
        }
        await reportLoadingProgress(BACKGROUND_LOAD_PROGRESS.settingsLoaded, 'Loading battle settings');
        await prewarmEntityPreviewImages((complete, total) => {
          const fraction = total > 0 ? complete / total : 1;
          onLoadingProgress(
            BACKGROUND_LOAD_PROGRESS.settingsLoaded +
              fraction *
                (BACKGROUND_LOAD_PROGRESS.previewImages - BACKGROUND_LOAD_PROGRESS.settingsLoaded),
            'Preparing interface previews',
          );
        });
        if (superseded()) {
          onRendererWarmupChange(false);
          return;
        }
        await reportLoadingProgress(BACKGROUND_LOAD_PROGRESS.previewImages, 'Interface previews ready');
        const lobbyManager = await loadLobbyManager();
        if (superseded()) {
          onRendererWarmupChange(false);
          return;
        }
        let createdBattle: BackgroundBattleState | null = null;
        let startupReadyPending = false;
        let startupReady = false;
        let rendererWarmupDone = !getPlayerClientEnabled();
        const maybeFinishLoading = () => {
          if (
            myGen !== backgroundBattleGen ||
            createdBattle === null ||
            backgroundBattle !== createdBattle ||
            !startupReady ||
            !rendererWarmupDone
          ) {
            return;
          }
          onLoadingProgress(BACKGROUND_LOAD_PROGRESS.done, 'Ready');
          onRendererWarmupChange(false);
        };
        const handleStartupReady = () => {
          if (myGen !== backgroundBattleGen) return;
          if (createdBattle === null || backgroundBattle !== createdBattle) {
            startupReadyPending = true;
            return;
          }
          startupReady = true;
          startupReadyPending = false;
          // Keep the loading cover in place until the cold driver work is
          // complete. The renderer warmup acknowledges startup before it
          // compiles, so this presentation gate cannot deadlock the server.
          maybeFinishLoading();
        };
        const battle = await lobbyManager.createBackgroundBattle(
          backgroundContainerRef.value,
          getLocalIpAddress(),
          getBattleMode(),
          getPreviewPlayerIds(),
          getPreviewLocalPlayerId(),
          getPreviewSides(),
          (warming) => {
            rendererWarmupDone = !warming;
            if (warming) {
              onLoadingProgress(BACKGROUND_LOAD_PROGRESS.shaderWarmup, 'Warming shaders');
            }
            const ready = startupReady && rendererWarmupDone;
            onRendererWarmupChange(getPlayerClientEnabled() && !ready);
            maybeFinishLoading();
          },
          (progress, phase) => reportLoadingProgress(
            BACKGROUND_LOAD_PROGRESS.previewImages +
              progress * (BACKGROUND_LOAD_PROGRESS.battleCreated - BACKGROUND_LOAD_PROGRESS.previewImages),
            phase ?? 'Creating battle',
          ),
          handleStartupReady,
        );
        if (myGen !== backgroundBattleGen || !canRunBackgroundBattle()) {
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
