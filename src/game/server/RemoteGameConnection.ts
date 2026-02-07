// RemoteGameConnection - WebRTC bridge for remote clients

import type { GameConnection } from './GameConnection';
import type { Command } from '../sim/commands';
import type { NetworkGameState } from '../network/NetworkTypes';
import type { AudioEvent } from '../sim/combat';
import type { PlayerId } from '../sim/types';
import { networkManager } from '../network/NetworkManager';

export class RemoteGameConnection implements GameConnection {
  private snapshotCallback: ((state: NetworkGameState) => void) | null = null;
  private gameOverCallback: ((winnerId: PlayerId) => void) | null = null;

  constructor() {
    // Wire NetworkManager's state received callback
    networkManager.onStateReceived = (state: NetworkGameState) => {
      this.snapshotCallback?.(state);

      // Check for game over in received state
      if (state.gameOver) {
        this.gameOverCallback?.(state.gameOver.winnerId);
      }
    };
  }

  sendCommand(command: Command): void {
    networkManager.sendCommand(command);
  }

  onSnapshot(callback: (state: NetworkGameState) => void): void {
    this.snapshotCallback = callback;
  }

  onAudioEvent(_callback: (event: AudioEvent) => void): void {
    // Audio events come through snapshots for remote clients
  }

  onGameOver(callback: (winnerId: PlayerId) => void): void {
    this.gameOverCallback = callback;
  }

  disconnect(): void {
    this.snapshotCallback = null;
    this.gameOverCallback = null;
  }
}
