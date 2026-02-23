// Damage system types extracted from game/sim/damage/types.ts

import type { EntityId, PlayerId } from './sim';
import type { Vec2 } from './vec2';

export type DamageSourceBase = {
  sourceEntityId: EntityId;
  ownerId: PlayerId;
  damage: number;
  excludeEntities: Set<EntityId>;
};

export type LineDamageSource = DamageSourceBase & {
  type: 'line';
  start: Vec2;
  end: Vec2;
  width: number;
  piercing: boolean;
  maxHits: number;
  projectileMass?: number;
  velocity?: number;
};

export type SweptDamageSource = DamageSourceBase & {
  type: 'swept';
  prev: Vec2;
  current: Vec2;
  radius: number;
  maxHits: number;
  velocity?: Vec2;
  projectileMass?: number;
};

export type AreaDamageSource = DamageSourceBase & {
  type: 'area';
  center: Vec2;
  radius: number;
  falloff: number;
  sliceAngle?: number;
  sliceDirection?: number;
  knockbackForce?: number;
};

export type AnyDamageSource = LineDamageSource | SweptDamageSource | AreaDamageSource;

export type KnockbackInfo = {
  entityId: EntityId;
  force: Vec2;
};

export type DeathContext = {
  penetrationDir: Vec2;
  attackerVel: Vec2;
  attackMagnitude: number;
};

export type RecoilInfo = {
  sourceEntityId: EntityId;
  force: Vec2;
};

export type DamageResult = {
  hitEntityIds: EntityId[];
  killedUnitIds: Set<EntityId>;
  killedBuildingIds: Set<EntityId>;
  truncationT?: number;
  knockbacks: KnockbackInfo[];
  recoil?: RecoilInfo;
  deathContexts: Map<EntityId, DeathContext>;
};

export type HitInfo = {
  entityId: EntityId;
  t: number;
  isUnit: boolean;
  isBuilding: boolean;
};
