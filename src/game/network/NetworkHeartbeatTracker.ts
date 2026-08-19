import type { DataConnection } from 'peerjs';
import type { PlayerId } from '../sim/types';
import type { NetworkMessage } from './NetworkTypes';

type NetworkHeartbeatTrackerOptions = {
  buildHeartbeat: () => NetworkMessage;
  closeConnection: (playerId: PlayerId) => void;
  getConnections: () => Iterable<[PlayerId, DataConnection]>;
  isGameStarted: () => boolean;
  send: (conn: DataConnection, message: NetworkMessage) => boolean;
  /** A peer has gone quiet for `silenceNoticeMs`. Reported during a battle as
   *  well as in the lobby, and reported once per silence rather than every
   *  sweep. Purely informational — the tracker takes no action on it. */
  onPeerSilent?: (playerId: PlayerId) => void;
  sendIntervalMs: number | undefined;
  silenceNoticeMs?: number | undefined;
  timeoutMs: number | undefined;
};

const DEFAULT_HEARTBEAT_SEND_INTERVAL_MS = 2000;

/** When a silent peer gets its connection closed. Deliberately generous:
 *  dropping someone who is merely slow is worse than waiting. */
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30000;

/** When silence is worth *reporting*. Beats arrive every 2s, so this is five
 *  missed ones — long enough not to fire on a hiccup, short enough that a
 *  player is not left staring at a frozen battle. Separate from the close
 *  threshold because noticing and acting are different decisions: a caller
 *  may want to react to a departed host long before anyone is disconnected. */
const DEFAULT_HEARTBEAT_SILENCE_NOTICE_MS = 10000;

export class NetworkHeartbeatTracker {
  private lastReceived: Map<PlayerId, number> = new Map();
  /** Peers already reported silent, so one silence is announced once. */
  private readonly reportedSilent = new Set<PlayerId>();
  private sendInterval: ReturnType<typeof setInterval> | null = null;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private readonly sendIntervalMs: number;
  private readonly silenceNoticeMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: NetworkHeartbeatTrackerOptions) {
    this.sendIntervalMs = options.sendIntervalMs ?? DEFAULT_HEARTBEAT_SEND_INTERVAL_MS;
    this.silenceNoticeMs = options.silenceNoticeMs ?? DEFAULT_HEARTBEAT_SILENCE_NOTICE_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  }

  track(playerId: PlayerId, now = Date.now()): void {
    this.lastReceived.set(playerId, now);
  }

  markReceived(playerId: PlayerId): void {
    if (!this.lastReceived.has(playerId)) return;
    this.lastReceived.set(playerId, Date.now());
    // Spoke again — a later silence is a new event worth reporting.
    this.reportedSilent.delete(playerId);
  }

  untrack(playerId: PlayerId): void {
    this.lastReceived.delete(playerId);
    this.reportedSilent.delete(playerId);
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
      const now = Date.now();
      const silenceCutoff = now - this.silenceNoticeMs;
      const closeCutoff = now - this.timeoutMs;
      const gameStarted = this.options.isGameStarted();

      for (const [playerId, lastSeen] of [...this.lastReceived]) {
        // Reporting runs during a battle too. A peer that stops answering
        // mid-match is exactly when someone needs to know — if it is the
        // host, nothing can progress and the caller has to act on it.
        if (lastSeen < silenceCutoff && !this.reportedSilent.has(playerId)) {
          this.reportedSilent.add(playerId);
          this.options.onPeerSilent?.(playerId);
        }
        if (lastSeen >= closeCutoff) continue;
        // Closing, however, stays a lobby-only action: dropping a peer
        // mid-battle would strand the lockstep frames the others are still
        // waiting on, so a slow player is left connected.
        if (gameStarted) continue;
        this.options.closeConnection(playerId);
        this.lastReceived.delete(playerId);
        this.reportedSilent.delete(playerId);
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
    this.reportedSilent.clear();
  }
}
