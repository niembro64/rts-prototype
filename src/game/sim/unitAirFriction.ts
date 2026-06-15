import { UNIT_AIR_FRICTION_PER_60HZ_FRAME } from '../../config';
import { dragCoefficientFromFrictionPer60HzFrame } from './motionFriction';

let cachedScale = Number.NaN;
let cachedDragCoefficient = 0;

export function getUnitAirDragCoefficient(scale = 1): number {
  if (scale === cachedScale) return cachedDragCoefficient;
  cachedScale = scale;
  cachedDragCoefficient = dragCoefficientFromFrictionPer60HzFrame(
    UNIT_AIR_FRICTION_PER_60HZ_FRAME,
    scale,
  );
  return cachedDragCoefficient;
}
