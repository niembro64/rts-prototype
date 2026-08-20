// Public blueprint type surface. Schema-owned aliases are generated from
// game/sim/blueprints/blueprintSchema.json; this file keeps the old import path
// and small runtime constants used by loaders/UI code.

import type {
  TurretEmitterKind,
  TurretLockOnEntityFamilyInclusion,
  TurretLockOnRelationshipInclusion,
} from './blueprintSchema.generated';

// Re-export for consumers
export type {
  BarrelShape,
  
} from './config';
export type {
  WorkEmitterSpec,
} from './constructionTypes';

export type {
  EntityBaseLedger,
  EntityHudBlueprint,
  EntityRadiusConfig,
  ShieldBarrierRatioConfig,
  ShieldBlueprint,
  ShieldMaterialBlueprint,

  
  ShieldSurfaceResponse,
  AirframeConfig,
  BotArms,
  SubmarineConfig,
  AmphibianConfig,
  DroneConfig,
  DroneFanMount,
  RayBlueprint,
  EntitySignature,
  LockOnInclusionObject,
  LockOnRequiresTargetLockedOntoSelf,
  UnitLocomotionBlueprint,
  SensorCapabilityConfig,
  SensorMediumRadiusMatrix,
  SensorMediumTargetRadii,
  SpawnTurretConfig,
  ResourcePylonConfig,
  ShotBlueprint,

  TankConfig,
  TurretAimStyle,
  TurretAngularActuator,
  TurretBlueprint,
  TurretCooldownConfig,
  TurretEmitterKind,
  TurretIntelRequirement,
  TurretMountControlMode,
  
  TurretLockOnRelationshipInclusion,
  TurretMount,
  TurretEmissionSocket,
  TurretPresentation,
  TurretStationArticulation,
  TurretHostAttachment,
  BuildingTurretHostAttachment,
  BuildingAimPieceTurretHostAttachment,
  BuildingYawPieceTurretHostAttachment,
  UnitTurretHostAttachment,
  TurretRangeVolume,
  TurretSubmunitionEmitterConfig,
  UnitBlueprint,
  UnitBodyShape,
  UnitBodyShapePart,
  UnitSupportSurface,
  RoverConfig,
  CrawlerConfig,
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
  ['buildings', 'units', 'turrets', 'shots'];

/** Authoritative mounted-emitter categories. */
export const TURRET_EMITTER_KINDS: readonly TurretEmitterKind[] = [
  'attack',
  'spawn',
  'resourcePylon',
  'sensor',
];
