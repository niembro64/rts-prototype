// GameConnection interface - uniform interface for host and remote clients

import type { Command } from '../sim/commands';
import type { NetworkGameState } from '../network/NetworkTypes';
import type { AudioEvent } from '../sim/combat';
import type { PlayerId } from '../sim/types';

export interface GameConnection {
  sendCommand(command: Command): void;
  onSnapshot(callback: (state: NetworkGameState) => void): void;
  onAudioEvent(callback: (event: AudioEvent) => void): void;
  onGameOver(callback: (winnerId: PlayerId) => void): void;
  disconnect(): void;
}
