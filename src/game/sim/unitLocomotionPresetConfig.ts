import type {
  SurfaceProbeSetId,
  UnitLocomotionResistancePhysics,
} from '@/types/unitLocomotionTypes';
import rawUnitLocomotionConfig from './unitLocomotionConfig.json';
import {
  assertUnitLocomotionBoolean,
  assertUnitLocomotionNonNegativeFinite,
  assertUnitLocomotionUnitFraction,
} from './unitLocomotionValidation';
import { isSurfaceProbeSetId } from './surfaceProbeSets';
import {
  assertExactObjectKeys,
  assertPlainObject,
} from '../../configValidation';

const UNIT_LOCOMOTION_MEDIUM_NAMES = ['ground', 'air', 'water'] as const;
type UnitLocomotionMediumName = (typeof UNIT_LOCOMOTION_MEDIUM_NAMES)[number];
type UnitLocomotionFluidMediumName = Exclude<UnitLocomotionMediumName, 'ground'>;

/** The JSON field is deliberately named `surfaceLiftResponse` to preserve the
 * authored contract. The zero-only values mean it has no runtime dynamics. */
export const UNIT_LOCOMOTION_SURFACE_FOLLOWING_RESPONSE_FIELDS = ['randomizationAmount', 'ema'] as const;

type UnitLocomotionSurfaceFollowingResponse = {
  randomizationAmount: number;
  ema: number;
};

type UnitLocomotionPresetFluidPhysics = UnitLocomotionResistancePhysics & {
  /** Kept explicit and fixed at zero: surface following is deterministic and
   * unfiltered. */
  surfaceLiftResponse: UnitLocomotionSurfaceFollowingResponse;
};

export type UnitLocomotionPresetConfig = {
  actuator: {
    propulsionAxis: 'bodyForward' | 'bodyForwardOnly' | 'worldPlanar';
    ground: {
      staticFrictionCoefficient: number;
      tangentialDampingRate: number;
    };
    air: UnitLocomotionPresetFluidPhysics;
    water: UnitLocomotionPresetFluidPhysics;
  };
  motionControl: {
    maintainFullThrustAtWaypoints: boolean;
    alwaysBrakeAtFinalWaypoint: boolean;
    cruiseWhenUncommanded: boolean;
    /** Cruise presets only: the no-turn deadzone around a waypoint. Inside
     * `turnRadiusMultiplier x natural turn radius`, the unit may only keep
     * turning while the waypoint sits within `frontSliceDegrees` left or
     * right of its nose; otherwise it may not turn at all. */
    waypointDeadzone?: {
      turnRadiusMultiplier: number;
      frontSliceDegrees: number;
    };
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
  assertPlainObject(value, `Invalid unitLocomotionConfig.json: missing ${label} object`);
}

function assertExactKeys(label: string, value: Record<string, unknown>, expected: readonly string[]): void {
  assertExactObjectKeys(
    value,
    expected,
    (key) => `Invalid unitLocomotionConfig.json: unexpected ${label}.${key}`,
    (key) => `Invalid unitLocomotionConfig.json: missing ${label}.${key}`,
  );
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
    'staticFrictionCoefficient',
    'tangentialDampingRate',
  ]);
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
    'linearDampingRate',
    'angularDampingRate',
    'surfaceLiftResponse',
  ]);
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
    preset.actuator.propulsionAxis !== 'bodyForwardOnly' &&
    preset.actuator.propulsionAxis !== 'worldPlanar'
  ) {
    throw new Error(`Invalid unit locomotion presets.${presetId}.actuator.propulsionAxis`);
  }
  assertObject(`presets.${presetId}.motionControl`, preset.motionControl);
  const cruiseWhenUncommanded = preset.motionControl.cruiseWhenUncommanded === true;
  assertExactKeys(
    `presets.${presetId}.motionControl`,
    preset.motionControl as unknown as Record<string, unknown>,
    cruiseWhenUncommanded
      ? [
        'maintainFullThrustAtWaypoints',
        'alwaysBrakeAtFinalWaypoint',
        'cruiseWhenUncommanded',
        'waypointDeadzone',
      ]
      : [
        'maintainFullThrustAtWaypoints',
        'alwaysBrakeAtFinalWaypoint',
        'cruiseWhenUncommanded',
      ],
  );
  assertUnitLocomotionBoolean(
    `presets.${presetId}.motionControl.maintainFullThrustAtWaypoints`,
    preset.motionControl.maintainFullThrustAtWaypoints,
  );
  assertUnitLocomotionBoolean(
    `presets.${presetId}.motionControl.alwaysBrakeAtFinalWaypoint`,
    preset.motionControl.alwaysBrakeAtFinalWaypoint,
  );
  assertUnitLocomotionBoolean(
    `presets.${presetId}.motionControl.cruiseWhenUncommanded`,
    preset.motionControl.cruiseWhenUncommanded,
  );
  if (cruiseWhenUncommanded) {
    const deadzoneLabel = `presets.${presetId}.motionControl.waypointDeadzone`;
    const deadzone = preset.motionControl.waypointDeadzone;
    assertObject(deadzoneLabel, deadzone);
    assertExactKeys(deadzoneLabel, deadzone as unknown as Record<string, unknown>, [
      'turnRadiusMultiplier',
      'frontSliceDegrees',
    ]);
    const { turnRadiusMultiplier, frontSliceDegrees } = deadzone as {
      turnRadiusMultiplier: number;
      frontSliceDegrees: number;
    };
    if (!Number.isFinite(turnRadiusMultiplier) || turnRadiusMultiplier < 1) {
      throw new Error(
        `Invalid unitLocomotionConfig.json: ${deadzoneLabel}.turnRadiusMultiplier must be a finite number >= 1`,
      );
    }
    if (!Number.isFinite(frontSliceDegrees) || frontSliceDegrees <= 0 || frontSliceDegrees >= 90) {
      throw new Error(
        `Invalid unitLocomotionConfig.json: ${deadzoneLabel}.frontSliceDegrees must be in (0, 90) - at 90 the slice becomes the half-plane a powered orbit never leaves`,
      );
    }
  }
  if (
    preset.motionControl.maintainFullThrustAtWaypoints &&
    preset.motionControl.alwaysBrakeAtFinalWaypoint
  ) {
    throw new Error(
      `Invalid unitLocomotionConfig.json: presets.${presetId}.motionControl authors both maintainFullThrustAtWaypoints and alwaysBrakeAtFinalWaypoint`,
    );
  }
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
