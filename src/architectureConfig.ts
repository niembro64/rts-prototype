import rawArchitectureConfig from './architecture.json';
import type { SnapshotConfig } from './types/config';

export type LockstepDesyncPolicy = 'pause';

export type LockstepPresentationSnapshotConfig = SnapshotConfig;

export type LockstepArchitectureConfig = {
  readonly fixedStepHz: number;
  readonly inputDelayTicks: number;
  readonly checksumIntervalTicks: number;
  readonly stallTimeoutMs: number;
  readonly desyncPolicy: LockstepDesyncPolicy;
  readonly allowLateJoin: false;
  readonly presentationSnapshots: LockstepPresentationSnapshotConfig;
};

export type ArchitectureConfig = {
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

function parseBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${path} must be a boolean; received ${String(value)}`);
  }
  return value;
}

function parseNonNegativeFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a finite number >= 0; received ${String(value)}`);
  }
  return value;
}

function parseDesyncPolicy(value: unknown): LockstepDesyncPolicy {
  if (value === 'pause') return value;
  throw new Error(`architecture.lockstep.desyncPolicy must be "pause"; received ${String(value)}`);
}

function parseAllowLateJoin(value: unknown): false {
  if (value === false) return false;
  throw new Error(
    'architecture.lockstep.allowLateJoin must be false until checkpoint import/export exists',
  );
}

function parseLockstepPresentationSnapshotConfig(
  value: unknown,
): LockstepPresentationSnapshotConfig {
  if (!isRecord(value)) {
    throw new Error('architecture.lockstep.presentationSnapshots must be an object');
  }
  return {
    deltaSnapshotsEnabled: parseBoolean(
      value.deltaSnapshotsEnabled,
      'architecture.lockstep.presentationSnapshots.deltaSnapshotsEnabled',
    ),
    deltaMovementPositionThresholdAsMapRatio: parseNonNegativeFiniteNumber(
      value.deltaMovementPositionThresholdAsMapRatio,
      'architecture.lockstep.presentationSnapshots.deltaMovementPositionThresholdAsMapRatio',
    ),
    deltaMovementVelocityMagnitudeThresholdAsLastSentSpeedRatio: parseNonNegativeFiniteNumber(
      value.deltaMovementVelocityMagnitudeThresholdAsLastSentSpeedRatio,
      'architecture.lockstep.presentationSnapshots.deltaMovementVelocityMagnitudeThresholdAsLastSentSpeedRatio',
    ),
    deltaMovementVelocityDirectionThresholdAsFullTurnRatio: parseNonNegativeFiniteNumber(
      value.deltaMovementVelocityDirectionThresholdAsFullTurnRatio,
      'architecture.lockstep.presentationSnapshots.deltaMovementVelocityDirectionThresholdAsFullTurnRatio',
    ),
    deltaRotationPositionThresholdAsFullTurnRatio: parseNonNegativeFiniteNumber(
      value.deltaRotationPositionThresholdAsFullTurnRatio,
      'architecture.lockstep.presentationSnapshots.deltaRotationPositionThresholdAsFullTurnRatio',
    ),
    deltaRotationVelocityMagnitudeThresholdAsLastSentAngularSpeedRatio: parseNonNegativeFiniteNumber(
      value.deltaRotationVelocityMagnitudeThresholdAsLastSentAngularSpeedRatio,
      'architecture.lockstep.presentationSnapshots.deltaRotationVelocityMagnitudeThresholdAsLastSentAngularSpeedRatio',
    ),
    deltaRotationVelocityDirectionThresholdAsFullTurnRatio: parseNonNegativeFiniteNumber(
      value.deltaRotationVelocityDirectionThresholdAsFullTurnRatio,
      'architecture.lockstep.presentationSnapshots.deltaRotationVelocityDirectionThresholdAsFullTurnRatio',
    ),
    fullSnapshotMinimapContactListMaxRefreshRateHz: parseNonNegativeFiniteNumber(
      value.fullSnapshotMinimapContactListMaxRefreshRateHz,
      'architecture.lockstep.presentationSnapshots.fullSnapshotMinimapContactListMaxRefreshRateHz',
    ),
    fullSnapshotEntityDetailFieldsMaxRefreshRateHz: parseNonNegativeFiniteNumber(
      value.fullSnapshotEntityDetailFieldsMaxRefreshRateHz,
      'architecture.lockstep.presentationSnapshots.fullSnapshotEntityDetailFieldsMaxRefreshRateHz',
    ),
    fullSnapshotProjectileDetailFieldsMaxRefreshRateHz: parseNonNegativeFiniteNumber(
      value.fullSnapshotProjectileDetailFieldsMaxRefreshRateHz,
      'architecture.lockstep.presentationSnapshots.fullSnapshotProjectileDetailFieldsMaxRefreshRateHz',
    ),
  };
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
    allowLateJoin: parseAllowLateJoin(value.allowLateJoin),
    presentationSnapshots: parseLockstepPresentationSnapshotConfig(value.presentationSnapshots),
  };
}

export function parseArchitectureConfig(value: unknown): ArchitectureConfig {
  if (!isRecord(value)) {
    throw new Error('architecture config must be an object');
  }
  return {
    lockstep: parseLockstepConfig(value.lockstep),
  };
}

export const ARCHITECTURE_CONFIG = parseArchitectureConfig(rawArchitectureConfig);
