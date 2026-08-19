/**
 * Replaying a match from frame 0 so a late arrival can join it.
 *
 * A joiner boots the same simulation everyone else booted, from the same
 * hashed initialization, and then runs the archived command frames through it
 * until it reaches the frame the coordinator was at when it was let in. There
 * is no state snapshot to import — `CanonicalCheckpoint` is a command log —
 * so this is the mechanism rather than one option among several.
 *
 * The thing that must not be discovered at runtime is the CEILING. Replay
 * speed is bounded by simulation step cost, which grows with the number of
 * live entities: measured at roughly 18 ms/tick at an entity cap of 1000 and
 * ~50 ms at 2500. A real-time frame at 20 Hz is 50 ms, so a joiner replays at
 * about 2.7x real time in the first case and about 1.0x in the second. At 1.0x
 * the gap never closes, and early frames are cheap while late ones are not, so
 * the achieved rate FALLS as the replay progresses.
 *
 * Therefore: measure the rate continuously, show it, and fail with the number
 * when convergence is not possible. A refused join with a reason is a better
 * outcome than an infinite spinner, and it is the honest one.
 *
 * The catch-up loop is deliberately time-budgeted rather than frame-counted.
 * It runs on the ordinary animation frame, in the one and only gameplay-truth
 * simulation this runtime is allowed to own — it does not boot a second sim
 * beside the real one and promote it later.
 */

import { createStateMachine, type StateMachine } from '../state/StateMachine';

export type LockstepCatchUpState =
  /** Asked the coordinator to let us in; waiting for the grant. */
  | 'requesting'
  /** Grant received; the simulation is booted and frames are arriving. */
  | 'replaying'
  /** Reached the grant frame; comparing our state hash against the
   *  coordinator's before we are allowed to render anything. */
  | 'verifying'
  /** Caught up and part of the match. */
  | 'live'
  /** Gave up, with a reason. Terminal. */
  | 'failed';

type LockstepCatchUpEvent = 'granted' | 'reachedGrant' | 'verified' | 'fail';

export type LockstepCatchUpFailure =
  /** The replay cannot outrun the live match — see the ceiling above. */
  | 'cannot-converge'
  /** Our replayed state does not match the coordinator's at the grant frame. */
  | 'state-mismatch'
  /** The coordinator never answered, or went away. */
  | 'no-grant';

export type LockstepCatchUpProgress = {
  readonly state: LockstepCatchUpState;
  readonly currentFrame: number;
  readonly targetFrame: number;
  /** 0..1 across the whole replay, for a loading bar. */
  readonly fraction: number;
  /** Achieved replay speed as a multiple of real time. 1.0 means the replay is
   *  running exactly as fast as the match is being played, which means it will
   *  never arrive. */
  readonly rateRealtime: number;
  /** Seconds until the replay reaches the target at the current rate, or null
   *  while that cannot be projected (too early, or not converging). */
  readonly etaSeconds: number | null;
  readonly failure: LockstepCatchUpFailure | null;
};

/**
 * Below this multiple of real time the replay is not gaining meaningfully and
 * an honest estimate is impossible. Not 1.0: a joiner running at 1.05x would
 * technically converge, in about an hour.
 */
const MIN_CONVERGING_RATE = 1.15;

/** How long a slow rate must persist before the join is refused. Long enough
 *  that a shader compile or a GC pause during the opening frames does not
 *  condemn an otherwise fine replay. */
const CONVERGENCE_GRACE_MS = 8000;

/** Rate is measured over a window rather than since the start, because the
 *  early frames of a match are unrepresentatively cheap. */
const RATE_WINDOW_MS = 2000;

type LockstepCatchUpOptions = {
  readonly tickRateHz: number;
  readonly nowMs?: () => number;
  readonly minConvergingRate?: number;
  readonly convergenceGraceMs?: number;
};

function createCatchUpMachine(): StateMachine<LockstepCatchUpState, LockstepCatchUpEvent> {
  return createStateMachine<LockstepCatchUpState, LockstepCatchUpEvent>({
    name: 'lockstep-catch-up',
    initial: 'requesting',
    transitions: {
      requesting: { granted: 'replaying', fail: 'failed' },
      replaying: { reachedGrant: 'verifying', fail: 'failed' },
      // Verification is the gate: a replay that does not agree with the
      // coordinator is a desync, and joining anyway would spread it.
      verifying: { verified: 'live', fail: 'failed' },
      // Terminal. Nothing returns a live peer to catching up; a peer that
      // falls behind later is an ordinary lag problem, not a new join.
      live: {},
      failed: {},
    },
  });
}

export class LockstepCatchUp {
  private readonly machine = createCatchUpMachine();
  private readonly tickRateHz: number;
  private readonly nowMs: () => number;
  private readonly minConvergingRate: number;
  private readonly convergenceGraceMs: number;

  private targetFrame = 0;
  private currentFrame = 0;
  private failure: LockstepCatchUpFailure | null = null;

  /** Start of the current measurement window: wall time and the frame we were
   *  on when it opened. */
  private windowStartMs = 0;
  private windowStartFrame = 0;
  private rateRealtime = 0;
  /** When the rate first dropped below the converging threshold, so a brief
   *  stall does not refuse a join that would have finished. */
  private slowSinceMs: number | null = null;

  constructor(options: LockstepCatchUpOptions) {
    this.tickRateHz = options.tickRateHz > 0 ? options.tickRateHz : 20;
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.minConvergingRate = options.minConvergingRate ?? MIN_CONVERGING_RATE;
    this.convergenceGraceMs = options.convergenceGraceMs ?? CONVERGENCE_GRACE_MS;
  }

  get state(): LockstepCatchUpState {
    return this.machine.state;
  }

  /** The coordinator let us in and told us how far it has got. */
  grant(grantFrame: number, startFrame: number): boolean {
    if (!this.machine.send('granted')) return false;
    this.targetFrame = grantFrame;
    this.currentFrame = startFrame;
    this.windowStartMs = this.nowMs();
    this.windowStartFrame = startFrame;
    this.slowSinceMs = null;
    return true;
  }

  /** The coordinator has moved on while we replay, so the finish line moves
   *  with it. This is why the rate has to beat real time rather than merely
   *  be positive. */
  setTargetFrame(frame: number): void {
    if (frame > this.targetFrame) this.targetFrame = frame;
  }

  /**
   * Report progress after a slice of replay.
   *
   * Returns the current progress, and moves the machine to `verifying` on the
   * pump that reaches the target, or to `failed` when the replay has spent
   * long enough unable to gain on a moving target.
   */
  report(currentFrame: number): LockstepCatchUpProgress {
    this.currentFrame = currentFrame;
    const now = this.nowMs();

    const windowMs = now - this.windowStartMs;
    if (windowMs >= RATE_WINDOW_MS) {
      const framesReplayed = currentFrame - this.windowStartFrame;
      const framesOfRealTime = (windowMs / 1000) * this.tickRateHz;
      this.rateRealtime = framesOfRealTime > 0 ? framesReplayed / framesOfRealTime : 0;
      this.windowStartMs = now;
      this.windowStartFrame = currentFrame;

      if (this.machine.is('replaying')) {
        if (this.rateRealtime < this.minConvergingRate) {
          if (this.slowSinceMs === null) this.slowSinceMs = now;
          else if (now - this.slowSinceMs >= this.convergenceGraceMs) {
            this.fail('cannot-converge');
          }
        } else {
          this.slowSinceMs = null;
        }
      }
    }

    if (this.machine.is('replaying') && currentFrame >= this.targetFrame) {
      this.machine.send('reachedGrant');
    }

    return this.getProgress();
  }

  /** Our replayed state agrees with the coordinator's at the grant frame. */
  verified(): boolean {
    return this.machine.send('verified');
  }

  fail(failure: LockstepCatchUpFailure): boolean {
    if (!this.machine.send('fail')) return false;
    this.failure = failure;
    return true;
  }

  getProgress(): LockstepCatchUpProgress {
    const span = Math.max(1, this.targetFrame - this.windowStartFrameFloor());
    const done = Math.max(0, this.currentFrame - this.windowStartFrameFloor());
    const remaining = Math.max(0, this.targetFrame - this.currentFrame);
    // A projection is only honest while the replay is actually gaining: at or
    // below real time the remaining frames never run out.
    const gain = this.rateRealtime - 1;
    const etaSeconds =
      this.machine.is('replaying') && gain > 0 && this.rateRealtime > 0
        ? remaining / this.tickRateHz / gain
        : null;
    return {
      state: this.machine.state,
      currentFrame: this.currentFrame,
      targetFrame: this.targetFrame,
      fraction: Math.max(0, Math.min(1, done / span)),
      rateRealtime: this.rateRealtime,
      etaSeconds,
      failure: this.failure,
    };
  }

  /** Replays always start at frame 0 today; kept as a seam so a state
   *  checkpoint baseline can start somewhere else without the progress maths
   *  having to change. */
  private windowStartFrameFloor(): number {
    return 0;
  }
}
