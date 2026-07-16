import { clamp01 } from '../math';

/** The grounded gait advances only after a planted foot leaves its moving
 *  authored rest sphere. The boundary itself remains planted. */
export function legRestSphereNeedsStep(
  footToRestDistanceSq: number,
  stepRadius: number,
): boolean {
  const radius = Math.max(0, stepRadius);
  return footToRestDistanceSq > radius * radius;
}

/** Whether a surface point lies inside a leg's usable reach sphere. */
export function legSurfaceWithinReach(
  hipToSurfaceDistanceSq: number,
  totalLength: number,
  reachFraction: number,
): boolean {
  const reach = Math.max(0, totalLength) * clamp01(reachFraction);
  return hipToSurfaceDistanceSq <= reach * reach;
}
