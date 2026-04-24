// Top-level game types extracted from game/createGame.ts and server files

import type { PlayerId } from './sim';
import type { Command } from './commands';
import type { NetworkServerSnapshot } from './network';
import type { SimEvent } from './combat';

// '2d' → Pixi renderer, '3d' → Three.js renderer. Named RendererMode to avoid
// colliding with the existing graphics-quality `RenderMode` in types/graphics.
export type RendererMode = '2d' | '3d';

export type GameConfig = {
  parent: HTMLElement;
  width: number;
  height: number;
  playerIds?: PlayerId[];
  localPlayerId?: PlayerId;
  gameConnection: GameConnection;
  /** ClientViewState owned by GameCanvas so its contents (units, buildings,
   *  prediction, selection, etc.) survive a live renderer swap without
   *  waiting on a keyframe. On first boot the caller creates a fresh one. */
  clientViewState: import('../game/network/ClientViewState').ClientViewState;
  mapWidth: number;
  mapHeight: number;
  backgroundMode?: boolean;
  /** Which renderer to use. Defaults to '2d'. */
  rendererMode?: RendererMode;
};

export type GameScene =
  | import('../game/scenes/RtsScene').RtsScene
  | import('../game/scenes/RtsScene3D').RtsScene3D;

export type GameApp =
  | import('../game/PixiApp').PixiApp
  | import('../game/render3d/ThreeApp').ThreeApp;

export type GameInstance = {
  app: GameApp;
  getScene: () => GameScene | null;
};

/**
 * Portable camera state for the live 2D↔3D renderer swap. Expressed in
 * the game's simulation coords + a single scalar zoom level so both
 * renderers can translate it into their own camera model:
 *
 *   2D (Pixi Camera)      — camera.zoom = zoom;
 *                           camera.centerOn(x, y).
 *   3D (OrbitCamera)      — orbit.setTarget(x, 0, y);
 *                           orbit.distance = baseDistance / zoom.
 *
 * Since zoom is expressed in 2D-equivalent units (1.0 = default
 * framing, 2.0 = twice as zoomed in), the 3D scene's cameraShim
 * `zoom` getter already does this conversion, so swapping between
 * renderers keeps the camera at the same apparent framing.
 */
export type SceneCameraState = {
  x: number;
  y: number;
  zoom: number;
};

export type SnapshotCallback = (state: NetworkServerSnapshot) => void;
export type SimEventCallback = (event: SimEvent) => void;
export type GameOverCallback = (winnerId: PlayerId) => void;

export type GameConnection = {
  sendCommand(command: Command): void;
  onSnapshot(callback: SnapshotCallback): void;
  onSimEvent(callback: SimEventCallback): void;
  onGameOver(callback: GameOverCallback): void;
  disconnect(): void;
};

export type GameServerConfig = {
  playerIds: PlayerId[];
  backgroundMode?: boolean;
  aiPlayerIds?: PlayerId[];
  maxSnapshotsPerSec?: number;
};

export type EmaConfig = {
  avg: number;
  low: { drop: number; recovery: number };
};
