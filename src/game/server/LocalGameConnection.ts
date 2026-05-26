// LocalGameConnection - In-memory bridge between GameServer and local client (host)

import type { GameConnection, SnapshotCallback, SimEventCallback, GameOverCallback } from './GameConnection';
import type { GameServer } from './GameServer';
import type { Command } from '../sim/commands';
import type { PlayerId } from '../sim/types';
import type { NetworkServerSnapshot } from '../network/NetworkTypes';
import { ReusableNetworkSnapshotCloner, cloneNetworkSnapshot } from '../network/snapshotClone';
import {
  encodeNetworkSnapshot,
  measureNetworkSnapshotWireBreakdown,
} from '../network/snapshotWireCodec';
import { setSnapshotWireBytes } from '../network/snapshotWireMetadata';
import { createSnapshotImpairmentQueue } from '../network/SnapshotImpairment';
import { SNAPSHOT_CADENCE_REGRESSION } from '../SnapshotCadenceRegression';
import { SNAPSHOT_ENCODE_INSTRUMENTATION } from '../SnapshotEncodeInstrumentation';
import type { CommandAuthority } from './commandAuthority';

export type LocalCommandAuthorityMode = 'player' | 'local-offline';

export class LocalGameConnection implements GameConnection {
  readonly sharesAuthoritativeState = true;

  private server: GameServer | null;
  private snapshotCallback: SnapshotCallback | null = null;
  private gameOverCallback: GameOverCallback | null = null;
  private pendingSnapshot: NetworkServerSnapshot | null = null;
  private pendingSnapshotCloner = new ReusableNetworkSnapshotCloner();
  private snapshotImpairment = createSnapshotImpairmentQueue('local');
  private snapshotListenerKey: string;
  private gameOverListenerRef: GameOverCallback;
  /** Who this client acts as for command attribution. `undefined`
   *  is an explicit spectator authority: the server receives the
   *  command but rejects gameplay and server-control mutations. */
  private commandPlayerId: PlayerId | undefined = undefined;
  private commandAuthorityMode: LocalCommandAuthorityMode;
  /** Whose snapshot view this client receives. `undefined` = global
   *  observer (no fog filter; sees every entity). Decoupled from
   *  commandPlayerId so a true spectator can view-as-N without being
   *  able to issue orders as N (FOW-07). */
  private filterPlayerId: PlayerId | undefined = undefined;

  constructor(
    server: GameServer,
    playerId: PlayerId | undefined = undefined,
    commandAuthorityMode: LocalCommandAuthorityMode = 'player',
  ) {
    this.server = server;
    this.commandPlayerId = playerId;
    this.filterPlayerId = playerId;
    this.commandAuthorityMode = commandAuthorityMode;
    this.snapshotListenerKey = this.subscribeSnapshots(server, playerId);

    this.gameOverListenerRef = server.addGameOverListener((winnerId) => {
      const callback = this.gameOverCallback;
      if (callback !== null) callback(winnerId);
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
   *  cannot order N's units. (FOW-07) */
  setSpectatorTarget(playerId: PlayerId | undefined): void {
    if (this.filterPlayerId === playerId) return;
    this.rebindFilter(playerId);
  }

  private rebindFilter(playerId: PlayerId | undefined): void {
    const server = this.server;
    if (server === null) return;
    this.snapshotImpairment.clear();
    server.removeSnapshotListener(this.snapshotListenerKey);
    SNAPSHOT_ENCODE_INSTRUMENTATION.clearListener(this.snapshotListenerKey, 'local');
    this.filterPlayerId = playerId;
    // Drop any held pending-snapshot from the previous binding — its
    // delta baseline is for the old recipient, so applying it on top
    // of the new view would produce nonsense.
    this.pendingSnapshot = null;
    this.snapshotListenerKey = this.subscribeSnapshots(server, playerId);
    // Mark the fresh listener ready immediately; we know the client
    // scene is already past startup (only running scenes toggle).
    server.markSnapshotListenerReady(this.snapshotListenerKey);
  }

  private subscribeSnapshots(server: GameServer, playerId: PlayerId | undefined): string {
    return server.addSnapshotListener((state) => {
      this.recordLocalSnapshotWireCost(state);
      this.snapshotImpairment.schedule(
        state,
        (deliveredState) => this.receiveSnapshot(deliveredState),
        cloneNetworkSnapshot,
      );
    }, playerId);
  }

  private receiveSnapshot(state: NetworkServerSnapshot): void {
    if (this.snapshotCallback) {
      this.snapshotCallback(state);
    } else if (!this.pendingSnapshot || (this.pendingSnapshot.isDelta && !state.isDelta)) {
      this.pendingSnapshot = state.isDelta
        ? state
        : this.pendingSnapshotCloner.clone(state);
    }
  }

  private recordLocalSnapshotWireCost(state: NetworkServerSnapshot): void {
    const start = performance.now();
    const payload = encodeNetworkSnapshot(state);
    const encodeMs = performance.now() - start;
    setSnapshotWireBytes(state, payload.byteLength);
    if (!SNAPSHOT_CADENCE_REGRESSION.enabled && !SNAPSHOT_ENCODE_INSTRUMENTATION.enabled) return;
    const serverMeta = state.serverMeta;
    const snapshotRate = serverMeta !== undefined ? serverMeta.snaps.rate : undefined;
    const unitCount = serverMeta !== undefined ? serverMeta.units.count : undefined;
    SNAPSHOT_CADENCE_REGRESSION.recordSnapshotEncode({
      rate: snapshotRate,
      bytes: payload.byteLength,
      encodeMs,
    });
    SNAPSHOT_ENCODE_INSTRUMENTATION.record({
      source: 'local',
      listener: this.snapshotListenerKey,
      rate: snapshotRate,
      unitCount,
      bytes: payload.byteLength,
      encodeMs,
      isDelta: state.isDelta,
      breakdown: SNAPSHOT_ENCODE_INSTRUMENTATION.enabled
        ? measureNetworkSnapshotWireBreakdown(state, payload.byteLength)
        : undefined,
    });
  }

  sendCommand(command: Command): void {
    const server = this.server;
    if (server === null) return;
    server.receiveCommand(command, this.commandAuthority());
  }

  private commandAuthority(): CommandAuthority {
    if (this.commandPlayerId === undefined) {
      return { mode: 'spectator', playerId: this.filterPlayerId };
    }
    return {
      mode: this.commandAuthorityMode,
      playerId: this.commandPlayerId,
    };
  }

  markClientReady(): void {
    const server = this.server;
    if (server === null) return;
    server.markSnapshotListenerReady(this.snapshotListenerKey);
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
    const server = this.server;
    if (server === null) return;
    this.server = null;
    this.snapshotImpairment.clear();
    server.removeSnapshotListener(this.snapshotListenerKey);
    SNAPSHOT_ENCODE_INSTRUMENTATION.clearListener(this.snapshotListenerKey, 'local');
    server.removeGameOverListener(this.gameOverListenerRef);
    this.snapshotCallback = null;
    this.gameOverCallback = null;
    this.pendingSnapshot = null;
    this.pendingSnapshotCloner.clear();
  }
}
