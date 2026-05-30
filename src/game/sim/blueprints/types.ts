/**
 * Blueprint Type Definitions — re-exported from canonical @/types/blueprints
 *
 * Interfaces for the unified blueprint system.
 * Blueprints are static config only — factory functions read them to create entities.
 */

// Re-export types that consumers need (previously re-exported from config/audio/sim modules)
export type {
  BarrelShape,
  ForceFieldTurretConfig,
  SpinConfig,
  SoundEntry,
  TurretRangeOverrides,
} from '@/types/blueprints';

// Re-export all blueprint types
export type {
  ForceFieldBarrierRatioConfig,
  ForceFieldMaterialBlueprint,
  ForceFieldMaterialVisualConfig,
  ShotCollision,
  ShotExplosion,
  ProjectileShotKind,
  ProjectileShotBlueprint,
  BeamShotBlueprint,
  LaserShotBlueprint,
  ForceFieldShotBlueprint,
  ForceFieldSurfaceResponse,
  EntityBaseLedger,
  EntityDeathExplosion,
  EntityRadiusConfig,
  LineShotBlueprint,
  ShotBlueprint,
  SmokeTrailSpec,
  SubmunitionSpec,
  ForceFieldPanel,
  ConstructionEmitterSize,
  ConstructionEmitterVisualSpec,
  TurretAimAngleType,
  TurretAimLockOnType,
  TurretAimStyle,
  LockOnExclusionObject,
  TurretLockOnRelationshipExclusion,
  TurretLockOnEntityFamilyExclusion,
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
  FORCE_FIELD_SURFACE_RESPONSES,
  isForceFieldReflectionMode,
} from '@/types/blueprints';
