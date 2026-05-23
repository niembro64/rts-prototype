import { clamp } from './MathHelpers';

export type TerrainFollowVerticalThrustInput = {
  positionZ: number;
  velocityZ: number;
  targetZ: number;
  mass: number;
  gravity: number;
  springAccelPerWorldUnit: number;
  dampingRatio: number;
  maxThrustForce: number;
};

/**
 * Upward engine acceleration for a terrain-following body. Gravity is
 * still integrated by the caller; this returns the bounded thrust that
 * tries to cancel gravity and close the vertical terrain error.
 */
export function computeTerrainFollowVerticalThrustAccel(
  input: TerrainFollowVerticalThrustInput,
): number {
  const mass = input.mass > 1e-6 ? input.mass : 1e-6;
  const maxThrustAccel = Math.max(0, input.maxThrustForce) / mass;
  if (maxThrustAccel <= 0) return 0;

  const springAccel = Math.max(0, input.springAccelPerWorldUnit);
  const dampingRatio = Math.max(0, input.dampingRatio);
  const dampingAccelPerSpeed = springAccel > 0
    ? 2 * Math.sqrt(springAccel) * dampingRatio
    : 0;
  const heightError = input.targetZ - input.positionZ;
  const desiredThrustAccel =
    input.gravity +
    springAccel * heightError -
    dampingAccelPerSpeed * input.velocityZ;
  return clamp(desiredThrustAccel, 0, maxThrustAccel);
}
