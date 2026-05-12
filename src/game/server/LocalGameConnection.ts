// LocalGameConnection - In-memory bridge between GameServer and local client (host)

import type { GameConnection, SnapshotCallback, SimEventCallback, GameOverCallback } from './GameConnection';
import type { GameServer } from './GameServer';
import type { Command } from '../sim/commands';
import type { PlayerId } from '../sim/types';
import type { NetworkServerSnapshot } from '../network/NetworkTypes';
import { ReusableNetworkSnapshotCloner } from '../network/snapshotClone';

export class LocalGameConnection implements GameConnection {
  readonly sharesAuthoritativeState = true;

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
    this.snapshotListenerKey = this.subscribeSnapshots(playerId);

    this.gameOverListenerRef = server.addGameOverListener((winnerId) => {
      this.gameOverCallback?.(winnerId);
    });
  }

  /** Rebind the snapshot listener to a new recipient player. Used when
   *  the demo / lobby-preview / offline scene toggles which seat the
   *  user is viewing as — the server's per-recipient fog-of-war filter
   *  has to follow the toggle, otherwise the client view state stays
   *  populated from the original seat and the shroud / minimap / world
   *  render for "the new player" using the old player's vision sources. */
  setRecipientPlayerId(playerId: PlayerId | undefined): void {
    if (this.playerId === playerId) return;
    this.server.removeSnapshotListener(this.snapshotListenerKey);
    this.playerId = playerId;
    // Drop any held pending-snapshot from the previous binding — its
    // delta baseline is for the old recipient, so applying it on top
    // of the new view would produce nonsense.
    this.pendingSnapshot = null;
    this.snapshotListenerKey = this.subscribeSnapshots(playerId);
    // Mark the fresh listener ready immediately; we know the client
    // scene is already past startup (only running scenes toggle).
    this.server.markSnapshotListenerReady(this.snapshotListenerKey);
  }

  private subscribeSnapshots(playerId: PlayerId | undefined): string {
    return this.server.addSnapshotListener((state) => {
      if (this.snapshotCallback) {
        this.snapshotCallback(state);
      } else if (!this.pendingSnapshot || (this.pendingSnapshot.isDelta && !state.isDelta)) {
        this.pendingSnapshot = state.isDelta
          ? state
          : this.pendingSnapshotCloner.clone(state);
      }
    }, playerId);
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
