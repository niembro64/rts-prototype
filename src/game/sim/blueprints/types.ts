/**
 * Blueprint Type Definitions — re-exported from canonical @/types/blueprints
 *
 * Interfaces for the unified blueprint system.
 * Blueprints are static config only — factory functions read them to create entities.
 */

// Re-export types that consumers need (previously re-exported from config/audio/sim modules)

// Re-export all blueprint types
export type {
  ShieldBarrierRatioConfig,
  ShieldMaterialBlueprint,

  

  ShieldBlueprint,
  ShieldSurfaceResponse,
  EntityBaseLedger,
  EntityRadiusConfig,
  RayBlueprint,
  ShotBlueprint,

  
  LockOnInclusionObject,

  
  TurretBlueprint,

  
  UnitBodyShape,
  
  UnitLocomotionBlueprint,
  UnitBlueprint,
} from '@/types/blueprints';

export {
  
  SHIELD_SURFACE_RESPONSES,
  isShieldReflectionMode,
} from '@/types/blueprints';
