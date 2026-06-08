import type { CanvasSpritePoolTelemetry } from '../../render3d/CanvasSpritePool';

export type HudSpriteTelemetry = {
  activeSlots: number;
  retainedSlots: number;
  peakRetainedSlots: number;
  createdSlots: number;
  disposedSlots: number;
  maxRetainedSlots: number;
  poolCount: number;
};

export function buildHudSpriteTelemetry(
  pools: readonly (CanvasSpritePoolTelemetry | undefined)[],
): HudSpriteTelemetry {
  const out: HudSpriteTelemetry = {
    activeSlots: 0,
    retainedSlots: 0,
    peakRetainedSlots: 0,
    createdSlots: 0,
    disposedSlots: 0,
    maxRetainedSlots: 0,
    poolCount: 0,
  };
  for (const pool of pools) {
    if (!pool) continue;
    out.activeSlots += pool.activeSlots;
    out.retainedSlots += pool.retainedSlots;
    out.peakRetainedSlots += pool.peakRetainedSlots;
    out.createdSlots += pool.createdSlots;
    out.disposedSlots += pool.disposedSlots;
    out.maxRetainedSlots += pool.maxRetainedSlots ?? 0;
    out.poolCount++;
  }
  return out;
}
