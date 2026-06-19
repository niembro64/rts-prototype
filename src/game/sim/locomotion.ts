import type {
  LocomotionBlueprint,
  PathfindingBlueprint,
} from '@/types/blueprints';
import type { UnitLocomotion } from './types';
import rawLocomotionConfig from './locomotionConfig.json';

const LOCOMOTION_TRACTION = {
  wheels: 0.45,
  treads: 0.75,
  legs: 1.0,
  // Hover units have no terrain contact patch; the "traction" here is
  // applied as a uniform horizontal-thrust scalar (1.0 = full authority).
  hover: 1.0,
  // Flying units use this as thrust and yaw authority: low values drift
  // through wide turns, high values feel closer to direct hover control.
  flying: 1.0,
} as const;

export const LOCOMOTION_FORCE_SCALE = 150000;

type LocomotionType = keyof typeof LOCOMOTION_TRACTION;

type LocomotionTypeConfig = {
  physics: {
    driveForceMultiplier: number;
  };
};

type LocomotionConfig = Record<LocomotionType, LocomotionTypeConfig>;

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

function readLocomotionConfig(): LocomotionConfig {
  const config = rawLocomotionConfig as unknown as Partial<Record<LocomotionType, LocomotionTypeConfig>>;
  for (const type of Object.keys(LOCOMOTION_TRACTION) as LocomotionType[]) {
    const typeConfig = config[type];
    if (!typeConfig || typeof typeConfig !== 'object') {
      throw new Error(`Invalid locomotionConfig.json: missing ${type} config`);
    }
    if (!typeConfig.physics || typeof typeConfig.physics !== 'object') {
      throw new Error(`Invalid locomotionConfig.json: missing ${type}.physics config`);
    }
    assertPositiveFinite(
      `${type}.physics.driveForceMultiplier`,
      typeConfig.physics.driveForceMultiplier,
    );
  }
  for (const type of Object.keys(config)) {
    if (!(type in LOCOMOTION_TRACTION)) {
      throw new Error(`Invalid locomotionConfig.json: unknown locomotion type "${type}"`);
    }
  }
  return config as LocomotionConfig;
}

const LOCOMOTION_CONFIG = readLocomotionConfig();

function getLocomotionDriveForceMultiplier(type: LocomotionType): number {
  return LOCOMOTION_CONFIG[type].physics.driveForceMultiplier;
}

function getEffectiveLocomotionDriveForce(
  type: LocomotionType,
  authoredDriveForce: number,
): number {
  assertPositiveFinite(`${type}.physics.driveForce`, authoredDriveForce);
  return authoredDriveForce * getLocomotionDriveForceMultiplier(type);
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
    driveForce: getEffectiveLocomotionDriveForce(type, physics.driveForce),
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

type LocomotionForceProfile = {
  rawDriveForce: number;
  tractionDriveForce: number;
  rawForceMagnitude: number;
  tractionForceMagnitude: number;
};

function writeLocomotionForceProfile(
  out: LocomotionForceProfile,
  locomotion: UnitLocomotion,
  referenceMass: number,
  thrustMultiplier: number,
  forceScale: number,
): LocomotionForceProfile {
  assertPositiveFinite(`${locomotion.type}.referenceMass`, referenceMass);
  assertPositiveFinite('forceScale', forceScale);
  const rawDriveForce = locomotion.driveForce * thrustMultiplier;
  const tractionDriveForce = rawDriveForce * locomotion.traction;
  out.rawDriveForce = rawDriveForce;
  out.tractionDriveForce = tractionDriveForce;
  out.rawForceMagnitude = (rawDriveForce * referenceMass) / forceScale;
  out.tractionForceMagnitude = (tractionDriveForce * referenceMass) / forceScale;
  return out;
}

export function getLocomotionForceProfile(
  locomotion: UnitLocomotion,
  referenceMass: number,
  thrustMultiplier: number,
  forceScale: number,
): LocomotionForceProfile {
  return writeLocomotionForceProfile(
    {
      rawDriveForce: 0,
      tractionDriveForce: 0,
      rawForceMagnitude: 0,
      tractionForceMagnitude: 0,
    },
    locomotion,
    referenceMass,
    thrustMultiplier,
    forceScale,
  );
}
