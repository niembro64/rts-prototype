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

export type PhysicsBody = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  mass: number;
  invMass: number;
  frictionAir: number;
  restitution: number;
  isStatic: boolean;
  label: string;
  halfW?: number;
  halfH?: number;
};

export type EmaConfig = {
  avg: number;
  low: { drop: number; recovery: number };
};
