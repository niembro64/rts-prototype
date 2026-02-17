import Peer, { DataConnection } from 'peerjs';
import type { PlayerId } from '../sim/types';
import type { Command } from '../sim/commands';

// Re-export types from NetworkTypes for backward compatibility
export type {
  NetworkMessage,
  NetworkAudioEvent,
  NetworkGameState,
  NetworkSprayTarget,
  NetworkAction,
  NetworkWeapon,
  NetworkEntity,
  NetworkEconomy,
  NetworkProjectileSpawn,
  NetworkProjectileDespawn,
  NetworkProjectileVelocityUpdate,
  NetworkGridCell,
  NetworkUnitTypeStats,
  NetworkCombatStats,
  LobbyPlayer,
  NetworkRole,
} from './NetworkTypes';

import type { NetworkGameState, LobbyPlayer, NetworkMessage, NetworkRole } from './NetworkTypes';

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
  private role: NetworkRole = 'offline';
  private roomCode: string = '';
  private localPlayerId: PlayerId = 1;
  private nextPlayerId: PlayerId = 2;
  private players: Map<PlayerId, LobbyPlayer> = new Map();
  private gameStarted: boolean = false;
  private snapshotsSent: number = 0;
  private snapshotsReceived: number = 0;

  // Callbacks
  public onPlayerJoined?: (player: LobbyPlayer) => void;
  public onPlayerLeft?: (playerId: PlayerId) => void;
  public onStateReceived?: (state: NetworkGameState) => void;
  public onCommandReceived?: (command: Command, fromPlayerId: PlayerId) => void;
  public onGameStart?: (playerIds: PlayerId[]) => void;
  public onPlayerAssignment?: (playerId: PlayerId) => void;
  public onError?: (error: string) => void;
  public onConnected?: () => void;

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

      // Send current player list to new player
      for (const p of this.players.values()) {
        this.sendTo(playerId, {
          type: 'playerJoined',
          playerId: p.playerId,
          playerName: p.name,
        });
      }

      // Notify all players about new player
      this.broadcast({ type: 'playerJoined', playerId, playerName });
      this.onPlayerJoined?.(player);

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
    switch (message.type) {
      case 'state':
        // Client receives state from host
        // State is pre-serialized as JSON string by host to avoid expensive
        // BinaryPack deserialization of deep object trees
        if (this.role === 'client') {
          this.snapshotsReceived++;
          if (this.snapshotsReceived % 100 === 0) {
            const hostConn = this.connections.get(1);
            const dc = hostConn?.dataChannel;
            console.log(`[NET] Client received snapshot #${this.snapshotsReceived} (dc=${dc?.readyState ?? 'none'})`);
          }
          const state: NetworkGameState = typeof message.data === 'string'
            ? JSON.parse(message.data)
            : message.data;
          this.onStateReceived?.(state);
        }
        break;

      case 'command':
        // Host receives command from client
        if (this.role === 'host') {
          this.onCommandReceived?.(message.data, fromPlayerId);
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
  // Pre-serializes to JSON string so PeerJS's BinaryPack only handles a flat
  // string (trivial) instead of a deep object tree (expensive to pack/unpack).
  broadcastState(state: NetworkGameState): void {
    if (this.role !== 'host') return;
    this.snapshotsSent++;

    // Pre-serialize once for all clients (V8-native JSON.stringify is fast)
    const jsonString = JSON.stringify(state);

    // Log every 100th snapshot with connection health + payload size
    if (this.snapshotsSent % 100 === 0) {
      for (const [pid, conn] of this.connections) {
        const dc = conn.dataChannel;
        const buffered = dc ? dc.bufferedAmount : -1;
        const dcState = dc ? dc.readyState : 'no-dc';
        console.log(`[NET] Host snapshot #${this.snapshotsSent} → player ${pid}: open=${conn.open} dc=${dcState} buffered=${buffered} size=${jsonString.length}`);
      }
    }

    this.broadcast({ type: 'state', data: jsonString });
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
  getRole(): NetworkRole {
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
    for (const conn of this.connections.values()) {
      conn.close();
    }
    this.connections.clear();
    this.peer?.destroy();
    this.peer = null;
    this.role = 'offline';
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
