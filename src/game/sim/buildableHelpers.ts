import type { Buildable, Entity, ResourceCost } from './types';

export type ResourceKind = keyof ResourceCost;

export const RESOURCE_KINDS: ReadonlyArray<ResourceKind> = ['energy', 'mana', 'metal'];

export function makeZeroResourceCost(): ResourceCost {
  return { energy: 0, mana: 0, metal: 0 };
}

export function makeUniformResourceCost(amount: number): ResourceCost {
  return { energy: amount, mana: amount, metal: amount };
}

/** Per-resource fill ratio of a Buildable (0..1). A required value of
 *  0 reads as "full" so a free-on-that-axis blueprint doesn't stall. */
export function getResourceFillRatio(b: Buildable, kind: ResourceKind): number {
  const req = b.required[kind];
  if (req <= 0) return 1;
  return Math.min(1, Math.max(0, b.paid[kind] / req));
}

/** Average fill across the three resources. Drives HP during
 *  construction and the shell's overall completion fraction. */
export function getBuildFraction(b: Buildable): number {
  let sum = 0;
  for (const k of RESOURCE_KINDS) sum += getResourceFillRatio(b, k);
  return sum / RESOURCE_KINDS.length;
}

/** True iff every required resource has been fully paid. Independent
 *  of the cached `isComplete` flag — callers can use either. */
export function isBuildFullyPaid(b: Buildable): boolean {
  for (const k of RESOURCE_KINDS) {
    if (b.paid[k] < b.required[k]) return false;
  }
  return true;
}

/** Remaining cost on a single resource (clamped at 0). */
export function getRemainingResource(b: Buildable, kind: ResourceKind): number {
  return Math.max(0, b.required[kind] - b.paid[kind]);
}

export function getTotalRemainingCost(b: Buildable): number {
  let r = 0;
  for (const k of RESOURCE_KINDS) r += getRemainingResource(b, k);
  return r;
}

/** Active iff the entity has no Buildable, or its Buildable is
 *  complete. Inert shells (Buildable present + !isComplete) skip
 *  combat, movement, production, income, animation, etc. */
export function isEntityActive(entity: Entity): boolean {
  const b = entity.buildable;
  if (!b) return true;
  if (b.isGhost) return false;
  return b.isComplete;
}

/** Convenience: true iff the entity is a shell (in-world, non-ghost,
 *  non-complete). Drives shell rendering + bar visibility. */
export function isShell(entity: Entity): boolean {
  const b = entity.buildable;
  return !!b && !b.isGhost && !b.isComplete;
}

export function cloneResourceCost(c: ResourceCost): ResourceCost {
  return { energy: c.energy, mana: c.mana, metal: c.metal };
}
