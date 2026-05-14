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

  setPredictionMode(mode: PredictionMode): void {
    // Routed through the regular command channel — flows over the
    // WebRTC data channel via NetworkCommandTransport just like every
    // other client→server command. The remote host's receiveCommand
    // intercepts the setPredictionMode type and applies it to every
    // snapshot listener belonging to the sender's player. tick=0 is
    // fine here because this is an out-of-band control command (the
    // server-control switch in receiveCommand short-circuits before
    // any tick-synchronization queueing).
    networkManager.sendCommand({ type: 'setPredictionMode', tick: 0, mode });
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
