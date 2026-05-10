import type { DataConnection } from 'peerjs';
import type { PlayerId } from '../sim/types';
import type { NetworkMessage } from './NetworkTypes';

type NetworkHeartbeatTrackerOptions = {
  buildHeartbeat: () => NetworkMessage;
  closeConnection: (playerId: PlayerId) => void;
  getConnections: () => Iterable<[PlayerId, DataConnection]>;
  isGameStarted: () => boolean;
  send: (conn: DataConnection, message: NetworkMessage) => boolean;
  sendIntervalMs?: number;
  timeoutMs?: number;
};

const DEFAULT_HEARTBEAT_SEND_INTERVAL_MS = 2000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30000;

export class NetworkHeartbeatTracker {
  private lastReceived: Map<PlayerId, number> = new Map();
  private sendInterval: ReturnType<typeof setInterval> | null = null;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private readonly sendIntervalMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: NetworkHeartbeatTrackerOptions) {
    this.sendIntervalMs = options.sendIntervalMs ?? DEFAULT_HEARTBEAT_SEND_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  }

  track(playerId: PlayerId, now = Date.now()): void {
    this.lastReceived.set(playerId, now);
  }

  markReceived(playerId: PlayerId): void {
    if (!this.lastReceived.has(playerId)) return;
    this.lastReceived.set(playerId, Date.now());
  }

  untrack(playerId: PlayerId): void {
    this.lastReceived.delete(playerId);
  }

  start(): void {
    if (this.sendInterval !== null) return;

    const now = Date.now();
    for (const [playerId] of this.options.getConnections()) {
      this.track(playerId, now);
    }

    this.sendInterval = setInterval(() => {
      const beat = this.options.buildHeartbeat();
      for (const [, conn] of this.options.getConnections()) {
        this.options.send(conn, beat);
      }
    }, this.sendIntervalMs);

    this.checkInterval = setInterval(() => {
      if (this.options.isGameStarted()) return;

      const cutoff = Date.now() - this.timeoutMs;
      for (const [playerId, lastSeen] of this.lastReceived) {
        if (lastSeen >= cutoff) continue;
        this.options.closeConnection(playerId);
        this.lastReceived.delete(playerId);
      }
    }, 1000);
  }

  stop(): void {
    if (this.sendInterval) {
      clearInterval(this.sendInterval);
      this.sendInterval = null;
    }
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.lastReceived.clear();
  }
}
