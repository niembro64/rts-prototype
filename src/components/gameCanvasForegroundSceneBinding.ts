import type { GameScene } from '@/types/game';
import { waitForSceneAndBind } from './gameSceneBindings';

export type GameCanvasForegroundSceneBinding = {
  bind(
    getScene: () => GameScene | null | undefined,
    onSceneReady: (scene: GameScene) => void,
  ): void;
  clear(): void;
};

export function useGameCanvasForegroundSceneBinding(): GameCanvasForegroundSceneBinding {
  let sceneWaitInterval: ReturnType<typeof setInterval> | null = null;

  function clear(): void {
    if (!sceneWaitInterval) return;
    clearInterval(sceneWaitInterval);
    sceneWaitInterval = null;
  }

  return {
    bind(getScene, onSceneReady) {
      clear();
      const interval = waitForSceneAndBind(
        getScene,
        (scene) => {
          if (sceneWaitInterval === interval) sceneWaitInterval = null;
          onSceneReady(scene);
        },
      );
      sceneWaitInterval = interval;
    },
    clear,
  };
}
