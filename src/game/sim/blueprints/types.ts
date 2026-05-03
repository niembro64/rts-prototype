/**
 * Blueprint Type Definitions — re-exported from canonical @/types/blueprints
 *
 * Interfaces for the unified blueprint system.
 * Blueprints are static config only — factory functions read them to create entities.
 */

// Re-export types that consumers need (previously re-exported from config/audio/sim modules)
export type {
  BarrelShape,
  MountPoint,
  ForceFieldTurretConfig,
  SpinConfig,
  SoundEntry,
  TurretRangeOverrides,
} from '@/types/blueprints';

// Re-export all blueprint types
export type {
  ForceFieldZoneRatioConfig,
  ShotCollision,
  ShotExplosion,
  ProjectileShotBlueprint,
  BeamShotBlueprint,
  LaserShotBlueprint,
  ShotBlueprint,
  MirrorPanel,
  TurretBlueprint,
  TurretMount,
  WheelConfig,
  TreadConfig,
  LegConfig,
  LegStyle,
  LocomotionPhysics,
  UnitBodyShape,
  UnitBodyShapePart,
  LocomotionBlueprint,
  UnitBlueprint,
} from '@/types/blueprints';
