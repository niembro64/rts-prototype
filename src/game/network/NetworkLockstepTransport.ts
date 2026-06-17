import type { DataConnection } from 'peerjs';
import type { PlayerId } from '../sim/types';
import {
  compareLockstepCommandEnvelopes,
  type LockstepCommandEnvelope,
} from '../architecture/LockstepCommandProtocol';
import type {
  LockstepAckMessage,
  LockstepCommandFrameBatchFrame,
  LockstepCommandFrameBatchMessage,
  LockstepCommandFrameMessage,
  LockstepCommandMessage,
  LockstepPeerSequenceAck,
  NetworkLockstepMessage,
  NetworkMessage,
} from './NetworkTypes';
import { LOCKSTEP_PROTOCOL_VERSION } from './NetworkTypes';
import type { CanonicalServerStateHash } from '../architecture/CanonicalStateHash';

const OUTBOUND_COMMAND_FRAME_RETAIN_AFTER_ACK = 900;
const DEDUP_RETAIN_AFTER_ACK = OUTBOUND_COMMAND_FRAME_RETAIN_AFTER_ACK;

export type LockstepCommandFrameDraft = {
  readonly frame: number;
  readonly frameSequence: number;
  readonly commands: readonly LockstepCommandEnvelope[];
};

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
  private readonly seenCommandKeyFrames = new Map<string, number>();
  private readonly seenCommandFrameKeyFrames = new Map<string, number>();
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
    const orderedCommands = orderCommandEnvelopes(commands);
    const message: LockstepCommandFrameMessage = {
      ...this.base(),
      type: 'lockstepCommandFrame',
      coordinatorPlayerId: this.options.getLocalPlayerId(),
      frame,
      frameSequence,
      commands: orderedCommands,
    };
    this.outboundCommandFrames.set(frame, message);
    this.pruneOutboundCommandFrames();
    return this.broadcast(message);
  }

  broadcastCommandFrameBatch(frames: readonly LockstepCommandFrameDraft[]): boolean {
    if (frames.length === 0) return false;
    if (frames.length === 1) {
      const frame = frames[0];
      return this.broadcastCommandFrame(frame.frame, frame.frameSequence, frame.commands);
    }
    const orderedFrames = orderCommandFrameDrafts(frames);
    const batchFrames = new Array<LockstepCommandFrameBatchFrame>(orderedFrames.length);
    for (let i = 0; i < orderedFrames.length; i++) {
      const frame = orderedFrames[i];
      const orderedCommands = orderCommandEnvelopes(frame.commands);
      batchFrames[i] = {
        frame: frame.frame,
        frameSequence: frame.frameSequence,
        commands: orderedCommands,
      };
      this.outboundCommandFrames.set(frame.frame, {
        ...this.base(),
        type: 'lockstepCommandFrame',
        coordinatorPlayerId: this.options.getLocalPlayerId(),
        frame: frame.frame,
        frameSequence: frame.frameSequence,
        commands: orderedCommands,
      });
    }
    this.pruneOutboundCommandFrames();
    return this.broadcast({
      ...this.base(),
      type: 'lockstepCommandFrameBatch',
      coordinatorPlayerId: this.options.getLocalPlayerId(),
      frames: batchFrames,
    });
  }

  sendAck(ackFrame: number, ackFrameSequence: number): boolean {
    const sent = this.sendToHostOrBroadcast({
      ...this.base(),
      type: 'lockstepAck',
      playerId: this.options.getLocalPlayerId(),
      ackFrame,
      ackFrameSequence,
      receivedPeerSequences: this.buildReceivedPeerSequenceAcks(),
    });
    this.pruneAcknowledgedDedupState(ackFrame);
    return sent;
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
    const frames: number[] = [];
    for (const frame of this.outboundCommandFrames.keys()) {
      if (frame > lastAckedFrame) frames.push(frame);
    }
    frames.sort((a, b) => a - b);
    let sent = 0;
    const count = Math.min(maxFrames, frames.length);
    for (let i = 0; i < count; i++) {
      const frame = frames[i];
      if (this.resendCommandFrame(frame, targetPlayerId)) sent++;
    }
    return sent;
  }

  handleMessage(message: NetworkMessage, fromPlayerId: PlayerId): boolean {
    if (!isNetworkLockstepMessage(message)) return false;
    if (!this.options.isMessageForCurrentGame(message)) return true;
    if (message.protocolVersion !== LOCKSTEP_PROTOCOL_VERSION) return true;
    if (!this.acceptInbound(message, fromPlayerId)) return true;
    this.options.onMessage(message, fromPlayerId);
    return true;
  }

  latestAckForPlayer(playerId: PlayerId): LockstepAckMessage | undefined {
    return this.latestAckByPlayer.get(playerId);
  }

  getDiagnostics(): NetworkLockstepTransportDiagnostics {
    const latestAcks: {
      playerId: PlayerId;
      ackFrame: number;
      ackFrameSequence: number;
    }[] = [];
    for (const [playerId, ack] of this.latestAckByPlayer) {
      latestAcks.push({
        playerId,
        ackFrame: ack.ackFrame,
        ackFrameSequence: ack.ackFrameSequence,
      });
    }
    latestAcks.sort((a, b) => a.playerId - b.playerId);

    const storedOutboundFrames: {
      frame: number;
      frameSequence: number;
      commandCount: number;
    }[] = [];
    for (const frame of this.outboundCommandFrames.values()) {
      storedOutboundFrames.push({
        frame: frame.frame,
        frameSequence: frame.frameSequence,
        commandCount: frame.commands.length,
      });
    }
    storedOutboundFrames.sort((a, b) => a.frame - b.frame || a.frameSequence - b.frameSequence);

    return {
      receivedPeerSequences: this.buildReceivedPeerSequenceAcks(),
      latestAcks,
      storedOutboundFrames,
      resendCount: this.resendCount,
    };
  }

  clear(): void {
    this.seenCommandKeyFrames.clear();
    this.seenCommandFrameKeyFrames.clear();
    this.receivedPeerSequences.clear();
    this.latestAckByPlayer.clear();
    this.outboundCommandFrames.clear();
    this.resendCount = 0;
  }

  private base() {
    return {
      gameId: this.options.getGameId(),
      protocolVersion: LOCKSTEP_PROTOCOL_VERSION,
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
    const acks: LockstepPeerSequenceAck[] = [];
    for (const [playerId, lastPlayerSequence] of this.receivedPeerSequences) {
      acks.push({ playerId, lastPlayerSequence });
    }
    acks.sort((a, b) => a.playerId - b.playerId);
    return acks;
  }

  private acceptInbound(message: NetworkLockstepMessage, fromPlayerId: PlayerId): boolean {
    switch (message.type) {
      case 'lockstepCommand':
        return this.acceptCommand(message);
      case 'lockstepCommandFrame':
        return this.acceptCommandFrame(message);
      case 'lockstepCommandFrameBatch':
        return this.acceptCommandFrameBatch(message);
      case 'lockstepAck':
        this.latestAckByPlayer.set(fromPlayerId, message);
        this.pruneAcknowledgedState();
        return true;
      default:
        return true;
    }
  }

  private acceptCommand(message: LockstepCommandMessage): boolean {
    const envelope = message.envelope;
    const key = commandEnvelopeKey(envelope);
    if (this.seenCommandKeyFrames.has(key)) return false;
    const previous = this.receivedPeerSequences.get(envelope.playerId) ?? -1;
    if (envelope.playerSequence < previous) return false;
    this.seenCommandKeyFrames.set(key, envelope.executeFrame);
    if (envelope.playerSequence > previous) {
      this.receivedPeerSequences.set(envelope.playerId, envelope.playerSequence);
    }
    return true;
  }

  private acceptCommandFrameBatch(message: LockstepCommandFrameBatchMessage): boolean {
    if (message.frames.length > 1) {
      message.frames.sort(compareCommandFrameBatchFrames);
    }
    for (let i = 0; i < message.frames.length; i++) {
      normalizeCommandFrame(message.frames[i]);
      this.rememberCommandFrame(message.frames[i]);
    }
    return true;
  }

  private acceptCommandFrame(message: LockstepCommandFrameMessage): boolean {
    const key = `${message.frame}:${message.frameSequence}`;
    if (this.seenCommandFrameKeyFrames.has(key)) {
      if (message.commands.length > 1) message.commands.sort(compareLockstepCommandEnvelopes);
      return true;
    }
    this.seenCommandFrameKeyFrames.set(key, message.frame);
    if (message.commands.length > 1) message.commands.sort(compareLockstepCommandEnvelopes);
    for (const envelope of message.commands) {
      this.seenCommandKeyFrames.set(commandEnvelopeKey(envelope), envelope.executeFrame);
      const previous = this.receivedPeerSequences.get(envelope.playerId) ?? -1;
      if (envelope.playerSequence > previous) {
        this.receivedPeerSequences.set(envelope.playerId, envelope.playerSequence);
      }
    }
    return true;
  }

  private rememberCommandFrame(frame: LockstepCommandFrameBatchFrame): void {
    this.seenCommandFrameKeyFrames.set(`${frame.frame}:${frame.frameSequence}`, frame.frame);
    for (const envelope of frame.commands) {
      this.seenCommandKeyFrames.set(commandEnvelopeKey(envelope), envelope.executeFrame);
      const previous = this.receivedPeerSequences.get(envelope.playerId) ?? -1;
      if (envelope.playerSequence > previous) {
        this.receivedPeerSequences.set(envelope.playerId, envelope.playerSequence);
      }
    }
  }

  private pruneOutboundCommandFrames(): void {
    const minAckedFrame = this.minAckedFrameAcrossConnectedPeers();
    if (minAckedFrame === null) return;
    this.pruneOutboundCommandFramesBefore(minAckedFrame);
    this.pruneAcknowledgedDedupState(minAckedFrame);
  }

  private pruneAcknowledgedState(): void {
    const minAckedFrame = this.minAckedFrameAcrossConnectedPeers();
    if (minAckedFrame === null) return;
    this.pruneOutboundCommandFramesBefore(minAckedFrame);
    this.pruneAcknowledgedDedupState(minAckedFrame);
  }

  private minAckedFrameAcrossConnectedPeers(): number | null {
    let minAckedFrame: number | null = null;
    for (const playerId of this.options.getConnections().keys()) {
      const ack = this.latestAckByPlayer.get(playerId);
      if (ack === undefined) return null;
      minAckedFrame = minAckedFrame === null
        ? ack.ackFrame
        : Math.min(minAckedFrame, ack.ackFrame);
    }
    return minAckedFrame;
  }

  private pruneOutboundCommandFramesBefore(minAckedFrame: number): void {
    if (this.outboundCommandFrames.size === 0) return;
    const pruneBeforeFrame = minAckedFrame - OUTBOUND_COMMAND_FRAME_RETAIN_AFTER_ACK;
    if (pruneBeforeFrame <= 0) return;
    for (const frame of this.outboundCommandFrames.keys()) {
      if (frame < pruneBeforeFrame) this.outboundCommandFrames.delete(frame);
    }
  }

  private pruneAcknowledgedDedupState(ackFrame: number): void {
    const pruneBeforeFrame = ackFrame - DEDUP_RETAIN_AFTER_ACK;
    if (pruneBeforeFrame <= 0) return;
    for (const [key, frame] of this.seenCommandFrameKeyFrames) {
      if (frame < pruneBeforeFrame) this.seenCommandFrameKeyFrames.delete(key);
    }
    for (const [key, executeFrame] of this.seenCommandKeyFrames) {
      if (executeFrame < pruneBeforeFrame) this.seenCommandKeyFrames.delete(key);
    }
  }
}

export function isNetworkLockstepMessage(message: NetworkMessage): message is NetworkLockstepMessage {
  switch (message.type) {
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
      return true;
    default:
      return false;
  }
}

function orderCommandEnvelopes(
  commands: readonly LockstepCommandEnvelope[],
): LockstepCommandEnvelope[] {
  return commands.length <= 1
    ? commands.length === 0
      ? []
      : [commands[0]]
    : [...commands].sort(compareLockstepCommandEnvelopes);
}

function normalizeCommandFrame(frame: LockstepCommandFrameBatchFrame): void {
  if (frame.commands.length > 1) frame.commands.sort(compareLockstepCommandEnvelopes);
}

function orderCommandFrameDrafts(
  frames: readonly LockstepCommandFrameDraft[],
): LockstepCommandFrameDraft[] {
  return frames.length <= 1
    ? frames.length === 0
      ? []
      : [frames[0]]
    : [...frames].sort(compareCommandFrameDrafts);
}

function compareCommandFrameDrafts(
  a: LockstepCommandFrameDraft,
  b: LockstepCommandFrameDraft,
): number {
  return a.frame - b.frame || a.frameSequence - b.frameSequence;
}

function compareCommandFrameBatchFrames(
  a: LockstepCommandFrameBatchFrame,
  b: LockstepCommandFrameBatchFrame,
): number {
  return a.frame - b.frame || a.frameSequence - b.frameSequence;
}

function commandEnvelopeKey(envelope: LockstepCommandEnvelope): string {
  return `${envelope.gameId}:${envelope.executeFrame}:${envelope.playerId}:` +
    `${envelope.playerSequence}:${envelope.commandIndex}`;
}
