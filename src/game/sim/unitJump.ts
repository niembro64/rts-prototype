import { UNIT_MASS_MULTIPLIER } from '../../config';
import type { Unit } from './types';
import type { UnitJumpConfig, UnitJumpState } from '@/types/locomotionTypes';

const JUMP_RECHARGE_OUTWARD_VELOCITY_EPSILON = 1;
const MIN_RANDOM_POWER_MULTIPLIER = 0.05;

export type UnitJumpIntent = {
  moving: boolean;
  combat: boolean;
};

function cloneJumpConfig(config: UnitJumpConfig): UnitJumpConfig {
  return {
    springStiffness: config.springStiffness,
    compression: config.compression,
    powerRandomMultiplier: config.powerRandomMultiplier,
    mode: config.mode,
  };
}

export function createUnitJump(config: UnitJumpConfig | undefined): UnitJumpState | undefined {
  if (!config) return undefined;
  return {
    config: cloneJumpConfig(config),
    requested: false,
    active: false,
    launchSeq: 0,
  };
}

export function requestUnitJump(unit: Unit): boolean {
  const jump = unit.jump;
  if (!jump) return false;
  jump.requested = true;
  return true;
}

function getUnitPhysicsMass(unit: Unit): number {
  return unit.mass * UNIT_MASS_MULTIPLIER;
}

export function getUnitJumpSpringEnergy(unit: Unit): number {
  const jump = unit.jump;
  if (!jump) return 0;
  const stiffness = jump.config.springStiffness;
  const compression = jump.config.compression;
  if (
    !Number.isFinite(stiffness) ||
    !Number.isFinite(compression) ||
    stiffness <= 0 ||
    compression <= 0
  ) {
    return 0;
  }
  return 0.5 * stiffness * compression * compression;
}

export function getUnitJumpSpringImpulse(unit: Unit): number {
  const energy = getUnitJumpSpringEnergy(unit);
  const mass = getUnitPhysicsMass(unit);
  return energy > 0 && mass > 0 ? Math.sqrt(2 * mass * energy) : 0;
}

export function getUnitJumpSpringForce(unit: Unit, dtSec: number): number {
  if (dtSec <= 0) return 0;
  const impulse = getUnitJumpSpringImpulse(unit);
  return impulse > 0 ? impulse / dtSec : 0;
}

export function sampleUnitJumpPowerMultiplier(unit: Unit): number {
  const amount = unit.jump?.config.powerRandomMultiplier ?? 0;
  if (!Number.isFinite(amount) || amount <= 0) return 1;
  return Math.max(
    MIN_RANDOM_POWER_MULTIPLIER,
    1 + (Math.random() * 2 - 1) * amount,
  );
}

export function getUnitJumpLaunchForce(unit: Unit, dtSec: number): number {
  return getUnitJumpSpringForce(unit, dtSec) * sampleUnitJumpPowerMultiplier(unit);
}

export function getUnitJumpSpringAcceleration(unit: Unit, dtSec: number): number {
  const mass = getUnitPhysicsMass(unit);
  return mass > 0 ? getUnitJumpSpringForce(unit, dtSec) / mass : 0;
}

function unitJumpHasAutomaticIntent(intent: UnitJumpIntent | undefined): boolean {
  return intent?.moving === true || intent?.combat === true;
}

export function unitJumpWantsActuator(
  unit: Unit,
  intent?: UnitJumpIntent,
): boolean {
  const jump = unit.jump;
  if (!jump) return false;
  if (jump.requested) return true;
  return jump.config.mode === 'always' && unitJumpHasAutomaticIntent(intent);
}

export function unitJumpCanRelease(
  unit: Unit,
  surfaceContact: boolean,
  releaseVelocity: number,
  intent?: UnitJumpIntent,
): boolean {
  const jump = unit.jump;
  if (!jump || !surfaceContact || !unitJumpWantsActuator(unit, intent)) return false;
  if (!jump.active) return true;
  return (
    Number.isFinite(releaseVelocity) &&
    releaseVelocity <= JUMP_RECHARGE_OUTWARD_VELOCITY_EPSILON
  );
}

export function unitJumpHasActuatorWork(
  unit: Unit,
  intent?: UnitJumpIntent,
): boolean {
  const jump = unit.jump;
  if (!jump || getUnitJumpSpringEnergy(unit) <= 0) return false;
  if (unitJumpWantsActuator(unit, intent)) return true;
  return jump.active;
}
