/** Air lift uses exactly one supporting surface source at each probe. */
export function surfaceProbeUsesWaterSurface(
  terrainBedZ: number,
  waterLevel: number,
): boolean {
  return terrainBedZ < waterLevel;
}

/** Aggregates force proposals after each probe has already applied its
 * source-specific authored force. The arithmetic mean is deliberately
 * hardcoded to preserve the original multi-probe lift behavior. */
export function accumulateSurfaceProbeProposedForce(
  aggregate: number,
  proposedForce: number,
): number {
  return aggregate + proposedForce;
}

export function finalizeSurfaceProbeProposedForce(
  aggregate: number,
  sampleCount: number,
): number {
  if (sampleCount <= 0) return 0;
  return aggregate / sampleCount;
}
