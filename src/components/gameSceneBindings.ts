import type { GameScene } from '@/types/game';
import type { PlayerId } from '@/types/sim';
import type { EconomyInfo, MinimapData, SelectionInfo } from '@/types/ui';
import type { NetworkServerSnapshotMeta } from '@/types/network';

export type SceneUiBindings = {
  onPlayerChange: (playerId: PlayerId) => void;
  onSelectionChange: (info: SelectionInfo) => void;
  onEconomyChange: (info: EconomyInfo) => void;
  onMinimapUpdate: (data: MinimapData) => void;
  onCameraQuadUpdate: (quad: MinimapData['cameraQuad'], cameraYaw: number) => void;
  onServerMetaUpdate: (meta: NetworkServerSnapshotMeta) => void;
  onGameOver?: (winnerId: PlayerId) => void;
  onGameRestart?: () => void;
};

export function bindSceneUiCallbacks(
  scene: GameScene,
  bindings: SceneUiBindings,
): void {
  scene.onPlayerChange = bindings.onPlayerChange;
  scene.onSelectionChange = bindings.onSelectionChange;
  scene.onEconomyChange = bindings.onEconomyChange;
  scene.onMinimapUpdate = bindings.onMinimapUpdate;
  scene.onCameraQuadUpdate = bindings.onCameraQuadUpdate;
  scene.onServerMetaUpdate = bindings.onServerMetaUpdate;
  if (bindings.onGameOver) scene.onGameOverUI = bindings.onGameOver;
  if (bindings.onGameRestart) scene.onGameRestart = bindings.onGameRestart;
}

export function waitForSceneAndBind(
  getScene: () => GameScene | null | undefined,
  onSceneReady: (scene: GameScene) => void,
  intervalMs = 100,
  maxAttempts = 50,
): ReturnType<typeof setInterval> {
  let attempts = 0;
  const interval = setInterval(() => {
    attempts++;
    if (attempts > maxAttempts) {
      clearInterval(interval);
      return;
    }
    const scene = getScene();
    if (!scene) return;
    clearInterval(interval);
    onSceneReady(scene);
  }, intervalMs);
  return interval;
}
