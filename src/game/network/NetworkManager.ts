import Peer, { DataConnection, util, type PeerOptions } from 'peerjs';
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import type { PlayerId } from '../sim/types';
import type { Command } from '../sim/commands';

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
  NetworkServerSnapshotProjectileSpawn,
  NetworkServerSnapshotProjectileDespawn,
  NetworkServerSnapshotVelocityUpdate,
  NetworkServerSnapshotGridCell,
  NetworkServerSnapshotUnitTypeStats,
  NetworkServerSnapshotCombatStats,
  NetworkServerSnapshotMeta,
  LobbyPlayer,
  NetworkRole,
  BattleHandoff,
} from './NetworkTypes';

import {
  BATTLE_HANDOFF_PROTOCOL,
  type BattleHandoff,
  type LobbySettings,
} from '@/types/network';
import type { NetworkServerSnapshot, LobbyPlayer, NetworkMessage, NetworkRole } from './NetworkTypes';

// Generate a short room code (4 characters)
function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude confusing chars
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function normalizeRoomCode(roomCode: string): string {
  return roomCode.trim().toUpperCase();
}

function roomCodeToGameId(roomCode: string): string {
  return `ba-${normalizeRoomCode(roomCode)}`;
}

function getDefaultPlayerName(playerId: PlayerId): string {
  const colorNames = ['Red', 'Blue', 'Yellow', 'Green', 'Purple', 'Orange'];
  return colorNames[playerId - 1] || `Player ${playerId}`;
}

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

export class NetworkManager {
  private peer: Peer | null = null;
  private connections: Map<PlayerId, DataConnection> = new Map();
  private role: NetworkRole | null = null;
  private roomCode: string = '';
  private localPlayerId: PlayerId = 1;
  private nextPlayerId: PlayerId = 2;
  private players: Map<PlayerId, LobbyPlayer> = new Map();
  private gameStarted: boolean = false;
  private snapshotsSent: number = 0;
  private snapshotsReceived: number = 0;
  private pendingReceivedState: NetworkServerSnapshot | null = null;

  // Heartbeat presence tracking for the lobby roster. Once the real
  // battle starts, we keep sending heartbeats but stop force-closing
  // peers from this timer; WebRTC's own close/error events are the
  // source of truth for an active match.
  private lastHeartbeatReceived: Map<PlayerId, number> = new Map();
  private heartbeatSendInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatCheckInterval: ReturnType<typeof setInterval> | null = null;
  private readonly heartbeatSendIntervalMs = 2000;
  private readonly heartbeatTimeoutMs = 30000;
  private signalingReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private signalingReconnectDelayMs = SIGNALING_RECONNECT_INITIAL_DELAY_MS;

  // Callbacks
  public onPlayerJoined?: (player: LobbyPlayer) => void;
  public onPlayerLeft?: (playerId: PlayerId) => void;
  public onStateReceived?: (state: NetworkServerSnapshot) => void;
  public onCommandReceived?: (command: Command, fromPlayerId: PlayerId) => void;
  public onGameStart?: (handoff: BattleHandoff) => void;
  public onPlayerAssignment?: (playerId: PlayerId) => void;
  public onError?: (error: string) => void;
  public onConnected?: () => void;
  /** Client-side: invoked when the host's lobby settings arrive
   *  (initial snapshot on connect AND every change while the
   *  lobby is open). The host runs the local copy of these
   *  settings as the source of truth and never receives this
   *  callback itself. */
  public onLobbySettings?: (settings: LobbySettings) => void;
  /** Host-side: read the current lobby settings on demand. The
   *  network layer pulls fresh values whenever it needs to ship
   *  them (e.g. a new player just connected) so the host's
   *  GameCanvas stays the single source of truth — no shadow
   *  copy in the network layer that could drift. */
  public getLobbySettings?: () => LobbySettings;
  /** Fired on every receiver (host AND clients) when a player's
   *  IP / location info arrives or updates. Hosts get this for
   *  joiners reporting in via `playerInfo`; clients get it for
   *  any player via the host's re-broadcast. The receiver
   *  updates its own LobbyPlayer record from `getPlayer(id)`. */
  public onPlayerInfoUpdate?: (player: LobbyPlayer) => void;

  private createPeer(peerId: string): Peer {
    return new Peer(peerId, PEER_OPTIONS);
  }

  private clearSignalingReconnect(): void {
    if (this.signalingReconnectTimer !== null) {
      clearTimeout(this.signalingReconnectTimer);
      this.signalingReconnectTimer = null;
    }
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

  // Host a new game
  async hostGame(): Promise<string> {
    this.roomCode = generateRoomCode();
    this.role = 'host';
    this.localPlayerId = 1;
    this.nextPlayerId = 2;
    this.players.clear();
    this.connections.clear();

    // Add host as player 1
    const hostPlayer: LobbyPlayer = {
      playerId: 1,
      name: 'Red', // First color
      isHost: true,
    };
    this.players.set(1, hostPlayer);

    return new Promise((resolve, reject) => {
      let resolved = false;

      // Timeout after 10 seconds
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.peer?.destroy();
          reject(new Error('Connection timeout - signaling server may be unavailable'));
        }
      }, 10000);

      // Use room code as peer ID prefix for discoverability.
      this.peer = this.createPeer(this.getUniversalGameId());

      this.peer.on('open', () => {
        this.markSignalingOpen();
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        console.log('Host peer opened with ID:', this.peer?.id);
        resolve(this.roomCode);
      });

      this.peer.on('connection', (conn) => {
        this.handleIncomingConnection(conn);
      });

      // While the lobby is open, the host must stay registered with
      // the signaling server so new computers can dial ba-ROOM.
      // Once a real battle starts, existing WebRTC data channels no
      // longer need the signaling socket.
      this.peer.on('disconnected', () => {
        console.log('Disconnected from signaling server');
        this.scheduleHostSignalingReconnect('host peer disconnected');
      });

      this.peer.on('error', (err) => {
        console.error('Peer error:', err);
        if (err.type === 'unavailable-id') {
          // Room code already in use, try another
          this.peer?.destroy();
          this.roomCode = generateRoomCode();
          this.peer = this.createPeer(this.getUniversalGameId());
          this.peer.on('open', () => {
            this.markSignalingOpen();
            if (resolved) return;
            resolved = true;
            clearTimeout(timeout);
            resolve(this.roomCode);
          });
          this.peer.on('connection', (conn) => this.handleIncomingConnection(conn));
          this.peer.on('disconnected', () => {
            console.log('Disconnected from signaling server');
            this.scheduleHostSignalingReconnect('host peer disconnected');
          });
          this.peer.on('error', (e) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timeout);
            reject(e);
          });
        } else if (err.type === 'disconnected' || err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error' || err.type === 'socket-closed') {
          // Connection to signaling server failed
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            reject(new Error('Could not connect to game server. Please try again.'));
          }
        } else {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeout);
          this.onError?.(err.message);
          reject(err);
        }
      });
    });
  }

  // Join an existing game
  async joinGame(roomCode: string): Promise<void> {
    this.roomCode = normalizeRoomCode(roomCode);
    this.role = 'client';
    this.players.clear();
    this.connections.clear();

    return new Promise((resolve, reject) => {
      let opened = false;
      // Generate a random ID for the client
      const clientId = `ba-client-${Math.random().toString(36).substring(2, 10)}`;
      this.peer = this.createPeer(clientId);

      this.peer.on('open', () => {
        console.log('Client peer opened, connecting to host...');

        const conn = this.peer!.connect(this.getUniversalGameId(), {
          reliable: true,
        });

        this.connections.set(1, conn); // Host is always player 1
        this.setupConnectionHandlers(conn, 1);

        conn.on('open', () => {
          opened = true;
          console.log('Connected to host');
          // Track host's heartbeats — if the host stops sending
          // for too long, the check loop closes our side of the
          // connection and the regular `playerLeft` path fires.
          this.lastHeartbeatReceived.set(1, Date.now());
          this.startHeartbeats();
          this.onConnected?.();
          resolve();
        });

        conn.on('error', (err) => {
          console.error('Connection error:', err);
          this.onError?.('Failed to connect to host');
          reject(err);
        });
      });

      // Handle disconnection from signaling server (OK once connected to host)
      this.peer.on('disconnected', () => {
        console.log('Client disconnected from signaling server (P2P still works)');
      });

      this.peer.on('error', (err) => {
        console.error('Peer error:', err);
        // Ignore signaling server disconnection errors
        if (err.type === 'disconnected' || err.type === 'network') {
          console.log('Signaling server issue (P2P connections still work)');
          return;
        }
        if (err.type === 'peer-unavailable') {
          this.onError?.('Game not found - check the code and try again');
          this.peer?.destroy();
          this.peer = null;
          reject(new Error('Game not found'));
          return;
        }
        this.onError?.(err.message);
        reject(err);
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        if (!opened) {
          this.peer?.destroy();
          this.peer = null;
          reject(new Error('Connection timeout - room may not exist'));
        }
      }, 10000);
    });
  }

  // Handle incoming connection (host only)
  private handleIncomingConnection(conn: DataConnection): void {
    if (this.gameStarted) {
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
    this.setupConnectionHandlers(conn, playerId);

    conn.on('open', () => {
      console.log(`Player ${playerId} connected`);

      // Begin tracking heartbeats from this peer; if it goes
      // silent for `heartbeatTimeoutMs`, the check loop will
      // close the connection and trigger normal cleanup.
      this.lastHeartbeatReceived.set(playerId, Date.now());
      this.startHeartbeats();

      const playerName = getDefaultPlayerName(playerId);

      const player: LobbyPlayer = {
        playerId,
        name: playerName,
        isHost: false,
      };
      this.players.set(playerId, player);

      // Send player their assignment
      this.sendTo(playerId, {
        type: 'playerAssignment',
        playerId,
        gameId: this.getUniversalGameId(),
      });

      // Send current player list to new player, plus any IP /
       // location info already known about each. Without the
       // info-update follow-up the joiner would see existing
       // players in the list but with their IP/location columns
       // blank until those players happened to re-report.
      for (const p of this.players.values()) {
        this.sendTo(playerId, {
          type: 'playerJoined',
          gameId: this.getUniversalGameId(),
          playerId: p.playerId,
          playerName: p.name,
        });
        if (
          p.ipAddress !== undefined ||
          p.location !== undefined ||
          p.timezone !== undefined
        ) {
          this.sendTo(playerId, {
            type: 'playerInfoUpdate',
            gameId: this.getUniversalGameId(),
            playerId: p.playerId,
            ipAddress: p.ipAddress,
            location: p.location,
            timezone: p.timezone,
          });
        }
      }

      // Notify all players about new player
      this.broadcast({
        type: 'playerJoined',
        gameId: this.getUniversalGameId(),
        playerId,
        playerName,
      });
      this.onPlayerJoined?.(player);

      // Bring the new player up to date on the host's current
      // lobby settings (terrain shape today, more later). Without
      // this initial push the joiner would render their own
      // stored terrain in the preview pane until the host happens
      // to change something — visually inconsistent across
      // clients during the lobby idle state.
      const settings = this.getLobbySettings?.();
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
  private setupConnectionHandlers(conn: DataConnection, playerId: PlayerId): void {
    conn.on('data', (data) => {
      const message = data as NetworkMessage;
      this.handleMessage(message, playerId);
    });

    conn.on('close', () => {
      console.warn(`[NET] Player ${playerId} connection CLOSED (role=${this.role})`);
      this.connections.delete(playerId);
      this.players.delete(playerId);
      this.lastHeartbeatReceived.delete(playerId);
      this.onPlayerLeft?.(playerId);

      if (this.role === 'host') {
        this.broadcast({
          type: 'playerLeft',
          gameId: this.getUniversalGameId(),
          playerId,
        });
      }
    });

    conn.on('error', (err) => {
      console.error(`[NET] Connection error with player ${playerId}:`, err);
    });

    // Monitor underlying DataChannel state changes (use addEventListener to avoid
    // overwriting PeerJS's internal onclose/onerror handlers)
    const dc = conn.dataChannel;
    if (dc) {
      this.monitorDataChannel(dc, playerId);
    } else {
      let dcAttempts = 0;
      const checkDc = setInterval(() => {
        dcAttempts++;
        if (conn.dataChannel) {
          this.monitorDataChannel(conn.dataChannel, playerId);
          clearInterval(checkDc);
        } else if (dcAttempts > 50) {
          clearInterval(checkDc);
        }
      }, 100);
    }
  }

  private monitorDataChannel(dc: RTCDataChannel, playerId: PlayerId): void {
    dc.addEventListener('close', () => {
      console.warn(`[NET] DataChannel CLOSED for player ${playerId} (state=${dc.readyState})`);
    });
    dc.addEventListener('error', (e) => {
      console.error(`[NET] DataChannel ERROR for player ${playerId}:`, e);
    });
  }

  private isMessageForCurrentGame(message: { gameId?: string }): boolean {
    return !message.gameId || message.gameId === this.getUniversalGameId();
  }

  private buildBattleHandoff(playerIds: PlayerId[]): BattleHandoff {
    const normalizedPlayerIds = [...new Set(playerIds)].sort((a, b) => a - b);
    const players = normalizedPlayerIds.map((playerId) => {
      const existing = this.players.get(playerId);
      return existing
        ? { ...existing }
        : {
            playerId,
            name: getDefaultPlayerName(playerId),
            isHost: playerId === 1,
          };
    });
    return {
      protocol: BATTLE_HANDOFF_PROTOCOL,
      gameId: this.getUniversalGameId(),
      roomCode: this.getRoomCode(),
      hostPlayerId: 1 as PlayerId,
      playerIds: normalizedPlayerIds,
      players,
    };
  }

  private normalizeBattleHandoff(message: { gameId?: string; playerIds: PlayerId[]; handoff?: BattleHandoff }): BattleHandoff {
    const handoff = message.handoff;
    if (
      handoff &&
      handoff.protocol === BATTLE_HANDOFF_PROTOCOL &&
      handoff.gameId === this.getUniversalGameId()
    ) {
      return {
        ...handoff,
        roomCode: normalizeRoomCode(handoff.roomCode),
        playerIds: [...new Set(handoff.playerIds)].sort((a, b) => a - b),
        players: handoff.players.map((player) => ({ ...player })),
      };
    }
    return this.buildBattleHandoff(message.playerIds);
  }

  private applyBattleHandoff(handoff: BattleHandoff): void {
    for (const player of handoff.players) {
      this.players.set(player.playerId, { ...player });
    }
  }

  // Handle incoming message
  private handleMessage(message: NetworkMessage, fromPlayerId: PlayerId): void {
    // Any inbound message is also a sign of life — refresh the
    // heartbeat-received timestamp for this peer regardless of
    // type. That prevents the timeout sweep from kicking peers
    // who are sending plenty of state but happen to skip a
    // heartbeat tick (snapshots, commands, etc. all count).
    if (this.lastHeartbeatReceived.has(fromPlayerId)) {
      this.lastHeartbeatReceived.set(fromPlayerId, Date.now());
    }
    switch (message.type) {
      case 'heartbeat':
        if (!this.isMessageForCurrentGame(message)) return;
        // Bookkeeping only — the unconditional refresh above
        // already updated the timestamp. Nothing else to do.
        return;
      case 'state':
        // Client receives state from host. Host now ships state as a
        // MessagePack Uint8Array; legacy JSON-string form is still
        // accepted as a fallback so a mixed-version game doesn't crash
        // on the first frame after upgrade.
        if (this.role === 'client') {
          if (!this.isMessageForCurrentGame(message)) return;
          this.snapshotsReceived++;
          if (this.snapshotsReceived % 100 === 0) {
            const hostConn = this.connections.get(1);
            const dc = hostConn?.dataChannel;
            console.log(`[NET] Client received snapshot #${this.snapshotsReceived} (dc=${dc?.readyState ?? 'none'})`);
          }
          const raw = message.data;
          let state: NetworkServerSnapshot;
          if (raw instanceof Uint8Array) {
            state = msgpackDecode(raw) as NetworkServerSnapshot;
          } else if (raw instanceof ArrayBuffer) {
            state = msgpackDecode(new Uint8Array(raw)) as NetworkServerSnapshot;
          } else if (typeof raw === 'string') {
            state = JSON.parse(raw);
          } else {
            state = raw as NetworkServerSnapshot;
          }
          if (this.onStateReceived) {
            this.onStateReceived(state);
          } else if (!this.pendingReceivedState || (this.pendingReceivedState.isDelta && !state.isDelta)) {
            this.pendingReceivedState = state;
          }
        }
        break;

      case 'command':
        // Host receives command from client
        if (this.role === 'host') {
          if (!this.isMessageForCurrentGame(message)) return;
          this.onCommandReceived?.(message.data, fromPlayerId);
        }
        break;

      case 'playerInfo':
        // Host: a client just resolved its own IP/location/tz
        // lookup and is reporting in. Stamp the values on our
        // player record + fan out to every connected client
        // (including the originator — keeps every end pulling
        // from one canonical record set, no special-casing).
        if (this.role === 'host') {
          if (!this.isMessageForCurrentGame(message)) return;
          const player = this.players.get(fromPlayerId);
          if (player) {
            player.ipAddress = message.ipAddress;
            player.location = message.location;
            player.timezone = message.timezone;
            this.onPlayerInfoUpdate?.(player);
            this.broadcast({
              type: 'playerInfoUpdate',
              gameId: this.getUniversalGameId(),
              playerId: fromPlayerId,
              ipAddress: message.ipAddress,
              location: message.location,
              timezone: message.timezone,
            });
          }
        }
        break;

      case 'playerAssignment':
        // Client receives their player ID
        if (this.role === 'client') {
          if (!this.isMessageForCurrentGame(message)) return;
          this.localPlayerId = message.playerId;
          this.onPlayerAssignment?.(message.playerId);
        }
        break;

      case 'gameStart':
        // Client receives game start signal
        if (this.role === 'client') {
          if (!this.isMessageForCurrentGame(message)) return;
          if (message.assignedPlayerId !== undefined) {
            this.localPlayerId = message.assignedPlayerId;
            this.onPlayerAssignment?.(message.assignedPlayerId);
          }
          const handoff = this.normalizeBattleHandoff(message);
          this.applyBattleHandoff(handoff);
          this.gameStarted = true;
          console.log(`[NET] Game start as player ${this.localPlayerId}; players=${handoff.playerIds.join(',')}`);
          this.onGameStart?.(handoff);
        }
        break;

      case 'playerJoined':
        if (!this.isMessageForCurrentGame(message)) return;
        // Update player list
        this.players.set(message.playerId, {
          playerId: message.playerId,
          name: message.playerName,
          isHost: message.playerId === 1,
        });
        this.onPlayerJoined?.(this.players.get(message.playerId)!);
        break;

      case 'playerLeft':
        if (!this.isMessageForCurrentGame(message)) return;
        this.players.delete(message.playerId);
        this.onPlayerLeft?.(message.playerId);
        break;

      case 'playerInfoUpdate':
        // Client: host is fanning out a player's IP/location/tz.
        // Update the matching record so every client's player
        // list stays in sync.
        if (this.role === 'client') {
          if (!this.isMessageForCurrentGame(message)) return;
          const target = this.players.get(message.playerId);
          if (target) {
            target.ipAddress = message.ipAddress;
            target.location = message.location;
            target.timezone = message.timezone;
            this.onPlayerInfoUpdate?.(target);
          }
        }
        break;

      case 'lobbySettings':
        // Only meaningful client-side — the host owns the source
        // of truth and never broadcasts to itself.
        if (this.role === 'client') {
          if (!this.isMessageForCurrentGame(message)) return;
          this.onLobbySettings?.(message.settings);
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

  /** Begin emitting heartbeat pings to every open connection +
   *  start the timeout sweep. Idempotent — calling twice is a
   *  no-op once timers exist. Called from hostGame / joinGame
   *  once a peer is established; stopped on `disconnect`. */
  private startHeartbeats(): void {
    if (this.heartbeatSendInterval !== null) return;
    const now = Date.now();
    for (const pid of this.connections.keys()) {
      this.lastHeartbeatReceived.set(pid, now);
    }
    this.heartbeatSendInterval = setInterval(() => {
      const beat: NetworkMessage = {
        type: 'heartbeat',
        gameId: this.getUniversalGameId(),
        playerId: this.localPlayerId,
      };
      for (const conn of this.connections.values()) {
        this.safeSend(conn, beat);
      }
    }, this.heartbeatSendIntervalMs);
    this.heartbeatCheckInterval = setInterval(() => {
      if (this.gameStarted) return;
      const cutoff = Date.now() - this.heartbeatTimeoutMs;
      for (const [pid, lastSeen] of this.lastHeartbeatReceived) {
        if (lastSeen < cutoff) {
          // Force-close the silent connection — its close handler
          // (setupConnectionHandlers) cleans up `players` /
          // `connections` and fires `onPlayerLeft`, so the lobby
          // roster updates without any extra plumbing here.
          const conn = this.connections.get(pid);
          if (conn) conn.close();
          this.lastHeartbeatReceived.delete(pid);
        }
      }
    }, 1000);
  }

  private stopHeartbeats(): void {
    if (this.heartbeatSendInterval) {
      clearInterval(this.heartbeatSendInterval);
      this.heartbeatSendInterval = null;
    }
    if (this.heartbeatCheckInterval) {
      clearInterval(this.heartbeatCheckInterval);
      this.heartbeatCheckInterval = null;
    }
    this.lastHeartbeatReceived.clear();
  }

  /** Report the LOCAL player's IP / location / timezone. On the
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
    if (this.role === 'host') {
      const self = this.players.get(this.localPlayerId);
      if (self) {
        self.ipAddress = ipAddress;
        self.location = location;
        self.timezone = timezone;
        this.onPlayerInfoUpdate?.(self);
        this.broadcast({
          type: 'playerInfoUpdate',
          gameId: this.getUniversalGameId(),
          playerId: this.localPlayerId,
          ipAddress,
          location,
          timezone,
        });
      }
    } else if (this.role === 'client') {
      const hostConn = this.connections.get(1);
      if (hostConn) {
        this.safeSend(hostConn, {
          type: 'playerInfo',
          gameId: this.getUniversalGameId(),
          ipAddress,
          location,
          timezone,
        });
      }
    }
  }

  // Send message to specific player (host only)
  private sendTo(playerId: PlayerId, message: NetworkMessage): void {
    const conn = this.connections.get(playerId);
    if (conn) this.safeSend(conn, message);
  }

  // Broadcast message to all connected players (host only)
  private broadcast(message: NetworkMessage, excludePlayerId?: PlayerId): void {
    for (const [playerId, conn] of this.connections) {
      if (playerId !== excludePlayerId) {
        this.safeSend(conn, message);
      }
    }
  }

  private safeSend(conn: DataConnection, message: NetworkMessage): boolean {
    if (!conn.open) return false;
    try {
      conn.send(message);
      return true;
    } catch (err) {
      console.warn('[NET] Failed to send message:', err);
      return false;
    }
  }

  // Send game state to all clients (host only)
  // Pre-serializes to a MessagePack Uint8Array so PeerJS's BinaryPack
  // only handles a flat byte buffer (trivial) instead of a deep object
  // tree (expensive to pack/unpack). MessagePack typically halves wire
  // size vs JSON because numbers go on as 1-9 bytes instead of 6-12
  // ASCII chars and field names use a length-prefixed compact form.
  broadcastState(state: NetworkServerSnapshot): void {
    if (this.role !== 'host') return;
    this.snapshotsSent++;

    // Pre-serialize once for all clients (msgpack-javascript is fast,
    // does no per-call allocations beyond the result buffer).
    const buf = msgpackEncode(state);

    // Log every 100th snapshot with connection health + payload size
    if (this.snapshotsSent % 100 === 0) {
      for (const [pid, conn] of this.connections) {
        const dc = conn.dataChannel;
        const buffered = dc ? dc.bufferedAmount : -1;
        const dcState = dc ? dc.readyState : 'no-dc';
        console.log(`[NET] Host snapshot #${this.snapshotsSent} → player ${pid}: open=${conn.open} dc=${dcState} buffered=${buffered} size=${buf.byteLength}`);
      }
    }

    this.broadcast({
      type: 'state',
      gameId: this.getUniversalGameId(),
      data: buf,
    });
  }

  sendStateTo(playerId: PlayerId, state: NetworkServerSnapshot): void {
    if (this.role !== 'host') return;
    const conn = this.connections.get(playerId);
    if (!conn || !conn.open) return;

    this.snapshotsSent++;
    const buf = msgpackEncode(state);

    if (this.snapshotsSent % 100 === 0) {
      const dc = conn.dataChannel;
      const buffered = dc ? dc.bufferedAmount : -1;
      const dcState = dc ? dc.readyState : 'no-dc';
      console.log(`[NET] Host snapshot #${this.snapshotsSent} -> player ${playerId}: open=${conn.open} dc=${dcState} buffered=${buffered} size=${buf.byteLength}`);
    }

    this.sendTo(playerId, {
      type: 'state',
      gameId: this.getUniversalGameId(),
      data: buf,
    });
  }

  // Send command to host (client only)
  sendCommand(command: Command): void {
    if (this.role !== 'client') return;
    const hostConn = this.connections.get(1);
    if (hostConn) {
      this.safeSend(hostConn, {
        type: 'command',
        gameId: this.getUniversalGameId(),
        data: command,
      });
    }
  }

  consumePendingState(): NetworkServerSnapshot | null {
    const state = this.pendingReceivedState;
    this.pendingReceivedState = null;
    return state;
  }

  // Start the game (host only)
  startGame(): void {
    if (this.role !== 'host') return;
    this.gameStarted = true;
    this.clearSignalingReconnect();

    let playerIds = this.getGamePlayerIds();

    // Single player mode: spawn 2 commanders so player can toggle between sides
    if (playerIds.length === 1) {
      playerIds = [1, 2];
    }

    const handoff = this.buildBattleHandoff(playerIds);
    this.applyBattleHandoff(handoff);

    for (const [playerId, conn] of this.connections) {
      this.safeSend(conn, {
        type: 'gameStart',
        gameId: handoff.gameId,
        playerIds: handoff.playerIds,
        handoff,
        assignedPlayerId: playerId,
      });
    }
    this.onGameStart?.(handoff);
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
    return Array.from(this.players.values());
  }

  getConnectedPlayerIds(): PlayerId[] {
    return Array.from(this.connections.keys()).sort((a, b) => a - b);
  }

  getPlayerCount(): number {
    return this.players.size;
  }

  isHost(): boolean {
    return this.role === 'host';
  }

  isGameStarted(): boolean {
    return this.gameStarted;
  }

  // Disconnect and cleanup
  disconnect(): void {
    this.clearSignalingReconnect();
    this.stopHeartbeats();
    for (const conn of this.connections.values()) {
      conn.close();
    }
    this.connections.clear();
    this.peer?.destroy();
    this.peer = null;
    this.role = null;
    this.gameStarted = false;
    this.players.clear();
    this.pendingReceivedState = null;

    // Clear all callbacks to release closure references
    this.onPlayerJoined = undefined;
    this.onPlayerLeft = undefined;
    this.onStateReceived = undefined;
    this.onCommandReceived = undefined;
    this.onGameStart = undefined;
    this.onPlayerAssignment = undefined;
    this.onError = undefined;
    this.onConnected = undefined;
  }
}

// Singleton instance
export const networkManager = new NetworkManager();
