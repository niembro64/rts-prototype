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

export function hasVelocityAirFriction(frictionPer60HzFrame: number): boolean {
  return Number.isFinite(frictionPer60HzFrame) &&
    frictionPer60HzFrame > 0 &&
    frictionPer60HzFrame < 1;
}

export function windVelocityForAirFriction<T extends { x: number; y: number; z: number }>(
  windVelocity: T | undefined,
  frictionPer60HzFrame: number,
): T | undefined {
  return hasVelocityAirFriction(frictionPer60HzFrame) ? windVelocity : undefined;
}

/** Convert a global friction knob into a physical coefficient at the
 * shared reference mass. Unit body integration divides the coefficient by
 * each body's mass, so lighter units respond more strongly to the same
 * global air. */
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

/** Convert an entity-authored velocity friction value into its continuous
 * damping rate. Projectiles use this path so their existing per-shot
 * damping remains intact while wind still enters as physical drag. */
export function dragRateFromVelocityFrictionPer60HzFrame(
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
  return -Math.log(1 - frictionPer60HzFrame) * 60 * scale;
}

export function frictionPer60HzFrameFromDragRate(dragRate: number): number {
  if (!Number.isFinite(dragRate) || dragRate <= 0) return 0;
  return 1 - Math.exp(-dragRate / 60);
}

export function dragCoefficientFromVelocityFrictionPer60HzFrame(
  frictionPer60HzFrame: number,
  mass: number,
  scale = 1,
): number {
  if (!Number.isFinite(mass) || mass <= 1e-6) return 0;
  const dragRate = dragRateFromVelocityFrictionPer60HzFrame(frictionPer60HzFrame, scale);
  return Number.isFinite(dragRate) && dragRate > 0 ? dragRate * mass : 0;
}
