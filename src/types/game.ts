// Top-level game types extracted from game/createGame.ts and server files

import type { PlayerId } from './sim';
import type { Command } from './commands';
import type { NetworkGameState } from './network';
import type { SimEvent } from './combat';

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
};

export type GameInstance = {
  game: import('phaser').Game;
  getScene: () => import('../game/scenes/RtsScene').RtsScene | null;
};

export type SnapshotCallback = (state: NetworkGameState) => void;
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
