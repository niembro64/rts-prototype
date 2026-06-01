import type {
  LocomotionBlueprint,
  LocomotionPhysics,
  PathfindingBlueprint,
} from '@/types/blueprints';
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

function assertPositiveFinite(label: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid locomotion ${label}: expected positive finite number, got ${value}`);
  }
}

function assertCounterGravityRatio(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error(`Invalid locomotion ${label}: expected finite ratio in [0, 1), got ${value}`);
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
): LocomotionPhysics {
  assertPositiveFinite(`${type}.driveForce`, driveForce);
  return {
    driveForce,
    traction: LOCOMOTION_TRACTION[type],
  };
}

function createRuntimePathfindingConfig(
  label: string,
  pathfinding: PathfindingBlueprint,
): UnitLocomotion['pathfinding'] {
  if (pathfinding.terrainMode === 'anywhere') {
    if (pathfinding.maxSlopeDeg !== null) {
      throw new Error(`Invalid ${label}: anywhere pathfinding must use maxSlopeDeg=null`);
    }
    return {
      pathfindingBlueprintId: pathfinding.pathfindingBlueprintId,
      terrainMode: pathfinding.terrainMode,
      ignoreTerrainBlocking: true,
      maxSlopeDeg: null,
      minSurfaceNormalZ: 0,
    };
  }
  const maxSlopeDeg = pathfinding.maxSlopeDeg;
  if (maxSlopeDeg === null) {
    throw new Error(`Invalid ${label}: land pathfinding requires maxSlopeDeg`);
  }
  assertSlopeDegrees(`${label}.maxSlopeDeg`, maxSlopeDeg);
  return {
    pathfindingBlueprintId: pathfinding.pathfindingBlueprintId,
    terrainMode: pathfinding.terrainMode,
    ignoreTerrainBlocking: false,
    maxSlopeDeg,
    minSurfaceNormalZ: maxSlopeDegToMinSurfaceNormalZ(maxSlopeDeg),
  };
}

export function createUnitLocomotion(
  locomotion: LocomotionBlueprint,
): UnitLocomotion {
  const { type, physics } = locomotion;
  assertPositiveFinite(`${type}.driveForce`, physics.driveForce);
  assertPositiveFinite(`${type}.traction`, physics.traction);
  const pathfinding = createRuntimePathfindingConfig(
    `${type}.pathfinding(${locomotion.pathfindingBlueprintId})`,
    locomotion.pathfinding,
  );
  const isAirborne = type === 'hover' || type === 'flying';
  const gravityCounterUpwardForceRatio = isAirborne
    ? locomotion.config.gravityCounterUpwardForceRatio
    : undefined;
  const hoverHeightUpwardForce = isAirborne
    ? locomotion.config.hoverHeightUpwardForce
    : undefined;
  let hoverHeightUpwardForceRandomizationAmount: number | undefined;
  let hoverHeightUpwardForceEMA: number | undefined;
  if (isAirborne) {
    assertCounterGravityRatio(
      `${type}.gravityCounterUpwardForceRatio`,
      gravityCounterUpwardForceRatio ?? NaN,
    );
    assertPositiveFinite(`${type}.hoverHeightUpwardForce`, hoverHeightUpwardForce ?? NaN);
    const raw = locomotion.config.hoverHeightUpwardForceRandomizationAmount;
    if (raw !== undefined) {
      if (!Number.isFinite(raw) || raw < 0 || raw >= 1) {
        throw new Error(
          `Invalid locomotion ${type}.hoverHeightUpwardForceRandomizationAmount: expected finite [0,1), got ${raw}`,
        );
      }
      hoverHeightUpwardForceRandomizationAmount = raw > 0 ? raw : undefined;
    }
    const rawEMA = locomotion.config.hoverHeightUpwardForceEMA;
    if (rawEMA !== undefined) {
      if (!Number.isFinite(rawEMA) || rawEMA < 0 || rawEMA >= 1) {
        throw new Error(
          `Invalid locomotion ${type}.hoverHeightUpwardForceEMA: expected finite [0,1), got ${rawEMA}`,
        );
      }
      hoverHeightUpwardForceEMA = rawEMA > 0 ? rawEMA : undefined;
    }
  }
  return {
    type,
    driveForce: physics.driveForce,
    traction: physics.traction,
    pathfinding,
    gravityCounterUpwardForceRatio,
    hoverHeightUpwardForce,
    hoverHeightUpwardForceRandomizationAmount,
    hoverHeightUpwardForceEMA,
  };
}

export function cloneUnitLocomotion(
  locomotion: UnitLocomotion,
): UnitLocomotion {
  return {
    type: locomotion.type,
    driveForce: locomotion.driveForce,
    traction: locomotion.traction,
    pathfinding: { ...locomotion.pathfinding },
    gravityCounterUpwardForceRatio: locomotion.gravityCounterUpwardForceRatio,
    hoverHeightUpwardForce: locomotion.hoverHeightUpwardForce,
    hoverHeightUpwardForceRandomizationAmount:
      locomotion.hoverHeightUpwardForceRandomizationAmount,
    hoverHeightUpwardForceEMA: locomotion.hoverHeightUpwardForceEMA,
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
