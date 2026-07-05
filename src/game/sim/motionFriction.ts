import { deterministicMath as DMath } from '@/game/sim/deterministicMath';

const NO_FRICTION_DAMP = 1;

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

function hasVelocityAirFriction(frictionPer60HzFrame: number): boolean {
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


export function dragCoefficientFromVelocityFrictionPer60HzFrame(
  frictionPer60HzFrame: number,
  mass: number,
  scale = 1,
): number {
  if (!Number.isFinite(mass) || mass <= 1e-6) return 0;
  const dragRate = dragRateFromVelocityFrictionPer60HzFrame(frictionPer60HzFrame, scale);
  return Number.isFinite(dragRate) && dragRate > 0 ? dragRate * mass : 0;
}

export function dragCoefficientFromDragRate(
  dragRate: number,
  mass: number,
): number {
  if (!Number.isFinite(mass) || mass <= 1e-6) return 0;
  return Number.isFinite(dragRate) && dragRate > 0 ? dragRate * mass : 0;
}
