import { ARCHITECTURE_CONFIG } from './architectureConfig';
import type { SnapshotRate } from './types/server';

export const PRESENTATION_SNAPSHOT_RATE_DEFAULT: number =
  ARCHITECTURE_CONFIG.lockstep.presentationSnapshots.nominalSnapshotRateHz;


function isPresentationSnapshotRate(rate: SnapshotRate): rate is number {
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0;
}

export function normalizePresentationSnapshotRate(rate: SnapshotRate): number {
  return isPresentationSnapshotRate(rate) ? rate : PRESENTATION_SNAPSHOT_RATE_DEFAULT;
}

export function presentationSnapshotRateHz(
  rate: SnapshotRate,
  uncappedFallback = ARCHITECTURE_CONFIG.lockstep.fixedStepHz,
): number {
  return rate === 'none' ? uncappedFallback : normalizePresentationSnapshotRate(rate);
}

export function presentationSnapshotRateIntervalMs(rate: SnapshotRate): number {
  const normalized = normalizePresentationSnapshotRate(rate);
  return 1000 / normalized;
}
