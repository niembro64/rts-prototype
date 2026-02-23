// Damage system types extracted from game/sim/damage/types.ts

import type { EntityId, PlayerId } from './sim';

export type DamageSourceBase = {
  sourceEntityId: EntityId;
  ownerId: PlayerId;
  damage: number;
  excludeEntities: Set<EntityId>;
};

export type LineDamageSource = DamageSourceBase & {
  type: 'line';
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  width: number;
  piercing: boolean;
  maxHits: number;
  projectileMass?: number;
  velocity?: number;
};

export type SweptDamageSource = DamageSourceBase & {
  type: 'swept';
  prevX: number;
  prevY: number;
  currentX: number;
  currentY: number;
  radius: number;
  maxHits: number;
  velocityX?: number;
  velocityY?: number;
  projectileMass?: number;
};

export type AreaDamageSource = DamageSourceBase & {
  type: 'area';
  centerX: number;
  centerY: number;
  radius: number;
  falloff: number;
  sliceAngle?: number;
  sliceDirection?: number;
  knockbackForce?: number;
};

export type AnyDamageSource = LineDamageSource | SweptDamageSource | AreaDamageSource;

export type KnockbackInfo = {
  entityId: EntityId;
  forceX: number;
  forceY: number;
};

export type DeathContext = {
  penetrationDirX: number;
  penetrationDirY: number;
  attackerVelX: number;
  attackerVelY: number;
  attackMagnitude: number;
};

export type RecoilInfo = {
  sourceEntityId: EntityId;
  forceX: number;
  forceY: number;
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
