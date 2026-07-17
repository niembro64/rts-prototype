import { getSimWasm } from '../sim-wasm/init';
import { SURFACE_LIFT_MINIMUM_DISTANCE_WORLD } from './unitLocomotionPresetConfig';

/** Exact signed-altitude clamp used before the inverse-distance response. */
export function getSurfaceLiftDistanceToSurfaceWorld(bodyZ: number, surfaceZ: number): number {
  if (!Number.isFinite(bodyZ) || !Number.isFinite(surfaceZ)) {
    return SURFACE_LIFT_MINIMUM_DISTANCE_WORLD;
  }
  const altitude = bodyZ - surfaceZ;
  return Number.isFinite(altitude)
    ? Math.max(SURFACE_LIFT_MINIMUM_DISTANCE_WORLD, altitude)
    : SURFACE_LIFT_MINIMUM_DISTANCE_WORLD;
}

/** Shared air/water inverse-distance response. The canonical reciprocal
 * implementation lives in Rust so probes and the native force kernel use
 * exactly the same deterministic equation. */
export function getSurfaceLiftDistanceResponse(distanceToSurfaceWorld: number): number {
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error(
      'surface lift requires rts-sim-wasm; await initSimWasm() before stepping gameplay truth',
    );
  }
  return sim.unitForceSurfaceLiftDistanceResponse(
    distanceToSurfaceWorld,
    SURFACE_LIFT_MINIMUM_DISTANCE_WORLD,
  );
}
