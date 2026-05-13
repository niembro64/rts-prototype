import { UNIT_MASS_MULTIPLIER } from '../../config';
import type { Unit } from './types';
import type { UnitJumpConfig, UnitJumpState } from '@/types/locomotionTypes';

const JUMP_RECHARGE_OUTWARD_VELOCITY_EPSILON = 1;
const MIN_RANDOM_POWER_MULTIPLIER = 0.05;

export type UnitJumpLaunchForce = {
  x: number;
  y: number;
  z: number;
};

export type UnitJumpIntent = {
  moving: boolean;
  combat: boolean;
};

function cloneJumpConfig(config: UnitJumpConfig): UnitJumpConfig {
  return {
    springStiffness: config.springStiffness,
    compression: config.compression,
    powerRandomMultiplier: config.powerRandomMultiplier,
    horizontalRandomMultiplier: config.horizontalRandomMultiplier,
    mode: config.mode,
    releaseChancePerTick: config.releaseChancePerTick,
  };
}

export function createUnitJump(config: UnitJumpConfig | undefined): UnitJumpState | undefined {
  if (!config) return undefined;
  return {
    config: cloneJumpConfig(config),
    enabled: true,
    requested: false,
    active: false,
    launchSeq: 0,
  };
}

export function setUnitJumpEnabled(unit: Unit, enabled: boolean): boolean {
  const jump = unit.jump;
  if (!jump) return false;
  const next = enabled === true;
  const changed = jump.enabled !== next || (!next && jump.requested);
  jump.enabled = next;
  if (!next) jump.requested = false;
  return changed;
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

export function sampleUnitJumpLaunchForce(
  unit: Unit,
  dtSec: number,
  out: UnitJumpLaunchForce,
): UnitJumpLaunchForce {
  const verticalForce = getUnitJumpLaunchForce(unit, dtSec);
  const horizontalAmount = unit.jump?.config.horizontalRandomMultiplier ?? 0;
  let horizontalForce = 0;
  if (Number.isFinite(horizontalAmount) && horizontalAmount > 0 && verticalForce > 0) {
    horizontalForce = verticalForce * horizontalAmount * Math.random();
  }

  if (horizontalForce > 0) {
    const angle = Math.random() * Math.PI * 2;
    out.x = Math.cos(angle) * horizontalForce;
    out.y = Math.sin(angle) * horizontalForce;
  } else {
    out.x = 0;
    out.y = 0;
  }
  out.z = verticalForce;
  return out;
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
  if (!jump.enabled) return false;
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
  let recharged: boolean;
  if (!jump.active) {
    recharged = true;
  } else {
    recharged = Number.isFinite(releaseVelocity) &&
      releaseVelocity <= JUMP_RECHARGE_OUTWARD_VELOCITY_EPSILON;
  }
  if (!recharged) return false;
  // Random per-tick gate for `always`-mode units that should hop with
  // irregular timing instead of relaunching every ground-contact tick
  // (tick unit). Manual jump requests bypass the gate so a scripted
  // command still fires immediately.
  if (jump.config.mode === 'always' && !jump.requested) {
    const chance = jump.config.releaseChancePerTick;
    if (chance !== undefined && chance < 1) {
      if (chance <= 0) return false;
      if (Math.random() >= chance) return false;
    }
  }
  return true;
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
