import type { EntityId } from './types';
import { magnitude } from '../math';

export type { ForceContribution } from '@/types/ui';
import type { ForceContribution } from '@/types/ui';

/**
 * Accumulated forces for a single entity this frame.
 */
type EntityForces = {
  contributions: ForceContribution[];
  contributionCount: number;  // How many contributions are active (avoids .length = 0 + push overhead)
  finalFx: number;
  finalFy: number;
  finalFz: number;
  active: boolean;
};

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
 *   5. Apply to physics bodies with physics.applyForce()
 */
export class ForceAccumulator {
  private forces: Map<EntityId, EntityForces> = new Map();
  private activeIds: EntityId[] = [];

  /**
   * Clear all accumulated forces (call at start of each frame).
   * Reuses Map entries — just resets contribution counts.
   */
  clear(): void {
    for (let i = 0; i < this.activeIds.length; i++) {
      const entry = this.forces.get(this.activeIds[i]);
      if (!entry) continue;
      entry.contributionCount = 0;
      entry.finalFx = 0;
      entry.finalFy = 0;
      entry.finalFz = 0;
      entry.active = false;
    }
    this.activeIds.length = 0;
  }

  /**
   * Full reset — delete all entries (call between game sessions).
   * Unlike clear(), this frees the Map entries themselves.
   */
  reset(): void {
    this.forces.clear();
    this.activeIds.length = 0;
  }

  /**
   * Add a raw force to an entity.
   * Use this for external effects like wave pull, knockback, explosions.
   * `fz` defaults to 0 — pass a non-zero value for 3D pushes (lift,
   * gravity-gun, scripted toss).
   */
  addForce(
    entityId: EntityId,
    fx: number,
    fy: number,
    source: string = 'unknown',
    fz: number = 0,
  ): void {
    let entry = this.forces.get(entityId);
    if (!entry) {
      entry = {
        contributions: [],
        contributionCount: 0,
        finalFx: 0,
        finalFy: 0,
        finalFz: 0,
        active: false,
      };
      this.forces.set(entityId, entry);
    }
    if (!entry.active) {
      entry.active = true;
      entry.contributionCount = 0;
      entry.finalFx = 0;
      entry.finalFy = 0;
      entry.finalFz = 0;
      this.activeIds.push(entityId);
    }
    const idx = entry.contributionCount++;
    if (idx < entry.contributions.length) {
      // Reuse existing contribution object
      const c = entry.contributions[idx];
      c.force.x = fx;
      c.force.y = fy;
      c.forceZ = fz;
      c.source = source;
    } else {
      // Grow the array (rare after warmup)
      entry.contributions.push({ force: { x: fx, y: fy }, forceZ: fz, source });
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
    for (let a = 0; a < this.activeIds.length; a++) {
      const entry = this.forces.get(this.activeIds[a]);
      if (!entry) continue;
      entry.finalFx = 0;
      entry.finalFy = 0;
      entry.finalFz = 0;
      const count = entry.contributionCount;
      for (let i = 0; i < count; i++) {
        const c = entry.contributions[i];
        entry.finalFx += c.force.x;
        entry.finalFy += c.force.y;
        entry.finalFz += c.forceZ ?? 0;
      }
    }
  }

  /** Reusable scratch for `readFinalForce`. */
  private _scratchForce: { fx: number; fy: number; fz: number } = { fx: 0, fy: 0, fz: 0 };

  /**
   * Get the final force for an entity (after finalize). Returns null
   * when the entity has no contributions; otherwise returns a SHARED
   * scratch object whose fields are mutated on each call — the caller
   * must read the components immediately and not retain the reference.
   * Avoids ~one allocation per dynamic unit per tick.
   */
  getFinalForce(entityId: EntityId): { fx: number; fy: number; fz: number } | null {
    const entry = this.forces.get(entityId);
    if (!entry || entry.contributionCount === 0) return null;
    const out = this._scratchForce;
    out.fx = entry.finalFx;
    out.fy = entry.finalFy;
    out.fz = entry.finalFz;
    return out;
  }

  /**
   * Check if entity has any force contributions.
   */
  hasForce(entityId: EntityId): boolean {
    const entry = this.forces.get(entityId);
    return entry !== undefined && entry.contributionCount > 0;
  }

  /**
   * Append entity IDs that have live force contributions this frame.
   * Unlike getEntityIds(), this ignores warm cached entries whose
   * contributionCount was reset by clear().
   */
  collectActiveEntityIds(out: EntityId[]): void {
    for (let i = 0; i < this.activeIds.length; i++) {
      const id = this.activeIds[i];
      const entry = this.forces.get(id);
      if (entry && entry.contributionCount > 0) out.push(id);
    }
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
