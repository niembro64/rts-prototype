// Combat system types extracted from game/sim/combat/types.ts

import type { EntityId, PlayerId, Entity } from './sim';
import type { DeathContext } from './damage';

export type WeaponAudioId = string;

export type ImpactContext = {
  collisionRadius: number;
  primaryRadius: number;
  secondaryRadius: number;
  projectileVelX: number;
  projectileVelY: number;
  projectileX: number;
  projectileY: number;
  entityVelX: number;
  entityVelY: number;
  entityCollisionRadius: number;
  penetrationDirX: number;
  penetrationDirY: number;
};

export type SimEvent = {
  type:
    | 'fire'
    | 'hit'
    | 'death'
    | 'laserStart'
    | 'laserStop'
    | 'forceFieldStart'
    | 'forceFieldStop'
    | 'projectileExpire';
  weaponId: WeaponAudioId;
  x: number;
  y: number;
  entityId?: EntityId;
  deathContext?: {
    unitVelX: number;
    unitVelY: number;
    hitDirX: number;
    hitDirY: number;
    projectileVelX: number;
    projectileVelY: number;
    attackMagnitude: number;
    radius: number;
    color: number;
    unitType?: string;
    rotation?: number;
  };
  impactContext?: ImpactContext;
};

export type ProjectileSpawnEvent = {
  id: EntityId;
  x: number;
  y: number;
  rotation: number;
  velocityX: number;
  velocityY: number;
  projectileType: string;
  weaponId: string;
  playerId: PlayerId;
  sourceEntityId: EntityId;
  weaponIndex: number;
  isDGun?: boolean;
  beamStartX?: number;
  beamStartY?: number;
  beamEndX?: number;
  beamEndY?: number;
  targetEntityId?: EntityId;
  homingTurnRate?: number;
};

export type ProjectileDespawnEvent = {
  id: EntityId;
};

export type ProjectileVelocityUpdateEvent = {
  id: EntityId;
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
};

export type FireWeaponsResult = {
  projectiles: Entity[];
  events: SimEvent[];
  spawnEvents: ProjectileSpawnEvent[];
};

export type CollisionResult = {
  deadUnitIds: Set<EntityId>;
  deadBuildingIds: Set<EntityId>;
  events: SimEvent[];
  despawnEvents: ProjectileDespawnEvent[];
  deathContexts: Map<EntityId, DeathContext>;
};
