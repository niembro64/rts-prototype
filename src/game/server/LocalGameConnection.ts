// LocalGameConnection - In-memory bridge between GameServer and local client (host)

import type { GameConnection, SnapshotCallback, SimEventCallback, GameOverCallback } from './GameConnection';
import type { GameServer } from './GameServer';
import type { Command } from '../sim/commands';
import type { PlayerId } from '../sim/types';
import type { NetworkServerSnapshot } from '../network/NetworkTypes';
import type { SnapshotWirePayload } from '../network/SnapshotWirePayload';
import { ReusableNetworkSnapshotCloner } from '../network/snapshotClone';
import {
  decodeNetworkSnapshot,
  encodeNetworkSnapshotDetailed,
  measureNetworkSnapshotWireBreakdown,
} from '../network/snapshotWireCodec';
import {
  addSnapshotMaterializationStageToSnapshot,
  copySnapshotMaterializationMetadata,
} from '../network/snapshotMaterializationMetadata';
import { setSnapshotWireBytes } from '../network/snapshotWireMetadata';
import { createSnapshotImpairmentQueue } from '../network/SnapshotImpairment';
import { SNAPSHOT_CADENCE_REGRESSION } from '../SnapshotCadenceRegression';
import { SNAPSHOT_ENCODE_INSTRUMENTATION } from '../SnapshotEncodeInstrumentation';
import type { CommandAuthority } from './commandAuthority';

export type LocalCommandAuthorityMode = 'player' | 'local-offline';
export type LocalGameConnectionOptions = {
  commandDoorway?: (command: Command, fromPlayerId: PlayerId) => boolean;
  /** Encode local snapshots only to stamp/diagnose estimated wire size.
   *  Leave false for lockstep local presentation: gameplay truth is the
   *  command stream, and SnapshotBuffer clones DTOs before render apply. */
  recordSnapshotWireCost?: boolean;
  loopbackSnapshotsThroughWire?: boolean;
  sharesAuthoritativeState?: boolean;
};

export class LocalGameConnection implements GameConnection {
  readonly sharesAuthoritativeState: boolean;

  private server: GameServer | null;
  private snapshotCallback: SnapshotCallback | null = null;
  private gameOverCallback: GameOverCallback | null = null;
  private pendingSnapshot: NetworkServerSnapshot | null = null;
  private pendingSnapshotRelease: (() => void) | null = null;
  private pendingSnapshotCloner = new ReusableNetworkSnapshotCloner();
  private snapshotImpairment = createSnapshotImpairmentQueue('local');
  private snapshotListenerKey: string;
  private gameOverListenerRef: GameOverCallback;
  /** Who this client acts as for command attribution. `undefined`
   *  is an explicit spectator authority: the server receives the
   *  command but rejects gameplay and server-control mutations. */
  private commandPlayerId: PlayerId | undefined = undefined;
  private commandAuthorityMode: LocalCommandAuthorityMode;
  private readonly commandDoorway: ((command: Command, fromPlayerId: PlayerId) => boolean) | undefined;
  private readonly recordSnapshotWireCost: boolean;
  private readonly loopbackSnapshotsThroughWire: boolean;
  /** Whose snapshot view this client receives. `undefined` = global
   *  observer (no fog filter; sees every entity). Decoupled from
   *  commandPlayerId so a true spectator can view-as-N without being
   *  able to issue orders as N (FOW-07). */
  private filterPlayerId: PlayerId | undefined = undefined;

  constructor(
    server: GameServer,
    playerId: PlayerId | undefined = undefined,
    commandAuthorityMode: LocalCommandAuthorityMode = 'player',
    options: LocalGameConnectionOptions = {},
  ) {
    this.server = server;
    this.commandPlayerId = playerId;
    this.filterPlayerId = playerId;
    this.commandAuthorityMode = commandAuthorityMode;
    this.commandDoorway = options.commandDoorway;
    this.recordSnapshotWireCost = options.recordSnapshotWireCost === true;
    this.loopbackSnapshotsThroughWire = options.loopbackSnapshotsThroughWire === true;
    this.sharesAuthoritativeState = options.sharesAuthoritativeState ??
      !this.loopbackSnapshotsThroughWire;
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
    this.releasePendingSnapshot();
    this.snapshotListenerKey = this.subscribeSnapshots(server, playerId);
    // Mark the fresh listener ready immediately; we know the client
    // scene is already past startup (only running scenes toggle).
    server.markSnapshotListenerReady(this.snapshotListenerKey);
  }

  private subscribeSnapshots(server: GameServer, playerId: PlayerId | undefined): string {
    return server.addSnapshotListener((state, _releaseSnapshot, wirePayload) => {
      const deliveredState = this.materializeLocalSnapshot(state, wirePayload);
      this.snapshotImpairment.schedule(
        deliveredState,
        (deliveredState, releaseSnapshot) => this.receiveSnapshot(deliveredState, releaseSnapshot),
      );
    }, playerId, { preencodeWire: this.loopbackSnapshotsThroughWire });
  }

  private materializeLocalSnapshot(
    state: NetworkServerSnapshot,
    wirePayload: SnapshotWirePayload | undefined = undefined,
  ): NetworkServerSnapshot {
    if (!this.loopbackSnapshotsThroughWire) {
      this.recordLocalSnapshotWireCostIfNeeded(state, wirePayload);
      return state;
    }
    const encoded = wirePayload ?? this.encodeSnapshotForDiagnostics(state);
    this.recordLocalSnapshotWireCostIfNeeded(state, encoded);
    const decoded = decodeNetworkSnapshot(encoded.bytes);
    setSnapshotWireBytes(decoded, encoded.bytes.byteLength);
    copySnapshotMaterializationMetadata(state, decoded);
    return decoded;
  }

  private receiveSnapshot(
    state: NetworkServerSnapshot,
    releaseSnapshot: (() => void) | undefined = undefined,
  ): void {
    if (this.snapshotCallback) {
      this.snapshotCallback(state, releaseSnapshot);
    } else {
      this.releasePendingSnapshot();
      this.pendingSnapshot = this.pendingSnapshotCloner.clone(state);
      this.pendingSnapshotRelease = null;
      releaseSnapshot?.();
    }
  }

  private recordLocalSnapshotWireCostIfNeeded(
    state: NetworkServerSnapshot,
    wirePayload: SnapshotWirePayload | undefined = undefined,
  ): void {
    if (
      wirePayload === undefined &&
      !this.recordSnapshotWireCost &&
      !SNAPSHOT_CADENCE_REGRESSION.enabled &&
      !SNAPSHOT_ENCODE_INSTRUMENTATION.enabled
    ) {
      return;
    }
    const encoded = wirePayload ?? this.encodeSnapshotForDiagnostics(state);
    const payload = encoded.bytes;
    const encodeMs = encoded.encodeMs;
    setSnapshotWireBytes(state, payload.byteLength);
    if (wirePayload === undefined) {
      addSnapshotMaterializationStageToSnapshot(state, 'wireEncode', encodeMs);
    }
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
      encoderKind: encoded.encoderKind,
      materializationKind: encoded.materializationKind,
      rustEntityCount: encoded.rustEntityCount,
      rawEntityCount: encoded.rawEntityCount,
      rawTopLevelKeys: encoded.rawTopLevelKeys,
      breakdown: SNAPSHOT_ENCODE_INSTRUMENTATION.enabled
        ? measureNetworkSnapshotWireBreakdown(state, payload.byteLength)
        : undefined,
    });
  }

  private encodeSnapshotForDiagnostics(state: NetworkServerSnapshot): SnapshotWirePayload {
    const start = performance.now();
    const encoded = encodeNetworkSnapshotDetailed(state);
    return {
      ...encoded,
      encodeMs: performance.now() - start,
      materializationKind: 'dto',
    };
  }

  sendCommand(command: Command): void {
    const server = this.server;
    if (server === null) return;
    if (this.commandDoorway !== undefined && this.commandPlayerId !== undefined) {
      if (this.commandDoorway(command, this.commandPlayerId)) return;
    }
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

  onSnapshot(callback: SnapshotCallback): () => void {
    this.snapshotCallback = callback;
    if (this.pendingSnapshot) {
      const pending = this.pendingSnapshot;
      const releasePending = this.pendingSnapshotRelease;
      this.pendingSnapshot = null;
      this.pendingSnapshotRelease = null;
      callback(pending, releasePending ?? undefined);
    }
    return () => {
      if (this.snapshotCallback === callback) this.snapshotCallback = null;
    };
  }

  clearSnapshotCallback(): void {
    this.snapshotCallback = null;
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
    this.releasePendingSnapshot();
    this.pendingSnapshotCloner.clear();
  }

  private releasePendingSnapshot(): void {
    this.pendingSnapshot = null;
    this.pendingSnapshotRelease?.();
    this.pendingSnapshotRelease = null;
  }
}
