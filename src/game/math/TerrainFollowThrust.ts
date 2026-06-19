import { getSimWasm } from '../sim-wasm/init';

type TerrainFollowVerticalThrustInput = {
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
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('Terrain-follow thrust requires initialized sim-wasm');
  }
  return sim.terrainFollowVerticalThrustAccel(
    input.positionZ,
    input.velocityZ,
    input.targetZ,
    input.mass,
    input.gravity,
    input.springAccelPerWorldUnit,
    input.dampingRatio,
    input.maxThrustForce,
  );
}
