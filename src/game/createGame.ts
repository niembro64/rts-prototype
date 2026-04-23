import { RtsScene } from './scenes/RtsScene';
import { RtsScene3D } from './scenes/RtsScene3D';
import { PixiApp } from './PixiApp';
import { ThreeApp } from './render3d/ThreeApp';
import type { PlayerId } from './sim/types';
import type { GameConnection } from './server/GameConnection';
import type { ClientViewState } from './network/ClientViewState';
import { MAP_BG_COLOR, hexToStr } from '../config';

export type { GameConfig, GameInstance, GameScene, GameApp, RendererMode } from '@/types/game';
import type { GameConfig, GameInstance, GameScene } from '@/types/game';

// Store config globally so the 2D scene can access it during create() (matches
// Phaser's initialization order — the 3D scene takes config via its constructor).
let pendingGameConfig: {
  playerIds: PlayerId[];
  localPlayerId: PlayerId;
  gameConnection: GameConnection;
  clientViewState: ClientViewState;
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
  const playerIds = config.playerIds ?? [1, 2];
  const localPlayerId = config.localPlayerId ?? 1;
  const backgroundMode = config.backgroundMode ?? false;
  const rendererMode = config.rendererMode ?? '2d';

  pendingGameConfig = {
    playerIds,
    localPlayerId,
    gameConnection: config.gameConnection,
    clientViewState: config.clientViewState,
    mapWidth: config.mapWidth,
    mapHeight: config.mapHeight,
    backgroundMode,
  };

  const bgColor = hexToStr(MAP_BG_COLOR);

  if (rendererMode === '3d') {
    return createGame3D(config, {
      playerIds,
      localPlayerId,
      backgroundMode,
      bgColor,
    });
  }

  return createGame2D(config, bgColor);
}

function createGame2D(config: GameConfig, bgColor: string): GameInstance {
  const app = new PixiApp(config.parent, config.width, config.height, bgColor);

  const scene = new RtsScene();
  scene._init(app);
  scene.create();

  app.onUpdate((time, delta) => {
    scene.update(time, delta);
  });

  app.start();

  // Match existing 2D behavior: block native wheel scrolling + context menu
  app.canvas.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
  app.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  let _scene: GameScene | null = scene;

  scene.scene.onRestart(() => {
    scene.shutdown();
    const newScene = new RtsScene();
    newScene._init(app);
    newScene.create();
    app.onUpdate((time, delta) => newScene.update(time, delta));
    _scene = newScene;
    newScene.scene.onRestart(() => {
      _scene?.shutdown();
      _scene = null;
    });
  });

  return {
    app,
    getScene: () => _scene,
  };
}

function createGame3D(
  config: GameConfig,
  params: {
    playerIds: PlayerId[];
    localPlayerId: PlayerId;
    backgroundMode: boolean;
    bgColor: string;
  },
): GameInstance {
  const app = new ThreeApp(
    config.parent,
    config.width,
    config.height,
    config.mapWidth,
    config.mapHeight,
    params.bgColor,
  );

  const buildScene = () =>
    new RtsScene3D(app, {
      playerIds: params.playerIds,
      localPlayerId: params.localPlayerId,
      gameConnection: config.gameConnection,
      clientViewState: config.clientViewState,
      mapWidth: config.mapWidth,
      mapHeight: config.mapHeight,
      backgroundMode: params.backgroundMode,
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
 * true for a live renderer swap where the connection is shared with a
 * replacement scene. The caller is responsible for ultimately
 * disconnecting when the game actually ends.
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
