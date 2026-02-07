// LocalGameConnection - In-memory bridge between GameServer and local client (host)

import type { GameConnection } from './GameConnection';
import type { GameServer } from './GameServer';
import type { Command } from '../sim/commands';
import type { NetworkGameState } from '../network/NetworkTypes';
import type { AudioEvent } from '../sim/combat';
import type { PlayerId } from '../sim/types';

export class LocalGameConnection implements GameConnection {
  private server: GameServer;
  private snapshotCallback: ((state: NetworkGameState) => void) | null = null;
  private gameOverCallback: ((winnerId: PlayerId) => void) | null = null;

  constructor(server: GameServer) {
    this.server = server;

    // Wire server snapshot emissions to this connection
    server.addSnapshotListener((state) => {
      this.snapshotCallback?.(state);
    });

    server.addGameOverListener((winnerId) => {
      this.gameOverCallback?.(winnerId);
    });
  }

  sendCommand(command: Command): void {
    this.server.receiveCommand(command);
  }

  onSnapshot(callback: (state: NetworkGameState) => void): void {
    this.snapshotCallback = callback;
  }

  onAudioEvent(_callback: (event: AudioEvent) => void): void {
    // Not used for local - audio events come through snapshots
  }

  onGameOver(callback: (winnerId: PlayerId) => void): void {
    this.gameOverCallback = callback;
  }

  disconnect(): void {
    this.snapshotCallback = null;
    this.gameOverCallback = null;
  }
}
