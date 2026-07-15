import type {
  LocomotionNavigationPolicy,
  SurfaceProbeSetId,
  UnitLocomotionGroundPhysics,
  UnitLocomotionLiftPhysics,
  UnitLocomotionPropulsionPhysics,
  UnitLocomotionResistancePhysics,
} from '@/types/locomotionTypes';
import rawLocomotionConfig from './locomotionConfig.json';
import {
  LOCOMOTION_MEDIUM_NAVIGATION_VALUES,
  isLocomotionMediumNavigation,
} from './locomotionNavigation';
import {
  assertLocomotionBoolean,
  assertLocomotionClosedUnitFraction,
  assertLocomotionNonNegativeFinite,
  assertLocomotionPositiveFinite,
  assertLocomotionUnitFraction,
} from './locomotionValidation';
import { isSurfaceProbeSetId } from './surfaceProbeSets';
import {
  isSurfaceProbeAggregation,
  type SurfaceProbeAggregation,
} from './surfaceProbeAggregation';

export const LOCOMOTION_MEDIUM_NAMES = ['ground', 'air', 'water'] as const;
export type LocomotionMediumName = (typeof LOCOMOTION_MEDIUM_NAMES)[number];
export type LocomotionFluidMediumName = Exclude<LocomotionMediumName, 'ground'>;

export const LOCOMOTION_PROPULSION_FIELDS = ['driveForce', 'forceCoupling'] as const;
export const LOCOMOTION_FLUID_RESISTANCE_FIELDS = [
  'frictionMultiplier',
  'quadraticDrag',
  'directionalScale',
  'angularDrag',
] as const;
export const LOCOMOTION_SURFACE_LIFT_RESPONSE_FIELDS = ['randomizationAmount', 'ema'] as const;
export const LOCOMOTION_CONTACT_FIELDS = ['surfaceGrip', 'tangentDamping'] as const;

export type LocomotionPresetPropulsionPhysics = UnitLocomotionPropulsionPhysics;
export type LocomotionPresetGroundPhysics = UnitLocomotionGroundPhysics;

export type LocomotionPresetFluidPhysics = {
  propulsion: LocomotionPresetPropulsionPhysics;
  resistance: UnitLocomotionResistancePhysics;
  surfaceLiftResponse: Pick<UnitLocomotionLiftPhysics, 'randomizationAmount' | 'ema'>;
};

export type LocomotionPresetConfig = {
  navigation: LocomotionNavigationPolicy;
  physics: {
    forwardForceRequiresFacing: boolean;
    driveForceScalesWithFacing: boolean;
    maintainFullThrustAtWaypoints: boolean;
    surfaceProbeSetId: SurfaceProbeSetId;
    idleAirDrive: boolean;
    ground: LocomotionPresetGroundPhysics;
    air: LocomotionPresetFluidPhysics;
    water: LocomotionPresetFluidPhysics;
  };
};

type LocomotionMediumDefaults = Record<
  LocomotionMediumName,
  { resistance: { linearFriction: number } }
>;

type LocomotionConfig = {
  forceScale: number;
  surfaceLiftDefaults: {
    referenceDistanceWorld: number;
    minimumDistanceWorld: number;
    distanceExponent: number;
    probeAggregation: SurfaceProbeAggregation;
  };
  mediumDefaults: LocomotionMediumDefaults;
  presets: Record<string, LocomotionPresetConfig>;
};

function assertObject(
  label: string,
  value: unknown,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid locomotionConfig.json: missing ${label} object`);
  }
}

function assertExactKeys(
  label: string,
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const expectedSet = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) {
      throw new Error(`Invalid locomotionConfig.json: unexpected ${label}.${key}`);
    }
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`Invalid locomotionConfig.json: missing ${label}.${key}`);
    }
  }
}

function assertPropulsion(label: string, value: unknown): void {
  assertObject(label, value);
  assertExactKeys(label, value, LOCOMOTION_PROPULSION_FIELDS);
  assertLocomotionNonNegativeFinite(`${label}.driveForce`, value.driveForce as number);
  assertLocomotionNonNegativeFinite(`${label}.forceCoupling`, value.forceCoupling as number);
}

function assertFrictionMultiplier(label: string, value: unknown): void {
  assertObject(label, value);
  assertExactKeys(label, value, ['frictionMultiplier']);
  assertLocomotionClosedUnitFraction(
    `${label}.frictionMultiplier`,
    value.frictionMultiplier as number,
  );
}

function assertGroundPhysics(presetId: string, value: unknown): void {
  const label = `presets.${presetId}.physics.ground`;
  assertObject(label, value);
  assertExactKeys(label, value, ['propulsion', 'resistance', 'contact']);
  assertPropulsion(`${label}.propulsion`, value.propulsion);
  assertFrictionMultiplier(`${label}.resistance`, value.resistance);
  assertObject(`${label}.contact`, value.contact);
  assertExactKeys(`${label}.contact`, value.contact, LOCOMOTION_CONTACT_FIELDS);
  assertLocomotionNonNegativeFinite(
    `${label}.contact.surfaceGrip`,
    value.contact.surfaceGrip as number,
  );
  assertLocomotionNonNegativeFinite(
    `${label}.contact.tangentDamping`,
    value.contact.tangentDamping as number,
  );
}

function assertFluidPhysics(
  presetId: string,
  medium: LocomotionFluidMediumName,
  value: unknown,
): void {
  const label = `presets.${presetId}.physics.${medium}`;
  assertObject(label, value);
  assertExactKeys(label, value, ['propulsion', 'resistance', 'surfaceLiftResponse']);
  assertPropulsion(`${label}.propulsion`, value.propulsion);
  assertObject(`${label}.resistance`, value.resistance);
  assertExactKeys(`${label}.resistance`, value.resistance, LOCOMOTION_FLUID_RESISTANCE_FIELDS);
  assertLocomotionClosedUnitFraction(
    `${label}.resistance.frictionMultiplier`,
    value.resistance.frictionMultiplier as number,
  );
  assertLocomotionNonNegativeFinite(
    `${label}.resistance.quadraticDrag`,
    value.resistance.quadraticDrag as number,
  );
  assertLocomotionNonNegativeFinite(
    `${label}.resistance.angularDrag`,
    value.resistance.angularDrag as number,
  );
  assertObject(`${label}.resistance.directionalScale`, value.resistance.directionalScale);
  assertExactKeys(
    `${label}.resistance.directionalScale`,
    value.resistance.directionalScale,
    ['forward', 'lateral', 'vertical'],
  );
  for (const axis of ['forward', 'lateral', 'vertical'] as const) {
    assertLocomotionNonNegativeFinite(
      `${label}.resistance.directionalScale.${axis}`,
      value.resistance.directionalScale[axis] as number,
    );
  }
  assertObject(`${label}.surfaceLiftResponse`, value.surfaceLiftResponse);
  assertExactKeys(
    `${label}.surfaceLiftResponse`,
    value.surfaceLiftResponse,
    LOCOMOTION_SURFACE_LIFT_RESPONSE_FIELDS,
  );
  assertLocomotionUnitFraction(
    `${label}.surfaceLiftResponse.randomizationAmount`,
    value.surfaceLiftResponse.randomizationAmount as number,
  );
  assertLocomotionUnitFraction(
    `${label}.surfaceLiftResponse.ema`,
    value.surfaceLiftResponse.ema as number,
  );
}

function assertPreset(presetId: string, preset: LocomotionPresetConfig | undefined): void {
  if (!preset || typeof preset !== 'object') {
    throw new Error(`Invalid locomotionConfig.json: missing presets.${presetId} config`);
  }
  assertExactKeys(`presets.${presetId}`, preset as unknown as Record<string, unknown>, [
    'navigation',
    'physics',
  ]);
  assertObject(`presets.${presetId}.navigation`, preset.navigation);
  assertExactKeys(`presets.${presetId}.navigation`, preset.navigation, [
    'allowOnGround',
    'allowInMedium',
  ]);
  assertLocomotionBoolean(
    `presets.${presetId}.navigation.allowOnGround`,
    preset.navigation.allowOnGround,
  );
  if (!isLocomotionMediumNavigation(preset.navigation.allowInMedium)) {
    throw new Error(
      `Invalid locomotion presets.${presetId}.navigation.allowInMedium: expected ${
        LOCOMOTION_MEDIUM_NAVIGATION_VALUES.join(', ')
      }, got ${String(preset.navigation.allowInMedium)}`,
    );
  }
  assertObject(`presets.${presetId}.physics`, preset.physics);
  assertExactKeys(`presets.${presetId}.physics`, preset.physics, [
    'forwardForceRequiresFacing',
    'driveForceScalesWithFacing',
    'maintainFullThrustAtWaypoints',
    'surfaceProbeSetId',
    'idleAirDrive',
    'ground',
    'air',
    'water',
  ]);
  assertLocomotionBoolean(
    `presets.${presetId}.physics.forwardForceRequiresFacing`,
    preset.physics.forwardForceRequiresFacing,
  );
  assertLocomotionBoolean(
    `presets.${presetId}.physics.driveForceScalesWithFacing`,
    preset.physics.driveForceScalesWithFacing,
  );
  assertLocomotionBoolean(
    `presets.${presetId}.physics.maintainFullThrustAtWaypoints`,
    preset.physics.maintainFullThrustAtWaypoints,
  );
  if (!isSurfaceProbeSetId(preset.physics.surfaceProbeSetId)) {
    throw new Error(
      `Invalid locomotion presets.${presetId}.physics.surfaceProbeSetId: ${String(preset.physics.surfaceProbeSetId)}`,
    );
  }
  assertLocomotionBoolean(`presets.${presetId}.physics.idleAirDrive`, preset.physics.idleAirDrive);
  assertGroundPhysics(presetId, preset.physics.ground);
  assertFluidPhysics(presetId, 'air', preset.physics.air);
  assertFluidPhysics(presetId, 'water', preset.physics.water);
}

function readLocomotionConfig(): LocomotionConfig {
  const config = rawLocomotionConfig as unknown as Partial<LocomotionConfig>;
  assertExactKeys('root', config as Record<string, unknown>, [
    'forceScale',
    'surfaceLiftDefaults',
    'mediumDefaults',
    'presets',
  ]);
  assertLocomotionPositiveFinite('forceScale', config.forceScale ?? NaN);
  const surfaceLiftDefaults = config.surfaceLiftDefaults;
  if (!surfaceLiftDefaults || typeof surfaceLiftDefaults !== 'object') {
    throw new Error('Invalid locomotionConfig.json: missing surfaceLiftDefaults config');
  }
  assertExactKeys('surfaceLiftDefaults', surfaceLiftDefaults as Record<string, unknown>, [
    'referenceDistanceWorld',
    'minimumDistanceWorld',
    'distanceExponent',
    'probeAggregation',
  ]);
  assertLocomotionPositiveFinite(
    'surfaceLiftDefaults.referenceDistanceWorld',
    surfaceLiftDefaults.referenceDistanceWorld,
  );
  assertLocomotionPositiveFinite(
    'surfaceLiftDefaults.minimumDistanceWorld',
    surfaceLiftDefaults.minimumDistanceWorld,
  );
  const exponent = surfaceLiftDefaults.distanceExponent ?? NaN;
  if (!Number.isFinite(exponent) || exponent <= 0 || exponent > 1) {
    throw new Error(
      `Invalid locomotion surfaceLiftDefaults.distanceExponent: expected finite in (0, 1], got ${exponent}`,
    );
  }
  const probeAggregation = surfaceLiftDefaults.probeAggregation;
  if (!isSurfaceProbeAggregation(probeAggregation)) {
    throw new Error(
      'Invalid locomotion surfaceLiftDefaults.probeAggregation: expected average or max, ' +
      `got ${String(probeAggregation)}`,
    );
  }
  const mediumDefaults = config.mediumDefaults;
  assertObject('mediumDefaults', mediumDefaults);
  assertExactKeys('mediumDefaults', mediumDefaults, LOCOMOTION_MEDIUM_NAMES);
  for (const medium of LOCOMOTION_MEDIUM_NAMES) {
    const defaults = mediumDefaults[medium];
    assertObject(`mediumDefaults.${medium}`, defaults);
    assertExactKeys(`mediumDefaults.${medium}`, defaults, ['resistance']);
    assertObject(`mediumDefaults.${medium}.resistance`, defaults.resistance);
    assertExactKeys(`mediumDefaults.${medium}.resistance`, defaults.resistance, ['linearFriction']);
    assertLocomotionNonNegativeFinite(
      `mediumDefaults.${medium}.resistance.linearFriction`,
      defaults.resistance.linearFriction as number,
    );
  }
  const rawPresets = config.presets;
  assertObject('presets', rawPresets);
  const presets: Record<string, LocomotionPresetConfig> = {};
  for (const [presetId, preset] of Object.entries(rawPresets)) {
    assertPreset(presetId, preset);
    presets[presetId] = preset;
  }
  return {
    forceScale: config.forceScale!,
    surfaceLiftDefaults: {
      referenceDistanceWorld: surfaceLiftDefaults.referenceDistanceWorld,
      minimumDistanceWorld: surfaceLiftDefaults.minimumDistanceWorld,
      distanceExponent: exponent,
      probeAggregation,
    },
    mediumDefaults: mediumDefaults as LocomotionMediumDefaults,
    presets,
  };
}

const LOCOMOTION_CONFIG = readLocomotionConfig();

export const LOCOMOTION_FORCE_SCALE = LOCOMOTION_CONFIG.forceScale;
export const SURFACE_LIFT_REFERENCE_DISTANCE_WORLD =
  LOCOMOTION_CONFIG.surfaceLiftDefaults.referenceDistanceWorld;
export const SURFACE_LIFT_MINIMUM_DISTANCE_WORLD =
  LOCOMOTION_CONFIG.surfaceLiftDefaults.minimumDistanceWorld;
export const SURFACE_LIFT_DISTANCE_EXPONENT =
  LOCOMOTION_CONFIG.surfaceLiftDefaults.distanceExponent;
export const SURFACE_LIFT_PROBE_AGGREGATION =
  LOCOMOTION_CONFIG.surfaceLiftDefaults.probeAggregation;

export const LOCOMOTION_FRICTION_BY_MEDIUM: Readonly<Record<LocomotionMediumName, number>> =
  Object.freeze(Object.fromEntries(
    LOCOMOTION_MEDIUM_NAMES.map((medium) => [
      medium,
      LOCOMOTION_CONFIG.mediumDefaults[medium].resistance.linearFriction,
    ]),
  ) as Record<LocomotionMediumName, number>);

export function getLocomotionEffectiveFriction(
  medium: LocomotionMediumName,
  physics: { resistance: { frictionMultiplier: number } },
): number {
  return LOCOMOTION_FRICTION_BY_MEDIUM[medium] * physics.resistance.frictionMultiplier;
}

export function getLocomotionPreset(presetId: string): LocomotionPresetConfig {
  const preset = LOCOMOTION_CONFIG.presets[presetId];
  if (!preset) throw new Error(`Invalid locomotion physicsPresetId "${presetId}"`);
  return preset;
}
