// RemoteGameConnection - WebRTC bridge for remote clients

import type { GameConnection, SnapshotCallback, SimEventCallback, GameOverCallback } from './GameConnection';
import type { Command } from '../sim/commands';
import type { NetworkServerSnapshot } from '../network/NetworkTypes';
import { networkManager } from '../network/NetworkManager';
import type { PredictionMode } from '@/types/client';

export class RemoteGameConnection implements GameConnection {
  private snapshotCallback: SnapshotCallback | null = null;
  private gameOverCallback: GameOverCallback | null = null;
  private pendingSnapshot: NetworkServerSnapshot | null = null;

  constructor() {
    // Wire NetworkManager's state received callback
    networkManager.onStateReceived = (state: NetworkServerSnapshot) => {
      if (this.snapshotCallback) {
        this.snapshotCallback(state);
      } else if (!this.pendingSnapshot || (this.pendingSnapshot.isDelta && !state.isDelta)) {
        this.pendingSnapshot = state;
      }

      // Check for game over in received state
      if (state.gameState?.phase === 'gameOver' && state.gameState.winnerId !== undefined) {
        this.gameOverCallback?.(state.gameState.winnerId);
      }
    };
  }

  sendCommand(command: Command): void {
    networkManager.sendCommand(command);
  }

  setPredictionMode(_mode: PredictionMode): void {
    // TODO: wire a ClientPredictionModeChanged data-channel message
    // through NetworkManager so the remote host can apply the
    // per-recipient bandwidth gate. Until then remote clients always
    // receive the full 'acc' payload — correct, just not optimized.
    // See issues.txt PREDICT-aware serializer block.
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
    this.snapshotCallback = null;
    this.gameOverCallback = null;
    this.pendingSnapshot = null;
    networkManager.onStateReceived = undefined;
  }
}
