export const PRODUCTION_HOLD_RING_TUBE_RADIUS_FRACTION = 0.18;

export function productionHoldRingRadiusForUnitRadius(
  radius: { other: number; collision: number },
): number {
  return Math.max(16, radius.other * 2.1, radius.collision * 1.75);
}

export function productionHoldRingOuterRadius(ringRadius: number): number {
  return ringRadius * (1 + PRODUCTION_HOLD_RING_TUBE_RADIUS_FRACTION);
}
