import type { SurfaceLiftProbeAggregationMode } from './unitLocomotionPresetConfig';

/** Air lift uses exactly one supporting surface source at each probe. */
export function surfaceProbeUsesWaterSurface(
  terrainBedZ: number,
  waterLevel: number,
): boolean {
  return terrainBedZ < waterLevel;
}

/** Aggregates force proposals after each probe has already applied its
 * source-specific authored force. Average mode is the arithmetic mean; max
 * mode preserves strict strongest-probe authority. */
export function accumulateSurfaceProbeProposedForce(
  aggregate: number,
  proposedForce: number,
  mode: SurfaceLiftProbeAggregationMode,
): number {
  if (mode === 'max') return Math.max(aggregate, proposedForce);
  return aggregate + proposedForce;
}

export function finalizeSurfaceProbeProposedForce(
  aggregate: number,
  sampleCount: number,
  mode: SurfaceLiftProbeAggregationMode,
): number {
  if (sampleCount <= 0) return 0;
  if (mode === 'max') return aggregate;
  return aggregate / sampleCount;
}
