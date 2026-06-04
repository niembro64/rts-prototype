import type { Buildable, ConstructionPieceBuildRecord, ConstructionPieceKind, Entity, ResourceCost } from './types';

export type ResourceKind = keyof ResourceCost;

export const RESOURCE_KINDS: ReadonlyArray<ResourceKind> = ['energy', 'metal'];
export const BUILDABLE_INITIAL_HP = 1;

export function makeZeroResourceCost(): ResourceCost {
  return { energy: 0, metal: 0 };
}

export function getInitialBuildHp(maxHp: number): number {
  if (!Number.isFinite(maxHp) || maxHp <= 0) return 0;
  return Math.min(BUILDABLE_INITIAL_HP, maxHp);
}

export type BuildableState = {
  paid: ResourceCost | null;
  isGhost: boolean | null;
  isInterrupted?: boolean | null;
  healthBuildFraction: number | null;
};

/** Canonical construction-component factory. Buildable means "this
 *  entity is currently under construction"; callers should delete it
 *  on activation instead of creating completed Buildables. */
export function createBuildable(required: ResourceCost, state: BuildableState | null = null): Buildable {
  const paid = state === null || state.paid === null
    ? makeZeroResourceCost()
    : cloneResourceCost(state.paid);
  return {
    paid,
    required: cloneResourceCost(required),
    isComplete: false,
    isGhost: state !== null && state.isGhost === true,
    isInterrupted: state !== null && state.isInterrupted === true,
    healthBuildFraction: state === null || state.healthBuildFraction === null
      ? 0
      : state.healthBuildFraction,
    pieces: [],
  };
}

/** Per-resource fill ratio of a Buildable (0..1). A required value of
 *  0 reads as "full" so a free-on-that-axis blueprint doesn't stall. */
export function getResourceFillRatio(b: Buildable, kind: ResourceKind): number {
  const req = b.required[kind];
  if (req <= 0) return 1;
  return Math.min(1, Math.max(0, b.paid[kind] / req));
}

/** Average fill across the construction resources. Drives HP during
 *  construction and the shell's overall completion fraction. */
export function getBuildFraction(b: Buildable): number {
  let sum = 0;
  for (const k of RESOURCE_KINDS) sum += getResourceFillRatio(b, k);
  return sum / RESOURCE_KINDS.length;
}

export function getPieceFillRatio(
  piece: Buildable['pieces'][number],
  kind: ResourceKind,
): number {
  const req = piece.required[kind];
  if (req <= 0) return 1;
  return Math.min(1, Math.max(0, piece.paid[kind] / req));
}

export function getPieceBuildFraction(piece: Buildable['pieces'][number]): number {
  let sum = 0;
  for (const k of RESOURCE_KINDS) sum += getPieceFillRatio(piece, k);
  return sum / RESOURCE_KINDS.length;
}

export function getConstructionPieceRecord(
  entity: Entity,
  kind: ConstructionPieceKind,
  mountIndex: number | null = null,
): ConstructionPieceBuildRecord | null {
  const buildable = entity.buildable;
  if (buildable === null || buildable.isGhost || buildable.isComplete) return null;
  for (let i = 0; i < buildable.pieces.length; i++) {
    const piece = buildable.pieces[i];
    if (piece.kind === kind && piece.mountIndex === mountIndex) return piece;
  }
  return null;
}

export function isConstructionPieceMaterialized(
  entity: Entity,
  kind: ConstructionPieceKind,
  mountIndex: number | null = null,
): boolean {
  const buildable = entity.buildable;
  if (buildable === null || buildable.isGhost || buildable.isComplete) return true;
  const piece = getConstructionPieceRecord(entity, kind, mountIndex);
  return piece === null || piece.isActive;
}

export function getConstructionPieceRenderFraction(
  entity: Entity,
  kind: ConstructionPieceKind,
  mountIndex: number | null = null,
): number {
  const buildable = entity.buildable;
  if (buildable === null || buildable.isGhost || buildable.isComplete) return 1;
  const piece = getConstructionPieceRecord(entity, kind, mountIndex);
  if (piece === null) return 1;
  if (!piece.isActive) return 0;
  return Math.max(0.05, Math.min(1, getPieceBuildFraction(piece)));
}

/** Per-piece build-in opacity (0..1) for the materialization fade.
 *  0 = piece not yet started (fully transparent / dithered out), 1 =
 *  fully built / opaque. Mirrors getConstructionPieceRenderFraction but
 *  with a true 0 floor: that function floors at 0.05 because it drives
 *  body SCALE, whereas opacity wants real transparency at the start so a
 *  piece materializes from invisible rather than popping in at 5%. */
export function getConstructionPieceOpacity(
  entity: Entity,
  kind: ConstructionPieceKind,
  mountIndex: number | null = null,
): number {
  const buildable = entity.buildable;
  if (buildable === null || buildable.isGhost || buildable.isComplete) return 1;
  const piece = getConstructionPieceRecord(entity, kind, mountIndex);
  if (piece === null) return 1;
  if (!piece.isActive) return 0;
  return Math.max(0, Math.min(1, getPieceBuildFraction(piece)));
}

export function isConstructionBodyMaterialized(entity: Entity): boolean {
  return isConstructionPieceMaterialized(entity, 'body');
}

export function getActiveBuildPiece(b: Buildable): Buildable['pieces'][number] | null {
  for (let i = 0; i < b.pieces.length; i++) {
    const piece = b.pieces[i];
    if (!piece.isComplete) return piece;
  }
  return null;
}

/** True iff every required resource has been fully paid. Independent
 *  of the cached `isComplete` flag — callers can use either. */
export function isBuildFullyPaid(b: Buildable): boolean {
  if (b.pieces.length > 0) {
    return b.pieces.every((piece) => piece.isComplete);
  }
  for (const k of RESOURCE_KINDS) {
    if (b.paid[k] < b.required[k]) return false;
  }
  return true;
}

/** Remaining cost on a single resource (clamped at 0). */
export function getRemainingResource(b: Buildable, kind: ResourceKind): number {
  const activePiece = getActiveBuildPiece(b);
  if (activePiece !== null) {
    return Math.max(0, activePiece.required[kind] - activePiece.paid[kind]);
  }
  return Math.max(0, b.required[kind] - b.paid[kind]);
}

export function getTotalRemainingCost(b: Buildable): number {
  let r = 0;
  for (const k of RESOURCE_KINDS) r += getRemainingResource(b, k);
  return r;
}

/** Active iff the entity has no Buildable, or its Buildable is
 *  complete. Inert shells (Buildable present + !isComplete) skip
 *  combat, commanded movement, production, income, animation, etc. */
export function isEntityActive(entity: Entity): boolean {
  const b = entity.buildable;
  if (!b) return true;
  if (b.isGhost) return false;
  return b.isComplete || b.isInterrupted;
}

/** Convenience: true iff the entity is a shell (in-world, non-ghost,
 *  non-complete). Drives shell rendering + bar visibility. */
export function isShell(entity: Entity): boolean {
  const b = entity.buildable;
  return !!b && !b.isGhost && !b.isComplete && !b.isInterrupted;
}

export function isBuildInProgress(buildable: Buildable | null | undefined): buildable is Buildable {
  return !!buildable && !buildable.isGhost && !buildable.isComplete && !buildable.isInterrupted;
}

export function isBuildBlockingActivation(buildable: Buildable | null | undefined): boolean {
  return !!buildable && !buildable.isComplete && !buildable.isInterrupted;
}

export function hasMaterializedLiveUnitPiece(entity: Entity): boolean {
  const unit = entity.unit;
  if (unit === null) return false;
  return unit.hp > 0 && isConstructionPieceMaterialized(entity, 'body');
}

export function cloneResourceCost(c: ResourceCost): ResourceCost {
  return { energy: c.energy, metal: c.metal };
}
