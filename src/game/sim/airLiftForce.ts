import { deterministicMath as DMath } from './deterministicMath';
import { AIR_LIFT_HEIGHT_FORCE_EXPONENT } from './locomotionPresetConfig';

export { AIR_LIFT_HEIGHT_FORCE_EXPONENT } from './locomotionPresetConfig';

export function getAirLiftHeightDistanceScale(
  clampedDistanceToSurface: number,
  heightUpwardForce: number,
): number {
  if (
    !Number.isFinite(clampedDistanceToSurface) ||
    clampedDistanceToSurface <= 0 ||
    !Number.isFinite(heightUpwardForce) ||
    heightUpwardForce <= 0
  ) {
    return 0;
  }
  const exactDistanceScale = 1 / clampedDistanceToSurface;
  const exactHeightForce = heightUpwardForce * exactDistanceScale;
  if (!Number.isFinite(exactHeightForce) || exactHeightForce <= 0) return 0;

  const rootedHeightForce = DMath.pow(exactHeightForce, AIR_LIFT_HEIGHT_FORCE_EXPONENT);
  return Math.min(exactDistanceScale, rootedHeightForce / heightUpwardForce);
}
