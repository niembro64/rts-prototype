import type { BuildGridDebugMode } from '@/types/client';

type BuildGridAvailabilityStatus =
  | 'hidden'
  | 'available'
  | 'blocked'
  | 'metal';

type BuildGridAvailabilityFacts = {
  readonly occupied: boolean;
  /** Undefined means the authoritative grid has not arrived; null is an
   *  authoritative waterline-split square that belongs to neither medium. */
  readonly squareType: 'ground' | 'water' | null | undefined;
  readonly terrainBuildable: boolean | null;
  readonly waterSurfaceClear: boolean;
  readonly metal: boolean;
};

/** Resolve one square with the same exhaustive set rules as placement. */
export function resolveBuildGridAvailabilityStatus(
  mode: BuildGridDebugMode,
  facts: BuildGridAvailabilityFacts,
): BuildGridAvailabilityStatus {
  if (mode === 'none') return 'hidden';
  if (facts.occupied) return 'blocked';
  if (facts.squareType === undefined) return 'hidden';
  const wantsGround = mode.startsWith('ground-');
  if (facts.squareType === null || (facts.squareType === 'ground') !== wantsGround) {
    return 'blocked';
  }
  if (
    mode === 'ground-build-squares-hover' ||
    mode === 'water-build-squares-hover-surface'
  ) return 'available';
  if (mode === 'water-build-squares-sea-on-surface') {
    return facts.waterSurfaceClear ? 'available' : 'blocked';
  }
  if (facts.terrainBuildable === null) return 'hidden';
  if (!facts.terrainBuildable) return 'blocked';
  return facts.metal ? 'metal' : 'available';
}
