// RemoteGameConnection - WebRTC bridge for remote clients

import type { GameConnection, SnapshotCallback, SimEventCallback, GameOverCallback } from './GameConnection';
import type { Command } from '../sim/commands';
import type { NetworkServerSnapshot } from '../network/NetworkTypes';
import { networkManager } from '../network/NetworkManager';
import { createSnapshotImpairmentQueue } from '../network/SnapshotImpairment';
import { ReusableNetworkSnapshotCloner, cloneNetworkSnapshot } from '../network/snapshotClone';

export class RemoteGameConnection implements GameConnection {
  private snapshotCallback: SnapshotCallback | null = null;
  private gameOverCallback: GameOverCallback | null = null;
  private pendingSnapshot: NetworkServerSnapshot | null = null;
  private pendingSnapshotCloner = new ReusableNetworkSnapshotCloner();
  private snapshotImpairment = createSnapshotImpairmentQueue('remote');
  private disconnected = false;
  private readonly stateHandler: (state: NetworkServerSnapshot) => void;

  constructor() {
    // Wire NetworkManager's state received callback
    this.stateHandler = (state: NetworkServerSnapshot) => {
      if (this.disconnected) return;
      // Decoded snapshots reuse pooled DTOs that the next decode overwrites.
      // A delayed (held-across-decodes) snapshot must be cloned into owned
      // objects, so clone-for-delay is required for pool safety.
      this.snapshotImpairment.schedule(state, (deliveredState) => {
        if (this.disconnected) return;
        this.receiveSnapshot(deliveredState);
      }, cloneNetworkSnapshot);
    };
    networkManager.onStateReceived = this.stateHandler;
  }

  private receiveSnapshot(state: NetworkServerSnapshot): void {
    if (this.snapshotCallback) {
      this.snapshotCallback(state);
    } else if (!this.pendingSnapshot || (this.pendingSnapshot.isDelta && !state.isDelta)) {
      // Buffered across the next decode, which reuses pooled DTOs — clone
      // into owned objects so the held snapshot can't be overwritten.
      this.pendingSnapshot = this.pendingSnapshotCloner.clone(state);
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
    if (this.disconnected) return;
    networkManager.sendCommand(command);
  }

  markClientReady(): void {
    if (this.disconnected) return;
    networkManager.sendClientReady();
  }

  onSnapshot(callback: SnapshotCallback): void {
    if (this.disconnected) return;
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
    if (this.disconnected) return;
    this.gameOverCallback = callback;
  }

  disconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.snapshotImpairment.clear();
    this.snapshotCallback = null;
    this.gameOverCallback = null;
    this.pendingSnapshot = null;
    if (networkManager.onStateReceived === this.stateHandler) {
      networkManager.onStateReceived = undefined;
    }
  }
}
