// HOST SERVER level-of-detail tables. Mirror of lodConfig.ts (player-
// client side) but for sim throttling. See types/serverSimLod.ts for
// the type contract.
//
// Each key defines what a server-side hot path does at each tier.
// Lower tier = more aggressive throttling = lower CPU per tick.
//
//   MAX  — every-tick fidelity. Targeting and beam tracing run on
//          every weapon, every tick. Mirror bisector iterates twice.
//   HIGH — light throttle. Targeting reacquires every other tick.
//          Beam tracing every other tick. Bisector still 2 iters.
//   MED  — current default. Targeting stride 4, beam stride 3.
//          Density-cap kicks in at 96 candidates.
//   LOW  — strider stride 8 / beam 5. Bisector drops to 1 iter
//          (~1° accuracy, still inside body radius). Density cap
//          drops to 64 so the stride-sampler engages earlier.
//   MIN  — aggressive: targeting stride 16, beam 8, density cap 32.
//          The instanced LOW renderer on the client side handles
//          ten-thousand-unit worlds — the server LOD has to keep
//          up by spending less per unit per tick.

import type {
  ServerSimAutoModeConfig,
  ServerSimDetailTable,
  ServerSimHysteresis,
} from './types/serverSimLod';

export const SERVER_SIM_DETAIL: ServerSimDetailTable = {
  TARGETING_REACQUIRE_STRIDE: {
    min: 16,
    low: 8,
    medium: 4,
    high: 2,
    max: 1,
  },
  BEAM_PATH_STRIDE: {
    min: 8,
    low: 5,
    medium: 3,
    high: 2,
    max: 1,
  },
  MIRROR_BISECTOR_ITERATIONS: {
    min: 1,
    low: 1,
    medium: 2,
    high: 2,
    max: 2,
  },
  TARGETING_DENSITY_THRESHOLD: {
    min: 32,
    low: 64,
    medium: 96,
    high: 192,
    // At MAX the threshold is effectively disabled — Number.POSITIVE_INFINITY
    // would be cleaner but `Infinity` survives JSON round-trips poorly,
    // so use a value bigger than any realistic candidate count.
    max: 100000,
  },
  TARGETING_DENSITY_STRIDE: {
    min: 8,
    low: 6,
    medium: 4,
    high: 3,
    max: 2,
  },
  // Force-field knockback application — every Nth tick at low LOD.
  // The on-apply call gets dt × N so total impulse over time matches
  // the every-tick path. With many force-field turrets active this
  // is the single biggest per-tick saving past the targeting trims.
  FORCE_FIELD_STRIDE: {
    min: 4,
    low: 2,
    medium: 1,
    high: 1,
    max: 1,
  },
  // Capture system — same skip+scale-dt trick. Walks every occupied
  // cell every tick, so on a packed map this is non-trivial.
  CAPTURE_STRIDE: {
    min: 4,
    low: 2,
    medium: 1,
    high: 1,
    max: 1,
  },
};

// Auto-mode thresholds. Same direction as client TPS/FPS/UNITS:
// ratio >= threshold ⇒ tier eligible. The server LOD reacts much
// EARLIER than the client side: by the time the host's TPS is at
// 50% of target the simulation is already drowning, and the LOD's
// only useful action is to drop work fast. So MAX requires nearly
// full headroom and HIGH demands ≥75% — tighter than the client's
// equivalent TPS thresholds.
export const SERVER_SIM_LOD_THRESHOLDS: ServerSimAutoModeConfig = {
  tps: {
    // Below 30% TPS we collapse to MIN — anything more permissive
    // and the LOD lets the host stay buried under work it can't do.
    low: 0.3,
    medium: 0.5,
    high: 0.75,
    max: 0.95,
  },
  // CPU ratio is fed in as `1 − cpuLoad / 100` (cpu load is a percent
  // of tick budget). 1.0 = idle; 0.0 = saturating. By the time CPU
  // load is 50% (ratio 0.5) we've already lost half the budget — the
  // ladder tightens accordingly.
  cpu: {
    low: 0.2,
    medium: 0.4,
    high: 0.65,
    max: 0.85,
  },
  // Units fullness — same as the client's UNITS auto mode.
  units: {
    low: 0.05,
    medium: 0.25,
    high: 0.5,
    max: 0.75,
  },
};

export const SERVER_SIM_HYSTERESIS: ServerSimHysteresis = {
  tps: 0.05,
  cpu: 0.05,
  units: 0.05,
};
