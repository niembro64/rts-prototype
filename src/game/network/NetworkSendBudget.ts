import type { DataConnection } from 'peerjs';
import type { NetworkMessage } from './NetworkTypes';

const NONCRITICAL_COALESCE_BYTES = 512 * 1024;
const NONCRITICAL_FLUSH_BYTES = 256 * 1024;
const COMMAND_REJECT_BYTES = 512 * 1024;
const CONTROL_REJECT_BYTES = 1024 * 1024;
const COMMANDS_PER_SECOND = 120;

type NetworkSendMessageClass =
  | 'heartbeat'
  | 'playerInfo'
  | 'playerInfoUpdate'
  | 'lobbySettings'
  | 'communication'
  | 'communicationEvent'
  | 'lockstep'
  | 'control';

export type NetworkSendBudgetClassTelemetry = {
  messageClass: NetworkSendMessageClass;
  sent: number;
  coalesced: number;
  droppedStale: number;
  rejected: number;
  rateLimited: number;
  pending: number;
  lastBufferedAmount: number;
  maxBufferedAmount: number;
};

export type NetworkSendBudgetTelemetry = NetworkSendBudgetClassTelemetry[];

type NetworkSendPolicy = 'command' | 'critical' | 'coalesce';

type NetworkSendClassification = {
  messageClass: NetworkSendMessageClass;
  policy: NetworkSendPolicy;
  coalesceKey: string | null;
};

type NetworkSendStats = {
  sent: number;
  coalesced: number;
  droppedStale: number;
  rejected: number;
  rateLimited: number;
  lastBufferedAmount: number;
  maxBufferedAmount: number;
};

type PendingSend = {
  message: NetworkMessage;
  messageClass: NetworkSendMessageClass;
};

type CommandRateWindow = {
  startedAtMs: number;
  count: number;
};

type NetworkSendBudgetOptions = {
  onPendingQueued?: () => void;
};

type RawSend = (conn: DataConnection, message: NetworkMessage) => boolean;

function createStats(): NetworkSendStats {
  return {
    sent: 0,
    coalesced: 0,
    droppedStale: 0,
    rejected: 0,
    rateLimited: 0,
    lastBufferedAmount: 0,
    maxBufferedAmount: 0,
  };
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function bufferedAmount(conn: DataConnection): number {
  const amount = conn.dataChannel?.bufferedAmount;
  return Number.isFinite(amount) ? amount as number : 0;
}

function dataChannelClosed(conn: DataConnection): boolean {
  const dc = conn.dataChannel;
  return dc !== undefined && dc.readyState !== 'open';
}

function classifyMessage(message: NetworkMessage): NetworkSendClassification {
  switch (message.type) {
    case 'heartbeat':
      return { messageClass: 'heartbeat', policy: 'coalesce', coalesceKey: 'heartbeat' };
    case 'playerInfo':
      return { messageClass: 'playerInfo', policy: 'coalesce', coalesceKey: 'playerInfo' };
    case 'playerInfoUpdate':
      return {
        messageClass: 'playerInfoUpdate',
        policy: 'coalesce',
        coalesceKey: `playerInfoUpdate:${message.playerId}`,
      };
    case 'lobbySettings':
      return { messageClass: 'lobbySettings', policy: 'coalesce', coalesceKey: 'lobbySettings' };
    case 'communication':
      return { messageClass: 'communication', policy: 'command', coalesceKey: null };
    case 'communicationEvent':
      return { messageClass: 'communicationEvent', policy: 'critical', coalesceKey: null };
    case 'lockstepHello':
    case 'lockstepReady':
    case 'lockstepCommand':
    case 'lockstepCommandFrame':
    case 'lockstepCommandFrameBatch':
    case 'lockstepAck':
    case 'lockstepChecksum':
    case 'lockstepPause':
    case 'lockstepResume':
    case 'lockstepDesync':
    case 'lockstepResyncRequest':
      return { messageClass: 'lockstep', policy: 'critical', coalesceKey: null };
    default:
      return { messageClass: 'control', policy: 'critical', coalesceKey: null };
  }
}

export class NetworkSendBudget {
  private readonly stats = new Map<NetworkSendMessageClass, NetworkSendStats>();
  private readonly pendingByConnection = new Map<DataConnection, Map<string, PendingSend>>();
  private readonly liveConnectionsScratch = new Set<DataConnection>();
  private commandWindows = new WeakMap<DataConnection, CommandRateWindow>();
  private readonly rejectionLogCounts = new Map<string, number>();

  constructor(private readonly options: NetworkSendBudgetOptions = {}) {}

  send(conn: DataConnection, message: NetworkMessage, rawSend: RawSend): boolean {
    const classification = classifyMessage(message);
    const stats = this.statsFor(classification.messageClass);
    this.recordBuffered(stats, conn);
    if (!conn.open || dataChannelClosed(conn)) {
      stats.rejected++;
      this.logRejected(classification.messageClass, message.type, 'connection closed');
      return false;
    }

    if (classification.messageClass === 'lockstep') {
      return this.sendNow(conn, message, rawSend, stats);
    }

    const buffered = bufferedAmount(conn);
    if (classification.policy === 'command') {
      if (!this.takeCommandRateSlot(conn)) {
        stats.rateLimited++;
        this.logRejected(classification.messageClass, message.type, 'command rate limit');
        return false;
      }
      if (buffered >= COMMAND_REJECT_BYTES) {
        stats.rejected++;
        this.logRejected(classification.messageClass, message.type, 'command backpressure');
        return false;
      }
      return this.sendNow(conn, message, rawSend, stats);
    }

    if (classification.policy === 'coalesce') {
      if (buffered >= NONCRITICAL_COALESCE_BYTES) {
        this.queueLatest(conn, classification, message, stats);
        return false;
      }
      return this.sendNow(conn, message, rawSend, stats);
    }

    if (buffered >= CONTROL_REJECT_BYTES) {
      stats.rejected++;
      this.logRejected(classification.messageClass, message.type, 'control backpressure');
      return false;
    }
    return this.sendNow(conn, message, rawSend, stats);
  }

  flushPending(
    connections: Iterable<DataConnection>,
    rawSend: RawSend,
  ): boolean {
    const liveConnections = this.liveConnectionsScratch;
    liveConnections.clear();
    for (const conn of connections) liveConnections.add(conn);

    for (const conn of this.pendingByConnection.keys()) {
      if (!liveConnections.has(conn)) this.pendingByConnection.delete(conn);
    }

    for (const conn of liveConnections) {
      this.flushPendingForConnection(conn, rawSend);
    }
    return this.hasPending();
  }

  clearConnection(conn: DataConnection): void {
    this.pendingByConnection.delete(conn);
  }

  clear(): void {
    this.pendingByConnection.clear();
    this.liveConnectionsScratch.clear();
    this.commandWindows = new WeakMap<DataConnection, CommandRateWindow>();
    this.rejectionLogCounts.clear();
    this.stats.clear();
  }

  getTelemetry(): NetworkSendBudgetTelemetry {
    const telemetry: NetworkSendBudgetTelemetry = [];
    for (const [messageClass, stats] of this.stats) {
      telemetry.push({
        messageClass,
        sent: stats.sent,
        coalesced: stats.coalesced,
        droppedStale: stats.droppedStale,
        rejected: stats.rejected,
        rateLimited: stats.rateLimited,
        pending: this.pendingCountForClass(messageClass),
        lastBufferedAmount: stats.lastBufferedAmount,
        maxBufferedAmount: stats.maxBufferedAmount,
      });
    }
    return telemetry;
  }

  private sendNow(
    conn: DataConnection,
    message: NetworkMessage,
    rawSend: RawSend,
    stats: NetworkSendStats,
  ): boolean {
    const sent = rawSend(conn, message);
    if (sent) stats.sent++;
    else stats.rejected++;
    this.recordBuffered(stats, conn);
    return sent;
  }

  private queueLatest(
    conn: DataConnection,
    classification: NetworkSendClassification,
    message: NetworkMessage,
    stats: NetworkSendStats,
  ): void {
    const coalesceKey = classification.coalesceKey;
    if (coalesceKey === null) return;
    let pending = this.pendingByConnection.get(conn);
    if (pending === undefined) {
      pending = new Map();
      this.pendingByConnection.set(conn, pending);
    }
    if (pending.has(coalesceKey)) stats.droppedStale++;
    pending.set(coalesceKey, {
      message,
      messageClass: classification.messageClass,
    });
    stats.coalesced++;
    this.options.onPendingQueued?.();
  }

  private flushPendingForConnection(conn: DataConnection, rawSend: RawSend): void {
    const pending = this.pendingByConnection.get(conn);
    if (pending === undefined) return;
    if (!conn.open || dataChannelClosed(conn)) {
      this.pendingByConnection.delete(conn);
      return;
    }
    for (const [key, entry] of pending) {
      if (bufferedAmount(conn) >= NONCRITICAL_FLUSH_BYTES) break;
      const stats = this.statsFor(entry.messageClass);
      this.recordBuffered(stats, conn);
      if (!this.sendNow(conn, entry.message, rawSend, stats)) break;
      pending.delete(key);
    }
    if (pending.size === 0) this.pendingByConnection.delete(conn);
  }

  private takeCommandRateSlot(conn: DataConnection): boolean {
    const timestamp = nowMs();
    let window = this.commandWindows.get(conn);
    if (window === undefined || timestamp - window.startedAtMs >= 1000) {
      window = { startedAtMs: timestamp, count: 0 };
      this.commandWindows.set(conn, window);
    }
    if (window.count >= COMMANDS_PER_SECOND) return false;
    window.count++;
    return true;
  }

  private statsFor(messageClass: NetworkSendMessageClass): NetworkSendStats {
    let stats = this.stats.get(messageClass);
    if (stats === undefined) {
      stats = createStats();
      this.stats.set(messageClass, stats);
    }
    return stats;
  }

  private recordBuffered(stats: NetworkSendStats, conn: DataConnection): void {
    const buffered = bufferedAmount(conn);
    stats.lastBufferedAmount = buffered;
    if (buffered > stats.maxBufferedAmount) stats.maxBufferedAmount = buffered;
  }

  private hasPending(): boolean {
    for (const pending of this.pendingByConnection.values()) {
      if (pending.size > 0) return true;
    }
    return false;
  }

  private pendingCountForClass(messageClass: NetworkSendMessageClass): number {
    let count = 0;
    for (const pending of this.pendingByConnection.values()) {
      for (const entry of pending.values()) {
        if (entry.messageClass === messageClass) count++;
      }
    }
    return count;
  }

  private logRejected(
    messageClass: NetworkSendMessageClass,
    type: NetworkMessage['type'],
    reason: string,
  ): void {
    const key = `${messageClass}:${reason}`;
    const count = (this.rejectionLogCounts.get(key) ?? 0) + 1;
    this.rejectionLogCounts.set(key, count);
    if (count !== 1 && count % 100 !== 0) return;
    console.warn(`[NET] Rejected ${type} send (${messageClass}): ${reason}; count=${count}`);
  }
}
