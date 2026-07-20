import type {
  SurfaceProbeSetId,
  UnitLocomotionGroundPhysics,
  UnitLocomotionResistancePhysics,
} from '@/types/unitLocomotionTypes';
import rawUnitLocomotionConfig from './unitLocomotionConfig.json';
import {
  assertUnitLocomotionBoolean,
  assertUnitLocomotionNonNegativeFinite,
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

export type UnitLocomotionPresetFluidPhysics = UnitLocomotionResistancePhysics & {
  maxPropulsiveForce: number;
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

type UnitLocomotionConfig = {
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
): void {
  const label = `presets.${presetId}.actuator.${medium}`;
  assertObject(label, value);
  assertExactKeys(label, value, [
    'maxPropulsiveForce',
    'linearDampingRate',
    'angularDampingRate',
    'surfaceLiftResponse',
  ]);
  assertUnitLocomotionNonNegativeFinite(`${label}.maxPropulsiveForce`, value.maxPropulsiveForce as number);
  assertUnitLocomotionNonNegativeFinite(`${label}.linearDampingRate`, value.linearDampingRate as number);
  assertUnitLocomotionNonNegativeFinite(`${label}.angularDampingRate`, value.angularDampingRate as number);
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
  assertFluidPhysics(presetId, 'air', preset.actuator.air);
  assertFluidPhysics(presetId, 'water', preset.actuator.water);
}

function readUnitLocomotionConfig(): UnitLocomotionConfig {
  const config = rawUnitLocomotionConfig as unknown as Partial<UnitLocomotionConfig>;
  assertExactKeys('root', config as Record<string, unknown>, ['presets']);
  const rawPresets = config.presets;
  assertObject('presets', rawPresets);
  const presets: Record<string, UnitLocomotionPresetConfig> = {};
  for (const [presetId, preset] of Object.entries(rawPresets)) {
    assertPreset(presetId, preset as UnitLocomotionPresetConfig);
    presets[presetId] = preset as UnitLocomotionPresetConfig;
  }
  return { presets };
}

const UNIT_LOCOMOTION_CONFIG = readUnitLocomotionConfig();

export function getUnitLocomotionPreset(presetId: string): UnitLocomotionPresetConfig {
  const preset = UNIT_LOCOMOTION_CONFIG.presets[presetId];
  if (!preset) throw new Error(`Invalid unit locomotion physicsPresetId "${presetId}"`);
  return preset;
}
