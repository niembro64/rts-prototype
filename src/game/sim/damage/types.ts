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
  // Actual projectile velocity (for explosion effects)
  velocityX?: number;
  velocityY?: number;
  // Projectile mass (for momentum-based knockback: p = mv)
  projectileMass?: number;
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
  // Penetration direction: from hit point through unit center (normalized)
  // This shows which side of the unit was hit - debris flies out the opposite side
  penetrationDirX: number;
  penetrationDirY: number;
  // Attacker's projectile/beam velocity (direction and magnitude)
  // For projectiles: actual velocity vector
  // For beams: direction * config magnitude
  attackerVelX: number;
  attackerVelY: number;
  // Magnitude of the attack damage (for scaling effects)
  attackMagnitude: number;
}

// Recoil info for the source unit (opposite direction of knockback)
export interface RecoilInfo {
  sourceEntityId: EntityId;
  forceX: number;  // Recoil force X (opposite of knockback direction)
  forceY: number;  // Recoil force Y (opposite of knockback direction)
}

// Result from damage application
export interface DamageResult {
  hitEntityIds: EntityId[];
  killedUnitIds: Set<EntityId>;
  killedBuildingIds: Set<EntityId>;
  // For line damage - where the line was blocked (0-1 parametric)
  truncationT?: number;
  // Knockback forces to apply to hit entities
  knockbacks: KnockbackInfo[];
  // Recoil force to apply to the source unit (for projectiles and beams, not waves)
  recoil?: RecoilInfo;
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
