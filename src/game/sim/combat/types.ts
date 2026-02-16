// Combat system types and interfaces

import type { EntityId, PlayerId } from '../types';
import type { DeathContext } from '../damage/types';
import type { WeaponAudioId } from '../../audio/AudioManager';

// Re-export types for use in other modules
export type { DeathContext } from '../damage/types';
export type { WeaponAudioId } from '../../audio/AudioManager';

// Audio event types
export interface AudioEvent {
  type: 'fire' | 'hit' | 'death' | 'laserStart' | 'laserStop' | 'projectileExpire';
  weaponId: WeaponAudioId;
  x: number;
  y: number;
  entityId?: EntityId; // For tracking continuous sounds

  // Death context (only for 'death' events) - for directional explosion effects
  deathContext?: {
    // Unit's velocity when it died (from physics body)
    unitVelX: number;
    unitVelY: number;
    // Hit direction: from hit point through unit center (normalized)
    hitDirX: number;
    hitDirY: number;
    // Projectile/beam velocity (actual velocity for projectiles, direction*magnitude for beams)
    projectileVelX: number;
    projectileVelY: number;
    // Magnitude of the attack damage
    attackMagnitude: number;
    radius: number;       // Unit's collision radius for explosion size
    color: number;        // Player color for explosion
  };
}

// Projectile spawn event - emitted when a projectile is created in the sim
export interface ProjectileSpawnEvent {
  id: EntityId;
  x: number; y: number; rotation: number;
  velocityX: number; velocityY: number;
  projectileType: string;
  weaponId: string;
  playerId: PlayerId;
  sourceEntityId: EntityId;
  weaponIndex: number;
  isDGun?: boolean;
  beamStartX?: number; beamStartY?: number;
  beamEndX?: number; beamEndY?: number;
}

// Projectile despawn event - emitted when a projectile is removed from the sim
export interface ProjectileDespawnEvent {
  id: EntityId;
}

// Projectile velocity update event - emitted when a projectile's velocity changes (e.g. force field pull)
// Includes position so clients can correct dead-reckoned drift
export interface ProjectileVelocityUpdateEvent {
  id: EntityId;
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
}

// Combat result containing entities and audio events
export interface FireWeaponsResult {
  projectiles: import('../types').Entity[];
  audioEvents: AudioEvent[];
  spawnEvents: ProjectileSpawnEvent[];
}

export interface CollisionResult {
  deadUnitIds: Set<EntityId>;
  deadBuildingIds: Set<EntityId>;
  audioEvents: AudioEvent[];
  despawnEvents: ProjectileDespawnEvent[];
  // Death context for each killed unit (for directional explosion effects)
  deathContexts: Map<EntityId, DeathContext>;
}
