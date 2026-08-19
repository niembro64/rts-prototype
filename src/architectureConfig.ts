import rawArchitectureConfig from './architecture.json';
import type { SnapshotConfig } from './types/config';

type LockstepDesyncPolicy = 'pause';

type LockstepPresentationSnapshotConfig = SnapshotConfig;

/**
 * How far the match may run ahead of its slowest seated player, and when it
 * stops running at all.
 *
 * Two tiers, because a pause is too coarse to be the only tool. Below the
 * window nothing happens; above it the coordinator throttles to the slowest
 * peer, which is what lockstep is supposed to feel like. A hard pause is
 * reserved for a player who is disconnected or hopelessly behind, and it is
 * bounded: past `dropAfterSeconds` the coordinator resigns the seat so one
 * closed laptop cannot end everyone's evening.
 */
export type LockstepFlowControlConfig = {
  /** Frames the coordinator may run ahead of the slowest seated player before
   *  it throttles. Roughly twice the input delay: under that, a peer is
   *  merely doing what the protocol already asks of it. */
  readonly lagWindowTicks: number;
  /** How far behind, in seconds and sustained, before a player becomes a
   *  pause subject. */
  readonly pauseAfterSeconds: number;
  /** How close they must get before the pause lifts. Lower than the entry
   *  threshold on purpose — without the gap a peer at the line flickers the
   *  whole match on and off. */
  readonly resumeWithinSeconds: number;
  /** How long a bad reading must persist before it counts. A spike is not a
   *  lagging player, and pausing on one is worse than waiting. */
  readonly pauseGraceMs: number;
  /** How long a subject may hold the match before the coordinator resigns
   *  their seat and play continues without them. */
  readonly dropAfterSeconds: number;
};

export type LockstepArchitectureConfig = {
  readonly fixedStepHz: number;
  readonly inputDelayTicks: number;
  readonly checksumIntervalTicks: number;
  readonly stallTimeoutMs: number;
  readonly desyncPolicy: LockstepDesyncPolicy;
  readonly flowControl: LockstepFlowControlConfig;
  readonly presentationSnapshots: LockstepPresentationSnapshotConfig;
};

type ArchitectureConfig = {
  readonly lockstep: LockstepArchitectureConfig;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePositiveInteger(
  value: unknown,
  path: string,
  options: { min?: number } = {},
): number {
  const min = options.min ?? 1;
  if (!Number.isInteger(value) || (value as number) < min) {
    throw new Error(`${path} must be an integer >= ${min}; received ${String(value)}`);
  }
  return value as number;
}

function parsePositiveFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${path} must be a finite number > 0; received ${String(value)}`);
  }
  return value;
}

function parseDesyncPolicy(value: unknown): LockstepDesyncPolicy {
  if (value === 'pause') return value;
  throw new Error(`architecture.lockstep.desyncPolicy must be "pause"; received ${String(value)}`);
}

function parseLockstepPresentationSnapshotConfig(
  value: unknown,
): LockstepPresentationSnapshotConfig {
  if (!isRecord(value)) {
    throw new Error('architecture.lockstep.presentationSnapshots must be an object');
  }
  return {
    nominalSnapshotRateHz: parsePositiveFiniteNumber(
      value.nominalSnapshotRateHz,
      'architecture.lockstep.presentationSnapshots.nominalSnapshotRateHz',
    ),
  };
}

function parseLockstepFlowControlConfig(value: unknown): LockstepFlowControlConfig {
  if (!isRecord(value)) {
    throw new Error('architecture.lockstep.flowControl must be an object');
  }
  const config: LockstepFlowControlConfig = {
    lagWindowTicks: parsePositiveInteger(
      value.lagWindowTicks,
      'architecture.lockstep.flowControl.lagWindowTicks',
    ),
    pauseAfterSeconds: parsePositiveFiniteNumber(
      value.pauseAfterSeconds,
      'architecture.lockstep.flowControl.pauseAfterSeconds',
    ),
    resumeWithinSeconds: parsePositiveFiniteNumber(
      value.resumeWithinSeconds,
      'architecture.lockstep.flowControl.resumeWithinSeconds',
    ),
    pauseGraceMs: parsePositiveInteger(
      value.pauseGraceMs,
      'architecture.lockstep.flowControl.pauseGraceMs',
      { min: 0 },
    ),
    dropAfterSeconds: parsePositiveFiniteNumber(
      value.dropAfterSeconds,
      'architecture.lockstep.flowControl.dropAfterSeconds',
    ),
  };
  // The hysteresis has to be real, or a peer hovering at the line toggles the
  // whole match. Caught at startup rather than felt in a live game.
  if (config.resumeWithinSeconds >= config.pauseAfterSeconds) {
    throw new Error(
      'architecture.lockstep.flowControl.resumeWithinSeconds must be below pauseAfterSeconds',
    );
  }
  if (config.dropAfterSeconds <= config.pauseAfterSeconds) {
    throw new Error(
      'architecture.lockstep.flowControl.dropAfterSeconds must exceed pauseAfterSeconds',
    );
  }
  return config;
}

function parseLockstepConfig(value: unknown): LockstepArchitectureConfig {
  if (!isRecord(value)) {
    throw new Error('architecture.lockstep must be an object');
  }
  return {
    fixedStepHz: parsePositiveInteger(
      value.fixedStepHz,
      'architecture.lockstep.fixedStepHz',
    ),
    inputDelayTicks: parsePositiveInteger(
      value.inputDelayTicks,
      'architecture.lockstep.inputDelayTicks',
    ),
    checksumIntervalTicks: parsePositiveInteger(
      value.checksumIntervalTicks,
      'architecture.lockstep.checksumIntervalTicks',
    ),
    stallTimeoutMs: parsePositiveInteger(
      value.stallTimeoutMs,
      'architecture.lockstep.stallTimeoutMs',
      { min: 250 },
    ),
    desyncPolicy: parseDesyncPolicy(value.desyncPolicy),
    flowControl: parseLockstepFlowControlConfig(value.flowControl),
    presentationSnapshots: parseLockstepPresentationSnapshotConfig(value.presentationSnapshots),
  };
}

function parseArchitectureConfig(value: unknown): ArchitectureConfig {
  if (!isRecord(value)) {
    throw new Error('architecture config must be an object');
  }
  return {
    lockstep: parseLockstepConfig(value.lockstep),
  };
}

export const ARCHITECTURE_CONFIG = parseArchitectureConfig(rawArchitectureConfig);
