import rawArchitectureConfig from './architecture.json';

export const ARCHITECTURE_CONFIG_READ_MODE = 'build-time' as const;

export const ARCHITECTURE_BACKENDS = [
  'deterministic-lockstep',
] as const;

export type ArchitectureBackend = typeof ARCHITECTURE_BACKENDS[number];
export type LockstepDesyncPolicy = 'pause';

export type LockstepArchitectureConfig = {
  readonly fixedStepHz: number;
  readonly inputDelayTicks: number;
  readonly checksumIntervalTicks: number;
  readonly stallTimeoutMs: number;
  readonly desyncPolicy: LockstepDesyncPolicy;
  readonly allowLateJoin: false;
};

export type ArchitectureConfig = {
  readonly backend: ArchitectureBackend;
  readonly lockstep: LockstepArchitectureConfig;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBackend(value: unknown): ArchitectureBackend {
  if (ARCHITECTURE_BACKENDS.includes(value as ArchitectureBackend)) {
    return value as ArchitectureBackend;
  }
  throw new Error(
    `architecture.backend must be one of ${ARCHITECTURE_BACKENDS.join(', ')}; ` +
      `received ${String(value)}`,
  );
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
  };
}

export function parseArchitectureConfig(value: unknown): ArchitectureConfig {
  if (!isRecord(value)) {
    throw new Error('architecture config must be an object');
  }
  return {
    backend: parseBackend(value.backend),
    lockstep: parseLockstepConfig(value.lockstep),
  };
}

export const ARCHITECTURE_CONFIG = parseArchitectureConfig(rawArchitectureConfig);
