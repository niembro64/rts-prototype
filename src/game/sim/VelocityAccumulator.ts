import type { EntityId } from './types';

// Velocity contribution from a single source
interface VelocityContribution {
  vx: number;
  vy: number;
  source: string; // For debugging: 'movement', 'wave_pull', etc.
}

// Accumulated velocity for a single entity
interface EntityVelocity {
  contributions: VelocityContribution[];
  finalVx: number;
  finalVy: number;
}

/**
 * VelocityAccumulator collects all velocity contributions for units each frame,
 * then applies the summed result at the end. This allows multiple systems
 * (movement, wave pull, knockback, etc.) to each add their velocity component
 * without overwriting each other.
 *
 * Usage:
 *   1. Call clear() at start of frame
 *   2. Each system calls addVelocity() for affected units
 *   3. Call finalize() to compute final velocities
 *   4. Read finalVx/finalVy for each unit to apply to physics
 */
export class VelocityAccumulator {
  private velocities: Map<EntityId, EntityVelocity> = new Map();

  // Clear all accumulated velocities (call at start of each frame)
  clear(): void {
    this.velocities.clear();
  }

  // Add a velocity contribution for an entity
  addVelocity(entityId: EntityId, vx: number, vy: number, source: string = 'unknown'): void {
    let entry = this.velocities.get(entityId);
    if (!entry) {
      entry = {
        contributions: [],
        finalVx: 0,
        finalVy: 0,
      };
      this.velocities.set(entityId, entry);
    }
    entry.contributions.push({ vx, vy, source });
  }

  // Finalize velocities by summing all contributions
  finalize(): void {
    for (const entry of this.velocities.values()) {
      entry.finalVx = 0;
      entry.finalVy = 0;
      for (const contrib of entry.contributions) {
        entry.finalVx += contrib.vx;
        entry.finalVy += contrib.vy;
      }
    }
  }

  // Get the final velocity for an entity (after finalize)
  getFinalVelocity(entityId: EntityId): { vx: number; vy: number } | null {
    const entry = this.velocities.get(entityId);
    if (!entry) return null;
    return { vx: entry.finalVx, vy: entry.finalVy };
  }

  // Check if entity has any velocity contributions
  hasVelocity(entityId: EntityId): boolean {
    return this.velocities.has(entityId);
  }

  // Get all entity IDs with accumulated velocities
  getEntityIds(): EntityId[] {
    return Array.from(this.velocities.keys());
  }

  // Debug: get all contributions for an entity
  getContributions(entityId: EntityId): VelocityContribution[] {
    return this.velocities.get(entityId)?.contributions ?? [];
  }
}
