import type {
  UnitLocomotionBlueprint,
} from '@/types/blueprints';
import type {
  UnitLocomotion,
  UnitLocomotionFluidPhysics,
  UnitLocomotionGroundPhysics,
  UnitLocomotionPhysics,
  UnitLocomotionType,
} from '@/types/unitLocomotionTypes';
import {
  getUnitLocomotionFluidResistance,
  getUnitLocomotionPreset,
  type UnitLocomotionPresetConfig,
} from './unitLocomotionPresetConfig';
import {
  assertUnitLocomotionClosedUnitFraction,
  assertUnitLocomotionNonNegativeFinite,
} from './unitLocomotionValidation';

const UNIT_LOCOMOTION_TYPES = [
  'wheels', 'treads', 'amphibious-treads', 'legs', 'flippers', 'hover', 'flying', 'submarine', 'dive',
] as const satisfies readonly UnitLocomotionType[];

export type UnitLocomotionTraversalCapabilities = Readonly<{
  allowOnGround: boolean;
  allowInWater: boolean;
  allowInAir: boolean;
}>;

/** Route permissions are authored with the physics preset, never inferred
 * from the renderer-facing locomotion mechanism. */
export function getUnitLocomotionTraversalCapabilities(
  locomotion: Pick<UnitLocomotion, 'navigation'>,
): UnitLocomotionTraversalCapabilities {
  return locomotion.navigation;
}

type AuthoredFluidPhysics = NonNullable<UnitLocomotionBlueprint['physics']['air']>;

function createRuntimeGroundPhysics(
  preset: UnitLocomotionPresetConfig,
): UnitLocomotionGroundPhysics {
  return { ...preset.actuator.ground };
}

function createRuntimeFluidPhysics(
  presetId: string,
  medium: 'air' | 'water',
  presetPhysics: UnitLocomotionPresetConfig['actuator']['air'],
  authored: AuthoredFluidPhysics | undefined,
): UnitLocomotionFluidPhysics {
  if (authored === undefined) {
    throw new Error(
      `Invalid unit locomotion ${presetId}.physics.${medium}: air and water lift objects must be explicitly authored`,
    );
  }
  for (const key of Object.keys(authored)) {
    if (key !== 'lift') {
      throw new Error(
        `Invalid unit locomotion ${presetId}.physics.${medium}.${key}: this belongs in the locomotion preset`,
      );
    }
  }
  const lift = authored.lift;
  const hasGroundSurfaceForce = Object.prototype.hasOwnProperty.call(
    lift,
    'surfaceFollowingForceFromGround',
  );
  const hasWaterSurfaceForce = Object.prototype.hasOwnProperty.call(
    lift,
    'surfaceFollowingForceFromWater',
  );
  const hasBuoyancyRatio = Object.prototype.hasOwnProperty.call(lift, 'buoyancyRatio');
  if (medium === 'air' && (!hasGroundSurfaceForce || !hasWaterSurfaceForce)) {
    throw new Error(
      `Invalid unit locomotion ${presetId}.physics.air.lift: air requires both ground and water surface-following forces`,
    );
  }
  if (medium === 'water' && hasWaterSurfaceForce) {
    throw new Error(
      `Invalid unit locomotion ${presetId}.physics.water.lift.surfaceFollowingForceFromWater: water support is sourced from the ground surface only`,
    );
  }
  if (medium === 'water' && !hasGroundSurfaceForce) {
    throw new Error(
      `Invalid unit locomotion ${presetId}.physics.water.lift: surfaceFollowingForceFromGround must be explicitly authored, using 0 when inactive`,
    );
  }
  if (!hasBuoyancyRatio) {
    throw new Error(
      `Invalid unit locomotion ${presetId}.physics.${medium}.lift: buoyancyRatio must be explicitly authored, using 0 when inactive`,
    );
  }
  const surfaceFollowingForceFromGround = lift.surfaceFollowingForceFromGround;
  const surfaceFollowingForceFromWater = lift.surfaceFollowingForceFromWater ?? 0;
  const buoyancyRatio = lift.buoyancyRatio;
  assertUnitLocomotionNonNegativeFinite(
    `${presetId}.physics.${medium}.lift.surfaceFollowingForceFromGround`,
    surfaceFollowingForceFromGround,
  );
  assertUnitLocomotionNonNegativeFinite(
    `${presetId}.physics.${medium}.lift.surfaceFollowingForceFromWater`,
    surfaceFollowingForceFromWater,
  );
  assertUnitLocomotionClosedUnitFraction(
    `${presetId}.physics.${medium}.lift.buoyancyRatio`,
    buoyancyRatio,
  );
  return {
    resistance: { ...getUnitLocomotionFluidResistance(presetPhysics.resistanceProfileId) },
    lift: {
      buoyancyRatio,
      surfaceFollowingForceFromGround,
      surfaceFollowingForceFromWater,
    },
  };
}

function createRuntimeLocomotionPhysics(
  presetId: string,
  preset: UnitLocomotionPresetConfig,
  authored: UnitLocomotionBlueprint['physics'],
): UnitLocomotionPhysics {
  if (!authored || typeof authored !== 'object') {
    throw new Error(`Invalid unit locomotion ${presetId}.physics: missing physics object`);
  }
  return {
    ground: createRuntimeGroundPhysics(preset),
    air: createRuntimeFluidPhysics(presetId, 'air', preset.actuator.air, authored.air),
    water: createRuntimeFluidPhysics(presetId, 'water', preset.actuator.water, authored.water),
  };
}

export function createUnitLocomotion(
  locomotion: UnitLocomotionBlueprint,
): UnitLocomotion {
  const { type, physicsPresetId, environmentalHazards } = locomotion;
  if (!(UNIT_LOCOMOTION_TYPES as readonly string[]).includes(type)) {
    throw new Error(`Invalid unit locomotion type "${String(type)}"`);
  }
  const preset = getUnitLocomotionPreset(physicsPresetId);
  const physics = createRuntimeLocomotionPhysics(physicsPresetId, preset, locomotion.physics);
  const runtime: UnitLocomotion = {
    type,
    physicsPresetId,
    physics,
    environmentalHazards: { ...environmentalHazards },
    actuator: {
      maxPropulsiveForce: preset.actuator.maxPropulsiveForce,
      propulsionAxis: preset.actuator.propulsionAxis,
    },
    motionControl: { ...preset.motionControl },
    surfaceFollowing: { ...preset.surfaceFollowing },
    navigation: {
      allowOnGround: preset.navigation.allowOnGround,
      allowInAir: preset.navigation.allowedFluidMedia.includes('air'),
      allowInWater: preset.navigation.allowedFluidMedia.includes('water'),
    },
  };
  assertUnitLocomotionClosedUnitFraction(
    `${physicsPresetId}.environmentalHazards.fatalSubmergedFraction`,
    environmentalHazards.fatalSubmergedFraction,
  );
  assertUnitLocomotionNonNegativeFinite(
    `${physicsPresetId}.environmentalHazards.fatalExposureSeconds`,
    environmentalHazards.fatalExposureSeconds,
  );
  return runtime;
}

function cloneGroundPhysics(physics: UnitLocomotionGroundPhysics): UnitLocomotionGroundPhysics {
  return { ...physics };
}

function cloneFluidPhysics(physics: UnitLocomotionFluidPhysics): UnitLocomotionFluidPhysics {
  return {
    resistance: { ...physics.resistance },
    lift: { ...physics.lift },
  };
}

export function cloneUnitLocomotion(
  locomotion: UnitLocomotion,
): UnitLocomotion {
  return {
    type: locomotion.type,
    physicsPresetId: locomotion.physicsPresetId,
    physics: {
      ground: cloneGroundPhysics(locomotion.physics.ground),
      air: cloneFluidPhysics(locomotion.physics.air),
      water: cloneFluidPhysics(locomotion.physics.water),
    },
    environmentalHazards: { ...locomotion.environmentalHazards },
    actuator: { ...locomotion.actuator },
    motionControl: { ...locomotion.motionControl },
    surfaceFollowing: { ...locomotion.surfaceFollowing },
    navigation: { ...locomotion.navigation },
  };
}
