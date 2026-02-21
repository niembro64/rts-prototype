// GameConnection interface - uniform interface for host and remote clients

import type { Command } from '../sim/commands';
import type { NetworkGameState } from '../network/NetworkTypes';
import type { SimEvent } from '../sim/combat';
import type { PlayerId } from '../sim/types';

// Named callback types for game connection events
export type SnapshotCallback = (state: NetworkGameState) => void;
export type SimEventCallback = (event: SimEvent) => void;
export type GameOverCallback = (winnerId: PlayerId) => void;

export interface GameConnection {
  sendCommand(command: Command): void;
  onSnapshot(callback: SnapshotCallback): void;
  onSimEvent(callback: SimEventCallback): void;
  onGameOver(callback: GameOverCallback): void;
  disconnect(): void;
}
