// Combat system types extracted from game/sim/combat/types.ts

import type { EntityId, PlayerId, Entity } from './sim';
import type { DeathContext } from './damage';
import type { Vec2 } from './vec2';

export type WeaponAudioId = string;

export type ImpactContext = {
  collisionRadius: number;
  primaryRadius: number;
  secondaryRadius: number;
  projectile: { pos: Vec2; vel: Vec2 };
  entity: { vel: Vec2; collisionRadius: number };
  penetrationDir: Vec2;
};

export type SimDeathContext = {
  unitVel: Vec2;
  hitDir: Vec2;
  projectileVel: Vec2;
  attackMagnitude: number;
  radius: number;
  color: number;
  unitType?: string;
  rotation?: number;
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
  deathContext?: SimDeathContext;
  impactContext?: ImpactContext;
};

export type ProjectileSpawnEvent = {
  id: EntityId;
  x: number;
  y: number;
  rotation: number;
  velocity: Vec2;
  projectileType: string;
  weaponId: string;
  playerId: PlayerId;
  sourceEntityId: EntityId;
  weaponIndex: number;
  isDGun?: boolean;
  beamStart?: Vec2;
  beamEnd?: Vec2;
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
  velocity: Vec2;
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
