// Server-side simulation LOD types — parallel to types/graphics +
// types/lod, but driving sim throttling instead of render quality.
//
//   PLAYER CLIENT LOD = how nice things LOOK
//   HOST SERVER LOD   = how often / how thoroughly things are SIMULATED
//
// Both ladders share the same five-tier shape (min/low/medium/high/max)
// and the same auto-mode pattern (AUTO mins over signals; specific
// signals via auto-<signal>). The server's signals are TPS (server's
// own actual tick rate vs target), CPU (per-tick budget consumption),
// and UNITS (count vs configured cap).

import type { EmaStat, SignalState } from './lod';

// AUTO is the meta-mode; per-signal contribution is set via
// ServerSimSignalStates. Legacy 'auto-tps' / 'auto-cpu' / 'auto-units'
// values are folded into the signal-state model and migrated at
// load time.
export type AutoServerSimQuality = 'auto';

/** Per-signal tri-state on the HOST SERVER LOD ladder. Same shape
 *  as the client side, with the server's own three signals. */
export type ServerSimSignalStates = {
  tps: SignalState;
  cpu: SignalState;
  units: SignalState;
};

/** Which EMA sample feeds each HOST SERVER auto-LOD signal.
 *  `low` means the pessimistic sample:
 *    - TPS: lower/worst tick-rate EMA
 *    - CPU: higher/spike CPU-load EMA, which becomes lower headroom
 */
export type ServerSimEmaSource = {
  tps: EmaStat;
  cpu: EmaStat;
};

export type ConcreteServerSimQuality = 'min' | 'low' | 'medium' | 'high' | 'max';

export type ServerSimQuality = AutoServerSimQuality | ConcreteServerSimQuality;

/** Per-tier numeric tunables that get plugged into the sim hot paths
 *  every tick. All values must be safe at every tier — lowering LOD
 *  trades responsiveness/precision for CPU, never correctness. */
export type ServerSimDetailConfig = {
  /** Resolved tier id (echo of the lookup, useful for debug/UI). */
  tier: ConcreteServerSimQuality;
  /** How many ticks between target-reacquisition passes per unit.
   *  1 = every tick (max responsiveness, max cost). */
  targetingReacquireStride: number;
  /** How many ticks between beam path raytrace recomputes. The
   *  beam follows the turret aim every tick visually; this only
   *  throttles the collision/reflection ray-trace. */
  beamPathStride: number;
  /** Maximum expensive beam/reflection path traces per tick. Beam
   *  starts still follow their turrets every tick; this caps the
   *  mirror/building/unit ray work during beam-heavy fights. */
  beamPathTraceBudget: number;
  /** Number of fixed-point iterations the mirror-aim bisector runs.
   *  2 = ~0.02° accuracy; 1 = ~1° accuracy (still inside body
   *  radius at typical engagement distances). */
  mirrorBisectorIterations: number;
  /** When the spatial-grid query for targeting returns more than
   *  this many candidates per weapon, switch to stride-sampling at
   *  `targetingDensityStride`. Lower threshold = the optimization
   *  kicks in earlier in dense crowds. */
  targetingDensityThreshold: number;
  /** Stride used inside the dense-crowd targeting fallback. Higher
   *  stride = fewer distance3 calls per weapon per tick, at the
   *  cost of taking more ticks to cover all candidates. */
  targetingDensityStride: number;
  /** Projectile collision stride. Traveling projectiles still move
   *  every tick, but their expensive unit/mirror collision sweep can
   *  be staggered. The projectile stores its last checked sweep start
   *  so a skipped tick widens the next swept segment instead of
   *  creating tunneling gaps. Beam/laser damage scales dt by this
   *  stride on processed ticks. */
  projectileCollisionStride: number;
  /** Capture-system stride. captureSystem.update walks every
   *  occupied cell each tick; same skip+scale-dt trick. Lower-tier
   *  flag heights climb at the same long-term rate but coarsen. */
  captureStride: number;
};

/** Per-tier table for one numeric setting (one row per ConcreteTier). */
export type ServerSimTierMap<T> = Record<ConcreteServerSimQuality, T>;

/** Identical to LodThresholds but for server signals — at-or-above
 *  threshold means tier eligible. tps/cpu use ratio semantics; units
 *  uses fullness-ratio (1 − count/cap), same as the client's UNITS LOD. */
export type ServerSimLodThresholds = Record<
  Exclude<ConcreteServerSimQuality, 'min'>,
  number
>;

export type ServerSimAutoModeConfig = {
  /** Server's actual TPS / target TPS (ratio). Higher = healthier. */
  tps: ServerSimLodThresholds;
  /** 1 − cpuLoad. Higher = more headroom = better tier eligible. */
  cpu: ServerSimLodThresholds;
  /** 1 − unitCount/unitCap. Higher = sparser world = better tier. */
  units: ServerSimLodThresholds;
};

export type ServerSimHysteresis = {
  tps: number;
  cpu: number;
  units: number;
};

/** Whole table of per-setting tier mappings, mirroring the client's
 *  GraphicsDetailConfig shape. */
export type ServerSimDetailTable = {
  TARGETING_REACQUIRE_STRIDE: ServerSimTierMap<number>;
  BEAM_PATH_STRIDE: ServerSimTierMap<number>;
  BEAM_PATH_TRACE_BUDGET: ServerSimTierMap<number>;
  MIRROR_BISECTOR_ITERATIONS: ServerSimTierMap<number>;
  TARGETING_DENSITY_THRESHOLD: ServerSimTierMap<number>;
  TARGETING_DENSITY_STRIDE: ServerSimTierMap<number>;
  PROJECTILE_COLLISION_STRIDE: ServerSimTierMap<number>;
  CAPTURE_STRIDE: ServerSimTierMap<number>;
};
