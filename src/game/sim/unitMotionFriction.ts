import type { Unit } from './types';

function clampScale(value: number, fallback = 1): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(2, value));
}

export function getUnitGroundFrictionScale(unit: Unit): number {
  return clampScale(unit.locomotion.physics.ground.traction);
}
