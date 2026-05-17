// HOST SERVER sim throttling is intentionally absent — the host always
// runs at MAX fidelity. This module survives only to give the sim hot
// paths (targeting, beam, projectile collision, capture) a single
// place to read their per-tick tunables; every value is hardcoded to
// the "every tick, no caps" setting.

export type SimDetailConfig = {
  /** Every-tick targeting reacquire. */
  targetingReacquireStride: number;
  /** Every-tick beam retrace. */
  beamPathStride: number;
  /** No cap on expensive beam traces per tick. */
  beamPathTraceBudget: number;
  /** Mirror bisector iterations (highest-fidelity setting). */
  mirrorBisectorIterations: number;
  /** Density-cap effectively disabled — never falls back to stride sampling. */
  targetingDensityThreshold: number;
  /** Stride used inside the density fallback (unreachable in practice). */
  targetingDensityStride: number;
  /** Every-tick projectile collision check. */
  projectileCollisionStride: number;
  /** Every-tick capture system update. */
  captureStride: number;
};

const DETAIL: SimDetailConfig = {
  targetingReacquireStride: 1,
  beamPathStride: 1,
  beamPathTraceBudget: Number.MAX_SAFE_INTEGER,
  mirrorBisectorIterations: 3,
  targetingDensityThreshold: Number.MAX_SAFE_INTEGER,
  targetingDensityStride: 1,
  projectileCollisionStride: 1,
  captureStride: 1,
};

export function getSimDetailConfig(): SimDetailConfig {
  return DETAIL;
}
