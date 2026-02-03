import type { EntityId } from './types';
import { magnitude } from '../math';

/**
 * Force contribution from a single source.
 * Forces are applied through Matter.js physics, so mass naturally affects acceleration.
 */
export interface ForceContribution {
  fx: number;  // Force in X direction (Newtons-ish, units depend on mass scale)
  fy: number;  // Force in Y direction
  source: string;  // For debugging: 'steering', 'wave_pull', 'knockback', 'collision_avoidance'
}

/**
 * Accumulated forces for a single entity this frame.
 */
interface EntityForces {
  contributions: ForceContribution[];
  finalFx: number;
  finalFy: number;
}

/**
 * ForceAccumulator - Unified force management for physics-based movement.
 *
 * This replaces the old velocity-based system with proper force-based physics:
 *
 * OLD WAY (broken):
 *   - Calculate desired velocity
 *   - setVelocity() directly on Matter body
 *   - Mass is ignored, collisions are overwritten
 *
 * NEW WAY (elegant):
 *   - Calculate desired velocity (target)
 *   - Apply steering FORCE toward target: F = (Vtarget - Vcurrent) * strength * mass
 *   - External effects (wave pull, knockback) also apply forces
 *   - Matter.js resolves all forces, respecting mass (F = ma → a = F/m)
 *   - Heavy units accelerate slower, light units are nimble
 *
 * Usage per frame:
 *   1. clear() - Start fresh
 *   2. addSteeringForce() - Movement toward waypoints
 *   3. addForce() - External effects (wave pull, knockback, etc.)
 *   4. finalize() - Sum all forces
 *   5. Apply to Matter bodies with matter.body.applyForce()
 */
export class ForceAccumulator {
  private forces: Map<EntityId, EntityForces> = new Map();

  /**
   * Clear all accumulated forces (call at start of each frame).
   */
  clear(): void {
    this.forces.clear();
  }

  /**
   * Add a raw force to an entity.
   * Use this for external effects like wave pull, knockback, explosions.
   */
  addForce(entityId: EntityId, fx: number, fy: number, source: string = 'unknown'): void {
    let entry = this.forces.get(entityId);
    if (!entry) {
      entry = { contributions: [], finalFx: 0, finalFy: 0 };
      this.forces.set(entityId, entry);
    }
    entry.contributions.push({ fx, fy, source });
  }

  /**
   * Add a steering force to move toward a target velocity.
   *
   * This is the core of the movement system:
   * - targetVelX/Y: The velocity the unit WANTS to have (from waypoint direction × moveSpeed)
   * - currentVelX/Y: The velocity the unit CURRENTLY has (from Matter body)
   * - mass: Unit's mass (affects how quickly it can change velocity)
   * - steeringStrength: How aggressively to steer (0.1 = gentle, 1.0 = aggressive)
   *
   * Formula: Force = (target - current) * strength * mass
   *
   * Why multiply by mass? So that F = ma gives us: a = (target - current) * strength
   * This means all units accelerate at similar rates toward their target, but heavier
   * units require more force to do so (and thus resist external forces better).
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
    // Calculate velocity error
    const errorX = targetVelX - currentVelX;
    const errorY = targetVelY - currentVelY;

    // Calculate steering force (proportional to error, scaled by mass)
    const fx = errorX * steeringStrength * mass;
    const fy = errorY * steeringStrength * mass;

    this.addForce(entityId, fx, fy, 'steering');
  }

  /**
   * Add a directional force (like wave pull or knockback).
   *
   * @param strength - Base force strength (will be multiplied by mass for consistency)
   * @param affectedByMass - If true, heavy units resist the force more
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
    // Normalize direction
    const len = magnitude(directionX, directionY);
    if (len === 0) return;

    const nx = directionX / len;
    const ny = directionY / len;

    // If affected by mass, lighter units get pushed more (divide by mass)
    // If not affected, all units get same acceleration (multiply by mass to cancel in F=ma)
    let fx: number, fy: number;
    if (affectedByMass) {
      // Light units get pushed more: F = strength (so a = strength/mass)
      fx = nx * strength;
      fy = ny * strength;
    } else {
      // All units get same acceleration: F = strength * mass (so a = strength)
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
      for (const contrib of entry.contributions) {
        entry.finalFx += contrib.fx;
        entry.finalFy += contrib.fy;
      }
    }
  }

  /**
   * Get the final force for an entity (after finalize).
   */
  getFinalForce(entityId: EntityId): { fx: number; fy: number } | null {
    const entry = this.forces.get(entityId);
    if (!entry) return null;
    return { fx: entry.finalFx, fy: entry.finalFy };
  }

  /**
   * Check if entity has any force contributions.
   */
  hasForce(entityId: EntityId): boolean {
    return this.forces.has(entityId);
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
    return this.forces.get(entityId)?.contributions ?? [];
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
