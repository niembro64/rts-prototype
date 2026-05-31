// Public blueprint type surface. Schema-owned aliases are generated from
// game/sim/blueprints/blueprintSchema.json; this file keeps the old import path
// and small runtime constants used by loaders/UI code.

import type {
  TurretLockOnEntityFamilyInclusion,
  TurretLockOnRelationshipInclusion,
  WeaponKind,
} from './blueprintSchema.generated';

// Re-export for consumers
export type {
  BarrelShape,
  ShieldTurretConfig,
  SpinConfig,
} from './config';
export type { SoundEntry } from './audio';
export type { TurretRangeOverrides } from './combatTypes';
export type {
  ConstructionEmitterSize,
  ConstructionEmitterVisualSpec,
} from './constructionTypes';

export type {
  BeamRayBlueprint,
  CloakBlueprint,
  DetectorBlueprint,
  EntityBaseLedger,
  EntityDeathExplosion,
  EntityHudBlueprint,
  EntityRadiusConfig,
  ShieldBarrierRatioConfig,
  ShieldBlueprint,
  ShieldMaterialBlueprint,
  ShieldMaterialVisualConfig,
  ShieldPanel,
  ShieldSurfaceResponse,
  FlyingConfig,
  HoverConfig,
  LaserRayBlueprint,
  RayBlueprint,
  LockOnInclusionObject,
  LocomotionBlueprint,
  LocomotionPhysics,
  MountOffset,
  PathfindingBlueprint,
  PathfindingTerrainMode,
  ProjectileShotBlueprint,
  ProjectileShotKind,
  ShotBlueprint,
  ShotCollision,
  ShotExplosion,
  SmokeTrailSpec,
  SubmunitionSpec,
  TreadConfig,
  TurretAimAngleType,
  TurretAimLockOnType,
  TurretAimStyle,
  TurretBlueprint,
  TurretLockOnEntityFamilyInclusion,
  TurretLockOnRelationshipInclusion,
  TurretMount,
  TurretRadiusConfig,
  UnitBlueprint,
  UnitBodyShape,
  UnitBodyShapePart,
  UnitTurretMountZResolver,
  WheelConfig,
  LegConfig,
  LegLayoutEntry,
  BuildingTurretMount,
  WeaponKind,
} from './blueprintSchema.generated';

export {
  SHIELD_SURFACE_RESPONSES,
  isShieldReflectionMode,
  isRayBlueprint,
} from './shotTypes';

/** Lock-on policy relationship inclusions, kept as runtime arrays for validators. */
export const TURRET_LOCK_ON_RELATIONSHIP_INCLUSIONS: readonly TurretLockOnRelationshipInclusion[] =
  ['friendly_entities', 'enemy_entities'];

/** Lock-on policy entity-family inclusions, kept as runtime arrays for validators. */
export const TURRET_LOCK_ON_ENTITY_FAMILY_INCLUSIONS: readonly TurretLockOnEntityFamilyInclusion[] =
  ['buildings', 'towers', 'units', 'turrets', 'locomotions', 'shots'];

/** Turret role categories used by host-directed mount validation. */
export const WEAPON_KINDS: readonly WeaponKind[] = ['attack', 'construction', 'repair'];
