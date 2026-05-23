// RemoteGameConnection - WebRTC bridge for remote clients

import type { GameConnection, SnapshotCallback, SimEventCallback, GameOverCallback } from './GameConnection';
import type { Command } from '../sim/commands';
import type { NetworkServerSnapshot } from '../network/NetworkTypes';
import { networkManager } from '../network/NetworkManager';
import { createSnapshotImpairmentQueue } from '../network/SnapshotImpairment';

export class RemoteGameConnection implements GameConnection {
  private snapshotCallback: SnapshotCallback | null = null;
  private gameOverCallback: GameOverCallback | null = null;
  private pendingSnapshot: NetworkServerSnapshot | null = null;
  private snapshotImpairment = createSnapshotImpairmentQueue('remote');

  constructor() {
    // Wire NetworkManager's state received callback
    networkManager.onStateReceived = (state: NetworkServerSnapshot) => {
      this.snapshotImpairment.schedule(state, (deliveredState) => {
        this.receiveSnapshot(deliveredState);
      });
    };
  }

  private receiveSnapshot(state: NetworkServerSnapshot): void {
    if (this.snapshotCallback) {
      this.snapshotCallback(state);
    } else if (!this.pendingSnapshot || (this.pendingSnapshot.isDelta && !state.isDelta)) {
      this.pendingSnapshot = state;
    }
    const gameState = state.gameState;
    const gameOverCallback = this.gameOverCallback;
    if (
      gameState !== undefined &&
      gameState.phase === 'gameOver' &&
      gameState.winnerId !== undefined &&
      gameOverCallback !== null
    ) {
      gameOverCallback(gameState.winnerId);
    }
  }

  sendCommand(command: Command): void {
    networkManager.sendCommand(command);
  }

  markClientReady(): void {
    networkManager.sendClientReady();
  }

  onSnapshot(callback: SnapshotCallback): void {
    this.snapshotCallback = callback;
    const pendingFromNetworkManager = networkManager.consumePendingState();
    const pending = !this.pendingSnapshot ||
      (this.pendingSnapshot.isDelta && pendingFromNetworkManager && !pendingFromNetworkManager.isDelta)
      ? pendingFromNetworkManager
      : this.pendingSnapshot;
    this.pendingSnapshot = null;
    if (pending) callback(pending);
  }

  onSimEvent(_callback: SimEventCallback): void {
    // Audio events come through snapshots for remote clients
  }

  onGameOver(callback: GameOverCallback): void {
    this.gameOverCallback = callback;
  }

  disconnect(): void {
    this.snapshotImpairment.clear();
    this.snapshotCallback = null;
    this.gameOverCallback = null;
    this.pendingSnapshot = null;
    networkManager.onStateReceived = undefined;
  }
}
