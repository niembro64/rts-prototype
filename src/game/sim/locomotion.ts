import type {
  LocomotionBlueprint,
  PathfindingBlueprint,
} from '@/types/blueprints';
import type {
  UnitLocomotion,
  UnitLocomotionMediumPhysics,
  UnitLocomotionPhysics,
} from '@/types/locomotionTypes';
import {
  LOCOMOTION_CONFIG_MEDIUM_FIELDS,
  LOCOMOTION_MEDIUM_NAMES,
  getLocomotionPreset,
  type LocomotionMediumName,
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
  assertLocomotionSlopeDegrees,
} from './locomotionValidation';

// Visual rig discriminants are deliberately separate from authoritative
// physics presets. A wheels rig may use any preset and moves identically to
// any other rig with the same expanded profile.
const LOCOMOTION_TYPES = ['wheels', 'treads', 'legs', 'flippers', 'hover', 'flying'] as const;
type AuthoredLocomotionMediumPhysics = LocomotionBlueprint['physics'][LocomotionMediumName];

function maxSlopeDegToMinSurfaceNormalZ(maxSlopeDeg: number): number {
  return Math.cos(maxSlopeDeg * Math.PI / 180);
}

function createRuntimeMediumPhysics(
  presetId: string,
  preset: LocomotionPresetConfig,
  medium: LocomotionMediumName,
  authored: AuthoredLocomotionMediumPhysics,
): UnitLocomotionMediumPhysics {
  if (!authored || typeof authored !== 'object') {
    throw new Error(`Invalid locomotion ${presetId}.physics.${medium}: missing medium physics`);
  }
  for (const field of LOCOMOTION_CONFIG_MEDIUM_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(authored, field)) {
      throw new Error(
        `Invalid locomotion ${presetId}.physics.${medium}.${field}: moved to locomotionConfig.json`,
      );
    }
  }
  assertLocomotionNonNegativeFinite(
    `${presetId}.physics.${medium}.heightUpwardForce`,
    authored.heightUpwardForce,
  );
  const authoredBuoyancy = authored.buoyancy ?? 0;
  assertLocomotionNonNegativeFinite(
    `${presetId}.physics.${medium}.buoyancy`,
    authoredBuoyancy,
  );
  const typeMediumPhysics = preset.physics[medium];
  return {
    driveForce: typeMediumPhysics.driveForce,
    traction: typeMediumPhysics.traction,
    friction: typeMediumPhysics.friction,
    quadraticDrag: typeMediumPhysics.quadraticDrag,
    dragForwardScale: typeMediumPhysics.dragForwardScale,
    dragLateralScale: typeMediumPhysics.dragLateralScale,
    dragVerticalScale: typeMediumPhysics.dragVerticalScale,
    angularDrag: typeMediumPhysics.angularDrag,
    surfaceGrip: typeMediumPhysics.surfaceGrip,
    contactDamping: typeMediumPhysics.contactDamping,
    buoyancy: authoredBuoyancy,
    heightUpwardForce: authored.heightUpwardForce,
    heightUpwardForceRandomizationAmount: typeMediumPhysics.heightUpwardForceRandomizationAmount,
    heightUpwardForceEMA: typeMediumPhysics.heightUpwardForceEMA,
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
    ground: createRuntimeMediumPhysics(presetId, preset, 'ground', authored.ground),
    air: createRuntimeMediumPhysics(presetId, preset, 'air', authored.air),
    water: createRuntimeMediumPhysics(presetId, preset, 'water', authored.water),
  };
}

function createRuntimePathfindingConfig(
  label: string,
  pathfinding: PathfindingBlueprint,
): UnitLocomotion['pathfinding'] {
  if (pathfinding.terrainMode === 'anywhere') {
    if (pathfinding.maxSlopeDeg !== null) {
      throw new Error(`Invalid ${label}: anywhere pathfinding must use maxSlopeDeg=null`);
    }
    return {
      pathfindingBlueprintId: pathfinding.pathfindingBlueprintId,
      terrainMode: pathfinding.terrainMode,
      ignoreTerrainBlocking: true,
      maxSlopeDeg: null,
      minSurfaceNormalZ: 0,
    };
  }
  const maxSlopeDeg = pathfinding.maxSlopeDeg;
  if (maxSlopeDeg === null) {
    throw new Error(`Invalid ${label}: land pathfinding requires maxSlopeDeg`);
  }
  assertLocomotionSlopeDegrees(`${label}.maxSlopeDeg`, maxSlopeDeg);
  return {
    pathfindingBlueprintId: pathfinding.pathfindingBlueprintId,
    terrainMode: pathfinding.terrainMode,
    ignoreTerrainBlocking: false,
    maxSlopeDeg,
    minSurfaceNormalZ: maxSlopeDegToMinSurfaceNormalZ(maxSlopeDeg),
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
    airLiftGroundProbeAheadDistance: preset.physics.airLiftGroundProbeAheadDistance,
    airLiftGroundProbeAheadRadiusMultiplier:
      preset.physics.airLiftGroundProbeAheadRadiusMultiplier,
    pathfinding: createRuntimePathfindingConfig(
      `${type}.pathfinding(${locomotion.pathfindingBlueprintId})`,
      locomotion.pathfinding,
    ),
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

function cloneMediumPhysics(
  physics: UnitLocomotionMediumPhysics,
): UnitLocomotionMediumPhysics {
  return { ...physics };
}

export function cloneUnitLocomotion(
  locomotion: UnitLocomotion,
): UnitLocomotion {
  return {
    type: locomotion.type,
    physicsPresetId: locomotion.physicsPresetId,
    physics: {
      ground: cloneMediumPhysics(locomotion.physics.ground),
      air: cloneMediumPhysics(locomotion.physics.air),
      water: cloneMediumPhysics(locomotion.physics.water),
    },
    navigation: { ...locomotion.navigation },
    survival: { ...locomotion.survival },
    idleAirDrive: locomotion.idleAirDrive,
    forwardForceRequiresFacing: locomotion.forwardForceRequiresFacing,
    driveForceScalesWithFacing: locomotion.driveForceScalesWithFacing,
    maintainFullThrustAtWaypoints: locomotion.maintainFullThrustAtWaypoints,
    airLiftGroundProbeAheadDistance: locomotion.airLiftGroundProbeAheadDistance,
    airLiftGroundProbeAheadRadiusMultiplier: locomotion.airLiftGroundProbeAheadRadiusMultiplier,
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
  let bestScore = best.driveForce * best.traction;
  for (const medium of LOCOMOTION_MEDIUM_NAMES) {
    const candidate = locomotion.physics[medium];
    const score = candidate.driveForce * candidate.traction;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

type LocomotionForceProfile = {
  rawDriveForce: number;
  tractionDriveForce: number;
  rawForceMagnitude: number;
  tractionForceMagnitude: number;
};

export function getLocomotionForceProfile(
  physics: UnitLocomotionMediumPhysics,
  referenceMass: number,
  thrustMultiplier: number,
  forceScale: number,
): LocomotionForceProfile {
  assertLocomotionPositiveFinite('referenceMass', referenceMass);
  assertLocomotionPositiveFinite('forceScale', forceScale);
  const rawDriveForce = physics.driveForce * thrustMultiplier;
  const tractionDriveForce = rawDriveForce * physics.traction;
  return {
    rawDriveForce,
    tractionDriveForce,
    rawForceMagnitude: (rawDriveForce * referenceMass) / forceScale,
    tractionForceMagnitude: (tractionDriveForce * referenceMass) / forceScale,
  };
}
