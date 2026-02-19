// Combat system types and interfaces

import type { EntityId, PlayerId } from '../types';
import type { DeathContext } from '../damage/types';
import type { WeaponAudioId } from '../../audio/AudioManager';

// Re-export types for use in other modules
export type { DeathContext } from '../damage/types';
export type { WeaponAudioId } from '../../audio/AudioManager';

// Impact context for hit/projectileExpire events - drives directional flame explosions
export interface ImpactContext {
  // Projectile radii (from weapon config)
  collisionRadius: number;     // Projectile collision radius
  primaryRadius: number;       // Primary damage/visual radius
  secondaryRadius: number;     // Secondary damage/visual radius
  // Projectile kinematics at impact
  projectileVelX: number;      // Projectile velocity (or beam direction * magnitude)
  projectileVelY: number;
  projectileX: number;         // Projectile center at impact
  projectileY: number;
  // Collided entity data (zero when no entity hit, e.g. projectileExpire)
  entityVelX: number;          // Hit entity velocity
  entityVelY: number;
  entityCollisionRadius: number; // Hit entity's collision radius
  // Normalized direction: projectile center → entity center
  penetrationDirX: number;
  penetrationDirY: number;
}

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
    unitType?: string;    // Unit type for debris generation
    rotation?: number;    // Unit's body rotation at death
  };

  // Impact context (only for 'hit' and 'projectileExpire' events) - for directional flame explosions
  impactContext?: ImpactContext;
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
  targetEntityId?: EntityId;  // Homing target (so clients know which projectiles are homing)
  homingTurnRate?: number;    // Max turn rate for homing (rad/sec)
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
