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
  bindSceneUi: (scene: GameScene) => void;
  onRendererWarmupChange: (warming: boolean) => void;
  onStarted: (battle: BackgroundBattleState) => void;
  onStopped: () => void;
};

export function useGameCanvasBackgroundBattle({
  backgroundContainerRef,
  getLocalIpAddress,
  getBattleMode,
  getPreviewPlayerIds,
  getPreviewLocalPlayerId,
  getPlayerClientEnabled,
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
    onRendererWarmupChange(getPlayerClientEnabled());
    const myGen = backgroundBattleGen;
    await waitForLoadingOverlayPaint();
    if (myGen !== backgroundBattleGen || !backgroundContainerRef.value) {
      onRendererWarmupChange(false);
      return;
    }
    const battle = await createBackgroundBattle(
      backgroundContainerRef.value,
      getLocalIpAddress(),
      getBattleMode(),
      getPreviewPlayerIds(),
      getPreviewLocalPlayerId(),
      (warming) => onRendererWarmupChange(warming && getPlayerClientEnabled()),
    );
    if (myGen !== backgroundBattleGen) {
      destroyBackgroundBattle(battle);
      onRendererWarmupChange(false);
      return;
    }
    backgroundBattle = battle;
    onStarted(battle);

    checkBgSceneInterval = waitForSceneAndBind(
      () => backgroundBattle?.gameInstance?.getScene(),
      (bgScene) => {
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
