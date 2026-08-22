import { deterministicMath as DMath } from '../sim/deterministicMath';

/** Frame-rate-independent blend factor that closes half the remaining gap
 * every `halfLifeSec`. Non-positive half-lives intentionally snap. */
export function halfLifeBlend(deltaSec: number, halfLifeSec: number): number {
  if (!Number.isFinite(deltaSec) || deltaSec <= 0) return 0;
  if (!Number.isFinite(halfLifeSec) || halfLifeSec <= 0) return 1;
  return 1 - DMath.pow(0.5, deltaSec / halfLifeSec);
}
