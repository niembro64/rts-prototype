// LocalGameConnection - In-memory bridge between GameServer and local client (host)

import type { GameConnection, SnapshotCallback, SimEventCallback, GameOverCallback } from './GameConnection';
import type { GameServer } from './GameServer';
import type { Command } from '../sim/commands';
import type { PlayerId } from '../sim/types';
import type { NetworkServerSnapshot } from '../network/NetworkTypes';
import { ReusableNetworkSnapshotCloner } from '../network/snapshotClone';

export class LocalGameConnection implements GameConnection {
  private server: GameServer;
  private snapshotCallback: SnapshotCallback | null = null;
  private gameOverCallback: GameOverCallback | null = null;
  private pendingSnapshot: NetworkServerSnapshot | null = null;
  private pendingSnapshotCloner = new ReusableNetworkSnapshotCloner();
  private snapshotListenerKey: string;
  private gameOverListenerRef: GameOverCallback;
  private playerId?: PlayerId;

  constructor(server: GameServer, playerId?: PlayerId) {
    this.server = server;
    this.playerId = playerId;

    // Wire server snapshot emissions to this connection
    this.snapshotListenerKey = server.addSnapshotListener((state) => {
      if (this.snapshotCallback) {
        this.snapshotCallback(state);
      } else if (!this.pendingSnapshot || (this.pendingSnapshot.isDelta && !state.isDelta)) {
        this.pendingSnapshot = state.isDelta
          ? state
          : this.pendingSnapshotCloner.clone(state);
      }
    }, playerId);

    this.gameOverListenerRef = server.addGameOverListener((winnerId) => {
      this.gameOverCallback?.(winnerId);
    });
  }

  sendCommand(command: Command): void {
    this.server.receiveCommand(command, this.playerId);
  }

  markClientReady(): void {
    this.server.markSnapshotListenerReady(this.snapshotListenerKey);
  }

  onSnapshot(callback: SnapshotCallback): void {
    this.snapshotCallback = callback;
    if (this.pendingSnapshot) {
      const pending = this.pendingSnapshot;
      this.pendingSnapshot = null;
      callback(pending);
    }
  }

  onSimEvent(_callback: SimEventCallback): void {
    // Not used for local - audio events come through snapshots
  }

  onGameOver(callback: GameOverCallback): void {
    this.gameOverCallback = callback;
  }

  disconnect(): void {
    this.server.removeSnapshotListener(this.snapshotListenerKey);
    this.server.removeGameOverListener(this.gameOverListenerRef);
    this.snapshotCallback = null;
    this.gameOverCallback = null;
    this.pendingSnapshot = null;
    this.pendingSnapshotCloner.clear();
  }
}
