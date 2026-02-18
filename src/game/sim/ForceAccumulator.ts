import type { EntityId } from './types';
import { magnitude } from '../math';

/**
 * Force contribution from a single source.
 * Forces are applied through Matter.js physics, so mass naturally affects acceleration.
 */
export interface ForceContribution {
  fx: number;  // Force in X direction (Newtons-ish, units depend on mass scale)
  fy: number;  // Force in Y direction
  source: string;  // For debugging: 'steering', 'force_field_pull', 'knockback', 'collision_avoidance'
}

/**
 * Accumulated forces for a single entity this frame.
 */
interface EntityForces {
  contributions: ForceContribution[];
  contributionCount: number;  // How many contributions are active (avoids .length = 0 + push overhead)
  finalFx: number;
  finalFy: number;
}

/**
 * ForceAccumulator - Unified force management for physics-based movement.
 *
 * Optimized to reuse Map entries and contribution arrays across frames
 * to avoid GC pressure from per-frame allocations.
 *
 * Usage per frame:
 *   1. clear() - Reset contribution counts (entries stay allocated)
 *   2. addSteeringForce() - Movement toward waypoints
 *   3. addForce() - External effects (wave pull, knockback, etc.)
 *   4. finalize() - Sum all forces
 *   5. Apply to Matter bodies with matter.body.applyForce()
 */
export class ForceAccumulator {
  private forces: Map<EntityId, EntityForces> = new Map();

  /**
   * Clear all accumulated forces (call at start of each frame).
   * Reuses Map entries — just resets contribution counts.
   */
  clear(): void {
    for (const entry of this.forces.values()) {
      entry.contributionCount = 0;
      entry.finalFx = 0;
      entry.finalFy = 0;
    }
  }

  /**
   * Full reset — delete all entries (call between game sessions).
   * Unlike clear(), this frees the Map entries themselves.
   */
  reset(): void {
    this.forces.clear();
  }

  /**
   * Add a raw force to an entity.
   * Use this for external effects like wave pull, knockback, explosions.
   */
  addForce(entityId: EntityId, fx: number, fy: number, source: string = 'unknown'): void {
    let entry = this.forces.get(entityId);
    if (!entry) {
      entry = { contributions: [], contributionCount: 0, finalFx: 0, finalFy: 0 };
      this.forces.set(entityId, entry);
    }
    const idx = entry.contributionCount++;
    if (idx < entry.contributions.length) {
      // Reuse existing contribution object
      const c = entry.contributions[idx];
      c.fx = fx;
      c.fy = fy;
      c.source = source;
    } else {
      // Grow the array (rare after warmup)
      entry.contributions.push({ fx, fy, source });
    }
  }

  /**
   * Add a steering force to move toward a target velocity.
   */
  addSteeringForce(
    entityId: EntityId,
    targetVelX: number,
    targetVelY: number,
    currentVelX: number,
    currentVelY: number,
    mass: number,
    steeringStrength: number = 0.5
  ): void {
    const errorX = targetVelX - currentVelX;
    const errorY = targetVelY - currentVelY;
    const fx = errorX * steeringStrength * mass;
    const fy = errorY * steeringStrength * mass;
    this.addForce(entityId, fx, fy, 'steering');
  }

  /**
   * Add a directional force (like wave pull or knockback).
   */
  addDirectionalForce(
    entityId: EntityId,
    directionX: number,
    directionY: number,
    strength: number,
    mass: number,
    affectedByMass: boolean = true,
    source: string = 'directional'
  ): void {
    const len = magnitude(directionX, directionY);
    if (len === 0) return;

    const nx = directionX / len;
    const ny = directionY / len;

    let fx: number, fy: number;
    if (affectedByMass) {
      fx = nx * strength;
      fy = ny * strength;
    } else {
      fx = nx * strength * mass;
      fy = ny * strength * mass;
    }

    this.addForce(entityId, fx, fy, source);
  }

  /**
   * Add a directional force with a pre-normalized direction vector.
   * Skips the magnitude() + division that addDirectionalForce() does internally.
   */
  addNormalizedDirectionalForce(
    entityId: EntityId,
    nx: number,
    ny: number,
    strength: number,
    mass: number,
    affectedByMass: boolean = true,
    source: string = 'directional'
  ): void {
    let fx: number, fy: number;
    if (affectedByMass) {
      fx = nx * strength;
      fy = ny * strength;
    } else {
      fx = nx * strength * mass;
      fy = ny * strength * mass;
    }

    this.addForce(entityId, fx, fy, source);
  }

  /**
   * Finalize forces by summing all contributions.
   */
  finalize(): void {
    for (const entry of this.forces.values()) {
      entry.finalFx = 0;
      entry.finalFy = 0;
      const count = entry.contributionCount;
      for (let i = 0; i < count; i++) {
        entry.finalFx += entry.contributions[i].fx;
        entry.finalFy += entry.contributions[i].fy;
      }
    }
  }

  /**
   * Get the final force for an entity (after finalize).
   */
  getFinalForce(entityId: EntityId): { fx: number; fy: number } | null {
    const entry = this.forces.get(entityId);
    if (!entry || entry.contributionCount === 0) return null;
    return { fx: entry.finalFx, fy: entry.finalFy };
  }

  /**
   * Check if entity has any force contributions.
   */
  hasForce(entityId: EntityId): boolean {
    const entry = this.forces.get(entityId);
    return entry !== undefined && entry.contributionCount > 0;
  }

  /**
   * Get all entity IDs with accumulated forces.
   */
  getEntityIds(): EntityId[] {
    return Array.from(this.forces.keys());
  }

  /**
   * Debug: get all contributions for an entity.
   */
  getContributions(entityId: EntityId): ForceContribution[] {
    const entry = this.forces.get(entityId);
    if (!entry) return [];
    return entry.contributions.slice(0, entry.contributionCount);
  }
}

/**
 * Steering strength presets for different behaviors.
 */
export const STEERING_PRESETS = {
  /** Smooth, gentle steering - good for large units */
  GENTLE: 0.3,
  /** Default steering - balanced responsiveness */
  NORMAL: 0.5,
  /** Aggressive steering - snappy, responsive */
  AGGRESSIVE: 0.8,
  /** Very tight steering - almost instant response */
  TIGHT: 1.0,
};
