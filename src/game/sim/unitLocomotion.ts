import type {
  UnitLocomotionBlueprint,
} from '@/types/blueprints';
import type {
  UnitLocomotion,
  UnitLocomotionFluidPhysics,
  UnitLocomotionGroundPhysics,
  UnitLocomotionMediumPhysics,
  UnitLocomotionPhysics,
  UnitLocomotionType,
} from '@/types/unitLocomotionTypes';
import {
  UNIT_LOCOMOTION_MEDIUM_NAMES,
  getUnitLocomotionPreset,
  type UnitLocomotionPresetConfig,
} from './unitLocomotionPresetConfig';
import {
  assertUnitLocomotionClosedUnitFraction,
  assertUnitLocomotionNonNegativeFinite,
  assertUnitLocomotionPositiveFinite,
} from './unitLocomotionValidation';

// Locomotion types are authoritative for route permissions. Physics presets
// remain independent expanded movement profiles.
const UNIT_LOCOMOTION_TYPES = [
  'wheels', 'treads', 'amphibious-treads', 'legs', 'flippers', 'hover', 'flying', 'submarine', 'dive',
] as const satisfies readonly UnitLocomotionType[];

export type UnitLocomotionTraversalCapabilities = Readonly<{
  allowOnGround: boolean;
  allowInWater: boolean;
  allowInAir: boolean;
}>;

const UNIT_LOCOMOTION_TRAVERSAL_CAPABILITIES: Record<
  UnitLocomotionType,
  UnitLocomotionTraversalCapabilities
> = {
  wheels: { allowOnGround: true, allowInWater: false, allowInAir: false },
  treads: { allowOnGround: true, allowInWater: false, allowInAir: false },
  'amphibious-treads': { allowOnGround: true, allowInWater: true, allowInAir: false },
  legs: { allowOnGround: true, allowInWater: false, allowInAir: false },
  flippers: { allowOnGround: true, allowInWater: true, allowInAir: false },
  hover: { allowOnGround: false, allowInWater: false, allowInAir: true },
  flying: { allowOnGround: false, allowInWater: false, allowInAir: true },
  submarine: { allowOnGround: false, allowInWater: true, allowInAir: false },
  dive: { allowOnGround: false, allowInWater: true, allowInAir: true },
};

/** Convert the unit's one locomotion concept to the traversal ABI flags. */
export function getUnitLocomotionTraversalCapabilities(
  type: UnitLocomotionType,
): UnitLocomotionTraversalCapabilities {
  return UNIT_LOCOMOTION_TRAVERSAL_CAPABILITIES[type];
}
type AuthoredFluidPhysics = NonNullable<UnitLocomotionBlueprint['physics']['air']>;

function createRuntimeGroundPhysics(
  preset: UnitLocomotionPresetConfig,
): UnitLocomotionGroundPhysics {
  const authored = preset.physics.ground;
  return {
    propulsion: { ...authored.propulsion },
    resistance: { ...authored.resistance },
    contact: { ...authored.contact },
  };
}

function createRuntimeFluidPhysics(
  presetId: string,
  medium: 'air' | 'water',
  presetPhysics: UnitLocomotionPresetConfig['physics']['air'],
  authored: AuthoredFluidPhysics | undefined,
): UnitLocomotionFluidPhysics {
  if (authored === undefined) {
    throw new Error(
      `Invalid unit locomotion ${presetId}.physics.${medium}: ` +
      'air and water lift objects must always be explicitly authored',
    );
  }
  for (const key of Object.keys(authored)) {
    if (key !== 'lift') {
      throw new Error(
        `Invalid unit locomotion ${presetId}.physics.${medium}.${key}: moved to unitLocomotionConfig.json`,
      );
    }
  }
  const authoredLift = authored?.lift;
  const hasGroundLift = authoredLift !== undefined &&
    Object.prototype.hasOwnProperty.call(authoredLift, 'liftForceFromGroundSurface');
  const hasWaterSurfaceLift = authoredLift !== undefined &&
    Object.prototype.hasOwnProperty.call(authoredLift, 'liftForceFromWaterSurface');
  const hasGravityCounter = authoredLift !== undefined &&
    Object.prototype.hasOwnProperty.call(authoredLift, 'gravityCounterRatio');
  if (medium === 'air' && (!hasGroundLift || !hasWaterSurfaceLift)) {
    throw new Error(
      `Invalid unit locomotion ${presetId}.physics.air.lift: air lift must explicitly author both ` +
      'liftForceFromGroundSurface and liftForceFromWaterSurface',
    );
  }
  if (medium === 'water' && hasWaterSurfaceLift) {
    throw new Error(
      `Invalid unit locomotion ${presetId}.physics.water.lift.liftForceFromWaterSurface: ` +
      'water lift may only be sourced from the ground surface',
    );
  }
  if (medium === 'water' && !hasGroundLift) {
    throw new Error(
      `Invalid unit locomotion ${presetId}.physics.water.lift: ` +
      'liftForceFromGroundSurface must always be explicitly authored, using 0 when inactive',
    );
  }
  if (!hasGravityCounter) {
    throw new Error(
      `Invalid unit locomotion ${presetId}.physics.${medium}.lift: ` +
      'gravityCounterRatio must always be explicitly authored, using 0 when inactive',
    );
  }
  const liftForceFromGroundSurface = authoredLift?.liftForceFromGroundSurface ?? 0;
  assertUnitLocomotionNonNegativeFinite(
    `${presetId}.physics.${medium}.liftForceFromGroundSurface`,
    liftForceFromGroundSurface,
  );
  const liftForceFromWaterSurface = authoredLift?.liftForceFromWaterSurface ?? 0;
  assertUnitLocomotionNonNegativeFinite(
    `${presetId}.physics.${medium}.liftForceFromWaterSurface`,
    liftForceFromWaterSurface,
  );
  const gravityCounterRatio = authoredLift?.gravityCounterRatio ?? 0;
  assertUnitLocomotionClosedUnitFraction(
    `${presetId}.physics.${medium}.gravityCounterRatio`,
    gravityCounterRatio,
  );
  return {
    propulsion: { ...presetPhysics.propulsion },
    resistance: {
      ...presetPhysics.resistance,
      directionalScale: { ...presetPhysics.resistance.directionalScale },
    },
    lift: {
      gravityCounterRatio,
      liftForceFromGroundSurface,
      liftForceFromWaterSurface,
      randomizationAmount: presetPhysics.surfaceLiftResponse.randomizationAmount,
      ema: presetPhysics.surfaceLiftResponse.ema,
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
    air: createRuntimeFluidPhysics(presetId, 'air', preset.physics.air, authored.air),
    water: createRuntimeFluidPhysics(presetId, 'water', preset.physics.water, authored.water),
  };
}

export function createUnitLocomotion(
  locomotion: UnitLocomotionBlueprint,
): UnitLocomotion {
  const { type, physicsPresetId, survival } = locomotion;
  if (!(UNIT_LOCOMOTION_TYPES as readonly string[]).includes(type)) {
    throw new Error(`Invalid unit locomotion type "${String(type)}"`);
  }
  const preset = getUnitLocomotionPreset(physicsPresetId);
  const physics = createRuntimeLocomotionPhysics(physicsPresetId, preset, locomotion.physics);
  const runtime: UnitLocomotion = {
    type,
    physicsPresetId,
    physics,
    survival: { ...survival },
    idleAirDrive: preset.physics.idleAirDrive,
    forwardForceRequiresFacing: preset.physics.forwardForceRequiresFacing,
    driveForceScalesWithFacing: preset.physics.driveForceScalesWithFacing,
    maintainFullThrustAtWaypoints: preset.physics.maintainFullThrustAtWaypoints,
    surfaceProbeSetId: preset.physics.surfaceProbeSetId,
  };
  assertUnitLocomotionClosedUnitFraction(
    `${physicsPresetId}.survival.fatalSubmergedFraction`,
    survival.fatalSubmergedFraction,
  );
  assertUnitLocomotionNonNegativeFinite(
    `${physicsPresetId}.survival.fatalExposureSeconds`,
    survival.fatalExposureSeconds,
  );
  return runtime;
}

function cloneGroundPhysics(physics: UnitLocomotionGroundPhysics): UnitLocomotionGroundPhysics {
  return {
    propulsion: { ...physics.propulsion },
    resistance: { ...physics.resistance },
    contact: { ...physics.contact },
  };
}

function cloneFluidPhysics(physics: UnitLocomotionFluidPhysics): UnitLocomotionFluidPhysics {
  return {
    propulsion: { ...physics.propulsion },
    resistance: {
      ...physics.resistance,
      directionalScale: { ...physics.resistance.directionalScale },
    },
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
    survival: { ...locomotion.survival },
    idleAirDrive: locomotion.idleAirDrive,
    forwardForceRequiresFacing: locomotion.forwardForceRequiresFacing,
    driveForceScalesWithFacing: locomotion.driveForceScalesWithFacing,
    maintainFullThrustAtWaypoints: locomotion.maintainFullThrustAtWaypoints,
    surfaceProbeSetId: locomotion.surfaceProbeSetId,
  };
}

export function getUnitLocomotionPrimaryDrivePhysics(
  locomotion: UnitLocomotion,
): UnitLocomotionMediumPhysics {
  const scores = [
    locomotion.physics.ground,
    locomotion.physics.air,
    locomotion.physics.water,
  ] as const;
  let primary: UnitLocomotionMediumPhysics = scores[0];
  let primaryScore = primary.propulsion.driveForce * primary.propulsion.forceCoupling;
  for (let i = 1; i < scores.length; i++) {
    const candidate = scores[i];
    const score = candidate.propulsion.driveForce * candidate.propulsion.forceCoupling;
    if (score > primaryScore) {
      primary = candidate;
      primaryScore = score;
    }
  }
  return primary;
}

export function getUnitLocomotionGroundDrivePhysics(
  locomotion: UnitLocomotion,
): UnitLocomotionMediumPhysics {
  return locomotion.physics.ground;
}

export function getUnitLocomotionBestDrivePhysics(
  locomotion: UnitLocomotion,
): UnitLocomotionMediumPhysics {
  let best = getUnitLocomotionPrimaryDrivePhysics(locomotion);
  let bestScore = best.propulsion.driveForce * best.propulsion.forceCoupling;
  for (const medium of UNIT_LOCOMOTION_MEDIUM_NAMES) {
    const candidate = locomotion.physics[medium];
    const score = candidate.propulsion.driveForce * candidate.propulsion.forceCoupling;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

type LocomotionForceProfile = {
  rawDriveForce: number;
  coupledDriveForce: number;
  rawForceMagnitude: number;
  coupledForceMagnitude: number;
};

export function getUnitLocomotionForceProfile(
  physics: UnitLocomotionMediumPhysics,
  referenceMass: number,
  thrustMultiplier: number,
  forceScale: number,
): LocomotionForceProfile {
  assertUnitLocomotionPositiveFinite('referenceMass', referenceMass);
  assertUnitLocomotionPositiveFinite('forceScale', forceScale);
  const rawDriveForce = physics.propulsion.driveForce * thrustMultiplier;
  const coupledDriveForce = rawDriveForce * physics.propulsion.forceCoupling;
  return {
    rawDriveForce,
    coupledDriveForce,
    rawForceMagnitude: (rawDriveForce * referenceMass) / forceScale,
    coupledForceMagnitude: (coupledDriveForce * referenceMass) / forceScale,
  };
}
