import type {
  SurfaceProbeSetId,
  UnitLocomotionGroundPhysics,
  UnitLocomotionResistancePhysics,
} from '@/types/unitLocomotionTypes';
import rawUnitLocomotionConfig from './unitLocomotionConfig.json';
import {
  assertUnitLocomotionBoolean,
  assertUnitLocomotionNonNegativeFinite,
  assertUnitLocomotionPositiveFinite,
  assertUnitLocomotionUnitFraction,
} from './unitLocomotionValidation';
import { isSurfaceProbeSetId } from './surfaceProbeSets';

export const UNIT_LOCOMOTION_MEDIUM_NAMES = ['ground', 'air', 'water'] as const;
export type UnitLocomotionMediumName = (typeof UNIT_LOCOMOTION_MEDIUM_NAMES)[number];
export type UnitLocomotionFluidMediumName = Exclude<UnitLocomotionMediumName, 'ground'>;

/** The JSON field is deliberately named `surfaceLiftResponse` to preserve the
 * authored contract. The zero-only values mean it has no runtime dynamics. */
export const UNIT_LOCOMOTION_SURFACE_FOLLOWING_RESPONSE_FIELDS = ['randomizationAmount', 'ema'] as const;

export type UnitLocomotionSurfaceFollowingResponse = {
  randomizationAmount: number;
  ema: number;
};

export type UnitLocomotionFluidResistanceProfile = UnitLocomotionResistancePhysics;

export type UnitLocomotionPresetFluidPhysics = {
  maxPropulsiveForce: number;
  resistanceProfileId: string;
  /** Kept explicit and fixed at zero: surface following is deterministic and
   * unfiltered. */
  surfaceLiftResponse: UnitLocomotionSurfaceFollowingResponse;
};

export type UnitLocomotionPresetConfig = {
  actuator: {
    propulsionAxis: 'bodyForward' | 'worldPlanar';
    ground: UnitLocomotionGroundPhysics;
    air: UnitLocomotionPresetFluidPhysics;
    water: UnitLocomotionPresetFluidPhysics;
  };
  motionControl: {
    maintainFullThrustAtWaypoints: boolean;
    cruiseWhenUncommanded: boolean;
  };
  surfaceFollowing: {
    altitudeProbeSetId: SurfaceProbeSetId;
  };
  navigation: {
    allowOnGround: boolean;
    allowedFluidMedia: readonly UnitLocomotionFluidMediumName[];
  };
};

export const SURFACE_FOLLOWING_PROBE_AGGREGATION_MODES = ['average', 'max'] as const;
export type SurfaceFollowingProbeAggregationMode =
  (typeof SURFACE_FOLLOWING_PROBE_AGGREGATION_MODES)[number];

type UnitLocomotionConfig = {
  surfaceFollowingDefaults: {
    minimumDistanceWorld: number;
    probeAggregation: SurfaceFollowingProbeAggregationMode;
  };
  fluidResistanceProfiles: Record<string, UnitLocomotionFluidResistanceProfile>;
  presets: Record<string, UnitLocomotionPresetConfig>;
};

function assertObject(label: string, value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid unitLocomotionConfig.json: missing ${label} object`);
  }
}

function assertExactKeys(label: string, value: Record<string, unknown>, expected: readonly string[]): void {
  const expectedSet = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) throw new Error(`Invalid unitLocomotionConfig.json: unexpected ${label}.${key}`);
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`Invalid unitLocomotionConfig.json: missing ${label}.${key}`);
    }
  }
}

function isSurfaceFollowingProbeAggregationMode(value: unknown): value is SurfaceFollowingProbeAggregationMode {
  return typeof value === 'string' &&
    (SURFACE_FOLLOWING_PROBE_AGGREGATION_MODES as readonly string[]).includes(value);
}

function assertSurfaceFollowingResponse(label: string, value: unknown): void {
  assertObject(label, value);
  assertExactKeys(label, value, UNIT_LOCOMOTION_SURFACE_FOLLOWING_RESPONSE_FIELDS);
  assertUnitLocomotionUnitFraction(`${label}.randomizationAmount`, value.randomizationAmount as number);
  assertUnitLocomotionUnitFraction(`${label}.ema`, value.ema as number);
  if (value.randomizationAmount !== 0 || value.ema !== 0) {
    throw new Error(`Invalid unitLocomotionConfig.json: ${label} must be { randomizationAmount: 0, ema: 0 }`);
  }
}

function assertGroundPhysics(presetId: string, value: unknown): void {
  const label = `presets.${presetId}.actuator.ground`;
  assertObject(label, value);
  assertExactKeys(label, value, [
    'maxPropulsiveForce',
    'staticFrictionCoefficient',
    'tangentialDampingRate',
  ]);
  assertUnitLocomotionNonNegativeFinite(`${label}.maxPropulsiveForce`, value.maxPropulsiveForce as number);
  assertUnitLocomotionNonNegativeFinite(
    `${label}.staticFrictionCoefficient`,
    value.staticFrictionCoefficient as number,
  );
  assertUnitLocomotionNonNegativeFinite(
    `${label}.tangentialDampingRate`,
    value.tangentialDampingRate as number,
  );
}

function assertFluidPhysics(
  presetId: string,
  medium: UnitLocomotionFluidMediumName,
  value: unknown,
  resistanceProfiles: Readonly<Record<string, UnitLocomotionFluidResistanceProfile>>,
): void {
  const label = `presets.${presetId}.actuator.${medium}`;
  assertObject(label, value);
  assertExactKeys(label, value, ['maxPropulsiveForce', 'resistanceProfileId', 'surfaceLiftResponse']);
  assertUnitLocomotionNonNegativeFinite(`${label}.maxPropulsiveForce`, value.maxPropulsiveForce as number);
  if (typeof value.resistanceProfileId !== 'string' || resistanceProfiles[value.resistanceProfileId] === undefined) {
    throw new Error(`Invalid unitLocomotionConfig.json: unknown ${label}.resistanceProfileId`);
  }
  assertSurfaceFollowingResponse(`${label}.surfaceLiftResponse`, value.surfaceLiftResponse);
}

function assertNavigation(label: string, value: unknown): void {
  assertObject(label, value);
  assertExactKeys(label, value, ['allowOnGround', 'allowedFluidMedia']);
  assertUnitLocomotionBoolean(`${label}.allowOnGround`, value.allowOnGround);
  if (!Array.isArray(value.allowedFluidMedia)) {
    throw new Error(`Invalid unitLocomotionConfig.json: ${label}.allowedFluidMedia must be an array`);
  }
  const seen = new Set<string>();
  for (const medium of value.allowedFluidMedia) {
    if ((medium !== 'air' && medium !== 'water') || seen.has(medium)) {
      throw new Error(`Invalid unitLocomotionConfig.json: invalid ${label}.allowedFluidMedia`);
    }
    seen.add(medium);
  }
}

function assertPreset(
  presetId: string,
  preset: UnitLocomotionPresetConfig | undefined,
  resistanceProfiles: Readonly<Record<string, UnitLocomotionFluidResistanceProfile>>,
): void {
  if (!preset || typeof preset !== 'object') {
    throw new Error(`Invalid unitLocomotionConfig.json: missing presets.${presetId} config`);
  }
  assertExactKeys(`presets.${presetId}`, preset as unknown as Record<string, unknown>, [
    'actuator',
    'motionControl',
    'surfaceFollowing',
    'navigation',
  ]);
  assertObject(`presets.${presetId}.actuator`, preset.actuator);
  assertExactKeys(`presets.${presetId}.actuator`, preset.actuator, [
    'propulsionAxis',
    'ground',
    'air',
    'water',
  ]);
  if (
    preset.actuator.propulsionAxis !== 'bodyForward' &&
    preset.actuator.propulsionAxis !== 'worldPlanar'
  ) {
    throw new Error(`Invalid unit locomotion presets.${presetId}.actuator.propulsionAxis`);
  }
  assertObject(`presets.${presetId}.motionControl`, preset.motionControl);
  assertExactKeys(`presets.${presetId}.motionControl`, preset.motionControl, [
    'maintainFullThrustAtWaypoints',
    'cruiseWhenUncommanded',
  ]);
  assertUnitLocomotionBoolean(
    `presets.${presetId}.motionControl.maintainFullThrustAtWaypoints`,
    preset.motionControl.maintainFullThrustAtWaypoints,
  );
  assertUnitLocomotionBoolean(
    `presets.${presetId}.motionControl.cruiseWhenUncommanded`,
    preset.motionControl.cruiseWhenUncommanded,
  );
  assertObject(`presets.${presetId}.surfaceFollowing`, preset.surfaceFollowing);
  assertExactKeys(`presets.${presetId}.surfaceFollowing`, preset.surfaceFollowing, [
    'altitudeProbeSetId',
  ]);
  if (!isSurfaceProbeSetId(preset.surfaceFollowing.altitudeProbeSetId)) {
    throw new Error(`Invalid unit locomotion presets.${presetId}.surfaceFollowing.altitudeProbeSetId`);
  }
  assertNavigation(`presets.${presetId}.navigation`, preset.navigation);
  assertGroundPhysics(presetId, preset.actuator.ground);
  assertFluidPhysics(presetId, 'air', preset.actuator.air, resistanceProfiles);
  assertFluidPhysics(presetId, 'water', preset.actuator.water, resistanceProfiles);
}

function readUnitLocomotionConfig(): UnitLocomotionConfig {
  const config = rawUnitLocomotionConfig as unknown as Partial<UnitLocomotionConfig>;
  assertExactKeys('root', config as Record<string, unknown>, [
    'surfaceFollowingDefaults',
    'fluidResistanceProfiles',
    'presets',
  ]);
  const defaults = config.surfaceFollowingDefaults;
  assertObject('surfaceFollowingDefaults', defaults);
  assertExactKeys('surfaceFollowingDefaults', defaults, ['minimumDistanceWorld', 'probeAggregation']);
  assertUnitLocomotionPositiveFinite('surfaceFollowingDefaults.minimumDistanceWorld', defaults.minimumDistanceWorld as number);
  if (!isSurfaceFollowingProbeAggregationMode(defaults.probeAggregation)) {
    throw new Error('Invalid unitLocomotionConfig.json: invalid surfaceFollowingDefaults.probeAggregation');
  }
  const rawProfiles = config.fluidResistanceProfiles;
  assertObject('fluidResistanceProfiles', rawProfiles);
  const resistanceProfiles: Record<string, UnitLocomotionFluidResistanceProfile> = {};
  for (const [profileId, profile] of Object.entries(rawProfiles)) {
    assertObject(`fluidResistanceProfiles.${profileId}`, profile);
    assertExactKeys(`fluidResistanceProfiles.${profileId}`, profile, [
      'linearDampingRate',
      'angularDampingRate',
    ]);
    assertUnitLocomotionNonNegativeFinite(
      `fluidResistanceProfiles.${profileId}.linearDampingRate`,
      profile.linearDampingRate as number,
    );
    assertUnitLocomotionNonNegativeFinite(
      `fluidResistanceProfiles.${profileId}.angularDampingRate`,
      profile.angularDampingRate as number,
    );
    resistanceProfiles[profileId] = {
      linearDampingRate: profile.linearDampingRate as number,
      angularDampingRate: profile.angularDampingRate as number,
    };
  }
  const rawPresets = config.presets;
  assertObject('presets', rawPresets);
  const presets: Record<string, UnitLocomotionPresetConfig> = {};
  for (const [presetId, preset] of Object.entries(rawPresets)) {
    assertPreset(presetId, preset as UnitLocomotionPresetConfig, resistanceProfiles);
    presets[presetId] = preset as UnitLocomotionPresetConfig;
  }
  return {
    surfaceFollowingDefaults: {
      minimumDistanceWorld: defaults.minimumDistanceWorld as number,
      probeAggregation: defaults.probeAggregation as SurfaceFollowingProbeAggregationMode,
    },
    fluidResistanceProfiles: resistanceProfiles,
    presets,
  };
}

const UNIT_LOCOMOTION_CONFIG = readUnitLocomotionConfig();

export const SURFACE_FOLLOWING_MINIMUM_DISTANCE_WORLD =
  UNIT_LOCOMOTION_CONFIG.surfaceFollowingDefaults.minimumDistanceWorld;
export const SURFACE_FOLLOWING_PROBE_AGGREGATION_MODE =
  UNIT_LOCOMOTION_CONFIG.surfaceFollowingDefaults.probeAggregation;

export function getUnitLocomotionFluidResistance(
  profileId: string,
): UnitLocomotionFluidResistanceProfile {
  const profile = UNIT_LOCOMOTION_CONFIG.fluidResistanceProfiles[profileId];
  if (profile === undefined) {
    throw new Error(`Invalid unit locomotion resistanceProfileId "${profileId}"`);
  }
  return profile;
}

export function getUnitLocomotionPreset(presetId: string): UnitLocomotionPresetConfig {
  const preset = UNIT_LOCOMOTION_CONFIG.presets[presetId];
  if (!preset) throw new Error(`Invalid unit locomotion physicsPresetId "${presetId}"`);
  return preset;
}
