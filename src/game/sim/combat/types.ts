// Combat system types — re-exported from canonical @/types/combat

// Re-export types that were previously re-exported from other modules
export type { DeathContext } from '@/types/damage';

// Re-export all combat types
export type {
  ImpactContext,
  SimEventSourceType,
  SimEvent,
  ProjectileSpawnEvent,
  ProjectileDespawnEvent,
  ProjectileVelocityUpdateEvent,
  FireTurretsResult,
  CollisionResult,
} from '@/types/combat';
