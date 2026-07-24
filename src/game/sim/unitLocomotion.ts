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
  assertUnitLocomotionNonNegativeFinite,
} from './unitLocomotionValidation';

const UNIT_LOCOMOTION_TYPES = [
  'wheels', 'treads', 'amphibious-treads', 'legs', 'flippers', 'hover', 'flying', 'submarine', 'dive',
] as const satisfies readonly UnitLocomotionType[];

export type UnitLocomotionTraversalCapabilities = Readonly<{
  waypoint: UnitLocomotion['navigation']['waypoint'];
  move: UnitLocomotion['navigation']['move'];
}>;

/** Route permissions are authored with the physics preset, never inferred
 * from the renderer-facing locomotion mechanism. */
export function getUnitLocomotionTraversalCapabilities(
  locomotion: Pick<UnitLocomotion, 'navigation'>,
): UnitLocomotionTraversalCapabilities {
  return locomotion.navigation;
}

function canPropel(force: number): boolean {
  return Number.isFinite(force) && force > 0;
}

type AuthoredAirFluidPhysics = UnitLocomotionBlueprint['physics']['air'];
type AuthoredWaterFluidPhysics = UnitLocomotionBlueprint['physics']['water'];
type AuthoredGroundPhysics = UnitLocomotionBlueprint['physics']['ground'];

function createRuntimeGroundPhysics(
  presetId: string,
  presetPhysics: UnitLocomotionPresetConfig['actuator']['ground'],
  authored: AuthoredGroundPhysics,
): UnitLocomotionGroundPhysics {
  assertAuthoredPhysicsKeys(presetId, 'ground', authored, ['maxPropulsiveForce']);
  assertUnitLocomotionNonNegativeFinite(
    `${presetId}.physics.ground.maxPropulsiveForce`,
    authored.maxPropulsiveForce,
  );
  return {
    maxPropulsiveForce: authored.maxPropulsiveForce,
    ...presetPhysics,
  };
}

function assertAuthoredPhysicsKeys(
  presetId: string,
  medium: 'ground' | 'air' | 'water',
  authored: AuthoredGroundPhysics | AuthoredAirFluidPhysics | AuthoredWaterFluidPhysics,
  expectedFields: readonly string[],
): void {
  if (!authored || typeof authored !== 'object') {
    throw new Error(`Invalid unit locomotion ${presetId}.physics.${medium}: missing object`);
  }
  for (const key of Object.keys(authored)) {
    if (!expectedFields.includes(key)) {
      throw new Error(
        `Invalid unit locomotion ${presetId}.physics.${medium}.${key}`,
      );
    }
  }
  for (const field of expectedFields) {
    if (!Object.prototype.hasOwnProperty.call(authored, field)) {
      throw new Error(`Invalid unit locomotion ${presetId}.physics.${medium}: missing ${field}`);
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
  assertAuthoredPhysicsKeys(presetId, 'air', authored, ['maxPropulsiveForce', 'lift']);
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
    `${presetId}.physics.air.maxPropulsiveForce`,
    authored.maxPropulsiveForce,
  );
  assertUnitLocomotionNonNegativeFinite(
    `${presetId}.physics.air.lift.surfaceFollowingInverseForceFromGround`,
    surfaceFollowingInverseForceFromGround,
  );
  assertUnitLocomotionNonNegativeFinite(
    `${presetId}.physics.air.lift.surfaceFollowingInverseForceFromWater`,
    surfaceFollowingInverseForceFromWater,
  );
  return {
    maxPropulsiveForce: authored.maxPropulsiveForce,
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
  assertAuthoredPhysicsKeys(presetId, 'water', authored, ['maxPropulsiveForce', 'lift']);
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
    `${presetId}.physics.water.maxPropulsiveForce`,
    authored.maxPropulsiveForce,
  );
  assertUnitLocomotionNonNegativeFinite(
    `${presetId}.physics.water.lift.surfaceFollowingInverseForceFromGround`,
    surfaceFollowingInverseForceFromGround,
  );
  assertUnitLocomotionNonNegativeFinite(
    `${presetId}.physics.water.lift.surfaceFollowingProportionalForceFromWater`,
    surfaceFollowingProportionalForceFromWater,
  );
  return {
    maxPropulsiveForce: authored.maxPropulsiveForce,
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
    ground: createRuntimeGroundPhysics(presetId, preset.actuator.ground, authored.ground),
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
      waypoint: {
        allowOnGround: preset.navigation.allowOnGround,
        allowInAir: preset.navigation.allowedFluidMedia.includes('air'),
        allowInWater: preset.navigation.allowedFluidMedia.includes('water'),
      },
      move: {
        allowOnGround: canPropel(physics.ground.maxPropulsiveForce),
        allowInAir: canPropel(physics.air.maxPropulsiveForce),
        allowInWater: canPropel(physics.water.maxPropulsiveForce),
      },
    },
  };
  assertUnitLocomotionNonNegativeFinite(
    `${physicsPresetId}.environmentalHazards.waterDamagePerSecond`,
    environmentalHazards.waterDamagePerSecond,
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
    navigation: {
      waypoint: { ...locomotion.navigation.waypoint },
      move: { ...locomotion.navigation.move },
    },
  };
}
