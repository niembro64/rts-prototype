// Top-level game types extracted from game/createGame.ts and server files

import type { PlayerId } from './sim';
import type { Command } from './commands';
import type { NetworkServerSnapshot } from './network';
import type { SimEvent } from './combat';

export type GameConfig = {
  parent: HTMLElement;
  width: number;
  height: number;
  playerIds?: PlayerId[];
  localPlayerId?: PlayerId;
  gameConnection: GameConnection;
  /** ClientViewState owned by GameCanvas so its contents (units, buildings,
   *  prediction, selection, etc.) survive a scene rebuild without waiting
   *  on a keyframe. On first boot the caller creates a fresh one. */
  clientViewState: import('../game/network/ClientViewState').ClientViewState;
  mapWidth: number;
  mapHeight: number;
  backgroundMode?: boolean;
};

export type GameScene = import('../game/scenes/RtsScene3D').RtsScene3D;

export type GameApp = import('../game/render3d/ThreeApp').ThreeApp;

export type GameInstance = {
  app: GameApp;
  getScene: () => GameScene | null;
};

/** Portable camera state. Sim-space center + scalar zoom; the 3D scene's
 *  cameraShim translates this into orbit distance / target. */
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
  /** Restrict the demo battle's initial-unit spawn to this set of unit
   *  types. When omitted the server falls back to "all background unit
   *  types allowed" — but a caller restoring user-saved demo settings
   *  should pass them here so the initial spawn doesn't create units
   *  the user has deselected (which would then be wiped a tick later
   *  by setBackgroundUnitTypeEnabled, leaving the player with far
   *  fewer initial units than centerSpawnPerPlayer would suggest). */
  initialAllowedTypes?: ReadonlySet<string>;
};

export type EmaConfig = {
  avg: number;
  low: { drop: number; recovery: number };
};
