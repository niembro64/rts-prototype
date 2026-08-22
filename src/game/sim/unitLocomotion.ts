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
import {
  assertExactObjectKeys,
  assertPlainObject,
} from '../../configValidation';

const UNIT_LOCOMOTION_TYPES = [
  'rover', 'tank', 'amphibious-tank', 'crawler', 'bot', 'amphibian', 'drone', 'plane', 'submarine', 'aerosub',
] as const satisfies readonly UnitLocomotionType[];

type UnitLocomotionTraversalCapabilities = Readonly<{
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
  const label = `${presetId}.physics.${medium}`;
  assertPlainObject(authored, `Invalid unit locomotion ${label}: missing object`);
  assertExactObjectKeys(
    authored,
    expectedFields,
    (key) => `Invalid unit locomotion ${label}.${key}`,
    (key) => `Invalid unit locomotion ${label}: missing ${key}`,
  );
}

function assertLiftFields(
  presetId: string,
  medium: 'air' | 'water',
  lift: Record<string, unknown>,
  expectedFields: readonly string[],
): void {
  const label = `${presetId}.physics.${medium}.lift`;
  assertExactObjectKeys(
    lift,
    expectedFields,
    (key) => `Invalid unit locomotion ${label}.${key}`,
    (key) => `Invalid unit locomotion ${label}: missing ${key}`,
  );
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
      turnRateDegreesPerSecond: preset.actuator.turnRateDegreesPerSecond,
    },
    motionControl: cloneMotionControl(preset.motionControl),
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

function cloneMotionControl(
  motionControl: UnitLocomotion['motionControl'],
): UnitLocomotion['motionControl'] {
  return {
    ...motionControl,
    waypointDeadzone: motionControl.waypointDeadzone === undefined
      ? undefined
      : { ...motionControl.waypointDeadzone },
  };
}

function cloneGroundPhysics(physics: UnitLocomotionGroundPhysics): UnitLocomotionGroundPhysics {
  return { ...physics };
}

function cloneFluidPhysics<Physics extends
  UnitLocomotionAirFluidPhysics | UnitLocomotionWaterFluidPhysics>(
  physics: Physics,
): Physics {
  return {
    ...physics,
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
    motionControl: cloneMotionControl(locomotion.motionControl),
    surfaceFollowing: { ...locomotion.surfaceFollowing },
    navigation: {
      waypoint: { ...locomotion.navigation.waypoint },
      move: { ...locomotion.navigation.move },
    },
  };
}
