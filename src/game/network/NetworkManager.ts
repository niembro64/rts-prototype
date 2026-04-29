import Peer, { DataConnection } from 'peerjs';
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
} from './NetworkTypes';

import type { NetworkServerSnapshot, LobbyPlayer, NetworkMessage, NetworkRole } from './NetworkTypes';
import type { LobbySettings } from '@/types/network';

// Generate a short room code (4 characters)
function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude confusing chars
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

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

  // Heartbeat presence tracking. Every connected peer sends a
  // `heartbeat` message every `heartbeatSendIntervalMs`; the
  // receiving side records the timestamp here. The check loop
  // sweeps the map every second and force-closes any connection
  // whose last heartbeat is older than `heartbeatTimeoutMs` —
  // that fires the regular `connection.close` handler (see
  // `setupConnectionHandlers`) which in turn calls
  // `onPlayerLeft`, so the GAME LOBBY player roster stays
  // accurate even when PeerJS misses a silent network drop.
  private lastHeartbeatReceived: Map<PlayerId, number> = new Map();
  private heartbeatSendInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatCheckInterval: ReturnType<typeof setInterval> | null = null;
  private readonly heartbeatSendIntervalMs = 2000;
  private readonly heartbeatTimeoutMs = 6000;

  // Callbacks
  public onPlayerJoined?: (player: LobbyPlayer) => void;
  public onPlayerLeft?: (playerId: PlayerId) => void;
  public onStateReceived?: (state: NetworkServerSnapshot) => void;
  public onCommandReceived?: (command: Command, fromPlayerId: PlayerId) => void;
  public onGameStart?: (playerIds: PlayerId[]) => void;
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

      // Use room code as peer ID prefix for discoverability
      // Configure with debug off and connection settings
      this.peer = new Peer(`ba-${this.roomCode}`, {
        debug: 0,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
          ],
        },
      });

      this.peer.on('open', () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        console.log('Host peer opened with ID:', this.peer?.id);
        resolve(this.roomCode);
      });

      this.peer.on('connection', (conn) => {
        this.handleIncomingConnection(conn);
      });

      // Handle disconnection from signaling server (this is OK once game starts)
      this.peer.on('disconnected', () => {
        console.log('Disconnected from signaling server (this is normal for P2P)');
        // Don't treat this as an error - P2P connections are already established
        // Only matters if we need new players to join
      });

      this.peer.on('error', (err) => {
        console.error('Peer error:', err);
        if (err.type === 'unavailable-id') {
          // Room code already in use, try another
          this.peer?.destroy();
          this.roomCode = generateRoomCode();
          this.peer = new Peer(`ba-${this.roomCode}`);
          this.peer.on('open', () => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timeout);
            resolve(this.roomCode);
          });
          this.peer.on('connection', (conn) => this.handleIncomingConnection(conn));
          this.peer.on('disconnected', () => {
            console.log('Disconnected from signaling server');
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
    this.roomCode = roomCode.toUpperCase();
    this.role = 'client';
    this.players.clear();
    this.connections.clear();

    return new Promise((resolve, reject) => {
      // Generate a random ID for the client
      const clientId = `ba-client-${Math.random().toString(36).substring(2, 10)}`;
      this.peer = new Peer(clientId, {
        debug: 0,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
          ],
        },
      });

      this.peer.on('open', () => {
        console.log('Client peer opened, connecting to host...');

        const conn = this.peer!.connect(`ba-${this.roomCode}`, {
          reliable: true,
        });

        conn.on('open', () => {
          console.log('Connected to host');
          this.connections.set(1, conn); // Host is always player 1
          this.setupConnectionHandlers(conn, 1);
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
          reject(new Error('Game not found'));
          return;
        }
        this.onError?.(err.message);
        reject(err);
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        if (this.connections.size === 0) {
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

    conn.on('open', () => {
      console.log(`Player ${playerId} connected`);

      // Begin tracking heartbeats from this peer; if it goes
      // silent for `heartbeatTimeoutMs`, the check loop will
      // close the connection and trigger normal cleanup.
      this.lastHeartbeatReceived.set(playerId, Date.now());
      this.startHeartbeats();

      // Get color name for this player
      const colorNames = ['Red', 'Blue', 'Yellow', 'Green', 'Purple', 'Orange'];
      const playerName = colorNames[playerId - 1] || `Player ${playerId}`;

      const player: LobbyPlayer = {
        playerId,
        name: playerName,
        isHost: false,
      };
      this.players.set(playerId, player);

      // Send player their assignment
      this.sendTo(playerId, { type: 'playerAssignment', playerId });

      // Send current player list to new player, plus any IP /
       // location info already known about each. Without the
       // info-update follow-up the joiner would see existing
       // players in the list but with their IP/location columns
       // blank until those players happened to re-report.
      for (const p of this.players.values()) {
        this.sendTo(playerId, {
          type: 'playerJoined',
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
            playerId: p.playerId,
            ipAddress: p.ipAddress,
            location: p.location,
            timezone: p.timezone,
          });
        }
      }

      // Notify all players about new player
      this.broadcast({ type: 'playerJoined', playerId, playerName });
      this.onPlayerJoined?.(player);

      // Bring the new player up to date on the host's current
      // lobby settings (terrain shape today, more later). Without
      // this initial push the joiner would render their own
      // stored terrain in the preview pane until the host happens
      // to change something — visually inconsistent across
      // clients during the lobby idle state.
      const settings = this.getLobbySettings?.();
      if (settings) {
        this.sendTo(playerId, { type: 'lobbySettings', settings });
      }

      this.setupConnectionHandlers(conn, playerId);
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
        this.broadcast({ type: 'playerLeft', playerId });
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
        // Bookkeeping only — the unconditional refresh above
        // already updated the timestamp. Nothing else to do.
        return;
      case 'state':
        // Client receives state from host. Host now ships state as a
        // MessagePack Uint8Array; legacy JSON-string form is still
        // accepted as a fallback so a mixed-version game doesn't crash
        // on the first frame after upgrade.
        if (this.role === 'client') {
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
          this.onStateReceived?.(state);
        }
        break;

      case 'command':
        // Host receives command from client
        if (this.role === 'host') {
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
          const player = this.players.get(fromPlayerId);
          if (player) {
            player.ipAddress = message.ipAddress;
            player.location = message.location;
            player.timezone = message.timezone;
            this.onPlayerInfoUpdate?.(player);
            this.broadcast({
              type: 'playerInfoUpdate',
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
          this.localPlayerId = message.playerId;
          this.onPlayerAssignment?.(message.playerId);
        }
        break;

      case 'gameStart':
        // Client receives game start signal
        if (this.role === 'client') {
          this.gameStarted = true;
          this.onGameStart?.(message.playerIds);
        }
        break;

      case 'playerJoined':
        // Update player list
        this.players.set(message.playerId, {
          playerId: message.playerId,
          name: message.playerName,
          isHost: message.playerId === 1,
        });
        this.onPlayerJoined?.(this.players.get(message.playerId)!);
        break;

      case 'playerLeft':
        this.players.delete(message.playerId);
        this.onPlayerLeft?.(message.playerId);
        break;

      case 'playerInfoUpdate':
        // Client: host is fanning out a player's IP/location/tz.
        // Update the matching record so every client's player
        // list stays in sync.
        if (this.role === 'client') {
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
    this.broadcast({ type: 'lobbySettings', settings });
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
      const beat: NetworkMessage = { type: 'heartbeat', playerId: this.localPlayerId };
      for (const conn of this.connections.values()) {
        if (conn.open) conn.send(beat);
      }
    }, this.heartbeatSendIntervalMs);
    this.heartbeatCheckInterval = setInterval(() => {
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
          playerId: this.localPlayerId,
          ipAddress,
          location,
          timezone,
        });
      }
    } else if (this.role === 'client') {
      const hostConn = this.connections.get(1);
      if (hostConn?.open) {
        hostConn.send({ type: 'playerInfo', ipAddress, location, timezone });
      }
    }
  }

  // Send message to specific player (host only)
  private sendTo(playerId: PlayerId, message: NetworkMessage): void {
    const conn = this.connections.get(playerId);
    if (conn && conn.open) {
      conn.send(message);
    }
  }

  // Broadcast message to all connected players (host only)
  private broadcast(message: NetworkMessage, excludePlayerId?: PlayerId): void {
    for (const [playerId, conn] of this.connections) {
      if (playerId !== excludePlayerId && conn.open) {
        conn.send(message);
      }
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

    this.broadcast({ type: 'state', data: buf });
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

    this.sendTo(playerId, { type: 'state', data: buf });
  }

  // Send command to host (client only)
  sendCommand(command: Command): void {
    if (this.role !== 'client') return;
    const hostConn = this.connections.get(1);
    if (hostConn && hostConn.open) {
      hostConn.send({ type: 'command', data: command });
    }
  }

  // Start the game (host only)
  startGame(): void {
    if (this.role !== 'host') return;
    this.gameStarted = true;

    let playerIds = Array.from(this.players.keys()).sort((a, b) => a - b);

    // Single player mode: spawn 2 commanders so player can toggle between sides
    if (playerIds.length === 1) {
      playerIds = [1, 2];
    }

    this.broadcast({ type: 'gameStart', playerIds });
    this.onGameStart?.(playerIds);
  }

  // Getters
  getRole(): NetworkRole | null {
    return this.role;
  }

  getRoomCode(): string {
    return this.roomCode;
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
