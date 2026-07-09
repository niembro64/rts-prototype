import type {
  LocomotionBlueprint,
  PathfindingBlueprint,
} from '@/types/blueprints';
import type {
  UnitLocomotion,
  UnitLocomotionMediumPhysics,
  UnitLocomotionPhysics,
} from '@/types/locomotionTypes';
import rawLocomotionConfig from './locomotionConfig.json';

// Canonical set of locomotion discriminants. Per-type tuning lives in
// locomotionConfig.json; unit blueprints keep only the medium scalars that
// are still authored per unit.
const LOCOMOTION_TYPES = ['wheels', 'treads', 'legs', 'hover', 'flying'] as const;
const LOCOMOTION_MEDIUM_NAMES = ['ground', 'air', 'water'] as const;
const LOCOMOTION_CONFIG_MEDIUM_FIELDS = [
  'traction',
  'friction',
  'heightUpwardForceRandomizationAmount',
  'heightUpwardForceEMA',
] as const;

type LocomotionType = (typeof LOCOMOTION_TYPES)[number];
type LocomotionMediumName = (typeof LOCOMOTION_MEDIUM_NAMES)[number];
type AuthoredLocomotionMediumPhysics = LocomotionBlueprint['physics'][LocomotionMediumName];
type LocomotionConfigMediumField = (typeof LOCOMOTION_CONFIG_MEDIUM_FIELDS)[number];
type LocomotionTypeMediumPhysics = Pick<UnitLocomotionMediumPhysics, LocomotionConfigMediumField>;

type LocomotionTypeConfig = {
  physics: {
    driveForceMultiplier: number;
    forwardForceRequiresFacing: boolean;
    driveForceScalesWithFacing: boolean;
    maintainFullThrustAtWaypoints: boolean;
    airLiftGroundProbeAheadDistance: number;
    airLiftGroundProbeAheadRadiusMultiplier: number;
  } & Record<LocomotionMediumName, LocomotionTypeMediumPhysics>;
};

type AirLiftHeightForceFalloffConfig = {
  heightForceExponent: number;
};

type LocomotionConfig = {
  forceScale: number;
  airLiftHeightForceFalloff: AirLiftHeightForceFalloffConfig;
  types: Record<LocomotionType, LocomotionTypeConfig>;
};

function assertPositiveFinite(label: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid locomotion ${label}: expected positive finite number, got ${value}`);
  }
}

function assertNonNegativeFinite(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid locomotion ${label}: expected finite >= 0, got ${value}`);
  }
}

function assertHeightForceExponent(label: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`Invalid locomotion ${label}: expected finite in (0, 1], got ${value}`);
  }
}

function assertUnitFraction(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error(`Invalid locomotion ${label}: expected finite [0, 1), got ${value}`);
  }
}

function assertBoolean(label: string, value: unknown): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid locomotion ${label}: expected boolean, got ${value}`);
  }
}

function assertSlopeDegrees(label: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 90) {
    throw new Error(`Invalid locomotion ${label}: expected finite degrees in (0, 90), got ${value}`);
  }
}

function assertLocomotionTypeMediumPhysics(
  type: LocomotionType,
  medium: LocomotionMediumName,
  physics: LocomotionTypeMediumPhysics | undefined,
): asserts physics is LocomotionTypeMediumPhysics {
  if (!physics || typeof physics !== 'object') {
    throw new Error(`Invalid locomotionConfig.json: missing types.${type}.physics.${medium} config`);
  }
  assertNonNegativeFinite(`types.${type}.physics.${medium}.traction`, physics.traction);
  assertNonNegativeFinite(`types.${type}.physics.${medium}.friction`, physics.friction);
  assertUnitFraction(
    `types.${type}.physics.${medium}.heightUpwardForceRandomizationAmount`,
    physics.heightUpwardForceRandomizationAmount,
  );
  assertUnitFraction(
    `types.${type}.physics.${medium}.heightUpwardForceEMA`,
    physics.heightUpwardForceEMA,
  );
}

function maxSlopeDegToMinSurfaceNormalZ(maxSlopeDeg: number): number {
  return Math.cos(maxSlopeDeg * Math.PI / 180);
}

function readLocomotionConfig(): LocomotionConfig {
  const config = rawLocomotionConfig as unknown as {
    forceScale?: number;
    airLiftHeightForceFalloff?: Partial<AirLiftHeightForceFalloffConfig>;
    types?: Partial<Record<LocomotionType, LocomotionTypeConfig>>;
  };
  assertPositiveFinite('forceScale', config.forceScale ?? NaN);
  const airLiftHeightForceFalloff = config.airLiftHeightForceFalloff;
  if (!airLiftHeightForceFalloff || typeof airLiftHeightForceFalloff !== 'object') {
    throw new Error('Invalid locomotionConfig.json: missing airLiftHeightForceFalloff config');
  }
  assertHeightForceExponent(
    'airLiftHeightForceFalloff.heightForceExponent',
    airLiftHeightForceFalloff.heightForceExponent ?? NaN,
  );
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
    assertBoolean(
      `types.${type}.physics.forwardForceRequiresFacing`,
      typeConfig.physics.forwardForceRequiresFacing,
    );
    assertBoolean(
      `types.${type}.physics.driveForceScalesWithFacing`,
      typeConfig.physics.driveForceScalesWithFacing,
    );
    assertBoolean(
      `types.${type}.physics.maintainFullThrustAtWaypoints`,
      typeConfig.physics.maintainFullThrustAtWaypoints,
    );
    assertNonNegativeFinite(
      `types.${type}.physics.airLiftGroundProbeAheadDistance`,
      typeConfig.physics.airLiftGroundProbeAheadDistance,
    );
    assertNonNegativeFinite(
      `types.${type}.physics.airLiftGroundProbeAheadRadiusMultiplier`,
      typeConfig.physics.airLiftGroundProbeAheadRadiusMultiplier,
    );
    for (const medium of LOCOMOTION_MEDIUM_NAMES) {
      assertLocomotionTypeMediumPhysics(type, medium, typeConfig.physics[medium]);
    }
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

/** Power-law falloff for the air height lift term, authored in
 *  locomotionConfig.json. 1 is exact inverse-distance force, 0.5 square-roots
 *  the inverse-distance height force, and 0.333333 cube-roots it. */
export const AIR_LIFT_HEIGHT_FORCE_EXPONENT: number =
  LOCOMOTION_CONFIG.airLiftHeightForceFalloff.heightForceExponent;

export function getAirLiftHeightDistanceScale(
  clampedDistanceToSurface: number,
  heightUpwardForce: number,
): number {
  if (
    !Number.isFinite(clampedDistanceToSurface) ||
    clampedDistanceToSurface <= 0 ||
    !Number.isFinite(heightUpwardForce) ||
    heightUpwardForce <= 0
  ) {
    return 0;
  }
  const exactDistanceScale = 1 / clampedDistanceToSurface;
  const exactHeightForce = heightUpwardForce * exactDistanceScale;
  if (!Number.isFinite(exactHeightForce) || exactHeightForce <= 0) {
    return 0;
  }
  const rootedHeightForce = Math.pow(exactHeightForce, AIR_LIFT_HEIGHT_FORCE_EXPONENT);
  const rootedDistanceScale = rootedHeightForce / heightUpwardForce;
  return Math.min(exactDistanceScale, rootedDistanceScale);
}

function getLocomotionDriveForceMultiplier(type: LocomotionType): number {
  return LOCOMOTION_CONFIG.types[type].physics.driveForceMultiplier;
}

function getLocomotionForwardForceRequiresFacing(type: LocomotionType): boolean {
  return LOCOMOTION_CONFIG.types[type].physics.forwardForceRequiresFacing;
}

function getLocomotionDriveForceScalesWithFacing(type: LocomotionType): boolean {
  return LOCOMOTION_CONFIG.types[type].physics.driveForceScalesWithFacing;
}

function getLocomotionMaintainFullThrustAtWaypoints(type: LocomotionType): boolean {
  return LOCOMOTION_CONFIG.types[type].physics.maintainFullThrustAtWaypoints;
}

function getLocomotionAirLiftGroundProbeAheadDistance(type: LocomotionType): number {
  return LOCOMOTION_CONFIG.types[type].physics.airLiftGroundProbeAheadDistance;
}

function getLocomotionAirLiftGroundProbeAheadRadiusMultiplier(type: LocomotionType): number {
  return LOCOMOTION_CONFIG.types[type].physics.airLiftGroundProbeAheadRadiusMultiplier;
}

function getLocomotionTypeMediumPhysics(
  type: LocomotionType,
  medium: LocomotionMediumName,
): LocomotionTypeMediumPhysics {
  return LOCOMOTION_CONFIG.types[type].physics[medium];
}

function getEffectiveLocomotionForce(
  type: LocomotionType,
  medium: LocomotionMediumName,
  authoredForce: number,
): number {
  assertNonNegativeFinite(`${type}.physics.${medium}.force`, authoredForce);
  return authoredForce * getLocomotionDriveForceMultiplier(type);
}

function createRuntimeMediumPhysics(
  type: LocomotionType,
  medium: LocomotionMediumName,
  authored: AuthoredLocomotionMediumPhysics,
): UnitLocomotionMediumPhysics {
  if (!authored || typeof authored !== 'object') {
    throw new Error(`Invalid locomotion ${type}.physics.${medium}: missing medium physics`);
  }
  for (const field of LOCOMOTION_CONFIG_MEDIUM_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(authored, field)) {
      throw new Error(
        `Invalid locomotion ${type}.physics.${medium}.${field}: moved to locomotionConfig.json`,
      );
    }
  }
  assertNonNegativeFinite(`${type}.physics.${medium}.force`, authored.force);
  assertNonNegativeFinite(
    `${type}.physics.${medium}.heightUpwardForce`,
    authored.heightUpwardForce,
  );
  const authoredBuoyancy = authored.buoyancy ?? 0;
  assertNonNegativeFinite(`${type}.physics.${medium}.buoyancy`, authoredBuoyancy);
  const typeMediumPhysics = getLocomotionTypeMediumPhysics(type, medium);
  return {
    force: getEffectiveLocomotionForce(type, medium, authored.force),
    traction: typeMediumPhysics.traction,
    friction: typeMediumPhysics.friction,
    buoyancy: authoredBuoyancy,
    heightUpwardForce: authored.heightUpwardForce,
    heightUpwardForceRandomizationAmount: typeMediumPhysics.heightUpwardForceRandomizationAmount,
    heightUpwardForceEMA: typeMediumPhysics.heightUpwardForceEMA,
  };
}

function createRuntimeLocomotionPhysics(
  type: LocomotionType,
  authored: LocomotionBlueprint['physics'],
): UnitLocomotionPhysics {
  if (!authored || typeof authored !== 'object') {
    throw new Error(`Invalid locomotion ${type}.physics: missing physics object`);
  }
  return {
    ground: createRuntimeMediumPhysics(type, 'ground', authored.ground),
    air: createRuntimeMediumPhysics(type, 'air', authored.air),
    water: createRuntimeMediumPhysics(type, 'water', authored.water),
  };
}

function isAirborneLocomotionType(type: LocomotionType): boolean {
  return type === 'hover' || type === 'flying';
}

function assertPrimaryMediumCanMove(
  type: LocomotionType,
  physics: UnitLocomotionPhysics,
): void {
  const primaryMedium: LocomotionMediumName = isAirborneLocomotionType(type) ? 'air' : 'ground';
  const primary = physics[primaryMedium];
  assertPositiveFinite(`${type}.physics.${primaryMedium}.force`, primary.force);
  assertPositiveFinite(`${type}.physics.${primaryMedium}.traction`, primary.traction);
  if (primaryMedium === 'air') {
    assertPositiveFinite(`${type}.physics.air.heightUpwardForce`, physics.air.heightUpwardForce);
  }
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
  const { type } = locomotion;
  const physics = createRuntimeLocomotionPhysics(type, locomotion.physics);
  assertPrimaryMediumCanMove(type, physics);
  const pathfinding = createRuntimePathfindingConfig(
    `${type}.pathfinding(${locomotion.pathfindingBlueprintId})`,
    locomotion.pathfinding,
  );
  return {
    type,
    physics,
    forwardForceRequiresFacing: getLocomotionForwardForceRequiresFacing(type),
    driveForceScalesWithFacing: getLocomotionDriveForceScalesWithFacing(type),
    maintainFullThrustAtWaypoints: getLocomotionMaintainFullThrustAtWaypoints(type),
    airLiftGroundProbeAheadDistance: getLocomotionAirLiftGroundProbeAheadDistance(type),
    airLiftGroundProbeAheadRadiusMultiplier:
      getLocomotionAirLiftGroundProbeAheadRadiusMultiplier(type),
    pathfinding,
  };
}

function cloneMediumPhysics(
  physics: UnitLocomotionMediumPhysics,
): UnitLocomotionMediumPhysics {
  return { ...physics };
}

export function cloneUnitLocomotion(
  locomotion: UnitLocomotion,
): UnitLocomotion {
  return {
    type: locomotion.type,
    physics: {
      ground: cloneMediumPhysics(locomotion.physics.ground),
      air: cloneMediumPhysics(locomotion.physics.air),
      water: cloneMediumPhysics(locomotion.physics.water),
    },
    forwardForceRequiresFacing: locomotion.forwardForceRequiresFacing,
    driveForceScalesWithFacing: locomotion.driveForceScalesWithFacing,
    maintainFullThrustAtWaypoints: locomotion.maintainFullThrustAtWaypoints,
    airLiftGroundProbeAheadDistance: locomotion.airLiftGroundProbeAheadDistance,
    airLiftGroundProbeAheadRadiusMultiplier: locomotion.airLiftGroundProbeAheadRadiusMultiplier,
    pathfinding: { ...locomotion.pathfinding },
  };
}

export function getLocomotionPrimaryDrivePhysics(
  locomotion: UnitLocomotion,
): UnitLocomotionMediumPhysics {
  return isAirborneLocomotionType(locomotion.type)
    ? locomotion.physics.air
    : locomotion.physics.ground;
}

export function getLocomotionGroundDrivePhysics(
  locomotion: UnitLocomotion,
): UnitLocomotionMediumPhysics {
  return locomotion.physics.ground;
}

export function getLocomotionBestDrivePhysics(
  locomotion: UnitLocomotion,
): UnitLocomotionMediumPhysics {
  let best = getLocomotionPrimaryDrivePhysics(locomotion);
  let bestScore = best.force * best.traction;
  for (const medium of LOCOMOTION_MEDIUM_NAMES) {
    const candidate = locomotion.physics[medium];
    const score = candidate.force * candidate.traction;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

type LocomotionForceProfile = {
  rawDriveForce: number;
  tractionDriveForce: number;
  rawForceMagnitude: number;
  tractionForceMagnitude: number;
};

function writeLocomotionForceProfile(
  out: LocomotionForceProfile,
  physics: UnitLocomotionMediumPhysics,
  referenceMass: number,
  thrustMultiplier: number,
  forceScale: number,
): LocomotionForceProfile {
  assertPositiveFinite('referenceMass', referenceMass);
  assertPositiveFinite('forceScale', forceScale);
  const rawDriveForce = physics.force * thrustMultiplier;
  const tractionDriveForce = rawDriveForce * physics.traction;
  out.rawDriveForce = rawDriveForce;
  out.tractionDriveForce = tractionDriveForce;
  out.rawForceMagnitude = (rawDriveForce * referenceMass) / forceScale;
  out.tractionForceMagnitude = (tractionDriveForce * referenceMass) / forceScale;
  return out;
}

export function getLocomotionForceProfile(
  physics: UnitLocomotionMediumPhysics,
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
    physics,
    referenceMass,
    thrustMultiplier,
    forceScale,
  );
}
