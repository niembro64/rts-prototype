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
};

// Auto-mode thresholds. Same direction as client TPS/FPS/UNITS:
// ratio >= threshold ⇒ tier eligible. Tighter than the client side
// because the SERVER is what actually loads the host's CPU — we want
// to react before the host hits the wall.
export const SERVER_SIM_LOD_THRESHOLDS: ServerSimAutoModeConfig = {
  tps: {
    low: 0.05,
    medium: 0.1,
    high: 0.4,
    max: 0.9,
  },
  // CPU ratio is fed in as `1 − cpuLoad / 100` (cpu load is a percent
  // of tick budget). 1.0 = idle; 0.0 = saturating.
  cpu: {
    low: 0.05,
    medium: 0.2,
    high: 0.5,
    max: 0.8,
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
