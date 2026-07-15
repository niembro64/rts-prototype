import type {
  LocomotionNavigationPolicy,
  UnitLocomotionMediumPhysics,
} from '@/types/locomotionTypes';
import rawLocomotionConfig from './locomotionConfig.json';
import {
  LOCOMOTION_MEDIUM_NAVIGATION_VALUES,
  isLocomotionMediumNavigation,
} from './locomotionNavigation';
import {
  assertLocomotionBoolean,
  assertLocomotionNonNegativeFinite,
  assertLocomotionPositiveFinite,
  assertLocomotionUnitFraction,
} from './locomotionValidation';

export const LOCOMOTION_MEDIUM_NAMES = ['ground', 'air', 'water'] as const;
export type LocomotionMediumName = (typeof LOCOMOTION_MEDIUM_NAMES)[number];

export const LOCOMOTION_CONFIG_MEDIUM_FIELDS = [
  'driveForce',
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

type LocomotionConfigMediumField = (typeof LOCOMOTION_CONFIG_MEDIUM_FIELDS)[number];
export type LocomotionPresetMediumPhysics = Pick<
  UnitLocomotionMediumPhysics,
  LocomotionConfigMediumField
>;

export type LocomotionPresetConfig = {
  navigation: LocomotionNavigationPolicy;
  physics: {
    forwardForceRequiresFacing: boolean;
    driveForceScalesWithFacing: boolean;
    maintainFullThrustAtWaypoints: boolean;
    airLiftGroundProbeAheadDistance: number;
    airLiftGroundProbeAheadRadiusMultiplier: number;
    idleAirDrive: boolean;
  } & Record<LocomotionMediumName, LocomotionPresetMediumPhysics>;
};

type LocomotionConfig = {
  forceScale: number;
  airLiftHeightForceFalloff: { heightForceExponent: number };
  presets: Record<string, LocomotionPresetConfig>;
};

type RawLocomotionPresetConfig = {
  extends?: string;
  navigation?: Partial<LocomotionNavigationPolicy>;
  physics?: Partial<LocomotionPresetConfig['physics']> & {
    ground?: Partial<LocomotionPresetMediumPhysics>;
    air?: Partial<LocomotionPresetMediumPhysics>;
    water?: Partial<LocomotionPresetMediumPhysics>;
  };
};

function assertPresetMediumPhysics(
  presetId: string,
  medium: LocomotionMediumName,
  physics: LocomotionPresetMediumPhysics | undefined,
): asserts physics is LocomotionPresetMediumPhysics {
  if (!physics || typeof physics !== 'object') {
    throw new Error(
      `Invalid locomotionConfig.json: missing presets.${presetId}.physics.${medium} config`,
    );
  }
  for (const field of LOCOMOTION_CONFIG_MEDIUM_FIELDS) {
    const value = physics[field];
    if (field === 'heightUpwardForceRandomizationAmount' || field === 'heightUpwardForceEMA') {
      assertLocomotionUnitFraction(`presets.${presetId}.physics.${medium}.${field}`, value);
    } else {
      assertLocomotionNonNegativeFinite(`presets.${presetId}.physics.${medium}.${field}`, value);
    }
  }
}

function assertPreset(presetId: string, preset: LocomotionPresetConfig | undefined): void {
  if (!preset || typeof preset !== 'object') {
    throw new Error(`Invalid locomotionConfig.json: missing presets.${presetId} config`);
  }
  if (!preset.navigation || typeof preset.navigation !== 'object') {
    throw new Error(`Invalid locomotionConfig.json: missing presets.${presetId}.navigation config`);
  }
  if (!preset.physics || typeof preset.physics !== 'object') {
    throw new Error(`Invalid locomotionConfig.json: missing presets.${presetId}.physics config`);
  }
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
  assertLocomotionNonNegativeFinite(
    `presets.${presetId}.physics.airLiftGroundProbeAheadDistance`,
    preset.physics.airLiftGroundProbeAheadDistance,
  );
  assertLocomotionNonNegativeFinite(
    `presets.${presetId}.physics.airLiftGroundProbeAheadRadiusMultiplier`,
    preset.physics.airLiftGroundProbeAheadRadiusMultiplier,
  );
  assertLocomotionBoolean(`presets.${presetId}.physics.idleAirDrive`, preset.physics.idleAirDrive);
  for (const medium of LOCOMOTION_MEDIUM_NAMES) {
    assertPresetMediumPhysics(presetId, medium, preset.physics[medium]);
  }
}

function resolvePreset(
  presetId: string,
  rawPresets: Record<string, RawLocomotionPresetConfig>,
  resolved: Record<string, LocomotionPresetConfig>,
  resolving: Set<string>,
): LocomotionPresetConfig {
  const cached = resolved[presetId];
  if (cached !== undefined) return cached;
  const raw = rawPresets[presetId];
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid locomotionConfig.json: missing presets.${presetId} config`);
  }
  if (resolving.has(presetId)) {
    throw new Error(`Invalid locomotionConfig.json: circular preset inheritance at ${presetId}`);
  }
  resolving.add(presetId);
  let candidate: LocomotionPresetConfig;
  if (raw.extends === undefined) {
    candidate = raw as LocomotionPresetConfig;
  } else {
    const base = resolvePreset(raw.extends, rawPresets, resolved, resolving);
    candidate = {
      navigation: { ...base.navigation, ...raw.navigation },
      physics: {
        ...base.physics,
        ...raw.physics,
        ground: { ...base.physics.ground, ...raw.physics?.ground },
        air: { ...base.physics.air, ...raw.physics?.air },
        water: { ...base.physics.water, ...raw.physics?.water },
      },
    };
  }
  resolving.delete(presetId);
  assertPreset(presetId, candidate);
  resolved[presetId] = candidate;
  return candidate;
}

function readLocomotionConfig(): LocomotionConfig {
  const config = rawLocomotionConfig as unknown as {
    forceScale?: number;
    airLiftHeightForceFalloff?: { heightForceExponent?: number };
    presets?: Record<string, RawLocomotionPresetConfig>;
  };
  assertLocomotionPositiveFinite('forceScale', config.forceScale ?? NaN);
  const falloff = config.airLiftHeightForceFalloff;
  if (!falloff || typeof falloff !== 'object') {
    throw new Error('Invalid locomotionConfig.json: missing airLiftHeightForceFalloff config');
  }
  const exponent = falloff.heightForceExponent ?? NaN;
  if (!Number.isFinite(exponent) || exponent <= 0 || exponent > 1) {
    throw new Error(
      `Invalid locomotion airLiftHeightForceFalloff.heightForceExponent: expected finite in (0, 1], got ${exponent}`,
    );
  }
  const rawPresets = config.presets;
  if (!rawPresets || typeof rawPresets !== 'object') {
    throw new Error('Invalid locomotionConfig.json: missing presets table');
  }
  const presets: Record<string, LocomotionPresetConfig> = {};
  for (const presetId of Object.keys(rawPresets)) {
    resolvePreset(presetId, rawPresets, presets, new Set<string>());
  }
  return {
    forceScale: config.forceScale,
    airLiftHeightForceFalloff: { heightForceExponent: exponent },
    presets,
  } as LocomotionConfig;
}

const LOCOMOTION_CONFIG = readLocomotionConfig();

/** Global force scale shared by every locomotion profile. */
export const LOCOMOTION_FORCE_SCALE = LOCOMOTION_CONFIG.forceScale;

/** Power-law falloff for the air height-lift term. */
export const AIR_LIFT_HEIGHT_FORCE_EXPONENT =
  LOCOMOTION_CONFIG.airLiftHeightForceFalloff.heightForceExponent;

export function getLocomotionPreset(presetId: string): LocomotionPresetConfig {
  const preset = LOCOMOTION_CONFIG.presets[presetId];
  if (!preset) throw new Error(`Invalid locomotion physicsPresetId "${presetId}"`);
  return preset;
}
