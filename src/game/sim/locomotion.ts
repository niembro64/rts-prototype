import type { LocomotionBlueprint, LocomotionPhysics } from '@/types/blueprints';
import type { UnitJumpConfig } from '@/types/locomotionTypes';
import type { UnitLocomotion } from './types';

export const LOCOMOTION_TRACTION = {
  wheels: 0.45,
  treads: 0.75,
  legs: 1.0,
} as const;

export type LocomotionType = keyof typeof LOCOMOTION_TRACTION;

function assertPositiveFinite(label: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid locomotion ${label}: expected positive finite number, got ${value}`);
  }
}

export function createLocomotionPhysics(
  type: LocomotionType,
  driveForce: number,
  jump?: UnitJumpConfig,
): LocomotionPhysics {
  assertPositiveFinite(`${type}.driveForce`, driveForce);
  return {
    driveForce,
    traction: LOCOMOTION_TRACTION[type],
    jump,
  };
}

export function createUnitLocomotion(locomotion: LocomotionBlueprint): UnitLocomotion {
  const { type, physics } = locomotion;
  assertPositiveFinite(`${type}.driveForce`, physics.driveForce);
  assertPositiveFinite(`${type}.traction`, physics.traction);
  return {
    type,
    driveForce: physics.driveForce,
    traction: physics.traction,
  };
}

export function cloneUnitLocomotion(locomotion: UnitLocomotion): UnitLocomotion {
  return {
    type: locomotion.type,
    driveForce: locomotion.driveForce,
    traction: locomotion.traction,
  };
}

export function getLocomotionForceProfile(
  locomotion: UnitLocomotion,
  mass: number,
  thrustMultiplier: number,
  forceScale: number,
): {
  rawDriveForce: number;
  tractionDriveForce: number;
  rawForceMagnitude: number;
  tractionForceMagnitude: number;
} {
  assertPositiveFinite(`${locomotion.type}.mass`, mass);
  assertPositiveFinite('forceScale', forceScale);
  const rawDriveForce = locomotion.driveForce * thrustMultiplier;
  const tractionDriveForce = rawDriveForce * locomotion.traction;
  return {
    rawDriveForce,
    tractionDriveForce,
    rawForceMagnitude: (rawDriveForce * mass) / forceScale,
    tractionForceMagnitude: (tractionDriveForce * mass) / forceScale,
  };
}
