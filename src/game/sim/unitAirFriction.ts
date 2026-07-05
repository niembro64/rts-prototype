import { UNIT_MASS_MULTIPLIER } from '../../config';
import type { Unit } from './types';
import { dragCoefficientFromDragRate } from './motionFriction';

let cachedAirFrictionRate = Number.NaN;
let cachedMass = Number.NaN;
let cachedDragCoefficient = 0;

export function getUnitAirFrictionRate(unit: Unit): number {
  const friction = unit.locomotion.physics.air.friction;
  return Number.isFinite(friction) && friction > 0 ? friction : 0;
}

export function getUnitAirDragCoefficient(unit: Unit): number {
  const friction = getUnitAirFrictionRate(unit);
  const mass = unit.mass * UNIT_MASS_MULTIPLIER;
  if (friction === cachedAirFrictionRate && mass === cachedMass) {
    return cachedDragCoefficient;
  }
  cachedAirFrictionRate = friction;
  cachedMass = mass;
  cachedDragCoefficient = dragCoefficientFromDragRate(friction, mass);
  return cachedDragCoefficient;
}
