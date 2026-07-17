import type {
  UnitLocomotionNavigationPolicy,
  SurfaceProbeSetId,
  UnitLocomotionGroundPhysics,
  UnitLocomotionLiftPhysics,
  UnitLocomotionPropulsionPhysics,
  UnitLocomotionResistancePhysics,
} from '@/types/unitLocomotionTypes';
import rawUnitLocomotionConfig from './unitLocomotionConfig.json';
import {
  UNIT_LOCOMOTION_MEDIUM_NAVIGATION_VALUES,
  isUnitLocomotionMediumNavigation,
} from './unitLocomotionNavigation';
import {
  assertUnitLocomotionBoolean,
  assertUnitLocomotionClosedUnitFraction,
  assertUnitLocomotionNonNegativeFinite,
  assertUnitLocomotionPositiveFinite,
  assertUnitLocomotionUnitFraction,
} from './unitLocomotionValidation';
import { isSurfaceProbeSetId } from './surfaceProbeSets';

export const UNIT_LOCOMOTION_MEDIUM_NAMES = ['ground', 'air', 'water'] as const;
export type UnitLocomotionMediumName = (typeof UNIT_LOCOMOTION_MEDIUM_NAMES)[number];
export type UnitLocomotionFluidMediumName = Exclude<UnitLocomotionMediumName, 'ground'>;

export const UNIT_LOCOMOTION_PROPULSION_FIELDS = ['driveForce', 'forceCoupling'] as const;
export const UNIT_LOCOMOTION_FLUID_RESISTANCE_FIELDS = [
  'frictionMultiplier',
  'quadraticDrag',
  'directionalScale',
  'angularDrag',
] as const;
export const UNIT_LOCOMOTION_SURFACE_LIFT_RESPONSE_FIELDS = ['randomizationAmount', 'ema'] as const;
export const UNIT_LOCOMOTION_CONTACT_FIELDS = ['surfaceGrip', 'tangentDamping'] as const;

export type UnitLocomotionPresetPropulsionPhysics = UnitLocomotionPropulsionPhysics;
export type UnitLocomotionPresetGroundPhysics = UnitLocomotionGroundPhysics;

export type UnitLocomotionPresetFluidPhysics = {
  propulsion: UnitLocomotionPresetPropulsionPhysics;
  resistance: UnitLocomotionResistancePhysics;
  surfaceLiftResponse: Pick<UnitLocomotionLiftPhysics, 'randomizationAmount' | 'ema'>;
};

export type UnitLocomotionPresetConfig = {
  navigation: UnitLocomotionNavigationPolicy;
  physics: {
    forwardForceRequiresFacing: boolean;
    driveForceScalesWithFacing: boolean;
    maintainFullThrustAtWaypoints: boolean;
    surfaceProbeSetId: SurfaceProbeSetId;
    idleAirDrive: boolean;
    ground: UnitLocomotionPresetGroundPhysics;
    air: UnitLocomotionPresetFluidPhysics;
    water: UnitLocomotionPresetFluidPhysics;
  };
};

type LocomotionMediumDefaults = Record<
  UnitLocomotionMediumName,
  { resistance: { linearFriction: number } }
>;

export const SURFACE_LIFT_PROBE_AGGREGATION_MODES = ['average', 'max'] as const;
export type SurfaceLiftProbeAggregationMode =
  (typeof SURFACE_LIFT_PROBE_AGGREGATION_MODES)[number];

type UnitLocomotionConfig = {
  forceScale: number;
  surfaceLiftDefaults: {
    minimumDistanceWorld: number;
    forceMultiplier: number;
    probeAggregation: SurfaceLiftProbeAggregationMode;
  };
  mediumDefaults: LocomotionMediumDefaults;
  presets: Record<string, UnitLocomotionPresetConfig>;
};

function assertObject(
  label: string,
  value: unknown,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid unitLocomotionConfig.json: missing ${label} object`);
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
      throw new Error(`Invalid unitLocomotionConfig.json: unexpected ${label}.${key}`);
    }
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`Invalid unitLocomotionConfig.json: missing ${label}.${key}`);
    }
  }
}

function isSurfaceLiftProbeAggregationMode(
  value: unknown,
): value is SurfaceLiftProbeAggregationMode {
  return typeof value === 'string' &&
    (SURFACE_LIFT_PROBE_AGGREGATION_MODES as readonly string[]).includes(value);
}

function assertPropulsion(label: string, value: unknown): void {
  assertObject(label, value);
  assertExactKeys(label, value, UNIT_LOCOMOTION_PROPULSION_FIELDS);
  assertUnitLocomotionNonNegativeFinite(`${label}.driveForce`, value.driveForce as number);
  assertUnitLocomotionNonNegativeFinite(`${label}.forceCoupling`, value.forceCoupling as number);
}

function assertFrictionMultiplier(label: string, value: unknown): void {
  assertObject(label, value);
  assertExactKeys(label, value, ['frictionMultiplier']);
  assertUnitLocomotionClosedUnitFraction(
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
  assertExactKeys(`${label}.contact`, value.contact, UNIT_LOCOMOTION_CONTACT_FIELDS);
  assertUnitLocomotionNonNegativeFinite(
    `${label}.contact.surfaceGrip`,
    value.contact.surfaceGrip as number,
  );
  assertUnitLocomotionNonNegativeFinite(
    `${label}.contact.tangentDamping`,
    value.contact.tangentDamping as number,
  );
}

function assertFluidPhysics(
  presetId: string,
  medium: UnitLocomotionFluidMediumName,
  value: unknown,
): void {
  const label = `presets.${presetId}.physics.${medium}`;
  assertObject(label, value);
  assertExactKeys(label, value, ['propulsion', 'resistance', 'surfaceLiftResponse']);
  assertPropulsion(`${label}.propulsion`, value.propulsion);
  assertObject(`${label}.resistance`, value.resistance);
  assertExactKeys(`${label}.resistance`, value.resistance, UNIT_LOCOMOTION_FLUID_RESISTANCE_FIELDS);
  assertUnitLocomotionClosedUnitFraction(
    `${label}.resistance.frictionMultiplier`,
    value.resistance.frictionMultiplier as number,
  );
  assertUnitLocomotionNonNegativeFinite(
    `${label}.resistance.quadraticDrag`,
    value.resistance.quadraticDrag as number,
  );
  assertUnitLocomotionNonNegativeFinite(
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
    assertUnitLocomotionNonNegativeFinite(
      `${label}.resistance.directionalScale.${axis}`,
      value.resistance.directionalScale[axis] as number,
    );
  }
  assertObject(`${label}.surfaceLiftResponse`, value.surfaceLiftResponse);
  assertExactKeys(
    `${label}.surfaceLiftResponse`,
    value.surfaceLiftResponse,
    UNIT_LOCOMOTION_SURFACE_LIFT_RESPONSE_FIELDS,
  );
  assertUnitLocomotionUnitFraction(
    `${label}.surfaceLiftResponse.randomizationAmount`,
    value.surfaceLiftResponse.randomizationAmount as number,
  );
  assertUnitLocomotionUnitFraction(
    `${label}.surfaceLiftResponse.ema`,
    value.surfaceLiftResponse.ema as number,
  );
}

function assertPreset(presetId: string, preset: UnitLocomotionPresetConfig | undefined): void {
  if (!preset || typeof preset !== 'object') {
    throw new Error(`Invalid unitLocomotionConfig.json: missing presets.${presetId} config`);
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
  assertUnitLocomotionBoolean(
    `presets.${presetId}.navigation.allowOnGround`,
    preset.navigation.allowOnGround,
  );
  if (!isUnitLocomotionMediumNavigation(preset.navigation.allowInMedium)) {
    throw new Error(
      `Invalid unit locomotion presets.${presetId}.navigation.allowInMedium: expected ${
        UNIT_LOCOMOTION_MEDIUM_NAVIGATION_VALUES.join(', ')
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
  assertUnitLocomotionBoolean(
    `presets.${presetId}.physics.forwardForceRequiresFacing`,
    preset.physics.forwardForceRequiresFacing,
  );
  assertUnitLocomotionBoolean(
    `presets.${presetId}.physics.driveForceScalesWithFacing`,
    preset.physics.driveForceScalesWithFacing,
  );
  assertUnitLocomotionBoolean(
    `presets.${presetId}.physics.maintainFullThrustAtWaypoints`,
    preset.physics.maintainFullThrustAtWaypoints,
  );
  if (!isSurfaceProbeSetId(preset.physics.surfaceProbeSetId)) {
    throw new Error(
      `Invalid unit locomotion presets.${presetId}.physics.surfaceProbeSetId: ${String(preset.physics.surfaceProbeSetId)}`,
    );
  }
  assertUnitLocomotionBoolean(`presets.${presetId}.physics.idleAirDrive`, preset.physics.idleAirDrive);
  assertGroundPhysics(presetId, preset.physics.ground);
  assertFluidPhysics(presetId, 'air', preset.physics.air);
  assertFluidPhysics(presetId, 'water', preset.physics.water);
}

function readUnitLocomotionConfig(): UnitLocomotionConfig {
  const config = rawUnitLocomotionConfig as unknown as Partial<UnitLocomotionConfig>;
  assertExactKeys('root', config as Record<string, unknown>, [
    'forceScale',
    'surfaceLiftDefaults',
    'mediumDefaults',
    'presets',
  ]);
  assertUnitLocomotionPositiveFinite('forceScale', config.forceScale ?? NaN);
  const surfaceLiftDefaults = config.surfaceLiftDefaults;
  if (!surfaceLiftDefaults || typeof surfaceLiftDefaults !== 'object') {
    throw new Error('Invalid unitLocomotionConfig.json: missing surfaceLiftDefaults config');
  }
  assertExactKeys('surfaceLiftDefaults', surfaceLiftDefaults as Record<string, unknown>, [
    'minimumDistanceWorld',
    'forceMultiplier',
    'probeAggregation',
  ]);
  assertUnitLocomotionPositiveFinite(
    'surfaceLiftDefaults.minimumDistanceWorld',
    surfaceLiftDefaults.minimumDistanceWorld,
  );
  assertUnitLocomotionPositiveFinite(
    'surfaceLiftDefaults.forceMultiplier',
    surfaceLiftDefaults.forceMultiplier,
  );
  const probeAggregation = surfaceLiftDefaults.probeAggregation;
  if (!isSurfaceLiftProbeAggregationMode(probeAggregation)) {
    throw new Error(
      'Invalid unit locomotion surfaceLiftDefaults.probeAggregation: expected ' +
        `${SURFACE_LIFT_PROBE_AGGREGATION_MODES.join(', ')}, got ${String(probeAggregation)}`,
    );
  }
  const mediumDefaults = config.mediumDefaults;
  assertObject('mediumDefaults', mediumDefaults);
  assertExactKeys('mediumDefaults', mediumDefaults, UNIT_LOCOMOTION_MEDIUM_NAMES);
  for (const medium of UNIT_LOCOMOTION_MEDIUM_NAMES) {
    const defaults = mediumDefaults[medium];
    assertObject(`mediumDefaults.${medium}`, defaults);
    assertExactKeys(`mediumDefaults.${medium}`, defaults, ['resistance']);
    assertObject(`mediumDefaults.${medium}.resistance`, defaults.resistance);
    assertExactKeys(`mediumDefaults.${medium}.resistance`, defaults.resistance, ['linearFriction']);
    assertUnitLocomotionNonNegativeFinite(
      `mediumDefaults.${medium}.resistance.linearFriction`,
      defaults.resistance.linearFriction as number,
    );
  }
  const rawPresets = config.presets;
  assertObject('presets', rawPresets);
  const presets: Record<string, UnitLocomotionPresetConfig> = {};
  for (const [presetId, preset] of Object.entries(rawPresets)) {
    assertPreset(presetId, preset);
    presets[presetId] = preset;
  }
  return {
    forceScale: config.forceScale!,
    surfaceLiftDefaults: {
      minimumDistanceWorld: surfaceLiftDefaults.minimumDistanceWorld,
      forceMultiplier: surfaceLiftDefaults.forceMultiplier,
      probeAggregation,
    },
    mediumDefaults: mediumDefaults as LocomotionMediumDefaults,
    presets,
  };
}

const UNIT_LOCOMOTION_CONFIG = readUnitLocomotionConfig();

export const UNIT_LOCOMOTION_FORCE_SCALE = UNIT_LOCOMOTION_CONFIG.forceScale;
export const SURFACE_LIFT_MINIMUM_DISTANCE_WORLD =
  UNIT_LOCOMOTION_CONFIG.surfaceLiftDefaults.minimumDistanceWorld;
export const SURFACE_LIFT_FORCE_MULTIPLIER =
  UNIT_LOCOMOTION_CONFIG.surfaceLiftDefaults.forceMultiplier;
export const SURFACE_LIFT_PROBE_AGGREGATION_MODE =
  UNIT_LOCOMOTION_CONFIG.surfaceLiftDefaults.probeAggregation;

export const UNIT_LOCOMOTION_FRICTION_BY_MEDIUM: Readonly<Record<UnitLocomotionMediumName, number>> =
  Object.freeze(Object.fromEntries(
    UNIT_LOCOMOTION_MEDIUM_NAMES.map((medium) => [
      medium,
      UNIT_LOCOMOTION_CONFIG.mediumDefaults[medium].resistance.linearFriction,
    ]),
  ) as Record<UnitLocomotionMediumName, number>);

export function getUnitLocomotionEffectiveFriction(
  medium: UnitLocomotionMediumName,
  physics: { resistance: { frictionMultiplier: number } },
): number {
  return UNIT_LOCOMOTION_FRICTION_BY_MEDIUM[medium] * physics.resistance.frictionMultiplier;
}

export function getUnitLocomotionPreset(presetId: string): UnitLocomotionPresetConfig {
  const preset = UNIT_LOCOMOTION_CONFIG.presets[presetId];
  if (!preset) throw new Error(`Invalid unit locomotion physicsPresetId "${presetId}"`);
  return preset;
}
