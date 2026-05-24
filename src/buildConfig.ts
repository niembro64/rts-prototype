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

export const BUILD_CONFIG = {
  maxBuildableSlopeAngleDegrees,
  minBuildableSurfaceNormalUp: Math.cos(
    maxBuildableSlopeAngleDegrees * Math.PI / 180,
  ),
} as const;
