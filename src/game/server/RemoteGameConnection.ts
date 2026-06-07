// RemoteGameConnection - WebRTC bridge for remote clients

import type { GameConnection, SnapshotCallback, SimEventCallback, GameOverCallback } from './GameConnection';
import type { Command } from '../sim/commands';
import type { NetworkServerSnapshot } from '../network/NetworkTypes';
import { networkManager } from '../network/NetworkManager';
import { createSnapshotImpairmentQueue } from '../network/SnapshotImpairment';
import { ReusableNetworkSnapshotCloner } from '../network/snapshotClone';

export class RemoteGameConnection implements GameConnection {
  private snapshotCallback: SnapshotCallback | null = null;
  private gameOverCallback: GameOverCallback | null = null;
  private pendingSnapshot: NetworkServerSnapshot | null = null;
  private pendingSnapshotRelease: (() => void) | null = null;
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
      this.snapshotImpairment.schedule(state, (deliveredState, releaseSnapshot) => {
        if (this.disconnected) {
          releaseSnapshot?.();
          return;
        }
        this.receiveSnapshot(deliveredState, releaseSnapshot);
      });
    };
    networkManager.onStateReceived = this.stateHandler;
  }

  private receiveSnapshot(
    state: NetworkServerSnapshot,
    releaseSnapshot: (() => void) | undefined = undefined,
  ): void {
    const gameState = state.gameState;
    if (this.snapshotCallback) {
      this.snapshotCallback(state, releaseSnapshot);
    } else if (!this.pendingSnapshot || (this.pendingSnapshot.isDelta && !state.isDelta)) {
      this.releasePendingSnapshot();
      // Buffered across the next decode, which reuses pooled DTOs — clone
      // into owned objects so the held snapshot can't be overwritten.
      this.pendingSnapshot = this.pendingSnapshotCloner.clone(state);
      releaseSnapshot?.();
    } else {
      releaseSnapshot?.();
    }
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

  onSnapshot(callback: SnapshotCallback): () => void {
    if (this.disconnected) return () => undefined;
    this.snapshotCallback = callback;
    const pendingFromNetworkManager = networkManager.consumePendingState();
    const pending = !this.pendingSnapshot ||
      (this.pendingSnapshot.isDelta && pendingFromNetworkManager && !pendingFromNetworkManager.isDelta)
      ? pendingFromNetworkManager
      : this.pendingSnapshot;
    const releasePending = pending === this.pendingSnapshot ? this.pendingSnapshotRelease : null;
    if (pending !== this.pendingSnapshot) this.pendingSnapshotRelease?.();
    this.pendingSnapshot = null;
    this.pendingSnapshotRelease = null;
    if (pending) callback(pending, releasePending ?? undefined);
    return () => {
      if (this.snapshotCallback === callback) this.snapshotCallback = null;
    };
  }

  clearSnapshotCallback(): void {
    this.snapshotCallback = null;
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
    this.releasePendingSnapshot();
    this.pendingSnapshotCloner.clear();
    if (networkManager.onStateReceived === this.stateHandler) {
      networkManager.onStateReceived = undefined;
    }
  }

  getPendingCloneRetainedCounts(): ReturnType<ReusableNetworkSnapshotCloner['getRetainedCounts']> {
    return this.pendingSnapshotCloner.getRetainedCounts();
  }

  private releasePendingSnapshot(): void {
    this.pendingSnapshot = null;
    this.pendingSnapshotRelease?.();
    this.pendingSnapshotRelease = null;
  }
}
