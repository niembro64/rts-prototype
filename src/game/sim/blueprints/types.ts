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
  ShotCollision,
  ShotExplosion,
  ProjectileShotBlueprint,
  BeamShotBlueprint,
  LaserShotBlueprint,
  ShotBlueprint,
  MirrorPanel,
  TurretRadiusConfig,
  TurretBlueprint,
  MountOffset,
  TurretMount,
  WheelConfig,
  TreadConfig,
  LegConfig,
  LegLayoutEntry,
  LocomotionPhysics,
  UnitBodyShape,
  UnitBodyShapePart,
  EntityHudBlueprint,
  LocomotionBlueprint,
  UnitBlueprint,
} from '@/types/blueprints';
