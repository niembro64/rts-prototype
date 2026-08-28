import { clamp01 } from '../math';

/** Short enough to read as the terminal half of one shot, long enough for the
 * tail tip to visibly arrive at the fixed impact head at ordinary frame rates. */
export const PLASMA_IMPACT_COLLAPSE_DURATION_MS = 180;

/** Remaining fraction of the recorded trail that may be drawn. Smoothstep
 * gives the incoming tail zero velocity at both the impact and disappearance
 * endpoints instead of replacing one abrupt cut with another. */
function plasmaImpactCollapseRemainingFraction(
  elapsedMs: number,
  durationMs: number = PLASMA_IMPACT_COLLAPSE_DURATION_MS,
): number {
  if (!(durationMs > 0)) return 0;
  const t = clamp01(Math.max(0, elapsedMs) / durationMs);
  const smooth = t * t * (3 - 2 * t);
  return 1 - smooth;
}

export function plasmaImpactCollapseTailLength(
  initialTailLength: number,
  elapsedMs: number,
  durationMs: number = PLASMA_IMPACT_COLLAPSE_DURATION_MS,
): number {
  return Math.max(0, initialTailLength) *
    plasmaImpactCollapseRemainingFraction(elapsedMs, durationMs);
}
