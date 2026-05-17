import type { DriftMode } from '@/types/client';

export type DriftAxis = { pos: number; vel: number };
export type DriftPreset = { movement: DriftAxis; rotation: DriftAxis };

// Drift half-lives (seconds). How long to close 50% of the gap to the
// server value. Smaller = snappier correction, larger = smoother/lazier.
// SNAP is just halfLife=0 — the EMA formula's natural limit is alpha=1
// (100% blend per step), so SNAP is "immediate EMA" with no special case.
export const DRIFT_PRESETS: Record<DriftMode, DriftPreset> = {
  snap: { movement: { pos: 0, vel: 0 }, rotation: { pos: 0, vel: 0 } },
  // FAST closes corrections ~twice as fast as MID. SLOW is deliberately
  // lazy for a weightier view of remote state.
  fast: {
    movement: { pos: 0.0175, vel: 0.010 },
    rotation: { pos: 0.0175, vel: 0.010 },
  },
  mid: {
    movement: { pos: 0.035, vel: 0.020 },
    rotation: { pos: 0.035, vel: 0.020 },
  },
  slow: {
    movement: { pos: 8, vel: 4 },
    rotation: { pos: 8, vel: 4 },
  },
};

/** Frame-rate independent EMA blend factor from a half-life in seconds.
 *  halfLife=0 collapses to alpha=1 (immediate / 100% blend) via the
 *  formula's natural limit — no special branch needed. */
export function halfLifeBlend(dt: number, halfLife: number): number {
  return 1 - Math.pow(0.5, dt / halfLife);
}

export function getDriftPreset(mode: DriftMode): DriftPreset {
  return DRIFT_PRESETS[mode];
}
