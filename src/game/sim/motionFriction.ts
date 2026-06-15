import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
import { AIR_DRAG_REFERENCE_MASS } from '../../config';

export const NO_FRICTION_DAMP = 1;

export function dampFromFrictionPer60HzFrame(
  frictionPer60HzFrame: number,
  dtSec: number,
): number {
  if (dtSec <= 0) return NO_FRICTION_DAMP;
  if (!Number.isFinite(frictionPer60HzFrame) || frictionPer60HzFrame <= 0) {
    return NO_FRICTION_DAMP;
  }
  if (frictionPer60HzFrame >= 1) return 0;
  return DMath.pow(1 - frictionPer60HzFrame, dtSec * 60);
}

export function scaleDampLoss(damp: number, scale: number): number {
  if (!Number.isFinite(damp)) return NO_FRICTION_DAMP;
  if (damp <= 0) return 0;
  if (damp >= 1) return NO_FRICTION_DAMP;
  if (!Number.isFinite(scale)) return damp;
  const clampedScale = Math.max(0, scale);
  if (clampedScale <= 0) return NO_FRICTION_DAMP;
  return DMath.pow(damp, clampedScale);
}

export function scaleFrictionPer60HzFrame(
  frictionPer60HzFrame: number,
  scale: number,
): number {
  if (!Number.isFinite(frictionPer60HzFrame) || frictionPer60HzFrame <= 0) return 0;
  if (frictionPer60HzFrame >= 1) return 1;
  if (!Number.isFinite(scale) || scale <= 0) return 0;
  return 1 - DMath.pow(1 - frictionPer60HzFrame, scale);
}

export function dragCoefficientFromFrictionPer60HzFrame(
  frictionPer60HzFrame: number,
  scale = 1,
): number {
  if (
    !Number.isFinite(frictionPer60HzFrame) ||
    frictionPer60HzFrame <= 0 ||
    !Number.isFinite(scale) ||
    scale <= 0
  ) {
    return 0;
  }
  if (frictionPer60HzFrame >= 1) return Number.POSITIVE_INFINITY;
  const dragRateAtReferenceMass = -Math.log(1 - frictionPer60HzFrame) * 60 * scale;
  return dragRateAtReferenceMass * AIR_DRAG_REFERENCE_MASS;
}

export function dragRateFromCoefficient(
  dragCoefficient: number,
  mass: number,
): number {
  if (
    !Number.isFinite(dragCoefficient) ||
    dragCoefficient <= 0 ||
    !Number.isFinite(mass) ||
    mass <= 1e-6
  ) {
    return 0;
  }
  return dragCoefficient / mass;
}

export function dragRateFromFrictionPer60HzFrame(
  frictionPer60HzFrame: number,
  mass: number,
  scale = 1,
): number {
  return dragRateFromCoefficient(
    dragCoefficientFromFrictionPer60HzFrame(frictionPer60HzFrame, scale),
    mass,
  );
}
