// RemoteGameConnection - WebRTC bridge for remote clients

import type { GameConnection, SnapshotCallback, AudioEventCallback, GameOverCallback } from './GameConnection';
import type { Command } from '../sim/commands';
import type { NetworkGameState } from '../network/NetworkTypes';
import { networkManager } from '../network/NetworkManager';

export class RemoteGameConnection implements GameConnection {
  private snapshotCallback: SnapshotCallback | null = null;
  private gameOverCallback: GameOverCallback | null = null;

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

  onSnapshot(callback: SnapshotCallback): void {
    this.snapshotCallback = callback;
  }

  onAudioEvent(_callback: AudioEventCallback): void {
    // Audio events come through snapshots for remote clients
  }

  onGameOver(callback: GameOverCallback): void {
    this.gameOverCallback = callback;
  }

  disconnect(): void {
    this.snapshotCallback = null;
    this.gameOverCallback = null;
    networkManager.onStateReceived = undefined;
  }
}
