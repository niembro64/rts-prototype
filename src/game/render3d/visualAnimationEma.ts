import type { DriftChannelMode } from '@/types/client';
import { DRIFT_CHANNEL_HALF_LIFE_SEC, halfLifeBlend } from '../network/driftEma';

/** Decorative client-only animations can borrow snapshot EMA modes as
 *  courtesy bindings. The snapshot channel's `ignore` mode has no useful
 *  meaning for local animation targets, so visual controllers treat it as
 *  `medium`. */
export function visualAnimHalfLife(mode: DriftChannelMode): number {
  if (mode === 'ignore') return DRIFT_CHANNEL_HALF_LIFE_SEC.medium;
  return DRIFT_CHANNEL_HALF_LIFE_SEC[mode];
}

export function visualAnimBlend(
  mode: DriftChannelMode,
  dtSec: number,
  halfLifeMultiplier = 1,
): number {
  if (dtSec <= 0) return 0;
  const halfLife = visualAnimHalfLife(mode) * halfLifeMultiplier;
  if (halfLife <= 0) return 1;
  return halfLifeBlend(dtSec, halfLife);
}
