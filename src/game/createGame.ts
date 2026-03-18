import { RtsScene } from './scenes/RtsScene';
import { PixiApp } from './PixiApp';
import type { PlayerId } from './sim/types';
import type { GameConnection } from './server/GameConnection';
import { MAP_BG_COLOR, hexToStr } from '../config';

export type { GameConfig, GameInstance } from '@/types/game';
import type { GameConfig, GameInstance } from '@/types/game';

// Store config globally so scene can access it
let pendingGameConfig: {
  playerIds: PlayerId[];
  localPlayerId: PlayerId;
  gameConnection: GameConnection;
  mapWidth: number;
  mapHeight: number;
  backgroundMode: boolean;
} | null = null;

export function getPendingGameConfig() {
  return pendingGameConfig;
}

export function clearPendingGameConfig() {
  pendingGameConfig = null;
}

export function createGame(config: GameConfig): GameInstance {
  // Store config for scene to pick up
  pendingGameConfig = {
    playerIds: config.playerIds ?? [1, 2],
    localPlayerId: config.localPlayerId ?? 1,
    gameConnection: config.gameConnection,
    mapWidth: config.mapWidth,
    mapHeight: config.mapHeight,
    backgroundMode: config.backgroundMode ?? false,
  };

  const bgColor = hexToStr(MAP_BG_COLOR);

  // Create PixiJS application
  const app = new PixiApp(config.parent, config.width, config.height, bgColor);

  // Create and initialize the scene
  const scene = new RtsScene();
  scene._init(app);
  scene.create();

  // Wire up the update loop
  app.onUpdate((time, delta) => {
    scene.update(time, delta);
  });

  app.start();

  // Prevent default wheel behavior on the canvas
  app.canvas.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
  // Prevent context menu
  app.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // Store scene reference for external access
  let _scene: RtsScene | null = scene;

  // Wire up scene restart
  scene.scene.onRestart(() => {
    scene.shutdown();
    // Re-create scene
    const newScene = new RtsScene();
    newScene._init(app);
    newScene.create();
    app.onUpdate((time, delta) => {
      newScene.update(time, delta);
    });
    _scene = newScene;
    newScene.scene.onRestart(() => {
      // Recursive restart support
      _scene?.shutdown();
      _scene = null;
    });
  });

  return {
    app,
    getScene: () => _scene,
  };
}

export function destroyGame(instance: GameInstance): void {
  const scene = instance.getScene();
  if (scene) {
    scene.shutdown();
  }
  instance.app.destroy();
}
