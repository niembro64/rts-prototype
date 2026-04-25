import { RtsScene3D } from './scenes/RtsScene3D';
import { ThreeApp } from './render3d/ThreeApp';
import { MAP_BG_COLOR, hexToStr } from '../config';

export type { GameConfig, GameInstance, GameScene, GameApp } from '@/types/game';
import type { GameConfig, GameInstance, GameScene } from '@/types/game';

export function createGame(config: GameConfig): GameInstance {
  const playerIds = config.playerIds ?? [1, 2];
  const localPlayerId = config.localPlayerId ?? 1;
  const backgroundMode = config.backgroundMode ?? false;
  const bgColor = hexToStr(MAP_BG_COLOR);

  const app = new ThreeApp(
    config.parent,
    config.width,
    config.height,
    config.mapWidth,
    config.mapHeight,
    bgColor,
  );

  const buildScene = () =>
    new RtsScene3D(app, {
      playerIds,
      localPlayerId,
      gameConnection: config.gameConnection,
      clientViewState: config.clientViewState,
      mapWidth: config.mapWidth,
      mapHeight: config.mapHeight,
      backgroundMode,
    });

  let scene = buildScene();
  scene.create();

  let currentScene: GameScene | null = scene;
  app.onUpdate((time, delta) => {
    currentScene?.update(time, delta);
  });
  app.start();

  const wireRestart = (s: RtsScene3D) => {
    s.scene.onRestart(() => {
      s.shutdown();
      const newScene = buildScene();
      newScene.create();
      scene = newScene;
      currentScene = newScene;
      wireRestart(newScene);
    });
  };
  wireRestart(scene);

  return {
    app,
    getScene: () => currentScene,
  };
}

/**
 * Destroy a game instance. `keepConnection` (default false) controls
 * whether the scene's GameConnection.disconnect() is called; set it to
 * true if the connection is shared with a replacement scene. The
 * caller is responsible for ultimately disconnecting when the game
 * actually ends.
 */
export function destroyGame(
  instance: GameInstance,
  opts: { keepConnection?: boolean } = {},
): void {
  const scene = instance.getScene();
  if (scene) {
    scene.shutdown(opts);
  }
  instance.app.destroy();
}
