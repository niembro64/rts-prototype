import { nextTick, type Ref } from 'vue';
import {
  createBackgroundBattle,
  destroyBackgroundBattle,
  type BackgroundBattleState,
} from '../game/lobby/LobbyManager';
import type { GameScene } from '../game/createGame';
import type { PlayerId } from '../game/sim/types';
import type { BattleMode } from '../battleBarConfig';
import { waitForSceneAndBind } from './gameSceneBindings';

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
  onLoadingProgress: (progress: number) => void;
  bindSceneUi: (scene: GameScene) => void;
  onRendererWarmupChange: (warming: boolean) => void;
  onStarted: (battle: BackgroundBattleState) => void;
  onStopped: () => void;
};

const BACKGROUND_LOAD_PROGRESS = {
  start: 0,
  overlayPainted: 0.06,
  settingsLoaded: 0.16,
  sceneCreated: 0.72,
  sceneBound: 0.78,
  firstSnapshot: 0.86,
  shaderWarmup: 0.94,
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
} {
  let backgroundBattle: BackgroundBattleState | null = null;
  let backgroundBattleGen = 0;
  let checkBgSceneInterval: ReturnType<typeof setInterval> | null = null;

  function clearBackgroundSceneWait(): void {
    if (!checkBgSceneInterval) return;
    clearInterval(checkBgSceneInterval);
    checkBgSceneInterval = null;
  }

  function stopBackgroundBattle(): void {
    backgroundBattleGen++;
    clearBackgroundSceneWait();
    if (backgroundBattle) {
      destroyBackgroundBattle(backgroundBattle);
      backgroundBattle = null;
    }
    onRendererWarmupChange(false);
    onStopped();
  }

  async function startBackgroundBattle(): Promise<void> {
    if (!backgroundContainerRef.value) {
      onRendererWarmupChange(false);
      return;
    }
    stopBackgroundBattle();
    onLoadingProgress(BACKGROUND_LOAD_PROGRESS.start);
    onRendererWarmupChange(getPlayerClientEnabled());
    const myGen = backgroundBattleGen;
    await waitForLoadingOverlayPaint();
    if (myGen !== backgroundBattleGen || !backgroundContainerRef.value) {
      onRendererWarmupChange(false);
      return;
    }
    onLoadingProgress(BACKGROUND_LOAD_PROGRESS.overlayPainted);
    onLoadingProgress(BACKGROUND_LOAD_PROGRESS.settingsLoaded);
    const battle = await createBackgroundBattle(
      backgroundContainerRef.value,
      getLocalIpAddress(),
      getBattleMode(),
      getPreviewPlayerIds(),
      getPreviewLocalPlayerId(),
      (warming) => {
        onLoadingProgress(warming
          ? BACKGROUND_LOAD_PROGRESS.shaderWarmup
          : BACKGROUND_LOAD_PROGRESS.done);
        onRendererWarmupChange(warming && getPlayerClientEnabled());
      },
    );
    if (myGen !== backgroundBattleGen) {
      destroyBackgroundBattle(battle);
      onRendererWarmupChange(false);
      return;
    }
    onLoadingProgress(BACKGROUND_LOAD_PROGRESS.sceneCreated);
    backgroundBattle = battle;
    const scene = battle.gameInstance.getScene();
    if (scene) {
      const previousStartupReady = scene.onStartupReady;
      scene.onStartupReady = () => {
        previousStartupReady?.();
        onLoadingProgress(BACKGROUND_LOAD_PROGRESS.firstSnapshot);
      };
    }
    onStarted(battle);

    checkBgSceneInterval = waitForSceneAndBind(
      () => backgroundBattle?.gameInstance?.getScene(),
      (bgScene) => {
        onLoadingProgress(BACKGROUND_LOAD_PROGRESS.sceneBound);
        bgScene.setClientRenderEnabled(getPlayerClientEnabled());
        bindSceneUi(bgScene);
        checkBgSceneInterval = null;
      },
    );
  }

  return {
    getBackgroundBattle: () => backgroundBattle,
    startBackgroundBattle,
    stopBackgroundBattle,
  };
}
