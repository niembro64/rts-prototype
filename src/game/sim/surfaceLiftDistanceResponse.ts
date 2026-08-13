import { getSimWasm } from '../sim-wasm/init';
import { SURFACE_FOLLOWING_MINIMUM_DISTANCE_WORLD } from './surfaceProbeSets';

/** Air-authored surface lift ceases once the body's origin crosses the water
 * plane. A partially immersed hull may still recover while its center remains
 * in air; once submerged, only explicitly authored water lift can support it.
 * This uses the same body-origin boundary as environmental water damage. */
export function airSurfaceLiftMediumIsActive(
  bodyZ: number,
  waterFraction: number,
  waterLevel: number,
): boolean {
  return bodyZ > waterLevel && waterFraction < 1;
}

/** Exact signed-altitude clamp used before the inverse-distance response. */
export function getSurfaceLiftInverseDistanceToSurfaceWorld(bodyZ: number, surfaceZ: number): number {
  if (!Number.isFinite(bodyZ) || !Number.isFinite(surfaceZ)) {
    return SURFACE_FOLLOWING_MINIMUM_DISTANCE_WORLD;
  }
  const altitude = bodyZ - surfaceZ;
  return Number.isFinite(altitude)
    ? Math.max(SURFACE_FOLLOWING_MINIMUM_DISTANCE_WORLD, altitude)
    : SURFACE_FOLLOWING_MINIMUM_DISTANCE_WORLD;
}

/** Shared air/water inverse-distance response. The canonical reciprocal
 * implementation lives in Rust so probes and the native force kernel use
 * exactly the same deterministic equation. */
export function getSurfaceLiftInverseDistanceResponse(distanceToSurfaceWorld: number): number {
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error(
      'surface lift requires rts-sim-wasm; await initSimWasm() before stepping gameplay truth',
    );
  }
  return sim.unitForceSurfaceLiftInverseDistanceResponse(
    distanceToSurfaceWorld,
    SURFACE_FOLLOWING_MINIMUM_DISTANCE_WORLD,
  );
}

/** Exact non-negative depth used by the proportional underwater support
 * response. Unlike inverse-distance lift, depth is zero at the water plane
 * and deliberately has no positive minimum. */
export function getSurfaceLiftWaterDepthWorld(bodyZ: number): number {
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error(
      'surface lift requires rts-sim-wasm; await initSimWasm() before stepping gameplay truth',
    );
  }
  return sim.unitForceWaterSurfaceDepthWorld(bodyZ);
}
