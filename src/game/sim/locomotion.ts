import type {
  LocomotionBlueprint,
  PathfindingBlueprint,
} from '@/types/blueprints';
import type {
  LocomotionNavigationPolicy,
  UnitLocomotion,
  UnitLocomotionMediumPhysics,
  UnitLocomotionPhysics,
} from '@/types/locomotionTypes';
import { deterministicMath as DMath } from './deterministicMath';
import rawLocomotionConfig from './locomotionConfig.json';

// Visual rig discriminants are deliberately separate from authoritative
// physics presets. A wheels rig may use any preset and moves identically to
// any other rig with the same expanded profile.
const LOCOMOTION_TYPES = ['wheels', 'treads', 'legs', 'hover', 'flying'] as const;
const LOCOMOTION_MEDIUM_NAMES = ['ground', 'air', 'water'] as const;
const LOCOMOTION_CONFIG_MEDIUM_FIELDS = [
  'traction',
  'friction',
  'heightUpwardForceRandomizationAmount',
  'heightUpwardForceEMA',
  'quadraticDrag',
  'dragForwardScale',
  'dragLateralScale',
  'dragVerticalScale',
  'angularDrag',
  'surfaceGrip',
  'contactDamping',
] as const;

type LocomotionMediumName = (typeof LOCOMOTION_MEDIUM_NAMES)[number];
type AuthoredLocomotionMediumPhysics = LocomotionBlueprint['physics'][LocomotionMediumName];
type LocomotionConfigMediumField = (typeof LOCOMOTION_CONFIG_MEDIUM_FIELDS)[number];
type LocomotionTypeMediumPhysics = Pick<UnitLocomotionMediumPhysics, LocomotionConfigMediumField>;

type LocomotionPresetConfig = {
  navigation: LocomotionNavigationPolicy;
  physics: {
    driveForceMultiplier: number;
    forwardForceRequiresFacing: boolean;
    driveForceScalesWithFacing: boolean;
    maintainFullThrustAtWaypoints: boolean;
    airLiftGroundProbeAheadDistance: number;
    airLiftGroundProbeAheadRadiusMultiplier: number;
    idleAirDrive: boolean;
  } & Record<LocomotionMediumName, LocomotionTypeMediumPhysics>;
};

type AirLiftHeightForceFalloffConfig = {
  heightForceExponent: number;
};

type LocomotionConfig = {
  forceScale: number;
  airLiftHeightForceFalloff: AirLiftHeightForceFalloffConfig;
  presets: Record<string, LocomotionPresetConfig>;
};

const LOCOMOTION_MEDIUM_NAVIGATION = [
  'air-only',
  'water-only',
  'air-and-water',
] as const satisfies readonly LocomotionNavigationPolicy['allowInMedium'][];

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

function assertClosedUnitFraction(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Invalid locomotion ${label}: expected finite [0, 1], got ${value}`);
  }
}

function assertBoolean(label: string, value: unknown): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid locomotion ${label}: expected boolean, got ${value}`);
  }
}

function assertMediumNavigation(
  label: string,
  value: unknown,
): asserts value is LocomotionNavigationPolicy['allowInMedium'] {
  if (!(LOCOMOTION_MEDIUM_NAVIGATION as readonly unknown[]).includes(value)) {
    throw new Error(
      `Invalid locomotion ${label}: expected ${LOCOMOTION_MEDIUM_NAVIGATION.join(', ')}, got ${String(value)}`,
    );
  }
}

function assertSlopeDegrees(label: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 90) {
    throw new Error(`Invalid locomotion ${label}: expected finite degrees in (0, 90), got ${value}`);
  }
}

function assertLocomotionTypeMediumPhysics(
  presetId: string,
  medium: LocomotionMediumName,
  physics: LocomotionTypeMediumPhysics | undefined,
): asserts physics is LocomotionTypeMediumPhysics {
  if (!physics || typeof physics !== 'object') {
    throw new Error(
      `Invalid locomotionConfig.json: missing presets.${presetId}.physics.${medium} config`,
    );
  }
  assertNonNegativeFinite(`presets.${presetId}.physics.${medium}.traction`, physics.traction);
  assertNonNegativeFinite(`presets.${presetId}.physics.${medium}.friction`, physics.friction);
  assertNonNegativeFinite(`presets.${presetId}.physics.${medium}.quadraticDrag`, physics.quadraticDrag);
  assertNonNegativeFinite(`presets.${presetId}.physics.${medium}.dragForwardScale`, physics.dragForwardScale);
  assertNonNegativeFinite(`presets.${presetId}.physics.${medium}.dragLateralScale`, physics.dragLateralScale);
  assertNonNegativeFinite(`presets.${presetId}.physics.${medium}.dragVerticalScale`, physics.dragVerticalScale);
  assertNonNegativeFinite(`presets.${presetId}.physics.${medium}.angularDrag`, physics.angularDrag);
  assertNonNegativeFinite(`presets.${presetId}.physics.${medium}.surfaceGrip`, physics.surfaceGrip);
  assertNonNegativeFinite(`presets.${presetId}.physics.${medium}.contactDamping`, physics.contactDamping);
  assertUnitFraction(
    `presets.${presetId}.physics.${medium}.heightUpwardForceRandomizationAmount`,
    physics.heightUpwardForceRandomizationAmount,
  );
  assertUnitFraction(
    `presets.${presetId}.physics.${medium}.heightUpwardForceEMA`,
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
    presets?: Record<string, LocomotionPresetConfig>;
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
  const presets = config.presets;
  if (!presets || typeof presets !== 'object') {
    throw new Error('Invalid locomotionConfig.json: missing presets table');
  }
  for (const [presetId, presetConfig] of Object.entries(presets)) {
    if (!presetConfig || typeof presetConfig !== 'object') {
      throw new Error(`Invalid locomotionConfig.json: missing presets.${presetId} config`);
    }
    if (!presetConfig.physics || typeof presetConfig.physics !== 'object') {
      throw new Error(`Invalid locomotionConfig.json: missing presets.${presetId}.physics config`);
    }
    if (!presetConfig.navigation || typeof presetConfig.navigation !== 'object') {
      throw new Error(`Invalid locomotionConfig.json: missing presets.${presetId}.navigation config`);
    }
    assertBoolean(
      `presets.${presetId}.navigation.allowOnGround`,
      presetConfig.navigation.allowOnGround,
    );
    assertMediumNavigation(
      `presets.${presetId}.navigation.allowInMedium`,
      presetConfig.navigation.allowInMedium,
    );
    assertPositiveFinite(
      `presets.${presetId}.physics.driveForceMultiplier`,
      presetConfig.physics.driveForceMultiplier,
    );
    assertBoolean(
      `presets.${presetId}.physics.forwardForceRequiresFacing`,
      presetConfig.physics.forwardForceRequiresFacing,
    );
    assertBoolean(
      `presets.${presetId}.physics.driveForceScalesWithFacing`,
      presetConfig.physics.driveForceScalesWithFacing,
    );
    assertBoolean(
      `presets.${presetId}.physics.maintainFullThrustAtWaypoints`,
      presetConfig.physics.maintainFullThrustAtWaypoints,
    );
    assertNonNegativeFinite(
      `presets.${presetId}.physics.airLiftGroundProbeAheadDistance`,
      presetConfig.physics.airLiftGroundProbeAheadDistance,
    );
    assertNonNegativeFinite(
      `presets.${presetId}.physics.airLiftGroundProbeAheadRadiusMultiplier`,
      presetConfig.physics.airLiftGroundProbeAheadRadiusMultiplier,
    );
    assertBoolean(`presets.${presetId}.physics.idleAirDrive`, presetConfig.physics.idleAirDrive);
    for (const medium of LOCOMOTION_MEDIUM_NAMES) {
      assertLocomotionTypeMediumPhysics(presetId, medium, presetConfig.physics[medium]);
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
  const rootedHeightForce = DMath.pow(exactHeightForce, AIR_LIFT_HEIGHT_FORCE_EXPONENT);
  const rootedDistanceScale = rootedHeightForce / heightUpwardForce;
  return Math.min(exactDistanceScale, rootedDistanceScale);
}

function getPreset(presetId: string): LocomotionPresetConfig {
  const preset = LOCOMOTION_CONFIG.presets[presetId];
  if (!preset) throw new Error(`Invalid locomotion physicsPresetId "${presetId}"`);
  return preset;
}

function getLocomotionDriveForceMultiplier(presetId: string): number {
  return getPreset(presetId).physics.driveForceMultiplier;
}

function getLocomotionForwardForceRequiresFacing(presetId: string): boolean {
  return getPreset(presetId).physics.forwardForceRequiresFacing;
}

function getLocomotionDriveForceScalesWithFacing(presetId: string): boolean {
  return getPreset(presetId).physics.driveForceScalesWithFacing;
}

function getLocomotionMaintainFullThrustAtWaypoints(presetId: string): boolean {
  return getPreset(presetId).physics.maintainFullThrustAtWaypoints;
}

function getLocomotionAirLiftGroundProbeAheadDistance(presetId: string): number {
  return getPreset(presetId).physics.airLiftGroundProbeAheadDistance;
}

function getLocomotionAirLiftGroundProbeAheadRadiusMultiplier(presetId: string): number {
  return getPreset(presetId).physics.airLiftGroundProbeAheadRadiusMultiplier;
}

function getLocomotionTypeMediumPhysics(
  presetId: string,
  medium: LocomotionMediumName,
): LocomotionTypeMediumPhysics {
  return getPreset(presetId).physics[medium];
}

function getEffectiveLocomotionForce(
  presetId: string,
  medium: LocomotionMediumName,
  authoredForce: number,
): number {
  assertNonNegativeFinite(`${presetId}.physics.${medium}.force`, authoredForce);
  return authoredForce * getLocomotionDriveForceMultiplier(presetId);
}

function createRuntimeMediumPhysics(
  presetId: string,
  medium: LocomotionMediumName,
  authored: AuthoredLocomotionMediumPhysics,
): UnitLocomotionMediumPhysics {
  if (!authored || typeof authored !== 'object') {
    throw new Error(`Invalid locomotion ${presetId}.physics.${medium}: missing medium physics`);
  }
  for (const field of LOCOMOTION_CONFIG_MEDIUM_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(authored, field)) {
      throw new Error(
        `Invalid locomotion ${presetId}.physics.${medium}.${field}: moved to locomotionConfig.json`,
      );
    }
  }
  assertNonNegativeFinite(`${presetId}.physics.${medium}.force`, authored.force);
  assertNonNegativeFinite(
    `${presetId}.physics.${medium}.heightUpwardForce`,
    authored.heightUpwardForce,
  );
  const authoredBuoyancy = authored.buoyancy ?? 0;
  assertNonNegativeFinite(`${presetId}.physics.${medium}.buoyancy`, authoredBuoyancy);
  const typeMediumPhysics = getLocomotionTypeMediumPhysics(presetId, medium);
  return {
    force: getEffectiveLocomotionForce(presetId, medium, authored.force),
    traction: typeMediumPhysics.traction,
    friction: typeMediumPhysics.friction,
    quadraticDrag: typeMediumPhysics.quadraticDrag,
    dragForwardScale: typeMediumPhysics.dragForwardScale,
    dragLateralScale: typeMediumPhysics.dragLateralScale,
    dragVerticalScale: typeMediumPhysics.dragVerticalScale,
    angularDrag: typeMediumPhysics.angularDrag,
    surfaceGrip: typeMediumPhysics.surfaceGrip,
    contactDamping: typeMediumPhysics.contactDamping,
    buoyancy: authoredBuoyancy,
    heightUpwardForce: authored.heightUpwardForce,
    heightUpwardForceRandomizationAmount: typeMediumPhysics.heightUpwardForceRandomizationAmount,
    heightUpwardForceEMA: typeMediumPhysics.heightUpwardForceEMA,
  };
}

function createRuntimeLocomotionPhysics(
  presetId: string,
  authored: LocomotionBlueprint['physics'],
): UnitLocomotionPhysics {
  if (!authored || typeof authored !== 'object') {
    throw new Error(`Invalid locomotion ${presetId}.physics: missing physics object`);
  }
  return {
    ground: createRuntimeMediumPhysics(presetId, 'ground', authored.ground),
    air: createRuntimeMediumPhysics(presetId, 'air', authored.air),
    water: createRuntimeMediumPhysics(presetId, 'water', authored.water),
  };
}

function mediumHasRouteAuthority(physics: UnitLocomotionMediumPhysics): boolean {
  return physics.force > 0 && physics.traction > 0;
}

function airHasLiftAuthority(physics: UnitLocomotionMediumPhysics): boolean {
  return physics.buoyancy > 0 || physics.heightUpwardForce > 0;
}

function policyAllowsAir(policy: LocomotionNavigationPolicy): boolean {
  return policy.allowInMedium === 'air-only' || policy.allowInMedium === 'air-and-water';
}

function policyAllowsWater(policy: LocomotionNavigationPolicy): boolean {
  return policy.allowInMedium === 'water-only' || policy.allowInMedium === 'air-and-water';
}

export function locomotionAllowsOnGround(locomotion: UnitLocomotion): boolean {
  return locomotion.navigation.allowOnGround && mediumHasRouteAuthority(locomotion.physics.ground);
}

export function locomotionAllowsInAir(locomotion: UnitLocomotion): boolean {
  return policyAllowsAir(locomotion.navigation) &&
    mediumHasRouteAuthority(locomotion.physics.air) &&
    airHasLiftAuthority(locomotion.physics.air);
}

export function locomotionAllowsInWater(locomotion: UnitLocomotion): boolean {
  return policyAllowsWater(locomotion.navigation) && mediumHasRouteAuthority(locomotion.physics.water);
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
  const { type, physicsPresetId, survival } = locomotion;
  if (!(LOCOMOTION_TYPES as readonly string[]).includes(type)) {
    throw new Error(`Invalid locomotion visual rig type "${String(type)}"`);
  }
  const preset = getPreset(physicsPresetId);
  const physics = createRuntimeLocomotionPhysics(physicsPresetId, locomotion.physics);
  const navigation = { ...preset.navigation };
  const runtime: UnitLocomotion = {
    type,
    physicsPresetId,
    physics,
    navigation,
    survival: { ...survival },
    idleAirDrive: preset.physics.idleAirDrive,
    forwardForceRequiresFacing: getLocomotionForwardForceRequiresFacing(physicsPresetId),
    driveForceScalesWithFacing: getLocomotionDriveForceScalesWithFacing(physicsPresetId),
    maintainFullThrustAtWaypoints: getLocomotionMaintainFullThrustAtWaypoints(physicsPresetId),
    airLiftGroundProbeAheadDistance: getLocomotionAirLiftGroundProbeAheadDistance(physicsPresetId),
    airLiftGroundProbeAheadRadiusMultiplier:
      getLocomotionAirLiftGroundProbeAheadRadiusMultiplier(physicsPresetId),
    pathfinding: createRuntimePathfindingConfig(
      `${type}.pathfinding(${locomotion.pathfindingBlueprintId})`,
      locomotion.pathfinding,
    ),
  };
  if (
    !locomotionAllowsOnGround(runtime) &&
    !locomotionAllowsInWater(runtime) &&
    !locomotionAllowsInAir(runtime)
  ) {
    throw new Error(
      `Invalid locomotion ${physicsPresetId}: preset navigation and physical authority allow no route domain`,
    );
  }
  assertClosedUnitFraction(
    `${physicsPresetId}.survival.fatalSubmergedFraction`,
    survival.fatalSubmergedFraction,
  );
  assertNonNegativeFinite(
    `${physicsPresetId}.survival.fatalExposureSeconds`,
    survival.fatalExposureSeconds,
  );
  return runtime;
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
    physicsPresetId: locomotion.physicsPresetId,
    physics: {
      ground: cloneMediumPhysics(locomotion.physics.ground),
      air: cloneMediumPhysics(locomotion.physics.air),
      water: cloneMediumPhysics(locomotion.physics.water),
    },
    navigation: { ...locomotion.navigation },
    survival: { ...locomotion.survival },
    idleAirDrive: locomotion.idleAirDrive,
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
  if (locomotionAllowsInAir(locomotion)) return locomotion.physics.air;
  if (locomotionAllowsInWater(locomotion) && !locomotionAllowsOnGround(locomotion)) {
    return locomotion.physics.water;
  }
  return locomotion.physics.ground;
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
