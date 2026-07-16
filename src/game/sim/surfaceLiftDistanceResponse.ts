import { getSimWasm } from '../sim-wasm/init';
import {
  SURFACE_LIFT_DISTANCE_EXPONENT,
  SURFACE_LIFT_MINIMUM_DISTANCE_WORLD,
  SURFACE_LIFT_REFERENCE_DISTANCE_WORLD,
} from './unitLocomotionPresetConfig';

/** Shared air/water inverse-distance response. The canonical power-law
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
    SURFACE_LIFT_REFERENCE_DISTANCE_WORLD,
    SURFACE_LIFT_MINIMUM_DISTANCE_WORLD,
    SURFACE_LIFT_DISTANCE_EXPONENT,
  );
}
