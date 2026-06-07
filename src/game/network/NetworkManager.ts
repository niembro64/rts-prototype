import Peer, { DataConnection, util, type PeerOptions } from 'peerjs';
import type { PlayerId } from '../sim/types';
import type { Command } from '../sim/commands';
import {
  getDefaultPlayerName,
  saveUsername,
  MAX_NAME_LENGTH,
} from '@/playerNamesConfig';

// Re-export types from NetworkTypes for backward compatibility
export type {
  NetworkMessage,
  NetworkPlayerActionMessage,
  NetworkServerSnapshotMessage,
  NetworkServerSnapshotSimEvent,
  NetworkServerSnapshot,
  NetworkServerSnapshotSprayTarget,
  NetworkServerSnapshotAction,
  NetworkServerSnapshotTurret,
  NetworkServerSnapshotEntity,
  NetworkServerSnapshotEconomy,
  NetworkServerSnapshotResourceMovement,
  NetworkServerSnapshotProjectileSpawn,
  NetworkServerSnapshotProjectileDespawn,
  NetworkServerSnapshotVelocityUpdate,
  NetworkServerSnapshotMinimapEntity,
  NetworkServerSnapshotBeamPoint,
  NetworkServerSnapshotBeamUpdate,
  NetworkServerSnapshotGridCell,
  NetworkServerSnapshotMeta,
  LobbyPlayer,
  LobbySettings,
  NetworkRole,
  BattleHandoff,
} from './NetworkTypes';

import {
  type BattleHandoff,
  type LobbySettings,
} from '@/types/network';
import type {
  NetworkServerSnapshot,
  LobbyPlayer,
  NetworkMessage,
  NetworkRole,
} from './NetworkTypes';
import type { SnapshotWirePayload } from './SnapshotWirePayload';
import {
  buildBattleHandoff,
  normalizeBattleHandoffMessage,
} from './NetworkBattleHandoff';
import { NetworkCommandTransport } from './NetworkCommandTransport';
import { NetworkDataChannelMonitor } from './NetworkDataChannelMonitor';
import { NetworkHeartbeatTracker } from './NetworkHeartbeatTracker';
import { createLobbyPlayer, NetworkLobbyRoster } from './NetworkLobbyRoster';
import {
  generateRoomCode,
  normalizeRoomCode,
  roomCodeToGameId,
} from './NetworkRoomCode';
import {
  NetworkSendBudget,
  type NetworkSendBudgetTelemetry,
} from './NetworkSendBudget';
import { NetworkSnapshotTransport } from './NetworkSnapshotTransport';

// Player-name policy lives in @/playerNamesConfig — single source of
// truth for both seeding (random funny name keyed by playerId) and the
// LOCAL player's persisted username (saved to localStorage on every
// edit, restored on next page load).

const PEER_OPTIONS: PeerOptions = {
  debug: 0,
  // Keep PeerJS's default TURN fallback. The previous STUN-only
  // override worked on easy local networks but could fail for real
  // internet peers behind stricter NATs.
  config: {
    ...util.defaultConfig,
    iceServers: [
      ...util.defaultConfig.iceServers,
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  },
};

const SIGNALING_RECONNECT_INITIAL_DELAY_MS = 1000;
const SIGNALING_RECONNECT_MAX_DELAY_MS = 10000;
type NetworkStateMessage = Extract<NetworkMessage, { type: 'state' }>;

export class NetworkManager {
  private peer: Peer | null = null;
  private connections: Map<PlayerId, DataConnection> = new Map();
  private role: NetworkRole | null = null;
  private roomCode: string = '';
  private localPlayerId: PlayerId = 1;
  private nextPlayerId: PlayerId = 2;
  private roster = new NetworkLobbyRoster();
  private gameStarted: boolean = false;
  private snapshotTransport = new NetworkSnapshotTransport({
    onSnapshotDropped: (playerId) => this.emitSnapshotDropped(playerId),
    onPendingDeltaDropped: () => this.commandTransport.sendSnapshotResyncRequest(),
  });
  private commandTransport = new NetworkCommandTransport({
    getGameId: () => this.getUniversalGameId(),
    getHostConnection: () => this.connections.get(1),
    getRole: () => this.role,
    isMessageForCurrentGame: (message) => this.isMessageForCurrentGame(message.gameId),
    onClientReady: (playerId) => this.emitClientReady(playerId),
    onCommandReceived: (command, fromPlayerId) => this.emitCommandReceived(command, fromPlayerId),
    onSnapshotResyncRequested: (playerId) => this.emitSnapshotDropped(playerId),
    send: (conn, message) => this.safeSend(conn, message),
  });
  private dataChannelMonitor = new NetworkDataChannelMonitor();
  private sendBudget = new NetworkSendBudget({
    onPendingQueued: () => this.scheduleSendBudgetFlush(),
  });
  private heartbeatTracker = new NetworkHeartbeatTracker({
    buildHeartbeat: () => this.buildHeartbeatMessage(),
    closeConnection: (playerId) => {
      const conn = this.connections.get(playerId);
      if (conn !== undefined) conn.close();
    },
    getConnections: () => this.connections,
    isGameStarted: () => this.gameStarted,
    send: (conn, message) => this.safeSend(conn, message),
    sendIntervalMs: undefined,
    timeoutMs: undefined,
  });
  private signalingReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sendBudgetFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private signalingReconnectDelayMs = SIGNALING_RECONNECT_INITIAL_DELAY_MS;
  private pendingStateMessage: NetworkStateMessage | null = null;
  private pendingStateMessageSeq = 0;
  private stateDecodeMessageSeq = 0;
  private stateDecodeNeedsKeyframeAfterSeq = 0;
  private stateDecodeDraining = false;
  private stateDecodeGeneration = 0;
  private sessionGeneration = 0;
  /** 10s connection-setup deadline created by hostGame/joinGame. Held
   *  here so disconnect() can cancel it — otherwise a stale timeout
   *  can fire after the user retries and destroy the new peer. */
  private setupTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private pendingSetupReject: ((error: Error) => void) | null = null;

  // Callbacks
  public onPlayerJoined: ((player: LobbyPlayer) => void) | undefined = undefined;
  public onPlayerLeft: ((playerId: PlayerId) => void) | undefined = undefined;
  public onStateReceived: ((state: NetworkServerSnapshot) => void) | undefined = undefined;
  public onCommandReceived: ((command: Command, fromPlayerId: PlayerId) => void) | undefined = undefined;
  public onGameStart: ((handoff: BattleHandoff) => void) | undefined = undefined;
  public onPlayerAssignment: ((playerId: PlayerId) => void) | undefined = undefined;
  public onError: ((error: string) => void) | undefined = undefined;
  public onConnected: (() => void) | undefined = undefined;
  /** Client-side: invoked when the host's lobby settings arrive
   *  (initial snapshot on connect AND every change while the
   *  lobby is open). The host runs the local copy of these
   *  settings as the source of truth and never receives this
   *  callback itself. */
  public onLobbySettings: ((settings: LobbySettings) => void) | undefined = undefined;
  /** Host-side: read the current lobby settings on demand. The
   *  network layer pulls fresh values whenever it needs to ship
   *  them (e.g. a new player just connected) so the host's
   *  GameCanvas stays the single source of truth — no shadow
   *  copy in the network layer that could drift. */
  public getLobbySettings: (() => LobbySettings) | undefined = undefined;
  /** Fired on every receiver (host AND clients) when a player's
   *  IP / location info arrives or updates. Hosts get this for
   *  joiners reporting in via `playerInfo`; clients get it for
   *  any player via the host's re-broadcast. The receiver
   *  updates its own LobbyPlayer record from `getPlayer(id)`. */
  public onPlayerInfoUpdate: ((player: LobbyPlayer) => void) | undefined = undefined;
  public onClientReady: ((playerId: PlayerId) => void) | undefined = undefined;
  public onSnapshotDropped: ((playerId: PlayerId) => void) | undefined = undefined;

  private emitPlayerJoined(player: LobbyPlayer): void {
    const callback = this.onPlayerJoined;
    if (callback !== undefined) callback(player);
  }

  private emitPlayerLeft(playerId: PlayerId): void {
    const callback = this.onPlayerLeft;
    if (callback !== undefined) callback(playerId);
  }

  private emitStateReceived(state: NetworkServerSnapshot): boolean {
    const callback = this.onStateReceived;
    if (callback === undefined) return false;
    callback(state);
    return true;
  }

  private emitCommandReceived(command: Command, fromPlayerId: PlayerId): void {
    const callback = this.onCommandReceived;
    if (callback !== undefined) callback(command, fromPlayerId);
  }

  private emitGameStart(handoff: BattleHandoff): void {
    const callback = this.onGameStart;
    if (callback !== undefined) callback(handoff);
  }

  private emitPlayerAssignment(playerId: PlayerId): void {
    const callback = this.onPlayerAssignment;
    if (callback !== undefined) callback(playerId);
  }

  private emitError(error: string): void {
    const callback = this.onError;
    if (callback !== undefined) callback(error);
  }

  private emitConnected(): void {
    const callback = this.onConnected;
    if (callback !== undefined) callback();
  }

  private emitLobbySettings(settings: LobbySettings): void {
    const callback = this.onLobbySettings;
    if (callback !== undefined) callback(settings);
  }

  private emitPlayerInfoUpdate(player: LobbyPlayer): void {
    const callback = this.onPlayerInfoUpdate;
    if (callback !== undefined) callback(player);
  }

  private emitClientReady(playerId: PlayerId): void {
    const callback = this.onClientReady;
    if (callback !== undefined) callback(playerId);
  }

  private emitSnapshotDropped(playerId: PlayerId): void {
    const callback = this.onSnapshotDropped;
    if (callback !== undefined) callback(playerId);
  }

  private readLobbySettings(): LobbySettings | undefined {
    const callback = this.getLobbySettings;
    return callback !== undefined ? callback() : undefined;
  }

  private createPeer(peerId: string): Peer {
    return new Peer(peerId, PEER_OPTIONS);
  }

  private clearSignalingReconnect(): void {
    if (this.signalingReconnectTimer !== null) {
      clearTimeout(this.signalingReconnectTimer);
      this.signalingReconnectTimer = null;
    }
  }

  private clearSetupTimeout(): void {
    if (this.setupTimeoutId !== null) {
      clearTimeout(this.setupTimeoutId);
      this.setupTimeoutId = null;
    }
  }

  private clearSendBudgetFlush(): void {
    if (this.sendBudgetFlushTimer !== null) {
      clearTimeout(this.sendBudgetFlushTimer);
      this.sendBudgetFlushTimer = null;
    }
  }

  private cancelPendingSetup(reason: string): void {
    const reject = this.pendingSetupReject;
    this.pendingSetupReject = null;
    if (reject !== null) reject(new Error(reason));
  }

  private beginNetworkSetup(): number {
    this.cancelPendingSetup('Network setup canceled');
    this.clearSignalingReconnect();
    this.clearSetupTimeout();
    this.clearSendBudgetFlush();
    this.signalingReconnectDelayMs = SIGNALING_RECONNECT_INITIAL_DELAY_MS;
    this.sessionGeneration++;
    this.heartbeatTracker.stop();
    this.sendBudget.clear();
    this.dataChannelMonitor.clear();
    for (const conn of this.connections.values()) {
      conn.close();
    }
    this.connections.clear();
    const existingPeer = this.peer;
    if (existingPeer !== null) existingPeer.destroy();
    this.peer = null;
    this.gameStarted = false;
    this.snapshotTransport.reset();
    this.stateDecodeGeneration++;
    this.pendingStateMessage = null;
    this.pendingStateMessageSeq = 0;
    this.stateDecodeMessageSeq = 0;
    this.stateDecodeNeedsKeyframeAfterSeq = 0;
    this.stateDecodeDraining = false;
    return this.sessionGeneration;
  }

  private isCurrentSession(generation: number): boolean {
    return this.sessionGeneration === generation;
  }

  private markSignalingOpen(): void {
    this.clearSignalingReconnect();
    this.signalingReconnectDelayMs = SIGNALING_RECONNECT_INITIAL_DELAY_MS;
  }

  private scheduleHostSignalingReconnect(reason: string): void {
    if (this.role !== 'host' || this.gameStarted) return;
    const peer = this.peer;
    if (!peer || peer.destroyed || !peer.disconnected) return;
    if (this.signalingReconnectTimer !== null) return;

    const delay = this.signalingReconnectDelayMs;
    console.warn(`[NET] Host signaling disconnected while lobby is open (${reason}); reconnecting in ${delay}ms`);
    this.signalingReconnectTimer = setTimeout(() => {
      this.signalingReconnectTimer = null;
      const currentPeer = this.peer;
      if (
        this.role !== 'host' ||
        this.gameStarted ||
        !currentPeer ||
        currentPeer.destroyed ||
        !currentPeer.disconnected
      ) {
        return;
      }

      try {
        currentPeer.reconnect();
        this.signalingReconnectDelayMs = Math.min(
          this.signalingReconnectDelayMs * 2,
          SIGNALING_RECONNECT_MAX_DELAY_MS,
        );
      } catch (err) {
        console.warn('[NET] Host signaling reconnect failed:', err);
        this.scheduleHostSignalingReconnect('reconnect failed');
      }
    }, delay);
  }

  private refreshLocalPlayerInfo(notify = true): LobbyPlayer | null {
    const { player, changed } = this.roster.refreshLocalPlayerInfo(this.localPlayerId);
    if (player && changed && notify) this.emitPlayerInfoUpdate(this.roster.copy(player));
    return player;
  }

  private mergeRosterPlayer(player: LobbyPlayer): LobbyPlayer {
    const result = this.roster.merge(player);
    if (result.joined) this.emitPlayerJoined(this.roster.copy(result.player));
    return result.player;
  }

  // Host a new game
  async hostGame(): Promise<string> {
    const generation = this.beginNetworkSetup();
    this.roomCode = generateRoomCode();
    this.role = 'host';
    this.localPlayerId = 1;
    this.nextPlayerId = 2;
    this.roster.clear();

    // Add host as player 1. The host IS the local player when hosting,
    // so seed with whatever username is persisted in localStorage (or a
    // fresh random funny pick if this is a first-time visitor — which
    // gets persisted immediately so subsequent loads are stable). The
    // user can edit this from their lobby player slot; setLocalPlayerName below
    // persists + broadcasts the change.
    this.roster.seedHost(1);

    return new Promise((resolve, reject) => {
      let resolved = false;
      const isCurrentPeer = (peer: Peer): boolean =>
        this.isCurrentSession(generation) && this.peer === peer;
      const settleResolve = (roomCode: string): void => {
        if (resolved) return;
        resolved = true;
        this.pendingSetupReject = null;
        this.clearSetupTimeout();
        resolve(roomCode);
      };
      const settleReject = (error: Error): void => {
        if (resolved) return;
        resolved = true;
        this.pendingSetupReject = null;
        this.clearSetupTimeout();
        reject(error);
      };
      this.pendingSetupReject = settleReject;

      const installHostPeerHandlers = (peer: Peer): void => {
        peer.on('open', () => {
          if (!isCurrentPeer(peer)) return;
          this.markSignalingOpen();
          this.heartbeatTracker.start();
          console.log('Host peer opened with ID:', peer.id);
          settleResolve(this.roomCode);
        });

        peer.on('connection', (conn) => {
          if (!isCurrentPeer(peer)) {
            conn.close();
            return;
          }
          this.handleIncomingConnection(conn, generation);
        });

        // While the lobby is open, the host must stay registered with
        // the signaling server so new computers can dial ba-ROOM.
        // Once a real battle starts, existing WebRTC data channels no
        // longer need the signaling socket.
        peer.on('disconnected', () => {
          if (!isCurrentPeer(peer)) return;
          console.log('Disconnected from signaling server');
          this.scheduleHostSignalingReconnect('host peer disconnected');
        });

        peer.on('error', (err) => {
          if (!isCurrentPeer(peer)) return;
          console.error('Peer error:', err);
          if (err.type === 'unavailable-id') {
            // Room code already in use, try another
            peer.destroy();
            this.roomCode = generateRoomCode();
            const retryPeer = this.createPeer(this.getUniversalGameId());
            this.peer = retryPeer;
            installHostPeerHandlers(retryPeer);
          } else if (
            err.type === 'disconnected' ||
            err.type === 'network' ||
            err.type === 'server-error' ||
            err.type === 'socket-error' ||
            err.type === 'socket-closed'
          ) {
            settleReject(new Error('Could not connect to game server. Please try again.'));
          } else {
            this.emitError(err.message);
            settleReject(err);
          }
        });
      };

      // Timeout after 10 seconds. Stored on `this` so disconnect()
      // can cancel a setup attempt that's still in flight; without
      // that, a retry creates a fresh peer and the old timer fires
      // 10s later destroying the new one.
      this.clearSetupTimeout();
      this.setupTimeoutId = setTimeout(() => {
        this.setupTimeoutId = null;
        if (resolved || !this.isCurrentSession(generation)) return;
        const currentPeer = this.peer;
        if (currentPeer !== null) currentPeer.destroy();
        this.peer = null;
        settleReject(new Error('Connection timeout - signaling server may be unavailable'));
      }, 10000);

      // Use room code as peer ID prefix for discoverability.
      const peer = this.createPeer(this.getUniversalGameId());
      this.peer = peer;
      installHostPeerHandlers(peer);
    });
  }

  // Join an existing game
  async joinGame(roomCode: string): Promise<void> {
    const generation = this.beginNetworkSetup();
    this.roomCode = normalizeRoomCode(roomCode);
    this.role = 'client';
    this.roster.clear();

    return new Promise((resolve, reject) => {
      let opened = false;
      let settled = false;
      const isCurrentPeer = (peer: Peer): boolean =>
        this.isCurrentSession(generation) && this.peer === peer;
      const settleResolve = (): void => {
        if (settled) return;
        settled = true;
        this.pendingSetupReject = null;
        this.clearSetupTimeout();
        resolve();
      };
      const settleReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        this.pendingSetupReject = null;
        this.clearSetupTimeout();
        reject(error);
      };
      this.pendingSetupReject = settleReject;

      // Generate a random ID for the client
      const clientId = `ba-client-${Math.random().toString(36).substring(2, 10)}`;
      const peer = this.createPeer(clientId);
      this.peer = peer;

      peer.on('open', () => {
        if (!isCurrentPeer(peer)) return;
        console.log('Client peer opened, connecting to host...');

        const conn = peer.connect(this.getUniversalGameId(), {
          reliable: true,
        });

        this.connections.set(1, conn); // Host is always player 1
        this.setupConnectionHandlers(conn, 1, generation);

        conn.on('open', () => {
          if (!this.isCurrentSession(generation) || this.connections.get(1) !== conn) return;
          opened = true;
          console.log('Connected to host');
          // Track host's heartbeats — if the host stops sending
          // for too long, the check loop closes our side of the
          // connection and the regular `playerLeft` path fires.
          this.heartbeatTracker.track(1);
          this.heartbeatTracker.start();
          this.emitConnected();
          settleResolve();
        });

        conn.on('error', (err) => {
          if (!this.isCurrentSession(generation) || this.connections.get(1) !== conn) return;
          console.error('Connection error:', err);
          this.emitError('Failed to connect to host');
          settleReject(err);
        });
      });

      // Handle disconnection from signaling server (OK once connected to host)
      peer.on('disconnected', () => {
        if (!isCurrentPeer(peer)) return;
        console.log('Client disconnected from signaling server (P2P still works)');
      });

      peer.on('error', (err) => {
        if (!isCurrentPeer(peer)) return;
        console.error('Peer error:', err);
        // Ignore signaling server disconnection errors
        if (err.type === 'disconnected' || err.type === 'network') {
          console.log('Signaling server issue (P2P connections still work)');
          return;
        }
        if (err.type === 'peer-unavailable') {
          this.emitError('Game not found - check the code and try again');
          peer.destroy();
          if (this.peer === peer) this.peer = null;
          settleReject(new Error('Game not found'));
          return;
        }
        this.emitError(err.message);
        settleReject(err);
      });

      // Timeout after 10 seconds. Stored on `this` (see hostGame for
      // the same pattern) so disconnect() can cancel an in-flight
      // attempt and avoid destroying a newly-created peer 10s later.
      this.clearSetupTimeout();
      this.setupTimeoutId = setTimeout(() => {
        this.setupTimeoutId = null;
        if (opened || settled || !isCurrentPeer(peer)) return;
        peer.destroy();
        if (this.peer === peer) this.peer = null;
        settleReject(new Error('Connection timeout - room may not exist'));
      }, 10000);
    });
  }

  // Handle incoming connection (host only)
  private handleIncomingConnection(
    conn: DataConnection,
    generation = this.sessionGeneration,
  ): void {
    if (!this.isCurrentSession(generation) || this.gameStarted) {
      // Reject late joiners
      conn.close();
      return;
    }

    if (this.nextPlayerId > 6) {
      // Max players reached
      conn.close();
      return;
    }

    const playerId = this.nextPlayerId++;
    this.connections.set(playerId, conn);
    this.setupConnectionHandlers(conn, playerId, generation);

    conn.on('open', () => {
      if (!this.isCurrentSession(generation) || this.connections.get(playerId) !== conn) return;
      console.log(`Player ${playerId} connected`);

      this.heartbeatTracker.track(playerId);
      this.heartbeatTracker.start();

      const playerName = getDefaultPlayerName(playerId);

      const player = createLobbyPlayer(playerId, playerName, false);
      this.roster.set(player);

      // Send player their assignment
      this.sendTo(playerId, {
        type: 'playerAssignment',
        playerId,
        gameId: this.getUniversalGameId(),
      });

      this.refreshLocalPlayerInfo(false);

      // Send current player list to new player, plus any IP /
       // location info already known about each. Without the
       // info-update follow-up the joiner would see existing
       // players in the list but with their IP/location columns
       // blank until those players happened to re-report.
      for (const p of this.roster.values()) {
        this.sendTo(playerId, {
          type: 'playerJoined',
          gameId: this.getUniversalGameId(),
          playerId: p.playerId,
          playerName: p.name,
        });
        if (
          p.ipAddress !== undefined ||
          p.location !== undefined ||
          p.timezone !== undefined ||
          p.localTime !== undefined
        ) {
          this.sendTo(playerId, this.roster.buildPlayerInfoUpdateMessage(p, this.getUniversalGameId()));
        }
      }

      // Notify all players about new player
      this.broadcast({
        type: 'playerJoined',
        gameId: this.getUniversalGameId(),
        playerId,
        playerName,
      });
      this.emitPlayerJoined(player);

      // Bring the new player up to date on the host's current
      // lobby settings (terrain shape today, more later). Without
      // this initial push the joiner would render their own
      // stored terrain in the preview pane until the host happens
      // to change something — visually inconsistent across
      // clients during the lobby idle state.
      const settings = this.readLobbySettings();
      if (settings) {
        this.sendTo(playerId, {
          type: 'lobbySettings',
          gameId: this.getUniversalGameId(),
          settings,
        });
      }
    });
  }

  // Setup handlers for a connection
  private setupConnectionHandlers(
    conn: DataConnection,
    playerId: PlayerId,
    generation = this.sessionGeneration,
  ): void {
    conn.on('data', (data) => {
      if (!this.isCurrentSession(generation) || this.connections.get(playerId) !== conn) return;
      const message = data as NetworkMessage;
      this.handleMessage(message, playerId);
    });

    conn.on('close', () => {
      if (!this.isCurrentSession(generation) || this.connections.get(playerId) !== conn) return;
      console.warn(`[NET] Player ${playerId} connection CLOSED (role=${this.role})`);
      this.connections.delete(playerId);
      this.sendBudget.clearConnection(conn);
      this.roster.delete(playerId);
      this.heartbeatTracker.untrack(playerId);
      this.snapshotTransport.clearPlayer(playerId);
      this.dataChannelMonitor.detach(playerId);
      this.emitPlayerLeft(playerId);

      if (this.role === 'host') {
        this.broadcast({
          type: 'playerLeft',
          gameId: this.getUniversalGameId(),
          playerId,
        });
      }
    });

    conn.on('error', (err) => {
      if (!this.isCurrentSession(generation) || this.connections.get(playerId) !== conn) return;
      console.error(`[NET] Connection error with player ${playerId}:`, err);
    });

    this.dataChannelMonitor.attach(conn, playerId);
  }

  private isMessageForCurrentGame(gameId: string | undefined): boolean {
    return gameId === undefined || gameId === this.getUniversalGameId();
  }

  // Handle incoming message
  private handleMessage(message: NetworkMessage, fromPlayerId: PlayerId): void {
    // Any inbound message is also a sign of life — refresh the
    // heartbeat-received timestamp for this peer regardless of
    // type. That prevents the timeout sweep from kicking peers
    // who are sending plenty of state but happen to skip a
    // heartbeat tick (snapshots, commands, etc. all count).
    this.heartbeatTracker.markReceived(fromPlayerId);
    switch (message.type) {
      case 'heartbeat':
        if (!this.isMessageForCurrentGame(message.gameId)) return;
        if (this.role === 'host' && message.playerInfo) {
          const { player, changed } = this.roster.applyInfo(fromPlayerId, message.playerInfo);
          if (player && changed) {
            this.emitPlayerInfoUpdate(this.roster.copy(player));
          }
        } else if (this.role === 'client' && message.players) {
          for (const rosterPlayer of message.players) {
            const merged = this.mergeRosterPlayer(rosterPlayer);
            this.emitPlayerInfoUpdate(this.roster.copy(merged));
          }
        }
        return;
      case 'state':
        // Client receives state from host. Host ships snapshots as a
        // MessagePack Uint8Array (optionally FULLSNAP-compressed)
        // so PeerJS carries one flat binary payload instead of a deep
        // object tree.
        if (this.role === 'client') {
          if (!this.isMessageForCurrentGame(message.gameId)) return;
          this.queueStateMessage(message);
        }
        break;

      case 'command':
      case 'clientReady':
      case 'snapshotResync':
        this.commandTransport.handleMessage(message, fromPlayerId);
        break;

      case 'playerInfo':
        // Host: a client is reporting its own IP/location/tz lookup
        // and/or a username rename. Stamp the values on our player
        // record + fan out to every connected client (including the
        // originator — keeps every end pulling from one canonical
        // record set, no special-casing). Field-by-field nullable so
        // a rename-only message doesn't accidentally clobber an
        // already-resolved IP.
        if (this.role === 'host') {
          if (!this.isMessageForCurrentGame(message.gameId)) return;
          const { player } = this.roster.applyInfo(fromPlayerId, message);
          if (player) {
            this.emitPlayerInfoUpdate(this.roster.copy(player));
            this.broadcast(this.roster.buildPlayerInfoUpdateMessage(player, this.getUniversalGameId()));
          }
        }
        break;

      case 'playerAssignment':
        // Client receives their player ID
        if (this.role === 'client') {
          if (!this.isMessageForCurrentGame(message.gameId)) return;
          this.localPlayerId = message.playerId;
          this.emitPlayerAssignment(message.playerId);
        }
        break;

      case 'gameStart':
        // Client receives game start signal
        if (this.role === 'client') {
          if (!this.isMessageForCurrentGame(message.gameId)) return;
          if (message.assignedPlayerId !== undefined) {
            this.localPlayerId = message.assignedPlayerId;
            this.emitPlayerAssignment(message.assignedPlayerId);
          }
          const handoff = normalizeBattleHandoffMessage(
            {
              gameId: message.gameId,
              playerIds: message.playerIds,
              handoff: message.handoff,
            },
            {
              gameId: this.getUniversalGameId(),
              roomCode: this.getRoomCode(),
              playerIds: message.playerIds,
              players: this.roster.asReadonlyMap(),
              settings: this.readLobbySettings(),
            },
          );
          this.roster.applyBattleHandoff(handoff);
          this.gameStarted = true;
          console.log(`[NET] Game start as player ${this.localPlayerId}; players=${handoff.playerIds.join(',')}`);
          this.emitGameStart(handoff);
        }
        break;

      case 'playerJoined':
        if (!this.isMessageForCurrentGame(message.gameId)) return;
        // Update player list without dropping richer metadata that may
        // have arrived first via heartbeat or playerInfoUpdate.
        this.mergeRosterPlayer(createLobbyPlayer(
          message.playerId,
          message.playerName,
          message.playerId === 1,
        ));
        break;

      case 'playerLeft':
        if (!this.isMessageForCurrentGame(message.gameId)) return;
        this.roster.delete(message.playerId);
        this.emitPlayerLeft(message.playerId);
        break;

      case 'playerInfoUpdate':
        // Client: host is fanning out a player's IP/location/tz/name
        // change. Update the matching record so every client's player
        // list stays in sync. Field-by-field nullable matches the
        // host-side handler — a rename-only update doesn't clobber an
        // already-known IP.
        if (this.role === 'client') {
          if (!this.isMessageForCurrentGame(message.gameId)) return;
          const target = this.mergeRosterPlayer(createLobbyPlayer(
            message.playerId,
            message.name ?? getDefaultPlayerName(message.playerId),
            message.playerId === 1,
          ));
          this.roster.applyPlayerInfo(target, message);
          this.emitPlayerInfoUpdate(this.roster.copy(target));
        }
        break;

      case 'lobbySettings':
        // Only meaningful client-side — the host owns the source
        // of truth and never broadcasts to itself.
        if (this.role === 'client') {
          if (!this.isMessageForCurrentGame(message.gameId)) return;
          this.emitLobbySettings(message.settings);
        }
        break;
    }
  }

  /** Host: ship the current lobby settings to every connected
   *  client. Caller invokes this whenever a host-controlled lobby
   *  setting changes (terrain shape today, future knobs later).
   *  No-op on clients. */
  broadcastLobbySettings(settings: LobbySettings): void {
    if (this.role !== 'host') return;
    this.broadcast({
      type: 'lobbySettings',
      gameId: this.getUniversalGameId(),
      settings,
    });
  }

  private buildHeartbeatMessage(): NetworkMessage {
    const self = this.refreshLocalPlayerInfo(true);
    return {
      type: 'heartbeat',
      gameId: this.getUniversalGameId(),
      playerId: this.localPlayerId,
      playerInfo: self ? this.roster.buildLocalPlayerInfo(this.localPlayerId) : undefined,
      players: this.role === 'host' ? this.roster.toArray() : undefined,
    };
  }

  /** Report the LOCAL player's IP / location / timezone and current
   *  username. On the
   *  host this updates the host's record + fans out to every
   *  client; on a client it ships a `playerInfo` to the host
   *  (which then does the broadcast). Caller invokes once the
   *  IP lookup resolves; timezone is available immediately so
   *  it can ride along on that single call. */
  reportLocalPlayerInfo(
    ipAddress: string | undefined,
    location: string | undefined,
    timezone: string | undefined,
  ): void {
    const payload = this.roster.buildReportedLocalPlayerInfo(ipAddress, location, timezone);
    if (this.role === 'host') {
      const { player: self } = this.roster.applyInfo(this.localPlayerId, payload);
      if (self) {
        this.emitPlayerInfoUpdate(this.roster.copy(self));
        this.broadcast(this.roster.buildPlayerInfoUpdateMessage(self, this.getUniversalGameId()));
      }
    } else if (this.role === 'client') {
      const { player: self } = this.roster.applyInfo(this.localPlayerId, payload);
      if (self) {
        this.emitPlayerInfoUpdate(this.roster.copy(self));
      }
      const hostConn = this.connections.get(1);
      if (hostConn) {
        this.safeSend(hostConn, {
          type: 'playerInfo',
          gameId: this.getUniversalGameId(),
          ...payload,
        });
      }
    }
  }

  /** Set the LOCAL player's username. Persists to localStorage so it
   *  survives reloads, updates the local roster, and (when networked)
   *  broadcasts the new value via `playerInfoUpdate` so every other
   *  connected client sees the change. Trims + length-caps the input
   *  to match the same rules saveUsername applies, so a value typed
   *  here matches what eventually lands in storage. */
  setLocalPlayerName(name: string): void {
    const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
    if (trimmed.length === 0) return;
    saveUsername(trimmed);
    const self = this.roster.get(this.localPlayerId);
    if (self && self.name !== trimmed) {
      self.name = trimmed;
      this.refreshLocalPlayerInfo(false);
      this.emitPlayerInfoUpdate(this.roster.copy(self));
    }
    if (this.role === 'host') {
      const player = this.refreshLocalPlayerInfo(false);
      if (player) this.broadcast(this.roster.buildPlayerInfoUpdateMessage(player, this.getUniversalGameId()));
    } else if (this.role === 'client') {
      const hostConn = this.connections.get(1);
      if (hostConn) {
        const payload = this.roster.buildLocalPlayerInfo(this.localPlayerId);
        payload.name = trimmed;
        this.safeSend(hostConn, {
          type: 'playerInfo',
          gameId: this.getUniversalGameId(),
          ...payload,
        });
      }
    }
  }

  /** Convenience for read-only consumers (TopBar) — returns whatever
   *  the local player is currently called, falling back to the
   *  deterministic-by-id default if for some reason the roster hasn't
   *  been populated yet. */
  getLocalPlayerName(): string {
    return this.roster.getLocalPlayerName(this.localPlayerId);
  }

  // Send message to specific player (host only)
  private sendTo(playerId: PlayerId, message: NetworkMessage): boolean {
    const conn = this.connections.get(playerId);
    return conn ? this.safeSend(conn, message) : false;
  }

  // Broadcast message to all connected players (host only)
  private broadcast(message: NetworkMessage, excludePlayerId: PlayerId | undefined = undefined): void {
    for (const [playerId, conn] of this.connections) {
      if (playerId !== excludePlayerId) {
        this.safeSend(conn, message);
      }
    }
  }

  private safeSend(conn: DataConnection, message: NetworkMessage): boolean {
    return this.sendBudget.send(
      conn,
      message,
      (target, payload) => this.rawSend(target, payload),
    );
  }

  private rawSend(conn: DataConnection, message: NetworkMessage): boolean {
    if (!conn.open) return false;
    try {
      conn.send(message);
      return true;
    } catch (err) {
      console.warn('[NET] Failed to send message:', err);
      return false;
    }
  }

  private scheduleSendBudgetFlush(): void {
    if (this.sendBudgetFlushTimer !== null) return;
    this.sendBudgetFlushTimer = setTimeout(() => {
      this.sendBudgetFlushTimer = null;
      const hasPending = this.sendBudget.flushPending(
        this.connections.values(),
        (conn, message) => this.rawSend(conn, message),
      );
      if (hasPending) this.scheduleSendBudgetFlush();
    }, 100);
  }

  getSendBudgetTelemetry(): NetworkSendBudgetTelemetry {
    return this.sendBudget.getTelemetry();
  }

  // Send game state to a specific client (host only).
  // Pre-serializes to a MessagePack Uint8Array so PeerJS's BinaryPack
  // only handles a flat byte buffer (trivial) instead of a deep object
  // tree (expensive to pack/unpack). MessagePack typically halves wire
  // size vs JSON because numbers go on as 1-9 bytes instead of 6-12
  // ASCII chars and field names use a length-prefixed compact form.
  sendStateTo(
    playerId: PlayerId,
    state: NetworkServerSnapshot,
    wirePayload: SnapshotWirePayload | undefined = undefined,
  ): boolean {
    if (this.role !== 'host') return false;
    const conn = this.connections.get(playerId);
    if (!conn) return false;
    const generation = this.sessionGeneration;
    const gameId = this.getUniversalGameId();
    const message = this.snapshotTransport.buildStateMessage(
      playerId,
      conn,
      gameId,
      state,
      wirePayload,
    );
    if (message === null) return false;
    if (message instanceof Promise) {
      void message
        .then((resolved) => {
          if (
            resolved !== null &&
            this.isCurrentSession(generation) &&
            this.role === 'host' &&
            this.getUniversalGameId() === gameId &&
            this.connections.get(playerId) === conn
          ) {
            this.safeSend(conn, resolved);
          }
        })
        .catch((err: unknown) => {
          console.warn('[NET] Failed to build compressed snapshot:', err);
        });
      return true;
    }
    return this.safeSend(conn, message);
  }

  // Send command to host (client only)
  sendCommand(command: Command): void {
    this.commandTransport.sendCommand(command);
  }

  sendClientReady(): void {
    this.commandTransport.sendClientReady();
  }

  consumePendingState(): NetworkServerSnapshot | null {
    return this.snapshotTransport.consumePendingState();
  }

  // Start the game (host only)
  startGame(): void {
    if (this.role !== 'host') return;
    this.gameStarted = true;
    this.clearSignalingReconnect();

    const playerIds = this.getGamePlayerIds();

    // 1-player real games are first-class — they spawn exactly one
    // commander, one base, one team. The same code path that handles
    // 2/4/6/N players runs here too; no fork that injects a fake
    // second team / second commander. The host's real-battle preview
    // (LobbyManager → spawnInitialBases) already iterates `playerIds`
    // unconditionally, so a single id produces a single base.

    const handoff = buildBattleHandoff({
      gameId: this.getUniversalGameId(),
      roomCode: this.getRoomCode(),
      playerIds,
      players: this.roster.asReadonlyMap(),
      settings: this.readLobbySettings(),
    });
    this.roster.applyBattleHandoff(handoff);

    for (const [playerId, conn] of this.connections) {
      this.safeSend(conn, {
        type: 'gameStart',
        gameId: handoff.gameId,
        playerIds: handoff.playerIds,
        handoff,
        assignedPlayerId: playerId,
      });
    }
    this.emitGameStart(handoff);
  }

  private getGamePlayerIds(): PlayerId[] {
    const ids = new Set<PlayerId>([1 as PlayerId]);
    for (const [playerId, conn] of this.connections) {
      if (conn.open) ids.add(playerId);
    }
    return Array.from(ids).sort((a, b) => a - b);
  }

  // Getters
  getRole(): NetworkRole | null {
    return this.role;
  }

  getRoomCode(): string {
    return this.roomCode;
  }

  getUniversalGameId(): string {
    return roomCodeToGameId(this.roomCode);
  }

  getLocalPlayerId(): PlayerId {
    return this.localPlayerId;
  }

  getPlayers(): LobbyPlayer[] {
    return this.roster.toArray();
  }

  getConnectedPlayerIds(): PlayerId[] {
    return Array.from(this.connections.entries())
      .filter(([, conn]) => conn.open)
      .map(([playerId]) => playerId)
      .sort((a, b) => a - b);
  }

  getPlayerCount(): number {
    return this.roster.size;
  }

  isHost(): boolean {
    return this.role === 'host';
  }

  isGameStarted(): boolean {
    return this.gameStarted;
  }

  // Disconnect and cleanup
  disconnect(): void {
    this.beginNetworkSetup();
    this.role = null;
    this.gameStarted = false;
    this.roster.clear();

    // Clear all callbacks to release closure references
    this.onPlayerJoined = undefined;
    this.onPlayerLeft = undefined;
    this.onStateReceived = undefined;
    this.onCommandReceived = undefined;
    this.onGameStart = undefined;
    this.onPlayerAssignment = undefined;
    this.onError = undefined;
    this.onConnected = undefined;
    this.onClientReady = undefined;
    this.onLobbySettings = undefined;
    this.getLobbySettings = undefined;
    this.onPlayerInfoUpdate = undefined;
    this.onSnapshotDropped = undefined;
  }

  private queueStateMessage(message: NetworkStateMessage): void {
    const generation = this.stateDecodeGeneration;
    const messageSeq = ++this.stateDecodeMessageSeq;
    if (this.stateDecodeNeedsKeyframeAfterSeq > 0 && message.isDelta === true) {
      this.stateDecodeNeedsKeyframeAfterSeq = Math.max(
        this.stateDecodeNeedsKeyframeAfterSeq,
        messageSeq,
      );
      this.commandTransport.sendSnapshotResyncRequest();
      return;
    }

    const pending = this.pendingStateMessage;
    if (pending !== null) {
      const droppedPendingSeq = this.pendingStateMessageSeq;
      if (message.isDelta === true) {
        this.pendingStateMessage = null;
        this.pendingStateMessageSeq = 0;
        this.stateDecodeNeedsKeyframeAfterSeq = Math.max(
          this.stateDecodeNeedsKeyframeAfterSeq,
          droppedPendingSeq,
          messageSeq,
        );
        this.commandTransport.sendSnapshotResyncRequest();
        return;
      }
      this.stateDecodeNeedsKeyframeAfterSeq = Math.max(
        this.stateDecodeNeedsKeyframeAfterSeq,
        droppedPendingSeq,
      );
    }
    this.pendingStateMessage = message;
    this.pendingStateMessageSeq = messageSeq;
    if (!this.stateDecodeDraining) {
      this.stateDecodeDraining = true;
      void this.drainStateDecodeQueue(generation);
    }
  }

  private async drainStateDecodeQueue(generation: number): Promise<void> {
    try {
      while (generation === this.stateDecodeGeneration) {
        const message = this.pendingStateMessage;
        if (message === null) return;
        const messageSeq = this.pendingStateMessageSeq;
        this.pendingStateMessage = null;
        this.pendingStateMessageSeq = 0;

        try {
          const hostConn = this.connections.get(1);
          const hostDataChannel = hostConn !== undefined ? hostConn.dataChannel : undefined;
          const state = await this.snapshotTransport.decodeReceivedState(
            message,
            hostDataChannel,
          );
          if (generation !== this.stateDecodeGeneration) return;
          if (this.stateDecodeNeedsKeyframeAfterSeq > 0 && state.isDelta) {
            this.stateDecodeNeedsKeyframeAfterSeq = Math.max(
              this.stateDecodeNeedsKeyframeAfterSeq,
              messageSeq,
            );
            this.commandTransport.sendSnapshotResyncRequest();
            continue;
          }
          if (!state.isDelta && messageSeq > this.stateDecodeNeedsKeyframeAfterSeq) {
            this.stateDecodeNeedsKeyframeAfterSeq = 0;
          }
          if (!this.emitStateReceived(state)) {
            this.snapshotTransport.storePendingState(state);
          }
        } catch (err: unknown) {
          if (generation === this.stateDecodeGeneration) {
            console.warn('[NET] Failed to decode snapshot:', err);
            this.stateDecodeNeedsKeyframeAfterSeq = Math.max(
              this.stateDecodeNeedsKeyframeAfterSeq,
              messageSeq,
            );
            this.commandTransport.sendSnapshotResyncRequest();
          }
        }
      }
    } finally {
      if (generation === this.stateDecodeGeneration) {
        this.stateDecodeDraining = false;
        if (this.pendingStateMessage !== null) {
          this.stateDecodeDraining = true;
          void this.drainStateDecodeQueue(generation);
        }
      }
    }
  }
}

// Singleton instance
export const networkManager = new NetworkManager();
