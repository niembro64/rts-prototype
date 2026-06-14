import { ARCHITECTURE_CONFIG } from '@/architectureConfig';
import type { Command } from '../sim/commands';
import type { PlayerId } from '../sim/types';
import type { ServerSimulationCore } from '../server/ServerSimulationCore';
import type { CanonicalServerStateHash } from './CanonicalStateHash';
import {
  compareLockstepCommandEnvelopes,
  type LockstepCommandEnvelope,
  type LockstepCommandRejection,
  validateLockstepCommandFrameForPeer,
} from './LockstepCommandProtocol';

export const LOCKSTEP_FIXED_STEP_HZ = ARCHITECTURE_CONFIG.lockstep.fixedStepHz;
export const LOCKSTEP_FIXED_DT_MS = 1000 / LOCKSTEP_FIXED_STEP_HZ;

export type LockstepFrameSchedulerStatus =
  | 'running'
  | 'stalled'
  | 'protocol-paused'
  | 'desynced';

export type LockstepTabThrottlingPolicy =
  'stall-on-missing-frames-catch-up-ready-frames';

export type LockstepCompleteCommandFrame = {
  readonly frame: number;
  readonly frameSequence: number;
  readonly commands: readonly LockstepCommandEnvelope[];
};

export type LockstepFrameAdvanceEvent = {
  readonly frame: number;
  readonly frameSequence: number;
  readonly dtMs: number;
  readonly commandCount: number;
  readonly nextFrame: number;
};

export type LockstepChecksumEvent = {
  readonly frame: number;
  readonly stateHash: CanonicalServerStateHash;
};

export type LockstepFrameSchedulerDiagnostics = {
  readonly status: LockstepFrameSchedulerStatus;
  readonly nextFrame: number;
  readonly fixedDtMs: number;
  readonly queuedFrameCount: number;
  readonly lastAdvancedFrame: number | null;
  readonly lastChecksumFrame: number | null;
  readonly missingFrame: number | null;
  readonly stalledSinceMs: number | null;
  readonly pausedFrame: number | null;
  readonly pauseReason: string | null;
  readonly missingReadyPeerIds: readonly PlayerId[];
  readonly pendingCommandFrames: readonly {
    readonly frame: number;
    readonly frameSequence: number;
    readonly commandCount: number;
  }[];
  readonly performance: {
    readonly framesAdvancedTotal: number;
    readonly lastPumpAdvancedFrames: number;
    readonly simStepMsAvg: number;
    readonly simStepMsHi: number;
    readonly pumpMsAvg: number;
    readonly pumpMsHi: number;
    readonly stallElapsedMs: number;
  };
  readonly tabThrottlingPolicy: LockstepTabThrottlingPolicy;
  readonly message: string;
};

export type LockstepFrameSchedulerAdvanceResult = {
  readonly advancedFrames: number;
  readonly nextFrame: number;
  readonly status: LockstepFrameSchedulerStatus;
  readonly stalled: boolean;
};

export type LockstepFrameSchedulerOptions = {
  readonly core: Pick<ServerSimulationCore, 'world' | 'stepFixedTick' | 'getCanonicalStateHash'>;
  readonly expectedPlayerIds: readonly PlayerId[];
  readonly checksumIntervalTicks?: number;
  readonly fixedDtMs?: number;
  readonly requirePeerReady?: boolean;
  readonly materializeCommandFrame?: (
    frame: LockstepCompleteCommandFrame,
    core: Pick<ServerSimulationCore, 'world' | 'stepFixedTick' | 'getCanonicalStateHash'>,
    onRejected: (rejection: LockstepCommandRejection) => void,
  ) => readonly Command[];
  readonly nowMs?: () => number;
  readonly onFrameAdvanced?: (event: LockstepFrameAdvanceEvent) => void;
  readonly onChecksum?: (event: LockstepChecksumEvent) => void;
  readonly onDiagnostics?: (diagnostics: LockstepFrameSchedulerDiagnostics) => void;
  readonly onCommandRejected?: (rejection: LockstepCommandRejection) => void;
};

type StoredCommandFrame = {
  readonly frame: number;
  readonly frameSequence: number;
  readonly commands: readonly LockstepCommandEnvelope[];
  readonly signature: string;
};

const RECENT_FRAME_LIMIT = 180;

export class LockstepFrameScheduler {
  private readonly core: Pick<ServerSimulationCore, 'world' | 'stepFixedTick' | 'getCanonicalStateHash'>;
  private readonly expectedPlayerIds: readonly PlayerId[];
  private readonly checksumIntervalTicks: number;
  private readonly fixedDtMs: number;
  private readonly requirePeerReady: boolean;
  private readonly materializeCommandFrame: NonNullable<LockstepFrameSchedulerOptions['materializeCommandFrame']>;
  private readonly nowMs: () => number;
  private readonly onFrameAdvanced: ((event: LockstepFrameAdvanceEvent) => void) | undefined;
  private readonly onChecksum: ((event: LockstepChecksumEvent) => void) | undefined;
  private readonly onDiagnostics: ((diagnostics: LockstepFrameSchedulerDiagnostics) => void) | undefined;
  private readonly onCommandRejected: ((rejection: LockstepCommandRejection) => void) | undefined;

  private readonly readyPeerIds = new Set<PlayerId>();
  private readonly queuedFrames = new Map<number, StoredCommandFrame>();
  private readonly recentFrames: StoredCommandFrame[] = [];
  private nextFrame: number;
  private status: LockstepFrameSchedulerStatus = 'running';
  private missingFrame: number | null = null;
  private stalledSinceMs: number | null = null;
  private pausedFrame: number | null = null;
  private pauseReason: string | null = null;
  private lastAdvancedFrame: number | null = null;
  private lastChecksumFrame: number | null = null;
  private framesAdvancedTotal = 0;
  private lastPumpAdvancedFrames = 0;
  private simStepMsAvg = 0;
  private simStepMsHi = 0;
  private simStepMsInitialized = false;
  private pumpMsAvg = 0;
  private pumpMsHi = 0;
  private pumpMsInitialized = false;

  constructor(options: LockstepFrameSchedulerOptions) {
    this.core = options.core;
    this.expectedPlayerIds = [...options.expectedPlayerIds].sort((a, b) => a - b);
    this.checksumIntervalTicks = options.checksumIntervalTicks ??
      ARCHITECTURE_CONFIG.lockstep.checksumIntervalTicks;
    this.fixedDtMs = options.fixedDtMs ?? LOCKSTEP_FIXED_DT_MS;
    this.requirePeerReady = options.requirePeerReady === true;
    this.materializeCommandFrame = options.materializeCommandFrame ??
      ((frame, core, onRejected) =>
        validateLockstepCommandFrameForPeer(frame.commands, core.world, onRejected));
    this.nowMs = options.nowMs ?? defaultNowMs;
    this.onFrameAdvanced = options.onFrameAdvanced;
    this.onChecksum = options.onChecksum;
    this.onDiagnostics = options.onDiagnostics;
    this.onCommandRejected = options.onCommandRejected;
    this.nextFrame = this.core.world.getTick();

    if (!this.requirePeerReady) {
      for (const playerId of this.expectedPlayerIds) this.readyPeerIds.add(playerId);
    }
  }

  receiveCommandFrame(frame: LockstepCompleteCommandFrame): boolean {
    this.assertFrameInteger(frame.frame, 'frame');
    this.assertFrameInteger(frame.frameSequence, 'frameSequence');
    if (frame.frame < this.nextFrame) return false;

    const commands = [...frame.commands].sort(compareLockstepCommandEnvelopes);
    const signature = commandFrameSignature(commands);
    const existing = this.queuedFrames.get(frame.frame);
    if (existing !== undefined) {
      if (
        existing.frameSequence === frame.frameSequence &&
        existing.signature === signature
      ) {
        return false;
      }
      this.markDesynced(
        `Conflicting command frame ${frame.frame}: ` +
          `existing sequence ${existing.frameSequence}, received ${frame.frameSequence}`,
      );
      return false;
    }

    this.queuedFrames.set(frame.frame, {
      frame: frame.frame,
      frameSequence: frame.frameSequence,
      commands,
      signature,
    });
    this.emitDiagnostics();
    return true;
  }

  markPeerReady(playerId: PlayerId): void {
    if (!this.expectedPlayerIds.includes(playerId)) return;
    this.readyPeerIds.add(playerId);
    if (this.status === 'stalled' && this.missingReadyPeerIds().length === 0) {
      this.clearStall();
    }
    this.emitDiagnostics();
  }

  pause(frame: number, reason: string): void {
    this.assertFrameInteger(frame, 'frame');
    this.status = 'protocol-paused';
    this.pausedFrame = frame;
    this.pauseReason = reason;
    this.clearStall();
    this.emitDiagnostics();
  }

  resume(resumeFrame: number): void {
    this.assertFrameInteger(resumeFrame, 'resumeFrame');
    if (resumeFrame > this.nextFrame) this.nextFrame = resumeFrame;
    this.status = 'running';
    this.pausedFrame = null;
    this.pauseReason = null;
    this.emitDiagnostics();
  }

  markDesynced(reason: string): void {
    this.status = 'desynced';
    this.pauseReason = reason;
    this.emitDiagnostics();
  }

  advanceReadyFrames(maxFrames: number = 1): LockstepFrameSchedulerAdvanceResult {
    if (!Number.isInteger(maxFrames) || maxFrames <= 0) {
      throw new Error('[lockstep scheduler] maxFrames must be a positive integer');
    }

    if (this.status === 'protocol-paused' || this.status === 'desynced') {
      return this.result(0);
    }

    const missingReadyPeerIds = this.missingReadyPeerIds();
    if (missingReadyPeerIds.length > 0) {
      this.markStalled(null);
      return this.result(0);
    }

    const pumpStartMs = this.nowMs();
    let advancedFrames = 0;
    while (advancedFrames < maxFrames) {
      const frame = this.queuedFrames.get(this.nextFrame);
      if (frame === undefined) {
        this.markStalled(this.nextFrame);
        break;
      }

      this.clearStall();
      this.queuedFrames.delete(this.nextFrame);
      const commands = this.materializeCommandFrame(
        frame,
        this.core,
        (rejection) => this.onCommandRejected?.(rejection),
      );
      const simStepStartMs = this.nowMs();
      this.core.stepFixedTick(this.fixedDtMs, commands);
      this.recordSimStepMs(this.nowMs() - simStepStartMs);
      this.recentFrames.push(frame);
      while (this.recentFrames.length > RECENT_FRAME_LIMIT) this.recentFrames.shift();

      this.lastAdvancedFrame = frame.frame;
      this.nextFrame = frame.frame + 1;
      advancedFrames++;
      this.framesAdvancedTotal++;
      this.onFrameAdvanced?.({
        frame: frame.frame,
        frameSequence: frame.frameSequence,
        dtMs: this.fixedDtMs,
        commandCount: commands.length,
        nextFrame: this.nextFrame,
      });

      if (
        this.checksumIntervalTicks > 0 &&
        this.nextFrame > 0 &&
        this.nextFrame % this.checksumIntervalTicks === 0
      ) {
        const stateHash = this.core.getCanonicalStateHash();
        this.lastChecksumFrame = this.nextFrame;
        this.onChecksum?.({ frame: this.nextFrame, stateHash });
      }
    }

    this.lastPumpAdvancedFrames = advancedFrames;
    this.recordPumpMs(this.nowMs() - pumpStartMs);
    if (advancedFrames > 0) this.emitDiagnostics();
    return this.result(advancedFrames);
  }

  getDiagnostics(): LockstepFrameSchedulerDiagnostics {
    const missingReadyPeerIds = this.missingReadyPeerIds();
    const message = this.statusMessage(missingReadyPeerIds);
    return {
      status: this.status,
      nextFrame: this.nextFrame,
      fixedDtMs: this.fixedDtMs,
      queuedFrameCount: this.queuedFrames.size,
      lastAdvancedFrame: this.lastAdvancedFrame,
      lastChecksumFrame: this.lastChecksumFrame,
      missingFrame: this.missingFrame,
      stalledSinceMs: this.stalledSinceMs,
      pausedFrame: this.pausedFrame,
      pauseReason: this.pauseReason,
      missingReadyPeerIds,
      pendingCommandFrames: this.getQueuedCommandFrameSummaries(),
      performance: {
        framesAdvancedTotal: this.framesAdvancedTotal,
        lastPumpAdvancedFrames: this.lastPumpAdvancedFrames,
        simStepMsAvg: this.simStepMsAvg,
        simStepMsHi: this.simStepMsHi,
        pumpMsAvg: this.pumpMsAvg,
        pumpMsHi: this.pumpMsHi,
        stallElapsedMs: this.stalledSinceMs === null ? 0 : Math.max(0, this.nowMs() - this.stalledSinceMs),
      },
      tabThrottlingPolicy: 'stall-on-missing-frames-catch-up-ready-frames',
      message,
    };
  }

  getQueuedCommandFrames(): readonly LockstepCompleteCommandFrame[] {
    return [...this.queuedFrames.values()]
      .sort((a, b) => a.frame - b.frame || a.frameSequence - b.frameSequence)
      .map((frame) => ({
        frame: frame.frame,
        frameSequence: frame.frameSequence,
        commands: frame.commands,
      }));
  }

  getRecentCommandFrames(): readonly LockstepCompleteCommandFrame[] {
    return this.recentFrames.map((frame) => ({
      frame: frame.frame,
      frameSequence: frame.frameSequence,
      commands: frame.commands,
    }));
  }

  clear(): void {
    this.queuedFrames.clear();
    this.recentFrames.length = 0;
    this.readyPeerIds.clear();
    if (!this.requirePeerReady) {
      for (const playerId of this.expectedPlayerIds) this.readyPeerIds.add(playerId);
    }
    this.status = 'running';
    this.missingFrame = null;
    this.stalledSinceMs = null;
    this.pausedFrame = null;
    this.pauseReason = null;
    this.lastAdvancedFrame = null;
    this.lastChecksumFrame = null;
    this.framesAdvancedTotal = 0;
    this.lastPumpAdvancedFrames = 0;
    this.simStepMsAvg = 0;
    this.simStepMsHi = 0;
    this.simStepMsInitialized = false;
    this.pumpMsAvg = 0;
    this.pumpMsHi = 0;
    this.pumpMsInitialized = false;
    this.nextFrame = this.core.world.getTick();
    this.emitDiagnostics();
  }

  private recordSimStepMs(sampleMs: number): void {
    const sample = Number.isFinite(sampleMs) && sampleMs >= 0 ? sampleMs : 0;
    if (!this.simStepMsInitialized) {
      this.simStepMsAvg = sample;
      this.simStepMsHi = sample;
      this.simStepMsInitialized = true;
      return;
    }
    this.simStepMsAvg = this.simStepMsAvg * 0.95 + sample * 0.05;
    this.simStepMsHi = sample > this.simStepMsHi
      ? this.simStepMsHi * 0.5 + sample * 0.5
      : this.simStepMsHi * 0.995 + sample * 0.005;
  }

  private recordPumpMs(sampleMs: number): void {
    const sample = Number.isFinite(sampleMs) && sampleMs >= 0 ? sampleMs : 0;
    if (!this.pumpMsInitialized) {
      this.pumpMsAvg = sample;
      this.pumpMsHi = sample;
      this.pumpMsInitialized = true;
      return;
    }
    this.pumpMsAvg = this.pumpMsAvg * 0.95 + sample * 0.05;
    this.pumpMsHi = sample > this.pumpMsHi
      ? this.pumpMsHi * 0.5 + sample * 0.5
      : this.pumpMsHi * 0.995 + sample * 0.005;
  }

  private result(advancedFrames: number): LockstepFrameSchedulerAdvanceResult {
    return {
      advancedFrames,
      nextFrame: this.nextFrame,
      status: this.status,
      stalled: this.status === 'stalled',
    };
  }

  private markStalled(missingFrame: number | null): void {
    if (this.status !== 'stalled') {
      this.stalledSinceMs = this.nowMs();
    }
    this.status = 'stalled';
    this.missingFrame = missingFrame;
    this.emitDiagnostics();
  }

  private clearStall(): void {
    if (this.status === 'stalled') this.status = 'running';
    this.missingFrame = null;
    this.stalledSinceMs = null;
  }

  private missingReadyPeerIds(): PlayerId[] {
    if (!this.requirePeerReady) return [];
    return this.expectedPlayerIds.filter((playerId) => !this.readyPeerIds.has(playerId));
  }

  private getQueuedCommandFrameSummaries(): LockstepFrameSchedulerDiagnostics['pendingCommandFrames'] {
    return [...this.queuedFrames.values()]
      .sort((a, b) => a.frame - b.frame || a.frameSequence - b.frameSequence)
      .map((frame) => ({
        frame: frame.frame,
        frameSequence: frame.frameSequence,
        commandCount: frame.commands.length,
      }));
  }

  private statusMessage(missingReadyPeerIds: readonly PlayerId[]): string {
    if (this.status === 'protocol-paused') {
      return `Lockstep paused at frame ${this.pausedFrame}: ${this.pauseReason ?? 'protocol pause'}`;
    }
    if (this.status === 'desynced') {
      return `Lockstep desynced at frame ${this.nextFrame}: ${this.pauseReason ?? 'checksum mismatch'}`;
    }
    if (missingReadyPeerIds.length > 0) {
      return `Waiting for lockstep peers: ${missingReadyPeerIds.join(', ')}`;
    }
    if (this.status === 'stalled') {
      return `Waiting for lockstep command frame ${this.missingFrame ?? this.nextFrame}`;
    }
    return `Lockstep running at frame ${this.nextFrame}`;
  }

  private emitDiagnostics(): void {
    this.onDiagnostics?.(this.getDiagnostics());
  }

  private assertFrameInteger(value: number, label: string): void {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`[lockstep scheduler] ${label} must be a non-negative integer`);
    }
  }
}

function commandFrameSignature(commands: readonly LockstepCommandEnvelope[]): string {
  return commands
    .map((envelope) =>
      `${envelope.gameId}:${envelope.executeFrame}:${envelope.playerId}:` +
        `${envelope.playerSequence}:${envelope.commandIndex}:` +
        `${JSON.stringify(envelope.command)}`,
    )
    .join('|');
}

function defaultNowMs(): number {
  return 0;
}
