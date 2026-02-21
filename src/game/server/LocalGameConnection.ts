// LocalGameConnection - In-memory bridge between GameServer and local client (host)

import type { GameConnection, SnapshotCallback, SimEventCallback, GameOverCallback } from './GameConnection';
import type { GameServer } from './GameServer';
import type { Command } from '../sim/commands';

export class LocalGameConnection implements GameConnection {
  private server: GameServer;
  private snapshotCallback: SnapshotCallback | null = null;
  private gameOverCallback: GameOverCallback | null = null;

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

  onSnapshot(callback: SnapshotCallback): void {
    this.snapshotCallback = callback;
  }

  onSimEvent(_callback: SimEventCallback): void {
    // Not used for local - audio events come through snapshots
  }

  onGameOver(callback: GameOverCallback): void {
    this.gameOverCallback = callback;
  }

  disconnect(): void {
    this.snapshotCallback = null;
    this.gameOverCallback = null;
  }
}
