import type {
  UnitLocomotionBlueprint,
} from '@/types/blueprints';
import type {
  UnitLocomotion,
  UnitLocomotionAirFluidPhysics,
  UnitLocomotionGroundPhysics,
  UnitLocomotionPhysics,
  UnitLocomotionType,
  UnitLocomotionWaterFluidPhysics,
} from '@/types/unitLocomotionTypes';
import {
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

type AuthoredAirFluidPhysics = UnitLocomotionBlueprint['physics']['air'];
type AuthoredWaterFluidPhysics = UnitLocomotionBlueprint['physics']['water'];

function createRuntimeGroundPhysics(
  preset: UnitLocomotionPresetConfig,
): UnitLocomotionGroundPhysics {
  return { ...preset.actuator.ground };
}

function assertAuthoredLiftKeys(
  presetId: string,
  medium: 'air' | 'water',
  authored: AuthoredAirFluidPhysics | AuthoredWaterFluidPhysics,
): void {
  for (const key of Object.keys(authored)) {
    if (key !== 'lift') {
      throw new Error(
        `Invalid unit locomotion ${presetId}.physics.${medium}.${key}: this belongs in the locomotion preset`,
      );
    }
  }
}

function assertLiftFields(
  presetId: string,
  medium: 'air' | 'water',
  lift: Record<string, unknown>,
  expectedFields: readonly string[],
): void {
  for (const field of Object.keys(lift)) {
    if (!expectedFields.includes(field)) {
      throw new Error(`Invalid unit locomotion ${presetId}.physics.${medium}.lift.${field}`);
    }
  }
  for (const field of expectedFields) {
    if (!Object.prototype.hasOwnProperty.call(lift, field)) {
      throw new Error(`Invalid unit locomotion ${presetId}.physics.${medium}.lift: missing ${field}`);
    }
  }
}

function createRuntimeAirFluidPhysics(
  presetId: string,
  presetPhysics: UnitLocomotionPresetConfig['actuator']['air'],
  authored: AuthoredAirFluidPhysics,
): UnitLocomotionAirFluidPhysics {
  assertAuthoredLiftKeys(presetId, 'air', authored);
  assertLiftFields(
    presetId,
    'air',
    authored.lift as unknown as Record<string, unknown>,
    ['surfaceFollowingInverseForceFromGround', 'surfaceFollowingInverseForceFromWater'],
  );
  const {
    surfaceFollowingInverseForceFromGround,
    surfaceFollowingInverseForceFromWater,
  } = authored.lift;
  assertUnitLocomotionNonNegativeFinite(
    `${presetId}.physics.air.lift.surfaceFollowingInverseForceFromGround`,
    surfaceFollowingInverseForceFromGround,
  );
  assertUnitLocomotionNonNegativeFinite(
    `${presetId}.physics.air.lift.surfaceFollowingInverseForceFromWater`,
    surfaceFollowingInverseForceFromWater,
  );
  return {
    maxPropulsiveForce: presetPhysics.maxPropulsiveForce,
    resistance: {
      linearDampingRate: presetPhysics.linearDampingRate,
      angularDampingRate: presetPhysics.angularDampingRate,
    },
    lift: {
      surfaceFollowingInverseForceFromGround,
      surfaceFollowingInverseForceFromWater,
    },
  };
}

function createRuntimeWaterFluidPhysics(
  presetId: string,
  presetPhysics: UnitLocomotionPresetConfig['actuator']['water'],
  authored: AuthoredWaterFluidPhysics,
): UnitLocomotionWaterFluidPhysics {
  assertAuthoredLiftKeys(presetId, 'water', authored);
  assertLiftFields(
    presetId,
    'water',
    authored.lift as unknown as Record<string, unknown>,
    ['surfaceFollowingInverseForceFromGround', 'surfaceFollowingProportionalForceFromWater'],
  );
  const {
    surfaceFollowingInverseForceFromGround,
    surfaceFollowingProportionalForceFromWater,
  } = authored.lift;
  assertUnitLocomotionNonNegativeFinite(
    `${presetId}.physics.water.lift.surfaceFollowingInverseForceFromGround`,
    surfaceFollowingInverseForceFromGround,
  );
  assertUnitLocomotionNonNegativeFinite(
    `${presetId}.physics.water.lift.surfaceFollowingProportionalForceFromWater`,
    surfaceFollowingProportionalForceFromWater,
  );
  return {
    maxPropulsiveForce: presetPhysics.maxPropulsiveForce,
    resistance: {
      linearDampingRate: presetPhysics.linearDampingRate,
      angularDampingRate: presetPhysics.angularDampingRate,
    },
    lift: {
      surfaceFollowingInverseForceFromGround,
      surfaceFollowingProportionalForceFromWater,
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
    air: createRuntimeAirFluidPhysics(presetId, preset.actuator.air, authored.air),
    water: createRuntimeWaterFluidPhysics(presetId, preset.actuator.water, authored.water),
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

function cloneAirFluidPhysics(
  physics: UnitLocomotionAirFluidPhysics,
): UnitLocomotionAirFluidPhysics {
  return {
    maxPropulsiveForce: physics.maxPropulsiveForce,
    resistance: { ...physics.resistance },
    lift: { ...physics.lift },
  };
}

function cloneWaterFluidPhysics(
  physics: UnitLocomotionWaterFluidPhysics,
): UnitLocomotionWaterFluidPhysics {
  return {
    maxPropulsiveForce: physics.maxPropulsiveForce,
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
      air: cloneAirFluidPhysics(locomotion.physics.air),
      water: cloneWaterFluidPhysics(locomotion.physics.water),
    },
    environmentalHazards: { ...locomotion.environmentalHazards },
    actuator: { ...locomotion.actuator },
    motionControl: { ...locomotion.motionControl },
    surfaceFollowing: { ...locomotion.surfaceFollowing },
    navigation: { ...locomotion.navigation },
  };
}
