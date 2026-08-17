import type { BuildGridDebugMode } from '@/types/client';

export type BuildGridAvailabilityStatus =
  | 'hidden'
  | 'available'
  | 'blocked'
  | 'metal';

export type BuildGridAvailabilityFacts = {
  readonly occupied: boolean;
  /** Null means the authoritative ground grid has not arrived yet. */
  readonly groundBuildable: boolean | null;
  readonly waterSurfaceClear: boolean;
  readonly metal: boolean;
};

/** Resolve one whole-map build square with the same domain ordering used by
 *  placement validation: occupancy blocks every structure type; only ground
 *  uses terrain buildability; only water-surface uses seabed clearance. */
export function resolveBuildGridAvailabilityStatus(
  mode: BuildGridDebugMode,
  facts: BuildGridAvailabilityFacts,
): BuildGridAvailabilityStatus {
  if (mode === 'none') return 'hidden';
  if (facts.occupied) return 'blocked';
  if (mode === 'hover') return 'available';
  if (mode === 'water-surface') {
    return facts.waterSurfaceClear ? 'available' : 'blocked';
  }
  if (facts.groundBuildable === null) return 'hidden';
  if (!facts.groundBuildable) return 'blocked';
  return facts.metal ? 'metal' : 'available';
}
