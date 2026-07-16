export const SURFACE_PROBE_AGGREGATION_VALUES = ['average', 'max'] as const;
export type SurfaceProbeAggregation =
  (typeof SURFACE_PROBE_AGGREGATION_VALUES)[number];

export function isSurfaceProbeAggregation(
  value: unknown,
): value is SurfaceProbeAggregation {
  return (SURFACE_PROBE_AGGREGATION_VALUES as readonly unknown[]).includes(
    value,
  );
}

/** Air lift uses exactly one supporting surface source at each probe. */
export function surfaceProbeUsesWaterSurface(
  terrainBedZ: number,
  waterLevel: number,
): boolean {
  return terrainBedZ < waterLevel;
}

export function accumulateSurfaceProbeResponse(
  aggregate: number,
  response: number,
  aggregation: SurfaceProbeAggregation,
): number {
  return aggregation === 'max'
    ? Math.max(aggregate, response)
    : aggregate + response;
}

export function finalizeSurfaceProbeResponse(
  aggregate: number,
  sampleCount: number,
  aggregation: SurfaceProbeAggregation,
): number {
  if (sampleCount <= 0) return 0;
  return aggregation === 'max' ? aggregate : aggregate / sampleCount;
}
