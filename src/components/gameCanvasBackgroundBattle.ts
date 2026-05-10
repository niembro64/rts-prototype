import type { Ref } from 'vue';
import {
  createBackgroundBattle,
  destroyBackgroundBattle,
  type BackgroundBattleState,
} from '../game/lobby/LobbyManager';
import type { GameScene } from '../game/createGame';
import type { PlayerId } from '../game/sim/types';
import type { BattleMode } from '../battleBarConfig';
import { waitForSceneAndBind } from './gameSceneBindings';

type BackgroundBattleOptions = {
  backgroundContainerRef: Ref<HTMLDivElement | null>;
  getLocalIpAddress: () => string;
  getBattleMode: () => BattleMode;
  getPreviewPlayerIds: () => PlayerId[] | undefined;
  getPreviewLocalPlayerId: () => PlayerId | undefined;
  getPlayerClientEnabled: () => boolean;
  bindSceneUi: (scene: GameScene) => void;
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
    onStopped();
  }

  async function startBackgroundBattle(): Promise<void> {
    if (!backgroundContainerRef.value) return;
    stopBackgroundBattle();
    const myGen = backgroundBattleGen;
    const battle = await createBackgroundBattle(
      backgroundContainerRef.value,
      getLocalIpAddress(),
      getBattleMode(),
      getPreviewPlayerIds(),
      getPreviewLocalPlayerId(),
    );
    if (myGen !== backgroundBattleGen) {
      destroyBackgroundBattle(battle);
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
