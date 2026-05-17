import type { DriftChannelMode } from '@/types/client';

/** Half-life (seconds) per snapshot-drift channel mode. The mode-only
 *  decision space means each channel has one knob (the mode) that
 *  selects from this table. Smaller half-life closes the gap to the
 *  server target faster; larger leaves the rendered value lazier.
 *
 *  'ignore' returns a sentinel (-1) so the caller can branch on it.
 *  'snap'   collapses to alpha=1 via halfLife=0 — the EMA formula's
 *           natural limit (no special case needed).
 *  fast / medium / slow span roughly 1.5 orders of magnitude so the
 *  visible difference between adjacent settings is obvious without
 *  tuning a custom number per channel. */
export const DRIFT_CHANNEL_HALF_LIFE_SEC: Record<DriftChannelMode, number> = {
  ignore: -1,
  snap: 0,
  fast: 0.020,
  medium: 0.080,
  slow: 0.500,
};

/** Frame-rate independent EMA blend factor from a half-life in seconds.
 *  halfLife=0 collapses to alpha=1 (immediate / 100% blend) via the
 *  formula's natural limit — no special branch needed. */
export function halfLifeBlend(dt: number, halfLife: number): number {
  return 1 - Math.pow(0.5, dt / halfLife);
}

/** Compute the per-frame blend factor for a channel mode. Returns -1
 *  for 'ignore' so the caller can skip applying the snapshot value
 *  entirely; 1 for 'snap' (immediate replacement); the half-life
 *  blend otherwise. */
export function getChannelBlend(mode: DriftChannelMode, dt: number): number {
  if (mode === 'ignore') return -1;
  if (mode === 'snap') return 1;
  return halfLifeBlend(dt, DRIFT_CHANNEL_HALF_LIFE_SEC[mode]);
}
