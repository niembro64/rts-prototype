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
  ServerSimEmaSource,
  ServerSimHysteresis,
  ServerSimQuality,
  ServerSimSignalStates,
} from './types/serverSimLod';
import { assertMonotonicLodThresholds } from './types/lod';

// =============================================================================
// HOST SERVER LOD — SIGNAL TOGGLES
// =============================================================================

// Per-signal enable flags. Set false to remove a signal from the LOD
// system entirely:
//   - The AUTO mode no longer factors that signal into its min().
//   - The dedicated auto-{signal} mode resolves to MAX (a no-op).
//   - The matching button is hidden in the HOST SERVER LOD bar.
//
// Mirrors LOD_SIGNALS_ENABLED on the client side. Toggle here to
// debug a single signal in isolation or to disable a signal you
// don't want feeding the resolver (e.g. CPU when running on a
// machine whose CPU readings are unreliable).
export const SERVER_SIM_LOD_SIGNALS_ENABLED = {
  tps: true,
  cpu: true,
  units: true,
} as const;

// Default per-signal tri-state, applied:
//   1) on first browser load (before localStorage is populated), and
//   2) when the user clicks DEFAULTS on the HOST SERVER bar.
//
// Single source of truth — serverBarConfig.ts seeds the loader fallback
// from this, and the DEFAULTS reset path re-applies it. To change what a
// signal does on first load, edit this table and nothing else.
//
// Currently OFF by default: CPU and UNITS (TPS alone is enough to drive
// the auto-LOD on most hardware; CPU readings are noisy on browsers
// without performance.now sub-ms resolution and UNITS only matters near
// the cap).
export const SERVER_SIM_LOD_SIGNAL_DEFAULTS: ServerSimSignalStates = {
  tps: 'active',
  cpu: 'off',
  units: 'off',
};

export const SERVER_SIM_QUALITY_DEFAULT: ServerSimQuality = 'auto';

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
  // Hard cap for expensive beam path traces per tick. This is the
  // safety valve for beam/mirror-heavy battles: start/end visuals
  // still update every frame, but obstruction/reflection solves are
  // spread across ticks instead of all beams retracing at once.
  BEAM_PATH_TRACE_BUDGET: {
    min: 32,
    low: 64,
    medium: 96,
    high: 160,
    max: 256,
  },
  MIRROR_BISECTOR_ITERATIONS: {
    min: 1,
    low: 1,
    medium: 2,
    high: 2,
    max: 3,
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
  // Projectile collision/damage work. Movement still integrates each
  // tick; the expensive swept collision / beam damage path is
  // staggered at lower tiers with accumulated swept segments.
  PROJECTILE_COLLISION_STRIDE: {
    min: 4,
    low: 3,
    medium: 2,
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
    medium: 0.4,
    high: 0.6,
    max: 0.8,
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
    low: 0.2,
    medium: 0.3,
    high: 0.4,
    max: 0.5,
  },
};

// Validate at module load — same shape contract as LOD_THRESHOLDS.
// The host-side resolver walks the four rungs in order and a
// non-monotonic config silently mis-tiers; hard-fail in dev instead.
assertMonotonicLodThresholds('serverSim.tps', SERVER_SIM_LOD_THRESHOLDS.tps);
assertMonotonicLodThresholds('serverSim.cpu', SERVER_SIM_LOD_THRESHOLDS.cpu);
assertMonotonicLodThresholds('serverSim.units', SERVER_SIM_LOD_THRESHOLDS.units);

export const SERVER_SIM_HYSTERESIS: ServerSimHysteresis = {
  tps: 0.05,
  cpu: 0.05,
  units: 0.05,
};

// Which HOST SERVER EMA sample drives each auto-LOD signal.
// Toggle these between 'avg' and 'low' when tuning how quickly the
// sim throttles:
//   - tps 'avg' = steady tick rate, 'low' = pessimistic/worst tick rate.
//   - cpu 'avg' = steady CPU load, 'low' = pessimistic high CPU load
//     converted into lower headroom for the LOD ladder.
export const SERVER_SIM_LOD_EMA_SOURCE: ServerSimEmaSource = {
  tps: 'avg',
  cpu: 'avg',
};
