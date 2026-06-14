import type { DataConnection } from 'peerjs';
import type { PlayerId } from '../sim/types';
import {
  compareLockstepCommandEnvelopes,
  type LockstepCommandEnvelope,
} from '../architecture/LockstepCommandProtocol';
import type {
  LockstepAckMessage,
  LockstepCommandFrameMessage,
  LockstepCommandMessage,
  NetworkLockstepMessage,
  NetworkMessage,
} from './NetworkTypes';
import { LOCKSTEP_PROTOCOL_VERSION } from './NetworkTypes';
import type { CanonicalServerStateHash } from '../architecture/CanonicalStateHash';

type NetworkLockstepTransportOptions = {
  getGameId: () => string;
  getHostConnection: () => DataConnection | undefined;
  getConnections: () => ReadonlyMap<PlayerId, DataConnection>;
  getLocalPlayerId: () => PlayerId;
  isMessageForCurrentGame: (message: { gameId: string | undefined }) => boolean;
  send: (conn: DataConnection, message: NetworkMessage) => boolean;
  onMessage: (message: NetworkLockstepMessage, fromPlayerId: PlayerId) => void;
};

export type NetworkLockstepTransportDiagnostics = {
  readonly receivedPeerSequences: readonly {
    readonly playerId: PlayerId;
    readonly lastPlayerSequence: number;
  }[];
  readonly latestAcks: readonly {
    readonly playerId: PlayerId;
    readonly ackFrame: number;
    readonly ackFrameSequence: number;
  }[];
  readonly storedOutboundFrames: readonly {
    readonly frame: number;
    readonly frameSequence: number;
    readonly commandCount: number;
  }[];
  readonly resendCount: number;
};

export class NetworkLockstepTransport {
  private readonly seenCommandKeys = new Set<string>();
  private readonly seenCommandFrameKeys = new Set<string>();
  private readonly receivedPeerSequences = new Map<PlayerId, number>();
  private readonly latestAckByPlayer = new Map<PlayerId, LockstepAckMessage>();
  private readonly outboundCommandFrames = new Map<number, LockstepCommandFrameMessage>();
  private resendCount = 0;

  constructor(private readonly options: NetworkLockstepTransportOptions) {}

  sendHello(
    initializationHash: string,
    lastReceivedFrame: number,
  ): boolean {
    return this.sendToHostOrBroadcast({
      ...this.base(),
      type: 'lockstepHello',
      playerId: this.options.getLocalPlayerId(),
      initializationHash,
      lastReceivedFrame,
      receivedPeerSequences: this.buildReceivedPeerSequenceAcks(),
    });
  }

  sendReady(initializationHash: string, readyFrame: number): boolean {
    return this.sendToHostOrBroadcast({
      ...this.base(),
      type: 'lockstepReady',
      playerId: this.options.getLocalPlayerId(),
      readyFrame,
      initializationHash,
    });
  }

  sendCommand(envelope: LockstepCommandEnvelope): boolean {
    return this.sendToHostOrBroadcast({
      ...this.base(),
      type: 'lockstepCommand',
      envelope,
    });
  }

  broadcastCommandFrame(
    frame: number,
    frameSequence: number,
    commands: readonly LockstepCommandEnvelope[],
  ): boolean {
    const message: LockstepCommandFrameMessage = {
      ...this.base(),
      type: 'lockstepCommandFrame',
      coordinatorPlayerId: this.options.getLocalPlayerId(),
      frame,
      frameSequence,
      commands: [...commands].sort(compareLockstepCommandEnvelopes),
    };
    this.outboundCommandFrames.set(frame, message);
    return this.broadcast(message);
  }

  sendAck(ackFrame: number, ackFrameSequence: number): boolean {
    return this.sendToHostOrBroadcast({
      ...this.base(),
      type: 'lockstepAck',
      playerId: this.options.getLocalPlayerId(),
      ackFrame,
      ackFrameSequence,
      receivedPeerSequences: this.buildReceivedPeerSequenceAcks(),
    });
  }

  sendChecksum(frame: number, stateHash: CanonicalServerStateHash): boolean {
    return this.sendToHostOrBroadcast({
      ...this.base(),
      type: 'lockstepChecksum',
      playerId: this.options.getLocalPlayerId(),
      frame,
      stateHash,
    });
  }

  broadcastPause(frame: number, reason: string): boolean {
    return this.broadcast({
      ...this.base(),
      type: 'lockstepPause',
      requestedByPlayerId: this.options.getLocalPlayerId(),
      frame,
      reason,
    });
  }

  broadcastResume(resumeFrame: number): boolean {
    return this.broadcast({
      ...this.base(),
      type: 'lockstepResume',
      requestedByPlayerId: this.options.getLocalPlayerId(),
      resumeFrame,
    });
  }

  broadcastDesync(
    frame: number,
    localHash: CanonicalServerStateHash,
    remotePlayerId: PlayerId | null,
    remoteHash: CanonicalServerStateHash | null,
  ): boolean {
    return this.broadcast({
      ...this.base(),
      type: 'lockstepDesync',
      detectedByPlayerId: this.options.getLocalPlayerId(),
      frame,
      localHash,
      remotePlayerId,
      remoteHash,
    });
  }

  sendResyncRequest(fromFrame: number, reason: string): boolean {
    return this.sendToHostOrBroadcast({
      ...this.base(),
      type: 'lockstepResyncRequest',
      requestedByPlayerId: this.options.getLocalPlayerId(),
      fromFrame,
      reason,
    });
  }

  resendCommandFrame(frame: number, targetPlayerId: PlayerId): boolean {
    const frameMessage = this.outboundCommandFrames.get(frame);
    if (frameMessage === undefined) return false;
    const conn = this.options.getConnections().get(targetPlayerId);
    if (conn === undefined) return false;
    const sent = this.options.send(conn, frameMessage);
    if (sent) this.resendCount++;
    return sent;
  }

  resendCommandFramesAfter(
    lastAckedFrame: number,
    targetPlayerId: PlayerId,
    maxFrames: number,
  ): number {
    if (!Number.isInteger(lastAckedFrame) || !Number.isInteger(maxFrames) || maxFrames <= 0) {
      return 0;
    }
    const frames = [...this.outboundCommandFrames.keys()]
      .filter((frame) => frame > lastAckedFrame)
      .sort((a, b) => a - b)
      .slice(0, maxFrames);
    let sent = 0;
    for (const frame of frames) {
      if (this.resendCommandFrame(frame, targetPlayerId)) sent++;
    }
    return sent;
  }

  handleMessage(message: NetworkMessage, fromPlayerId: PlayerId): boolean {
    if (!isNetworkLockstepMessage(message)) return false;
    if (!this.options.isMessageForCurrentGame(message)) return true;
    if (
      message.protocolVersion !== LOCKSTEP_PROTOCOL_VERSION ||
      message.architecture !== 'deterministic-lockstep'
    ) {
      return true;
    }
    if (!this.acceptInbound(message, fromPlayerId)) return true;
    this.options.onMessage(message, fromPlayerId);
    return true;
  }

  latestAckForPlayer(playerId: PlayerId): LockstepAckMessage | undefined {
    return this.latestAckByPlayer.get(playerId);
  }

  getDiagnostics(): NetworkLockstepTransportDiagnostics {
    return {
      receivedPeerSequences: this.buildReceivedPeerSequenceAcks(),
      latestAcks: [...this.latestAckByPlayer.entries()]
        .sort(([a], [b]) => a - b)
        .map(([playerId, ack]) => ({
          playerId,
          ackFrame: ack.ackFrame,
          ackFrameSequence: ack.ackFrameSequence,
        })),
      storedOutboundFrames: [...this.outboundCommandFrames.values()]
        .sort((a, b) => a.frame - b.frame || a.frameSequence - b.frameSequence)
        .map((frame) => ({
          frame: frame.frame,
          frameSequence: frame.frameSequence,
          commandCount: frame.commands.length,
        })),
      resendCount: this.resendCount,
    };
  }

  clear(): void {
    this.seenCommandKeys.clear();
    this.seenCommandFrameKeys.clear();
    this.receivedPeerSequences.clear();
    this.latestAckByPlayer.clear();
    this.outboundCommandFrames.clear();
    this.resendCount = 0;
  }

  private base() {
    return {
      gameId: this.options.getGameId(),
      protocolVersion: LOCKSTEP_PROTOCOL_VERSION,
      architecture: 'deterministic-lockstep' as const,
    };
  }

  private sendToHostOrBroadcast(message: NetworkLockstepMessage): boolean {
    const hostConn = this.options.getHostConnection();
    if (hostConn !== undefined) return this.options.send(hostConn, message);
    return this.broadcast(message);
  }

  private broadcast(message: NetworkLockstepMessage): boolean {
    let sent = false;
    for (const conn of this.options.getConnections().values()) {
      sent = this.options.send(conn, message) || sent;
    }
    return sent;
  }

  private buildReceivedPeerSequenceAcks() {
    return [...this.receivedPeerSequences.entries()]
      .sort(([a], [b]) => a - b)
      .map(([playerId, lastPlayerSequence]) => ({ playerId, lastPlayerSequence }));
  }

  private acceptInbound(message: NetworkLockstepMessage, fromPlayerId: PlayerId): boolean {
    switch (message.type) {
      case 'lockstepCommand':
        return this.acceptCommand(message);
      case 'lockstepCommandFrame':
        return this.acceptCommandFrame(message);
      case 'lockstepAck':
        this.latestAckByPlayer.set(fromPlayerId, message);
        return true;
      default:
        return true;
    }
  }

  private acceptCommand(message: LockstepCommandMessage): boolean {
    const envelope = message.envelope;
    const key = commandEnvelopeKey(envelope);
    if (this.seenCommandKeys.has(key)) return false;
    this.seenCommandKeys.add(key);
    const previous = this.receivedPeerSequences.get(envelope.playerId) ?? -1;
    if (envelope.playerSequence > previous) {
      this.receivedPeerSequences.set(envelope.playerId, envelope.playerSequence);
    }
    return true;
  }

  private acceptCommandFrame(message: LockstepCommandFrameMessage): boolean {
    const key = `${message.frame}:${message.frameSequence}`;
    if (this.seenCommandFrameKeys.has(key)) {
      message.commands.sort(compareLockstepCommandEnvelopes);
      return true;
    }
    this.seenCommandFrameKeys.add(key);
    message.commands.sort(compareLockstepCommandEnvelopes);
    for (const envelope of message.commands) {
      this.seenCommandKeys.add(commandEnvelopeKey(envelope));
      const previous = this.receivedPeerSequences.get(envelope.playerId) ?? -1;
      if (envelope.playerSequence > previous) {
        this.receivedPeerSequences.set(envelope.playerId, envelope.playerSequence);
      }
    }
    return true;
  }
}

export function isNetworkLockstepMessage(message: NetworkMessage): message is NetworkLockstepMessage {
  switch (message.type) {
    case 'lockstepHello':
    case 'lockstepReady':
    case 'lockstepCommand':
    case 'lockstepCommandFrame':
    case 'lockstepAck':
    case 'lockstepChecksum':
    case 'lockstepPause':
    case 'lockstepResume':
    case 'lockstepDesync':
    case 'lockstepResyncRequest':
      return true;
    default:
      return false;
  }
}

function commandEnvelopeKey(envelope: LockstepCommandEnvelope): string {
  return `${envelope.gameId}:${envelope.executeFrame}:${envelope.playerId}:` +
    `${envelope.playerSequence}:${envelope.commandIndex}`;
}
