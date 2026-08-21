/**
 * How far the match may run ahead of its slowest seated player, and when it
 * stops running at all.
 *
 * Lockstep is supposed to run at the speed of its slowest participant. It did
 * not: the coordinator minted command frames off a wall clock and read peer
 * acks only for resends, so a lagging player fell behind without limit while
 * everyone else played on. Their orders still executed — rescheduled forward
 * to whatever frame the coordinator had reached — which is the worst of both
 * worlds: no desync, and no playable game for the person behind. The "WAITING
 * FOR" indicator on screen named who was behind while nobody waited.
 *
 * Two tiers, both driven by the acks the coordinator already tracks:
 *
 *   THROTTLE (continuous, unlatched)  the coordinator will not emit a frame
 *     more than `lagWindowTicks` ahead of the slowest seated player. Under the
 *     window nothing changes; over it the match slows to that player. This is
 *     the mechanism, and it makes the second tier rare.
 *
 *   PAUSE (discrete, latched, named subject)  a player who is disconnected or
 *     sustainedly far behind stops the match outright, with their name on it.
 *     Bounded: a subject that spends `dropAfterSeconds` making NO progress is
 *     resigned and play continues, because one closed laptop must not end
 *     everyone's evening. Progress defers the clock — a reconnected player
 *     replaying a long match back from frame 0 acks continuously and is
 *     waited for however long the replay takes, while a dead socket, a killed
 *     tab, or a failed replay all go silent and run the clock out.
 *
 * WATCHERS ARE NEVER INPUTS HERE. A spectator holds no seat, so it never
 * appears in the ack set this reads, and cannot throttle or pause anything.
 * That is structural rather than a rule to remember: `report()` is only ever
 * given seated players.
 */

import { ARCHITECTURE_CONFIG, type LockstepFlowControlConfig } from '@/architectureConfig';
import { createStateMachine, type StateMachine } from '../state/StateMachine';
import type { PlayerId } from '../sim/types';

/** Why the match is being held. Machine-readable so the UI can say something
 *  specific rather than "paused". */
export type LockstepPauseReason =
  /** The subject's connection has gone quiet. */
  | 'disconnected'
  /** The subject is connected but too far behind to keep up. */
  | 'far-behind';

export type LockstepFlowState =
  /** Everyone is inside the window; frames are emitted freely. */
  | 'running'
  /** Somebody is over the window; frame emission is capped to them. */
  | 'throttled'
  /** Over the pause threshold once. Not yet a pause — a spike is not a
   *  lagging player, and stopping the match for one is worse than waiting. */
  | 'slipping'
  /** Stopped, with a named subject. */
  | 'paused';

type LockstepFlowEvent =
  | 'withinWindow'
  | 'behindWindow'
  | 'overPauseThreshold'
  | 'recovered';

/** One seated player's progress, as the coordinator last saw it. */
export type SeatedPeerProgress = {
  readonly playerId: PlayerId;
  /** Frame acked, or null when nothing has been heard yet. Null is "unknown",
   *  not "at frame 0": at match start that would read as maximally behind. */
  readonly ackFrame: number | null;
  /** Whether the connection is still answering. A silent peer is a pause
   *  subject regardless of how far behind its last ack said it was. */
  readonly connected: boolean;
};

export type LockstepFlowDecision = {
  readonly state: LockstepFlowState;
  /** Frames the coordinator may mint this pump. Zero while paused, and capped
   *  to the window while throttled. */
  readonly allowedFrames: number;
  /** Who the match is being held for, or null. */
  readonly subjectPlayerId: PlayerId | null;
  readonly reason: LockstepPauseReason | null;
  /** True on the pump where a pause begins or ends, so the caller broadcasts
   *  exactly once rather than every tick. */
  readonly pauseChanged: boolean;
  /** Seats the coordinator should now resign: gone past `dropAfterSeconds`.
   *  Emitted once each — resigning is a frame-scheduled gameplay command and
   *  must not be issued twice for the same seat. */
  readonly dropPlayerIds: readonly PlayerId[];
  /** How far behind the worst seated player is, in frames. */
  readonly worstLagFrames: number;
};

type LockstepFlowControlOptions = {
  readonly tickRateHz: number;
  readonly config?: LockstepFlowControlConfig;
  readonly nowMs?: () => number;
};

function createFlowMachine(): StateMachine<LockstepFlowState, LockstepFlowEvent> {
  return createStateMachine<LockstepFlowState, LockstepFlowEvent>({
    name: 'lockstep-flow',
    initial: 'running',
    transitions: {
      running: { behindWindow: 'throttled', overPauseThreshold: 'slipping' },
      // Throttling is the ordinary state under load and returns freely; only
      // a sustained problem escalates past it.
      throttled: { withinWindow: 'running', overPauseThreshold: 'slipping' },
      // The grace state. A single bad reading gets here and no further, so a
      // hitch never stops the match.
      slipping: { overPauseThreshold: 'paused', withinWindow: 'running', recovered: 'running' },
      // Leaving a pause needs a clearly good reading, not merely a less bad
      // one. That asymmetry is the hysteresis, and it is why a peer hovering
      // at the threshold does not toggle the whole match on and off.
      paused: { recovered: 'running' },
    },
  });
}

export class LockstepFlowControl {
  private readonly config: LockstepFlowControlConfig;
  private readonly tickRateHz: number;
  private readonly nowMs: () => number;
  private readonly machine = createFlowMachine();
  private subjectPlayerId: PlayerId | null = null;
  private reason: LockstepPauseReason | null = null;
  /** When the current subject first went over the pause threshold. The grace
   *  window is measured from here rather than counted in ticks, because pump
   *  cadence varies under exactly the load this is watching for. */
  private overThresholdSinceMs: number | null = null;
  /**
   * When the drop clock last (re)started. Set when a pause latches, and RESET
   * whenever the paused subject reports a new ack: the timeout measures time
   * the subject spends making no progress, not wall time held. A closed laptop
   * never acks and is resigned on schedule; a player replaying their way back
   * into a long match acks continuously and is waited for — dropping a seat
   * mid-recovery would remove an army whose owner is seconds from returning.
   */
  private dropClockSinceMs: number | null = null;
  /** The subject's last seen ack while paused, for telling a stalled peer from
   *  one that is replaying. CHANGE is the signal, not increase: a rejoiner
   *  replays from frame 0, so its first acks are far below its old ones. */
  private subjectProgressAckFrame: number | null = null;
  private worstLagFrames = 0;
  private readonly droppedPlayerIds = new Set<PlayerId>();

  constructor(options: LockstepFlowControlOptions) {
    this.config = options.config ?? ARCHITECTURE_CONFIG.lockstep.flowControl;
    this.tickRateHz = options.tickRateHz > 0 ? options.tickRateHz : 20;
    this.nowMs = options.nowMs ?? (() => performance.now());
  }

  /**
   * Decide what the coordinator may do this pump.
   *
   * `seated` is the completion set and nothing else. `requestedFrames` is what
   * the wall clock would allow; the return caps it.
   */
  report(
    coordinatorFrame: number,
    seated: readonly SeatedPeerProgress[],
    requestedFrames: number,
  ): LockstepFlowDecision {
    const now = this.nowMs();
    const previousState = this.machine.state;

    const worst = this.findWorstPeer(coordinatorFrame, seated);
    this.worstLagFrames = worst.lagFrames;

    const lagSeconds = worst.lagFrames / this.tickRateHz;
    const pauseWorthy =
      worst.playerId !== null &&
      (!worst.connected || lagSeconds >= this.config.pauseAfterSeconds);
    const recovered =
      worst.playerId === null ||
      (worst.connected && lagSeconds <= this.config.resumeWithinSeconds);

    if (pauseWorthy) {
      this.reason = worst.connected ? 'far-behind' : 'disconnected';
      // A subject swap restarts the grace window: the new subject has not been
      // over the line for as long as the old one was.
      const isNewSubject =
        this.subjectPlayerId !== worst.playerId || this.overThresholdSinceMs === null;
      this.subjectPlayerId = worst.playerId;
      if (isNewSubject) {
        this.overThresholdSinceMs = now;
        this.subjectProgressAckFrame = null;
        // First bad reading only reaches `slipping`. The grace window below is
        // what decides whether it becomes a pause, so a spike stops here.
        this.machine.send('overPauseThreshold');
      } else if (
        this.overThresholdSinceMs !== null &&
        now - this.overThresholdSinceMs >= this.config.pauseGraceMs
      ) {
        this.machine.send('overPauseThreshold');
        if (this.machine.is('paused') && this.dropClockSinceMs === null) {
          this.dropClockSinceMs = now;
        }
      }
    } else {
      this.overThresholdSinceMs = null;
      if (recovered) {
        if (this.machine.send('recovered') || this.machine.send('withinWindow')) {
          this.subjectPlayerId = null;
          this.reason = null;
          this.dropClockSinceMs = null;
          this.subjectProgressAckFrame = null;
        }
      }
    }

    if (this.machine.is('paused')) this.deferDropWhileSubjectProgresses(seated, now);

    // Throttling only applies while not paused: a paused match emits nothing
    // at all, so the window is moot.
    if (!this.machine.is('paused') && !this.machine.is('slipping')) {
      if (worst.lagFrames > this.config.lagWindowTicks) {
        this.machine.send('behindWindow');
        if (this.subjectPlayerId === null) this.subjectPlayerId = worst.playerId;
      } else {
        if (this.machine.send('withinWindow')) this.subjectPlayerId = null;
      }
    }

    const dropPlayerIds = this.collectDrops(now);
    const state = this.machine.state;
    return {
      state,
      allowedFrames: this.allowedFrames(state, worst, requestedFrames),
      subjectPlayerId: state === 'running' ? null : this.subjectPlayerId,
      reason: state === 'paused' ? this.reason : null,
      pauseChanged: (previousState === 'paused') !== (state === 'paused'),
      dropPlayerIds,
      worstLagFrames: worst.lagFrames,
    };
  }

  /** Forget a seat entirely — it resigned, or the match ended. */
  forget(playerId: PlayerId): void {
    if (this.subjectPlayerId === playerId) {
      this.subjectPlayerId = null;
      this.reason = null;
      this.overThresholdSinceMs = null;
      this.dropClockSinceMs = null;
      this.subjectProgressAckFrame = null;
      this.machine.send('recovered');
    }
  }

  /**
   * A paused subject that is still reporting NEW acks is coming back — either
   * replaying into the match after a reconnect, or grinding through a stall —
   * so each fresh ack restarts the drop clock. A subject whose acks have
   * stopped moving is the case the timeout exists for: a dead socket, a killed
   * tab, or a failed replay all go silent, and the clock runs out on them.
   */
  private deferDropWhileSubjectProgresses(
    seated: readonly SeatedPeerProgress[],
    now: number,
  ): void {
    const subject = this.subjectPlayerId;
    if (subject === null || this.dropClockSinceMs === null) return;
    for (const peer of seated) {
      if (peer.playerId !== subject) continue;
      if (!peer.connected || peer.ackFrame === null) return;
      if (peer.ackFrame !== this.subjectProgressAckFrame) {
        this.subjectProgressAckFrame = peer.ackFrame;
        this.dropClockSinceMs = now;
      }
      return;
    }
  }

  getDiagnostics(): {
    readonly state: LockstepFlowState;
    readonly subjectPlayerId: PlayerId | null;
    readonly reason: LockstepPauseReason | null;
    readonly worstLagFrames: number;
    readonly config: LockstepFlowControlConfig;
  } {
    return {
      state: this.machine.state,
      subjectPlayerId: this.subjectPlayerId,
      reason: this.reason,
      worstLagFrames: this.worstLagFrames,
      config: this.config,
    };
  }

  /** The seated player furthest behind the coordinator. A peer that has not
   *  acked yet is skipped rather than counted at frame 0 — at match start that
   *  would paint everyone as maximally behind. */
  private findWorstPeer(
    coordinatorFrame: number,
    seated: readonly SeatedPeerProgress[],
  ): { playerId: PlayerId | null; lagFrames: number; connected: boolean } {
    let playerId: PlayerId | null = null;
    let lagFrames = 0;
    let connected = true;
    for (const peer of seated) {
      // A silent peer is a subject on its own account: its last ack may say it
      // was perfectly caught up a moment before the socket died.
      if (!peer.connected) {
        if (playerId === null || connected) {
          playerId = peer.playerId;
          connected = false;
          lagFrames = Math.max(lagFrames, peer.ackFrame === null
            ? 0
            : Math.max(0, coordinatorFrame - peer.ackFrame));
        }
        continue;
      }
      if (peer.ackFrame === null) continue;
      const behind = Math.max(0, coordinatorFrame - peer.ackFrame);
      if (connected && behind > lagFrames) {
        lagFrames = behind;
        playerId = peer.playerId;
      }
    }
    return { playerId, lagFrames, connected };
  }

  private allowedFrames(
    state: LockstepFlowState,
    worst: { playerId: PlayerId | null; lagFrames: number },
    requestedFrames: number,
  ): number {
    if (state === 'paused') return 0;
    if (worst.playerId === null) return requestedFrames;
    // Never mint a frame further than the window past the slowest player. The
    // headroom is what is left of the window, so a peer exactly at the edge
    // gets zero and the match waits for it.
    const headroom = this.config.lagWindowTicks - worst.lagFrames;
    if (headroom <= 0) return 0;
    return Math.min(requestedFrames, headroom);
  }

  /** Subjects that have held the match past `dropAfterSeconds` WITHOUT making
   *  progress — the clock restarts on every new ack, so only a subject that
   *  has gone quiet runs it out. Reported once each: resigning is a
   *  frame-scheduled gameplay command, and issuing it twice for one seat would
   *  remove an army that is already gone. */
  private collectDrops(now: number): readonly PlayerId[] {
    if (this.dropClockSinceMs === null || this.subjectPlayerId === null) return [];
    if (now - this.dropClockSinceMs < this.config.dropAfterSeconds * 1000) return [];
    const subject = this.subjectPlayerId;
    if (this.droppedPlayerIds.has(subject)) return [];
    this.droppedPlayerIds.add(subject);
    return [subject];
  }
}
