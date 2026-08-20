import rawConfig from './buildConfig.json';

function validSlopeAngleDegrees(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value >= 90) {
    throw new Error(
      `buildConfig.maxBuildableSlopeAngleDegrees must be finite and in [0, 90); received ${value}`,
    );
  }
  return value;
}

const maxBuildableSlopeAngleDegrees = validSlopeAngleDegrees(
  rawConfig.maxBuildableSlopeAngleDegrees,
);

function nonNegativeSeconds(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`buildConfig.${label} must be finite and >= 0; received ${value}`);
  }
  return value;
}

function decayFractionPerSecond(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(
      `buildConfig.unfinishedBuildDecay.fractionPerSecond must be finite and in (0, 1]; received ${value}`,
    );
  }
  return value;
}

export const BUILD_CONFIG = {
  maxBuildableSlopeAngleDegrees,
  minBuildableSurfaceNormalUp: Math.cos(
    maxBuildableSlopeAngleDegrees * Math.PI / 180,
  ),
  /** Unfinished shells rot when nobody is paying for them: after the delay
   *  they lose a constant fraction of their OWN full cost per second, and the
   *  frame is removed outright at zero progress. */
  unfinishedBuildDecay: {
    unfundedDelaySeconds: nonNegativeSeconds(
      rawConfig.unfinishedBuildDecay.unfundedDelaySeconds,
      'unfinishedBuildDecay.unfundedDelaySeconds',
    ),
    fractionPerSecond: decayFractionPerSecond(
      rawConfig.unfinishedBuildDecay.fractionPerSecond,
    ),
  },
} as const;
