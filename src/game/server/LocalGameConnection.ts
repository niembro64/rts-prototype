// LocalGameConnection - In-memory bridge between GameServer and local client (host)

import type { GameConnection, SnapshotCallback, SimEventCallback, GameOverCallback } from './GameConnection';
import type { GameServer } from './GameServer';
import type { Command } from '../sim/commands';
import type { PlayerId } from '../sim/types';
import type { NetworkServerSnapshot } from '../network/NetworkTypes';
import { ReusableNetworkSnapshotCloner } from '../network/snapshotClone';
import { encodeNetworkSnapshot } from '../network/snapshotWireCodec';
import { SNAPSHOT_CADENCE_REGRESSION } from '../SnapshotCadenceRegression';

export class LocalGameConnection implements GameConnection {
  readonly sharesAuthoritativeState = true;

  private server: GameServer;
  private snapshotCallback: SnapshotCallback | null = null;
  private gameOverCallback: GameOverCallback | null = null;
  private pendingSnapshot: NetworkServerSnapshot | null = null;
  private pendingSnapshotCloner = new ReusableNetworkSnapshotCloner();
  private snapshotListenerKey: string;
  private gameOverListenerRef: GameOverCallback;
  /** Who this client acts as for command attribution. `undefined` =
   *  admin / spectator (no command authority — sendCommand still
   *  reaches the server but with `fromPlayerId` blank, so the
   *  server's authorization layer treats every gameplay command as
   *  an admin override). */
  private commandPlayerId?: PlayerId;
  /** Whose snapshot view this client receives. `undefined` = global
   *  observer (no fog filter; sees every entity). Decoupled from
   *  commandPlayerId so a true spectator can view-as-N without being
   *  able to issue orders as N (issues.txt FOW-07). */
  private filterPlayerId?: PlayerId;

  constructor(server: GameServer, playerId?: PlayerId) {
    this.server = server;
    this.commandPlayerId = playerId;
    this.filterPlayerId = playerId;
    this.snapshotListenerKey = this.subscribeSnapshots(playerId);

    this.gameOverListenerRef = server.addGameOverListener((winnerId) => {
      this.gameOverCallback?.(winnerId);
    });
  }

  /** Rebind the snapshot listener to a new recipient player AND
   *  re-attribute commands to that player. Used by the demo /
   *  lobby-preview / offline flow when the user toggles which seat
   *  they're playing — they expect both their view and their command
   *  authority to follow the toggle. For pure spectating (no command
   *  authority) call setSpectatorTarget instead. */
  setRecipientPlayerId(playerId: PlayerId | undefined): void {
    if (this.commandPlayerId === playerId && this.filterPlayerId === playerId) return;
    this.commandPlayerId = playerId;
    this.rebindFilter(playerId);
  }

  /** Re-aim ONLY the snapshot filter at a new player, leaving command
   *  attribution alone. A spectator client constructs the connection
   *  with playerId=undefined (no command authority) and then calls
   *  setSpectatorTarget(N) whenever the user picks a player to follow
   *  — the server filters as if the spectator were N, but sendCommand
   *  still reaches the server with no attribution so the spectator
   *  cannot order N's units. (issues.txt FOW-07) */
  setSpectatorTarget(playerId: PlayerId | undefined): void {
    if (this.filterPlayerId === playerId) return;
    this.rebindFilter(playerId);
  }

  private rebindFilter(playerId: PlayerId | undefined): void {
    this.server.removeSnapshotListener(this.snapshotListenerKey);
    this.filterPlayerId = playerId;
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
      this.recordLocalSnapshotWireCost(state);
      if (this.snapshotCallback) {
        this.snapshotCallback(state);
      } else if (!this.pendingSnapshot || (this.pendingSnapshot.isDelta && !state.isDelta)) {
        this.pendingSnapshot = state.isDelta
          ? state
          : this.pendingSnapshotCloner.clone(state);
      }
    }, playerId);
  }

  private recordLocalSnapshotWireCost(state: NetworkServerSnapshot): void {
    if (!SNAPSHOT_CADENCE_REGRESSION.enabled) return;
    const start = performance.now();
    const payload = encodeNetworkSnapshot(state);
    SNAPSHOT_CADENCE_REGRESSION.recordSnapshotEncode({
      rate: state.serverMeta?.snaps.rate,
      bytes: payload.byteLength,
      encodeMs: performance.now() - start,
    });
  }

  sendCommand(command: Command): void {
    this.server.receiveCommand(command, this.commandPlayerId);
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
