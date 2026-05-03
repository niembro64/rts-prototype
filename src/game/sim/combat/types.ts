// Combat system types — re-exported from canonical @/types/combat

// Re-export types that were previously re-exported from other modules
export type { DeathContext } from '@/types/damage';
export type { TurretAudioId } from '@/types/combat';

// Re-export all combat types
export type {
  ImpactContext,
  SimEventSourceType,
  SimDeathContext,
  SimEvent,
  ProjectileSpawnEvent,
  ProjectileDespawnEvent,
  ProjectileVelocityUpdateEvent,
  FireTurretsResult,
  CollisionResult,
} from '@/types/combat';
