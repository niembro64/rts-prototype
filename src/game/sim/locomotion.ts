import type {
  LocomotionBlueprint,
  PathfindingBlueprint,
} from '@/types/blueprints';
import type { UnitLocomotion } from './types';
import rawLocomotionConfig from './locomotionConfig.json';

// Canonical set of locomotion discriminants. The live per-type physics
// tuning (drive-force multiplier) and the global force scale are authored
// in locomotionConfig.json (Config Is Data, Not Code); per-unit traction
// is authored on each blueprint's physics.traction.
const LOCOMOTION_TYPES = ['wheels', 'treads', 'legs', 'hover', 'flying'] as const;

type LocomotionType = (typeof LOCOMOTION_TYPES)[number];

type LocomotionTypeConfig = {
  physics: {
    driveForceMultiplier: number;
  };
};

type LocomotionConfig = {
  forceScale: number;
  types: Record<LocomotionType, LocomotionTypeConfig>;
};

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
  const config = rawLocomotionConfig as unknown as {
    forceScale?: number;
    types?: Partial<Record<LocomotionType, LocomotionTypeConfig>>;
  };
  assertPositiveFinite('forceScale', config.forceScale ?? NaN);
  const types = config.types;
  if (!types || typeof types !== 'object') {
    throw new Error('Invalid locomotionConfig.json: missing types table');
  }
  for (const type of LOCOMOTION_TYPES) {
    const typeConfig = types[type];
    if (!typeConfig || typeof typeConfig !== 'object') {
      throw new Error(`Invalid locomotionConfig.json: missing types.${type} config`);
    }
    if (!typeConfig.physics || typeof typeConfig.physics !== 'object') {
      throw new Error(`Invalid locomotionConfig.json: missing types.${type}.physics config`);
    }
    assertPositiveFinite(
      `types.${type}.physics.driveForceMultiplier`,
      typeConfig.physics.driveForceMultiplier,
    );
  }
  for (const type of Object.keys(types)) {
    if (!(LOCOMOTION_TYPES as readonly string[]).includes(type)) {
      throw new Error(`Invalid locomotionConfig.json: unknown locomotion type "${type}"`);
    }
  }
  return config as LocomotionConfig;
}

const LOCOMOTION_CONFIG = readLocomotionConfig();

/** Global force scale shared by every locomotion profile, authored in
 *  locomotionConfig.json. Drives the mass-to-acceleration conversion in
 *  the arrival controller, pathfinding mobility, and UnitForceSystem. */
export const LOCOMOTION_FORCE_SCALE: number = LOCOMOTION_CONFIG.forceScale;

function getLocomotionDriveForceMultiplier(type: LocomotionType): number {
  return LOCOMOTION_CONFIG.types[type].physics.driveForceMultiplier;
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
