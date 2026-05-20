import type { LocomotionBlueprint, LocomotionPhysics } from '@/types/blueprints';
import type { UnitLocomotion } from './types';

export const LOCOMOTION_TRACTION = {
  wheels: 0.45,
  treads: 0.75,
  legs: 1.0,
  // Hover units have no terrain contact patch; the "traction" here is
  // applied as a uniform horizontal-thrust scalar (1.0 = full authority).
  hover: 1.0,
  // Flying units share hover-style lift and horizontal force authority,
  // but the force system keeps applying forward thrust even with no order.
  flying: 1.0,
} as const;

export const LOCOMOTION_FORCE_SCALE = 150000;

export type LocomotionType = keyof typeof LOCOMOTION_TRACTION;

export const LOCOMOTION_MAX_SLOPE_DEG: Record<LocomotionType, number> = {
  wheels: 10,
  treads: 20,
  legs: 70,
  // Hovers fly over arbitrary terrain — set near 90° so pathfinding
  // treats every land cell as traversable.
  hover: 89,
  // Flying units use the same traversal rule as hovers.
  flying: 89,
};

function assertPositiveFinite(label: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid locomotion ${label}: expected positive finite number, got ${value}`);
  }
}

function assertSlopeDegrees(label: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 90) {
    throw new Error(`Invalid locomotion ${label}: expected finite degrees in (0, 90), got ${value}`);
  }
}

function maxSlopeDegToMinSurfaceNormalZ(maxSlopeDeg: number): number {
  return Math.cos(maxSlopeDeg * Math.PI / 180);
}

export function createLocomotionPhysics(
  type: LocomotionType,
  driveForce: number,
  maxSlopeDeg = LOCOMOTION_MAX_SLOPE_DEG[type],
): LocomotionPhysics {
  assertPositiveFinite(`${type}.driveForce`, driveForce);
  assertSlopeDegrees(`${type}.maxSlopeDeg`, maxSlopeDeg);
  return {
    driveForce,
    traction: LOCOMOTION_TRACTION[type],
    maxSlopeDeg,
  };
}

export function createUnitLocomotion(locomotion: LocomotionBlueprint): UnitLocomotion {
  const { type, physics } = locomotion;
  assertPositiveFinite(`${type}.driveForce`, physics.driveForce);
  assertPositiveFinite(`${type}.traction`, physics.traction);
  const maxSlopeDeg = physics.maxSlopeDeg ?? LOCOMOTION_MAX_SLOPE_DEG[type];
  assertSlopeDegrees(`${type}.maxSlopeDeg`, maxSlopeDeg);
  const hoverHeight = type === 'hover' || type === 'flying'
    ? locomotion.config.hoverHeight
    : undefined;
  if (type === 'hover' || type === 'flying') {
    assertPositiveFinite(`${type}.hoverHeight`, hoverHeight ?? NaN);
  }
  return {
    type,
    driveForce: physics.driveForce,
    traction: physics.traction,
    maxSlopeDeg,
    minSurfaceNormalZ: maxSlopeDegToMinSurfaceNormalZ(maxSlopeDeg),
    hoverHeight,
  };
}

export function cloneUnitLocomotion(locomotion: UnitLocomotion): UnitLocomotion {
  return {
    type: locomotion.type,
    driveForce: locomotion.driveForce,
    traction: locomotion.traction,
    maxSlopeDeg: locomotion.maxSlopeDeg,
    minSurfaceNormalZ: locomotion.minSurfaceNormalZ,
    hoverHeight: locomotion.hoverHeight,
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
