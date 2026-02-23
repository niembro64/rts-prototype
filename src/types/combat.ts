// Combat system types extracted from game/sim/combat/types.ts

import type { EntityId, PlayerId, Entity } from './sim';
import type { DeathContext } from './damage';
import type { Vec2 } from './vec2';

export type TurretAudioId = string;

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
  turretId: TurretAudioId;
  pos: Vec2;
  entityId?: EntityId;
  deathContext?: SimDeathContext;
  impactContext?: ImpactContext;
};

export type ProjectileSpawnEvent = {
  id: EntityId;
  pos: Vec2;
  rotation: number;
  velocity: Vec2;
  projectileType: string;
  turretId: string;
  playerId: PlayerId;
  sourceEntityId: EntityId;
  turretIndex: number;
  isDGun?: boolean;
  beam?: { start: Vec2; end: Vec2 };
  targetEntityId?: EntityId;
  homingTurnRate?: number;
};

export type ProjectileDespawnEvent = {
  id: EntityId;
};

export type ProjectileVelocityUpdateEvent = {
  id: EntityId;
  pos: Vec2;
  velocity: Vec2;
};

export type FireTurretsResult = {
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
