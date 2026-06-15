import { UNIT_MASS_MULTIPLIER } from '../../config';
import type { Unit } from './types';
import { dragCoefficientFromVelocityFrictionPer60HzFrame } from './motionFriction';

let cachedAirFrictionPer60HzFrame = Number.NaN;
let cachedMass = Number.NaN;
let cachedDragCoefficient = 0;

export function getUnitAirFrictionPer60HzFrame(unit: Unit): number {
  const friction = unit.airFrictionPer60HzFrame;
  return Number.isFinite(friction) && friction > 0 ? friction : 0;
}

export function getUnitAirDragCoefficient(unit: Unit): number {
  const friction = getUnitAirFrictionPer60HzFrame(unit);
  const mass = unit.mass * UNIT_MASS_MULTIPLIER;
  if (friction === cachedAirFrictionPer60HzFrame && mass === cachedMass) {
    return cachedDragCoefficient;
  }
  cachedAirFrictionPer60HzFrame = friction;
  cachedMass = mass;
  cachedDragCoefficient = dragCoefficientFromVelocityFrictionPer60HzFrame(friction, mass);
  return cachedDragCoefficient;
}
