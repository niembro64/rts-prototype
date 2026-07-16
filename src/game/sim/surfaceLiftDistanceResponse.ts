import { getSimWasm } from '../sim-wasm/init';
import {
  SURFACE_LIFT_DISTANCE_MEASUREMENT,
  SURFACE_LIFT_DISTANCE_EXPONENT,
  SURFACE_LIFT_MINIMUM_DISTANCE_WORLD,
  SURFACE_LIFT_NEAR_SURFACE_AVOIDANCE,
  SURFACE_LIFT_REFERENCE_DISTANCE_WORLD,
} from './unitLocomotionPresetConfig';
import { deterministicMath as DMath } from './deterministicMath';

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

/** Converts a body-center pose into the distance owned by every surface probe.
 * Body-clearance mode measures from the authored underside/ground offset so a
 * visually touching hull is also a numerically close probe. */
export function getSurfaceLiftProbeDistance(
  bodyZ: number,
  bodyCenterHeight: number,
  surfaceZ: number,
): number {
  const originZ = SURFACE_LIFT_DISTANCE_MEASUREMENT === 'body-clearance'
    ? bodyZ - Math.max(0, bodyCenterHeight)
    : bodyZ;
  return originZ - surfaceZ;
}

/** Per-probe proposed-force multiplier. The ordinary inverse-distance response
 * maintains flight altitude; the capped power barrier gives a dangerously
 * close local probe enough authority to survive multi-probe averaging. */
export function getSurfaceLiftProbeForceMultiplier(
  distanceToSurfaceWorld: number,
  bodyRadius: number,
): number {
  const baseResponse = getSurfaceLiftDistanceResponse(distanceToSurfaceWorld);
  const distance = Number.isFinite(distanceToSurfaceWorld)
    ? Math.max(distanceToSurfaceWorld, SURFACE_LIFT_MINIMUM_DISTANCE_WORLD)
    : SURFACE_LIFT_MINIMUM_DISTANCE_WORLD;
  const radius = Number.isFinite(bodyRadius) ? Math.max(0, bodyRadius) : 0;
  const avoidance = SURFACE_LIFT_NEAR_SURFACE_AVOIDANCE;
  const avoidanceClearance =
    avoidance.clearanceWorld + radius * avoidance.bodyRadiusMultiplier;
  if (
    avoidance.gain <= 0 ||
    avoidance.maximumAdditionalResponse <= 0 ||
    avoidanceClearance <= distance
  ) {
    return baseResponse;
  }
  const normalizedDanger = avoidanceClearance / distance - 1;
  const additionalResponse = Math.min(
    avoidance.maximumAdditionalResponse,
    avoidance.gain * DMath.pow(normalizedDanger, avoidance.distanceExponent),
  );
  return baseResponse + additionalResponse;
}
