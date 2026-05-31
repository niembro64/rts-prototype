/**
 * Blueprint Type Definitions — re-exported from canonical @/types/blueprints
 *
 * Interfaces for the unified blueprint system.
 * Blueprints are static config only — factory functions read them to create entities.
 */

// Re-export types that consumers need (previously re-exported from config/audio/sim modules)
export type {
  BarrelShape,
  ShieldTurretConfig,
  SpinConfig,
  SoundEntry,
  TurretRangeOverrides,
} from '@/types/blueprints';

// Re-export all blueprint types
export type {
  ShieldBarrierRatioConfig,
  ShieldMaterialBlueprint,
  ShieldMaterialVisualConfig,
  ShotCollision,
  ShotExplosion,
  ProjectileShotKind,
  ProjectileShotBlueprint,
  BeamRayBlueprint,
  LaserRayBlueprint,
  ShieldBlueprint,
  ShieldSurfaceResponse,
  EntityBaseLedger,
  EntityDeathExplosion,
  EntityRadiusConfig,
  RayBlueprint,
  ShotBlueprint,
  SmokeTrailSpec,
  SubmunitionSpec,
  ShieldPanel,
  ConstructionEmitterSize,
  ConstructionEmitterVisualSpec,
  TurretAimAngleType,
  TurretAimLockOnType,
  TurretAimStyle,
  LockOnInclusionObject,
  TurretLockOnRelationshipInclusion,
  TurretLockOnEntityFamilyInclusion,
  TurretRadiusConfig,
  TurretBlueprint,
  MountOffset,
  TurretMount,
  UnitTurretMountZResolver,
  BuildingTurretMount,
  WheelConfig,
  TreadConfig,
  LegConfig,
  LegLayoutEntry,
  LocomotionPhysics,
  PathfindingBlueprint,
  PathfindingTerrainMode,
  UnitBodyShape,
  UnitBodyShapePart,
  EntityHudBlueprint,
  CloakBlueprint,
  DetectorBlueprint,
  LocomotionBlueprint,
  UnitBlueprint,
} from '@/types/blueprints';

export {
  SHIELD_SURFACE_RESPONSES,
  isShieldReflectionMode,
} from '@/types/blueprints';
