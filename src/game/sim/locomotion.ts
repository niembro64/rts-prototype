import type {
  LocomotionBlueprint,
  PathfindingBlueprint,
} from '@/types/blueprints';
import type {
  UnitLocomotion,
  UnitLocomotionFluidPhysics,
  UnitLocomotionGroundPhysics,
  UnitLocomotionMediumPhysics,
  UnitLocomotionPhysics,
} from '@/types/locomotionTypes';
import {
  LOCOMOTION_MEDIUM_NAMES,
  getLocomotionPreset,
  type LocomotionPresetConfig,
} from './locomotionPresetConfig';
import {
  hasAnyLocomotionRouteCapability,
  resolveLocomotionRouteCapabilities,
} from './locomotionNavigation';
import {
  assertLocomotionClosedUnitFraction,
  assertLocomotionNonNegativeFinite,
  assertLocomotionPositiveFinite,
} from './locomotionValidation';

// Visual rig discriminants are deliberately separate from authoritative
// physics presets. A wheels rig may use any preset and moves identically to
// any other rig with the same expanded profile.
const LOCOMOTION_TYPES = [
  'wheels', 'treads', 'legs', 'flippers', 'hover', 'flying', 'swim',
] as const;
type AuthoredFluidPhysics = NonNullable<LocomotionBlueprint['physics']['air']>;

function createRuntimeGroundPhysics(
  preset: LocomotionPresetConfig,
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
  presetPhysics: LocomotionPresetConfig['physics']['air'],
  authored: AuthoredFluidPhysics | undefined,
): UnitLocomotionFluidPhysics {
  if (authored === undefined) {
    throw new Error(
      `Invalid locomotion ${presetId}.physics.${medium}: ` +
      'air and water lift objects must always be explicitly authored',
    );
  }
  for (const key of Object.keys(authored)) {
    if (key !== 'lift') {
      throw new Error(
        `Invalid locomotion ${presetId}.physics.${medium}.${key}: moved to locomotionConfig.json`,
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
      `Invalid locomotion ${presetId}.physics.air.lift: air lift must explicitly author both ` +
      'liftForceFromGroundSurface and liftForceFromWaterSurface',
    );
  }
  if (medium === 'water' && hasWaterSurfaceLift) {
    throw new Error(
      `Invalid locomotion ${presetId}.physics.water.lift.liftForceFromWaterSurface: ` +
      'water lift may only be sourced from the ground surface',
    );
  }
  if (medium === 'water' && !hasGroundLift) {
    throw new Error(
      `Invalid locomotion ${presetId}.physics.water.lift: ` +
      'liftForceFromGroundSurface must always be explicitly authored, using 0 when inactive',
    );
  }
  if (!hasGravityCounter) {
    throw new Error(
      `Invalid locomotion ${presetId}.physics.${medium}.lift: ` +
      'gravityCounterRatio must always be explicitly authored, using 0 when inactive',
    );
  }
  const liftForceFromGroundSurface = authoredLift?.liftForceFromGroundSurface ?? 0;
  assertLocomotionNonNegativeFinite(
    `${presetId}.physics.${medium}.liftForceFromGroundSurface`,
    liftForceFromGroundSurface,
  );
  const liftForceFromWaterSurface = authoredLift?.liftForceFromWaterSurface ?? 0;
  assertLocomotionNonNegativeFinite(
    `${presetId}.physics.${medium}.liftForceFromWaterSurface`,
    liftForceFromWaterSurface,
  );
  const gravityCounterRatio = authoredLift?.gravityCounterRatio ?? 0;
  assertLocomotionClosedUnitFraction(
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
  preset: LocomotionPresetConfig,
  authored: LocomotionBlueprint['physics'],
): UnitLocomotionPhysics {
  if (!authored || typeof authored !== 'object') {
    throw new Error(`Invalid locomotion ${presetId}.physics: missing physics object`);
  }
  return {
    ground: createRuntimeGroundPhysics(preset),
    air: createRuntimeFluidPhysics(presetId, 'air', preset.physics.air, authored.air),
    water: createRuntimeFluidPhysics(presetId, 'water', preset.physics.water, authored.water),
  };
}

function createRuntimePathfindingConfig(
  pathfinding: PathfindingBlueprint,
): UnitLocomotion['pathfinding'] {
  return {
    pathfindingBlueprintId: pathfinding.pathfindingBlueprintId,
    terrainMode: pathfinding.terrainMode,
    ignoreTerrainBlocking: pathfinding.terrainMode === 'anywhere',
  };
}

export function createUnitLocomotion(
  locomotion: LocomotionBlueprint,
): UnitLocomotion {
  const { type, physicsPresetId, survival } = locomotion;
  if (!(LOCOMOTION_TYPES as readonly string[]).includes(type)) {
    throw new Error(`Invalid locomotion visual rig type "${String(type)}"`);
  }
  const preset = getLocomotionPreset(physicsPresetId);
  const physics = createRuntimeLocomotionPhysics(physicsPresetId, preset, locomotion.physics);
  const navigation = { ...preset.navigation };
  const runtime: UnitLocomotion = {
    type,
    physicsPresetId,
    physics,
    navigation,
    survival: { ...survival },
    idleAirDrive: preset.physics.idleAirDrive,
    forwardForceRequiresFacing: preset.physics.forwardForceRequiresFacing,
    driveForceScalesWithFacing: preset.physics.driveForceScalesWithFacing,
    maintainFullThrustAtWaypoints: preset.physics.maintainFullThrustAtWaypoints,
    surfaceProbeSetId: preset.physics.surfaceProbeSetId,
    pathfinding: createRuntimePathfindingConfig(locomotion.pathfinding),
  };
  if (!hasAnyLocomotionRouteCapability(resolveLocomotionRouteCapabilities(runtime))) {
    throw new Error(
      `Invalid locomotion ${physicsPresetId}: preset navigation and physical authority allow no route domain`,
    );
  }
  assertLocomotionClosedUnitFraction(
    `${physicsPresetId}.survival.fatalSubmergedFraction`,
    survival.fatalSubmergedFraction,
  );
  assertLocomotionNonNegativeFinite(
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
    navigation: { ...locomotion.navigation },
    survival: { ...locomotion.survival },
    idleAirDrive: locomotion.idleAirDrive,
    forwardForceRequiresFacing: locomotion.forwardForceRequiresFacing,
    driveForceScalesWithFacing: locomotion.driveForceScalesWithFacing,
    maintainFullThrustAtWaypoints: locomotion.maintainFullThrustAtWaypoints,
    surfaceProbeSetId: locomotion.surfaceProbeSetId,
    pathfinding: { ...locomotion.pathfinding },
  };
}

export function getLocomotionPrimaryDrivePhysics(
  locomotion: UnitLocomotion,
): UnitLocomotionMediumPhysics {
  const capabilities = resolveLocomotionRouteCapabilities(locomotion);
  if (capabilities.allowInAir) return locomotion.physics.air;
  if (capabilities.allowInWater && !capabilities.allowOnGround) {
    return locomotion.physics.water;
  }
  return locomotion.physics.ground;
}

export function getLocomotionGroundDrivePhysics(
  locomotion: UnitLocomotion,
): UnitLocomotionMediumPhysics {
  return locomotion.physics.ground;
}

export function getLocomotionBestDrivePhysics(
  locomotion: UnitLocomotion,
): UnitLocomotionMediumPhysics {
  let best = getLocomotionPrimaryDrivePhysics(locomotion);
  let bestScore = best.propulsion.driveForce * best.propulsion.forceCoupling;
  for (const medium of LOCOMOTION_MEDIUM_NAMES) {
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

export function getLocomotionForceProfile(
  physics: UnitLocomotionMediumPhysics,
  referenceMass: number,
  thrustMultiplier: number,
  forceScale: number,
): LocomotionForceProfile {
  assertLocomotionPositiveFinite('referenceMass', referenceMass);
  assertLocomotionPositiveFinite('forceScale', forceScale);
  const rawDriveForce = physics.propulsion.driveForce * thrustMultiplier;
  const coupledDriveForce = rawDriveForce * physics.propulsion.forceCoupling;
  return {
    rawDriveForce,
    coupledDriveForce,
    rawForceMagnitude: (rawDriveForce * referenceMass) / forceScale,
    coupledForceMagnitude: (coupledDriveForce * referenceMass) / forceScale,
  };
}
