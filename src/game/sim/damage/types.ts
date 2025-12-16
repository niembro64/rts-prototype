// Unified Damage System Types
// All damage sources go through the DamageSystem for consistent collision detection

import type { EntityId, PlayerId } from '../types';

// Base interface for anything that can deal damage
export interface DamageSourceBase {
  sourceEntityId: EntityId;
  ownerId: PlayerId;
  damage: number;
  excludeEntities: Set<EntityId>; // Already hit entities (won't be hit again)
}

// Line damage (beams, hitscan weapons)
// Damages entities along a line, optionally stopping at first hit
export interface LineDamageSource extends DamageSourceBase {
  type: 'line';
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  width: number;        // Beam width for collision
  piercing: boolean;    // If true, hits all entities; if false, stops at first
  maxHits: number;      // Maximum entities to hit (Infinity for piercing)
}

// Swept volume damage (traveling projectiles)
// Uses previous and current position to detect collisions along travel path
export interface SweptDamageSource extends DamageSourceBase {
  type: 'swept';
  prevX: number;
  prevY: number;
  currentX: number;
  currentY: number;
  radius: number;       // Projectile radius
  maxHits: number;      // Usually 1 for non-piercing projectiles
}

// Area damage (splash, wave weapons)
// Damages all entities within a radius, with optional pie-slice for wave weapons
export interface AreaDamageSource extends DamageSourceBase {
  type: 'area';
  centerX: number;
  centerY: number;
  radius: number;
  falloff: number;      // 0-1, damage multiplier at edge (1 = no falloff)
  // Optional slice for wave weapons (if not set, full circle)
  sliceAngle?: number;      // Total slice angle in radians
  sliceDirection?: number;  // Center direction of slice in radians
}

// Union type for all damage sources
export type AnyDamageSource = LineDamageSource | SweptDamageSource | AreaDamageSource;

// Knockback info for a hit entity
export interface KnockbackInfo {
  entityId: EntityId;
  forceX: number;  // Force direction X (normalized) * damage * multiplier
  forceY: number;  // Force direction Y (normalized) * damage * multiplier
}

// Death context - info about the killing blow for explosion effects
export interface DeathContext {
  // Impact force direction (the knockback force from the killing blow)
  impactForceX: number;
  impactForceY: number;
  // Attacker's projectile/beam direction (direction damage traveled)
  attackerDirX: number;
  attackerDirY: number;
  // Magnitude of the attack (for scaling effects)
  attackMagnitude: number;
}

// Result from damage application
export interface DamageResult {
  hitEntityIds: EntityId[];
  killedUnitIds: EntityId[];
  killedBuildingIds: EntityId[];
  // For line damage - where the line was blocked (0-1 parametric)
  truncationT?: number;
  // Knockback forces to apply to hit entities
  knockbacks: KnockbackInfo[];
  // Death context for killed units (for directional explosion effects)
  deathContexts: Map<EntityId, DeathContext>;
}

// Hit info for sorting by distance
export interface HitInfo {
  entityId: EntityId;
  t: number;  // Parametric distance (0 = at start, 1 = at end)
  isUnit: boolean;
  isBuilding: boolean;
}
