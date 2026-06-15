import type { Unit } from './types';

function clampScale(value: number, fallback = 1): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(2, value));
}

export function getUnitAirFrictionScale(unit: Unit): number {
  switch (unit.locomotion.type) {
    case 'flying':
      return 0.35;
    case 'hover':
      return 0.7;
    case 'legs':
    case 'treads':
    case 'wheels':
      return 1;
  }
}

export function getUnitGroundFrictionScale(unit: Unit): number {
  const traction = clampScale(unit.locomotion.traction);
  switch (unit.locomotion.type) {
    case 'flying':
      return traction * 0.25;
    case 'hover':
      return traction * 0.5;
    case 'legs':
    case 'treads':
    case 'wheels':
      return traction;
  }
}
