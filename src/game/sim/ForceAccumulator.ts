import type { EntityId } from './types';
import { magnitude } from '../math';
import { entitySlotRegistry } from './EntitySlotRegistry';

import type { ForceContribution } from '@/types/ui';
import type { KnockbackInfo } from '@/types/damage';

/**
 * Accumulated forces for a single entity this frame.
 */
type EntityForces = {
  entityId: EntityId;
  entitySlot: number;
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
  private activeEntries: EntityForces[] = [];
  private activeSlotMarks = new Uint32Array(1024);
  private activeSlotMark = 1;
  private activeSlots = new Uint32Array(1024);
  private activeSlotCount = 0;
  private slotFinalFx = new Float64Array(1024);
  private slotFinalFy = new Float64Array(1024);
  private slotFinalFz = new Float64Array(1024);
  private slotEntityId = new Int32Array(1024);
  private slotCacheValid = false;

  /**
   * Clear all accumulated forces (call at start of each frame).
   * Reuses Map entries — just resets contribution counts.
   */
  clear(): void {
    for (let i = 0; i < this.activeEntries.length; i++) {
      const entry = this.activeEntries[i];
      entry.contributionCount = 0;
      entry.finalFx = 0;
      entry.finalFy = 0;
      entry.finalFz = 0;
      entry.active = false;
    }
    this.activeEntries.length = 0;
    this.slotCacheValid = false;
  }

  /**
   * Full reset — delete all entries (call between game sessions).
   * Unlike clear(), this frees the Map entries themselves.
   */
  reset(): void {
    this.forces.clear();
    this.activeEntries.length = 0;
    this.slotCacheValid = false;
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
    entitySlot: number = -1,
  ): void {
    if (!Number.isFinite(fx) || !Number.isFinite(fy) || !Number.isFinite(fz)) return;
    this.slotCacheValid = false;
    const resolvedSlot = entitySlot >= 0 ? entitySlot : entitySlotRegistry.getSlot(entityId);
    let entry = this.forces.get(entityId);
    if (!entry) {
      entry = {
        entityId,
        entitySlot: resolvedSlot,
        contributions: [],
        contributionCount: 0,
        finalFx: 0,
        finalFy: 0,
        finalFz: 0,
        active: false,
      };
      this.forces.set(entityId, entry);
    } else if (resolvedSlot >= 0 && entry.entitySlot !== resolvedSlot) {
      entry.entitySlot = resolvedSlot;
    }
    if (!entry.active) {
      entry.active = true;
      entry.contributionCount = 0;
      entry.finalFx = 0;
      entry.finalFy = 0;
      entry.finalFz = 0;
      this.activeEntries.push(entry);
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
   * Add a precomputed batch of knockback forces from damage resolution.
   * The force vectors are already scaled and must not be normalized again.
   */
  addKnockbackForces(knockbacks: readonly KnockbackInfo[]): void {
    for (let i = 0; i < knockbacks.length; i++) {
      const knockback = knockbacks[i];
      this.addForce(
        knockback.entityId,
        knockback.force.x,
        knockback.force.y,
        'knockback',
        knockback.forceZ ?? 0,
        knockback.entitySlot,
      );
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
    this.slotCacheValid = false;
    for (let a = 0; a < this.activeEntries.length; a++) {
      const entry = this.activeEntries[a];
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

  activeEntityCount(): number {
    return this.activeEntries.length;
  }

  collectActiveEntitySlots(
    out: Uint32Array,
    slotForEntityId?: (entityId: EntityId) => number,
  ): number {
    this.prepareSlotCache(slotForEntityId);
    out.set(this.activeSlots.subarray(0, this.activeSlotCount));
    return this.activeSlotCount;
  }

  copyFinalForceBySlot(
    slot: number,
    out: Float64Array,
    offset: number,
    expectedEntityId?: EntityId,
  ): boolean {
    if (
      !this.slotCacheValid ||
      slot < 0 ||
      slot >= this.activeSlotMarks.length ||
      this.activeSlotMarks[slot] !== this.activeSlotMark ||
      (expectedEntityId !== undefined && this.slotEntityId[slot] !== expectedEntityId) ||
      offset < 0 ||
      offset + 2 >= out.length
    ) {
      return false;
    }
    out[offset] = this.slotFinalFx[slot];
    out[offset + 1] = this.slotFinalFy[slot];
    out[offset + 2] = this.slotFinalFz[slot];
    return true;
  }

  private prepareSlotCache(slotForEntityId?: (entityId: EntityId) => number): void {
    if (this.slotCacheValid) return;
    this.beginSlotCacheFrame();
    this.activeSlotCount = 0;
    for (let i = 0; i < this.activeEntries.length; i++) {
      const entry = this.activeEntries[i];
      if (entry.contributionCount <= 0) continue;
      let slot = entry.entitySlot;
      if (slot < 0 || !Number.isInteger(slot)) {
        slot = slotForEntityId !== undefined
          ? slotForEntityId(entry.entityId)
          : entitySlotRegistry.getSlot(entry.entityId);
        if (slot >= 0 && Number.isInteger(slot)) entry.entitySlot = slot;
      }
      if (slot < 0 || !Number.isInteger(slot)) continue;
      this.ensureSlotCacheCapacity(slot);
      if (this.activeSlotMarks[slot] !== this.activeSlotMark) {
        this.activeSlotMarks[slot] = this.activeSlotMark;
        this.ensureActiveSlotListCapacity(this.activeSlotCount + 1);
        this.activeSlots[this.activeSlotCount++] = slot;
        this.slotFinalFx[slot] = entry.finalFx;
        this.slotFinalFy[slot] = entry.finalFy;
        this.slotFinalFz[slot] = entry.finalFz;
        this.slotEntityId[slot] = entry.entityId;
      } else {
        this.slotFinalFx[slot] += entry.finalFx;
        this.slotFinalFy[slot] += entry.finalFy;
        this.slotFinalFz[slot] += entry.finalFz;
        if (this.slotEntityId[slot] !== entry.entityId) {
          this.slotEntityId[slot] = -1;
        }
      }
    }
    this.slotCacheValid = true;
  }

  private beginSlotCacheFrame(): void {
    if (this.activeSlotMark >= 0xffffffff) {
      this.activeSlotMarks.fill(0);
      this.activeSlotMark = 1;
      return;
    }
    this.activeSlotMark++;
  }

  private ensureSlotCacheCapacity(slot: number): void {
    if (slot < this.activeSlotMarks.length) return;
    let capacity = this.activeSlotMarks.length;
    while (capacity <= slot) capacity *= 2;
    const marks = new Uint32Array(capacity);
    marks.set(this.activeSlotMarks);
    this.activeSlotMarks = marks;
    const fx = new Float64Array(capacity);
    fx.set(this.slotFinalFx);
    this.slotFinalFx = fx;
    const fy = new Float64Array(capacity);
    fy.set(this.slotFinalFy);
    this.slotFinalFy = fy;
    const fz = new Float64Array(capacity);
    fz.set(this.slotFinalFz);
    this.slotFinalFz = fz;
    const entityIds = new Int32Array(capacity);
    entityIds.set(this.slotEntityId);
    this.slotEntityId = entityIds;
  }

  private ensureActiveSlotListCapacity(required: number): void {
    if (required <= this.activeSlots.length) return;
    let capacity = this.activeSlots.length;
    while (capacity < required) capacity *= 2;
    const next = new Uint32Array(capacity);
    next.set(this.activeSlots);
    this.activeSlots = next;
  }

  /**
   * Get all entity IDs with accumulated forces.
   */
  getEntityIds(): EntityId[] {
    const ids: EntityId[] = [];
    for (const id of this.forces.keys()) ids.push(id);
    ids.sort((a, b) => a - b);
    return ids;
  }

  /**
   * Debug: get all contributions for an entity.
   */
  getContributions(entityId: EntityId): ForceContribution[] {
    const entry = this.forces.get(entityId);
    if (!entry) return [];
    const contributions = new Array<ForceContribution>(entry.contributionCount);
    for (let i = 0; i < entry.contributionCount; i++) {
      contributions[i] = entry.contributions[i];
    }
    return contributions;
  }
}

