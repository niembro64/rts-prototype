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
} {
  let backgroundBattle: BackgroundBattleState | null = null;
  let backgroundBattleGen = 0;
  let checkBgSceneInterval: ReturnType<typeof setInterval> | null = null;

  async function reportLoadingProgress(progress: number, phase: string): Promise<void> {
    onLoadingProgress(progress, phase);
    await waitForLoadingOverlayPaint();
  }

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
    await reportLoadingProgress(BACKGROUND_LOAD_PROGRESS.start, 'Preparing battle');
    onRendererWarmupChange(getPlayerClientEnabled());
    const myGen = backgroundBattleGen;
    await waitForLoadingOverlayPaint();
    if (myGen !== backgroundBattleGen || !backgroundContainerRef.value) {
      onRendererWarmupChange(false);
      return;
    }
    await reportLoadingProgress(BACKGROUND_LOAD_PROGRESS.overlayPainted, 'Preparing loading screen');
    await reportLoadingProgress(BACKGROUND_LOAD_PROGRESS.settingsLoaded, 'Loading battle settings');
    const battle = await createBackgroundBattle(
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
    );
    if (myGen !== backgroundBattleGen) {
      destroyBackgroundBattle(battle);
      onRendererWarmupChange(false);
      return;
    }
    backgroundBattle = battle;
    const scene = battle.gameInstance.getScene();
    if (scene) {
      const previousStartupReady = scene.onStartupReady;
      scene.onStartupReady = () => {
        if (myGen !== backgroundBattleGen || backgroundBattle !== battle) return;
        previousStartupReady?.();
        onLoadingProgress(BACKGROUND_LOAD_PROGRESS.firstSnapshot, 'Applying first snapshot');
      };
    }
    await reportLoadingProgress(BACKGROUND_LOAD_PROGRESS.sceneCreated, 'Creating 3D scene');
    if (myGen !== backgroundBattleGen || backgroundBattle !== battle) {
      if (backgroundBattle === battle) {
        destroyBackgroundBattle(battle);
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
  }

  return {
    getBackgroundBattle: () => backgroundBattle,
    startBackgroundBattle,
    stopBackgroundBattle,
  };
}
