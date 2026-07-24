import type { Buildable, ConstructionPieceBuildRecord, ConstructionPieceKind, Entity, ResourceCost } from './types';
import { NANOFRAME_VISUAL_CONFIG } from '@/constructionVisualConfig';

type ResourceKind = keyof ResourceCost;

const RESOURCE_KINDS: ReadonlyArray<ResourceKind> = ['energy', 'metal'];

export function makeZeroResourceCost(): ResourceCost {
  return { energy: 0, metal: 0 };
}

type BuildableState = {
  paid: ResourceCost | null;
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

function getPieceFillRatio(
  piece: Buildable['pieces'][number],
  kind: ResourceKind,
): number {
  const req = piece.required[kind];
  if (req <= 0) return 1;
  return Math.min(1, Math.max(0, piece.paid[kind] / req));
}

function getPieceBuildFraction(piece: Buildable['pieces'][number]): number {
  let sum = 0;
  for (const k of RESOURCE_KINDS) sum += getPieceFillRatio(piece, k);
  return sum / RESOURCE_KINDS.length;
}

function getConstructionPieceRecord(
  entity: Entity,
  kind: ConstructionPieceKind,
  mountIndex: number | null = null,
): ConstructionPieceBuildRecord | null {
  const buildable = entity.buildable;
  if (buildable === null || buildable.isComplete) return null;
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
  if (buildable === null || buildable.isComplete) return true;
  const piece = getConstructionPieceRecord(entity, kind, mountIndex);
  return piece === null || piece.isActive;
}

/** Raw per-piece build fraction (0..1) for the renderer's nanoframe
 *  bands. 0 = queued (nothing paid yet), 1 = complete or not under
 *  construction. This is the value the BAR-style materialization
 *  thresholds `pow(fraction, e)` consume. */
export function getConstructionPieceBuildFraction(
  entity: Entity,
  kind: ConstructionPieceKind,
  mountIndex: number | null = null,
): number {
  const buildable = entity.buildable;
  if (buildable === null || buildable.isComplete) return 1;
  const piece = getConstructionPieceRecord(entity, kind, mountIndex);
  if (piece === null) return 1;
  if (!piece.isActive) return 0;
  return Math.max(0, Math.min(1, getPieceBuildFraction(piece)));
}

/** BAR-derived whole-part translucency for a build fraction: a queued
 *  frame renders as the 24%-alpha ghost, an in-progress frame never
 *  drops below the not-yet-built alpha floor, and completion is fully
 *  opaque. One curve for every backend that carries a single alpha
 *  (instanced pools, custom shader parts); the per-object band shader
 *  reproduces the same envelope per-fragment. */
export function getBuildAlphaForFraction(fraction: number): number {
  if (fraction >= 1) return 1;
  if (fraction <= 0) return NANOFRAME_VISUAL_CONFIG.ghostAlpha;
  return Math.max(NANOFRAME_VISUAL_CONFIG.topAlphaFloor, fraction);
}

/** Per-piece render alpha for single-alpha backends: the BAR
 *  translucency curve over the piece's build fraction. Inactive pieces
 *  stay fully transparent until construction activates them. */
export function getConstructionPieceRenderAlpha(
  entity: Entity,
  kind: ConstructionPieceKind,
  mountIndex: number | null = null,
): number {
  const buildable = entity.buildable;
  if (buildable === null || buildable.isComplete) return 1;
  const piece = getConstructionPieceRecord(entity, kind, mountIndex);
  if (piece === null) return 1;
  if (!piece.isActive) return 0;
  return getBuildAlphaForFraction(getPieceBuildFraction(piece));
}

export function isConstructionBodyMaterialized(entity: Entity): boolean {
  return isConstructionPieceMaterialized(entity, 'body');
}

function getActiveBuildPiece(b: Buildable): Buildable['pieces'][number] | null {
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
 *  combat, commanded movement, production, income, animation, etc.
 *  An interrupted (cancelled / orphaned) shell is NEVER active: an
 *  unfinished host can never act as a real unit (BAR: only a finished
 *  unit is controllable). Interrupting construction leaves an
 *  incomplete host, not a coherent finished body. */
export function isEntityActive(entity: Entity): boolean {
  const b = entity.buildable;
  if (!b) return true;
  return b.isComplete;
}

/** Convenience: true iff the entity is a shell (in-world,
 *  non-complete). Drives shell rendering + bar visibility. */
export function isShell(entity: Entity): boolean {
  const b = entity.buildable;
  return !!b && !b.isComplete && !b.isInterrupted;
}

export function isBuildInProgress(buildable: Buildable | null | undefined): buildable is Buildable {
  return !!buildable && !buildable.isComplete && !buildable.isInterrupted;
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
