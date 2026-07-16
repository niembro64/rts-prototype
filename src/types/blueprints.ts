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
  
} from './config';
export type {
  ConstructionEmitterSize,
} from './constructionTypes';

export type {
  EntityBaseLedger,
  EntityHudBlueprint,
  EntityRadiusConfig,
  ShieldBarrierRatioConfig,
  ShieldBlueprint,
  ShieldMaterialBlueprint,

  
  ShieldSurfaceResponse,
  FlyingConfig,
  SwimConfig,
  FlipperConfig,
  HoverConfig,
  RayBlueprint,
  LockOnInclusionObject,
  LockOnRequiresTargetLockedOntoSelf,
  UnitLocomotionBlueprint,
  
  PathfindingBlueprint,
  
  SensorCapabilityConfig,
  ShotBlueprint,

  TreadConfig,
  TurretAimStyle,
  TurretBlueprint,
  TurretCooldownConfig,
  
  TurretLockOnRelationshipInclusion,
  TurretMount,
  TurretRadiusConfig,
  TurretRangeVolume,
  TurretSubmunitionEmitterConfig,
  UnitBlueprint,
  UnitBodyShape,
  UnitBodyShapePart,
  UnitSupportSurface,
  WheelConfig,
  LegConfig,
  BuildingTurretMount,
} from './blueprintSchema.generated';

export {
  SHIELD_SURFACE_RESPONSES,
  
  isShieldReflectionMode,
} from './shotTypes';

/** Lock-on policy relationship inclusions, kept as runtime arrays for validators. */
export const TURRET_LOCK_ON_RELATIONSHIP_INCLUSIONS: readonly TurretLockOnRelationshipInclusion[] =
  ['friendly_entities', 'enemy_entities'];

/** Lock-on policy entity-family inclusions, kept as runtime arrays for validators. */
export const TURRET_LOCK_ON_ENTITY_FAMILY_INCLUSIONS: readonly TurretLockOnEntityFamilyInclusion[] =
  ['buildings', 'towers', 'units', 'turrets', 'shots'];

/** Turret role categories used by host-directed mount validation. */
export const WEAPON_KINDS: readonly WeaponKind[] = [
  'attack',
  'construction',
  'repair',
  'spawn',
  'resourcePylon',
];
