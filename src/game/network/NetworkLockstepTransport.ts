import type { DataConnection } from 'peerjs';
import type { PlayerId } from '../sim/types';
import type { MemberId } from '@/types/network';
import {
  compareLockstepCommandEnvelopes,
  type LockstepCommandEnvelope,
} from '../architecture/LockstepCommandProtocol';
import type {
  LockstepAckMessage,
  LockstepResumeGrantMessage,
  LockstepCommandFrameBatchFrame,
  LockstepCommandFrameBatchMessage,
  LockstepCommandFrameMessage,
  LockstepCommandMessage,
  LockstepPeerFrame,
  LockstepPeerSequenceAck,
  NetworkLockstepMessage,
  NetworkMessage,
} from './NetworkTypes';
import { isNetworkLockstepMessage } from './NetworkTypes';
import type { CanonicalServerStateHash } from '../architecture/CanonicalStateHash';

const OUTBOUND_COMMAND_FRAME_RETAIN_AFTER_ACK = 900;
const DEDUP_RETAIN_AFTER_ACK = OUTBOUND_COMMAND_FRAME_RETAIN_AFTER_ACK;

type LockstepCommandFrameDraft = {
  readonly frame: number;
  readonly frameSequence: number;
  readonly commands: readonly LockstepCommandEnvelope[];
};

/**
 * The transport addresses two different sets, and conflating them is what
 * would let a watcher stall a match:
 *
 *   DELIVERY   `getConnections` — every attached member. Command frames go
 *              here, because a watcher cannot simulate without them.
 *   COMPLETION `getSeatedConnections` — members that hold a seat. Only these
 *              can send commands, and only these are ever waited on.
 */
type NetworkLockstepTransportOptions = {
  getGameId: () => string;
  getHostConnection: () => DataConnection | undefined;
  getConnections: () => ReadonlyMap<MemberId, DataConnection>;
  getSeatedConnections: () => ReadonlyMap<PlayerId, DataConnection>;
  /** The local SEAT, or undefined while watching. A member with no seat
   *  cannot author a command, so the send paths that stamp one refuse. */
  getLocalPlayerId: () => PlayerId | undefined;
  isMessageForCurrentGame: (message: { gameId: string | undefined }) => boolean;
  send: (conn: DataConnection, message: NetworkMessage) => boolean;
  /** `fromPlayerId` is the SEAT the sender speaks for, or undefined when a
   *  watcher sent it — which is why every consumer has to decide explicitly
   *  what an unseated sender may do. */
  onMessage: (
    message: NetworkLockstepMessage,
    fromPlayerId: PlayerId | undefined,
  ) => void;
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
  /** Progress reported by SEATED peers only. A watcher's progress is its own
   *  business: it is never waited on and never prunes the outbound history. */
  private readonly latestAckByPlayer = new Map<PlayerId, LockstepAckMessage>();
  private readonly outboundCommandFrames = new Map<number, LockstepCommandFrameMessage>();
  private resendCount = 0;

  constructor(private readonly options: NetworkLockstepTransportOptions) {}

  /** The local seat, or null while watching. Every send that stamps a seat
   *  goes through here, so "a watcher cannot enter the command stream" is one
   *  guard rather than a rule repeated at eight call sites. */
  /** Seat to stamp on a coordinator-authored message. The coordinator is the
   *  host, which always holds seat 1 in its own lobby; the fallback only
   *  covers a caller that is not the coordinator, whose broadcast is refused
   *  by the receivers anyway. */
  private coordinatorSeat(): PlayerId {
    return this.options.getLocalPlayerId() ?? (1 as PlayerId);
  }

  private localSeatOrNull(): PlayerId | null {
    const seat = this.options.getLocalPlayerId();
    return seat === undefined ? null : seat;
  }

  sendHello(
    initializationHash: string,
    lastReceivedFrame: number,
  ): boolean {
    const playerId = this.localSeatOrNull();
    if (playerId === null) return false;
    return this.sendToHostOrBroadcast({
      ...this.base(),
      type: 'lockstepHello',
      playerId,
      initializationHash,
      lastReceivedFrame,
      receivedPeerSequences: this.buildReceivedPeerSequenceAcks(),
    });
  }

  sendReady(initializationHash: string, readyFrame: number): boolean {
    const playerId = this.localSeatOrNull();
    if (playerId === null) return false;
    return this.sendToHostOrBroadcast({
      ...this.base(),
      type: 'lockstepReady',
      playerId,
      readyFrame,
      initializationHash,
    });
  }

  sendCommand(envelope: LockstepCommandEnvelope): boolean {
    if (this.localSeatOrNull() === null) return false;
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
      coordinatorPlayerId: this.coordinatorSeat(),
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
        coordinatorPlayerId: this.coordinatorSeat(),
        frame: frame.frame,
        frameSequence: frame.frameSequence,
        commands: orderedCommands,
      });
    }
    this.pruneOutboundCommandFrames();
    return this.broadcast({
      ...this.base(),
      type: 'lockstepCommandFrameBatch',
      coordinatorPlayerId: this.coordinatorSeat(),
      frames: batchFrames,
    });
  }

  /** Report progress to the coordinator. Seated peers only: an ack is what
   *  the match waits on, and a watcher is never waited on. */
  sendAck(ackFrame: number, ackFrameSequence: number): boolean {
    const playerId = this.localSeatOrNull();
    if (playerId === null) return false;
    const sent = this.sendToHostOrBroadcast({
      ...this.base(),
      type: 'lockstepAck',
      playerId,
      ackFrame,
      ackFrameSequence,
      receivedPeerSequences: this.buildReceivedPeerSequenceAcks(),
    });
    this.pruneAcknowledgedDedupState(ackFrame);
    return sent;
  }

  /** Coordinator only: tell everyone how far along everyone is.
   *
   *  Broadcast rather than sent to the host, because this is the one piece
   *  of lockstep state that travels outward — the coordinator is the only
   *  peer that knows it. */
  broadcastPeerFrames(
    coordinatorFrame: number,
    peers: readonly LockstepPeerFrame[],
  ): boolean {
    return this.broadcast({
      ...this.base(),
      type: 'lockstepPeerFrames',
      coordinatorPlayerId: this.coordinatorSeat(),
      coordinatorFrame,
      peers: peers.map((peer) => ({ playerId: peer.playerId, frame: peer.frame })),
    });
  }

  /** Seated peers only. A watcher that diverges must fail on its own screen;
   *  it may never pause a match it is not part of. */
  sendChecksum(frame: number, stateHash: CanonicalServerStateHash): boolean {
    const playerId = this.localSeatOrNull();
    if (playerId === null) return false;
    return this.sendToHostOrBroadcast({
      ...this.base(),
      type: 'lockstepChecksum',
      playerId,
      frame,
      stateHash,
    });
  }

  broadcastPause(frame: number, reason: string): boolean {
    return this.broadcast({
      ...this.base(),
      type: 'lockstepPause',
      requestedByPlayerId: this.coordinatorSeat(),
      frame,
      reason,
    });
  }

  broadcastResume(resumeFrame: number): boolean {
    return this.broadcast({
      ...this.base(),
      type: 'lockstepResume',
      requestedByPlayerId: this.coordinatorSeat(),
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
      detectedByPlayerId: this.coordinatorSeat(),
      frame,
      localHash,
      remotePlayerId,
      remoteHash,
    });
  }

  /** A late arrival asking to be let into a running match. Sent by a watcher
   *  joining mid-battle and by a player reclaiming a seat, so it stamps the
   *  MEMBER — the requester may hold no seat at all. */
  sendResumeRequest(
    memberId: MemberId,
    playerId: PlayerId | undefined,
    haveThroughFrame: number,
  ): boolean {
    return this.sendToHostOrBroadcast({
      ...this.base(),
      type: 'lockstepResumeRequest',
      memberId,
      playerId,
      haveThroughFrame,
    });
  }

  /** Coordinator: let one peer in. Unicast — the grant is that connection's
   *  alone, and nobody else's business. */
  sendResumeGrant(
    targetMemberId: MemberId,
    message: Omit<LockstepResumeGrantMessage, 'gameId' | 'type'>,
  ): boolean {
    const conn = this.options.getConnections().get(targetMemberId);
    if (conn === undefined) return false;
    const grant: LockstepResumeGrantMessage = {
      ...this.base(),
      type: 'lockstepResumeGrant',
      ...message,
    };
    return this.options.send(conn, grant);
  }

  /** Coordinator: one chunk of match history, to one joiner. */
  sendHistoryChunk(
    targetMemberId: MemberId,
    fromFrame: number,
    throughFrame: number,
    frames: readonly LockstepCommandFrameBatchFrame[],
    final: boolean,
  ): boolean {
    const conn = this.options.getConnections().get(targetMemberId);
    if (conn === undefined) return false;
    return this.options.send(conn, {
      ...this.base(),
      type: 'lockstepHistory',
      fromFrame,
      throughFrame,
      frames: frames.map((frame) => ({
        frame: frame.frame,
        frameSequence: frame.frameSequence,
        commands: orderCommandEnvelopes(frame.commands),
      })),
      final,
    });
  }

  /** Ask the coordinator for frames we are missing.
   *
   *  The one lockstep send a WATCHER also makes: catching up is exactly
   *  asking for history. The coordinator answers on the connection the
   *  request arrived on rather than by the stamped seat, so an unseated
   *  requester is served the same way a seated one is. */
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
    const conn = this.options.getSeatedConnections().get(targetPlayerId);
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
    const conn = this.options.getSeatedConnections().get(targetPlayerId);
    if (conn === undefined) return 0;
    return this.resendCommandFramesAfterTo(lastAckedFrame, conn, maxFrames);
  }

  /** Answer a catch-up request on the connection it arrived on. Watchers ask
   *  for frames too and hold no seat, so the address is the member. */
  resendCommandFramesAfterToMember(
    lastAckedFrame: number,
    targetMemberId: MemberId,
    maxFrames: number,
  ): number {
    const conn = this.options.getConnections().get(targetMemberId);
    if (conn === undefined) return 0;
    return this.resendCommandFramesAfterTo(lastAckedFrame, conn, maxFrames);
  }

  private resendCommandFramesAfterTo(
    lastAckedFrame: number,
    conn: DataConnection,
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
      const message = this.outboundCommandFrames.get(frames[i]);
      if (message === undefined) continue;
      if (this.options.send(conn, message)) {
        this.resendCount++;
        sent++;
      }
    }
    return sent;
  }

  handleMessage(
    message: NetworkMessage,
    fromPlayerId: PlayerId | undefined,
  ): boolean {
    if (!isNetworkLockstepMessage(message)) return false;
    if (!this.options.isMessageForCurrentGame(message)) return true;
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

  private acceptInbound(
    message: NetworkLockstepMessage,
    fromPlayerId: PlayerId | undefined,
  ): boolean {
    switch (message.type) {
      case 'lockstepCommand':
        // A watcher holds no seat, so it can own no unit and author no
        // command. Refused at the transport rather than downstream: a
        // command that never enters the stream cannot be executed by mistake.
        if (fromPlayerId === undefined) return false;
        if (message.envelope.playerId !== fromPlayerId) return false;
        return this.acceptCommand(message);
      case 'lockstepCommandFrame':
        return this.acceptCommandFrame(message);
      case 'lockstepCommandFrameBatch':
        return this.acceptCommandFrameBatch(message);
      case 'lockstepAck':
        if (fromPlayerId === undefined) return true;
        {
          // Monotonic: acks carry EXECUTED progress, which never regresses.
          // A stale ack overtaken in flight (or replayed during a resend
          // burst) must not shrink the coordinator's view of a peer — that
          // regression is what used to trip spurious flow-control pauses.
          const stored = this.latestAckByPlayer.get(fromPlayerId);
          if (stored !== undefined && message.ackFrame <= stored.ackFrame) return true;
          this.latestAckByPlayer.set(fromPlayerId, message);
          this.pruneOutboundCommandFrames();
        }
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

  private minAckedFrameAcrossConnectedPeers(): number | null {
    let minAckedFrame: number | null = null;
    // Seated peers only. History is retained for the players a resend can
    // ever be owed to; a watcher that falls behind asks for what it needs.
    for (const playerId of this.options.getSeatedConnections().keys()) {
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
