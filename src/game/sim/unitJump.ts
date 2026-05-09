import { UNIT_MASS_MULTIPLIER } from '../../config';
import type { Unit } from './types';

export function getUnitJumpForce(unit: Unit): number {
  const force = unit.suspension?.jump?.force ?? 0;
  return Number.isFinite(force) && force > 0 ? force : 0;
}

export function getUnitJumpAcceleration(unit: Unit): number {
  const force = getUnitJumpForce(unit);
  if (force <= 0) return 0;
  const physicsMass = unit.mass * UNIT_MASS_MULTIPLIER;
  return physicsMass > 0 ? force / physicsMass : 0;
}

export function unitJumpWantsActuator(unit: Unit): boolean {
  const suspension = unit.suspension;
  const jump = suspension?.jump;
  if (!jump) return false;
  return jump.mode === 'always' || suspension.jumpRequested;
}
