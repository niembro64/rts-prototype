// Server simulation LOD driver — runtime resolver for the HOST SERVER
// side of the LOD ladder. Conceptual mirror of the client's
// clientBarConfig LOD plumbing:
//
//   PLAYER CLIENT side: clientBarConfig.getEffectiveQuality()
//                       → drives RENDER quality
//   HOST SERVER  side: this module's getEffectiveSimQuality()
//                       → drives SIM throttling
//
// The host's GameServer pushes its TPS / CPU / units stats into this
// module each tick. Sim hot paths (targeting, beam tracing, mirror
// solver) call getSimDetailConfig() to read the current per-tier
// numeric tunables. The user picks a quality tier (or 'auto-*'); the
// resolver maps signals to the lowest eligible rank, hysteresis-
// protected so transient spikes don't flap LOD up and down.

import type {
  ServerSimQuality,
  ConcreteServerSimQuality,
  ServerSimDetailConfig,
} from '../../types/serverSimLod';
import {
  SERVER_SIM_DETAIL,
  SERVER_SIM_LOD_THRESHOLDS,
  SERVER_SIM_HYSTERESIS,
  SERVER_SIM_LOD_SIGNALS_ENABLED,
} from '../../serverSimLodConfig';

let currentQuality: ServerSimQuality = 'auto';

let currentTpsRatio: number = 1.0;
let currentCpuRatio: number = 1.0;
let currentUnitCount: number = 0;
let currentUnitCap: number = 4096;

let prevTpsRank: number = 4;
let prevCpuRank: number = 4;
let prevUnitsRank: number = 4;

const RANK_TO_QUALITY: ConcreteServerSimQuality[] = [
  'min', 'low', 'medium', 'high', 'max',
];

function toArray(t: { low: number; medium: number; high: number; max: number }): number[] {
  return [t.low, t.medium, t.high, t.max];
}

const TPS_THRESHOLDS = toArray(SERVER_SIM_LOD_THRESHOLDS.tps);
const CPU_THRESHOLDS = toArray(SERVER_SIM_LOD_THRESHOLDS.cpu);
const UNITS_THRESHOLDS = toArray(SERVER_SIM_LOD_THRESHOLDS.units);

function ratioToRank(
  ratio: number,
  thresholds: number[],
  prevRank: number,
  hysteresis: number,
): number {
  let rank = 0;
  for (let i = 0; i < thresholds.length; i++) {
    const threshold = thresholds[i];
    const effectiveThreshold = i + 1 > prevRank
      ? threshold + hysteresis  // upgrading from below: harder
      : threshold - hysteresis; // already here: easier to stay
    if (ratio >= effectiveThreshold) rank = i + 1;
  }
  return rank;
}

function unitsRatio(): number {
  if (currentUnitCap <= 0) return 1;
  const fullness = currentUnitCount / currentUnitCap;
  if (fullness <= 0) return 1;
  if (fullness >= 1) return 0;
  return 1 - fullness;
}

export function setSimQuality(q: ServerSimQuality): void {
  currentQuality = q;
}

export function getSimQuality(): ServerSimQuality {
  return currentQuality;
}

/** Server's actual TPS divided by target TPS. Higher = healthier. */
export function setSimTpsRatio(ratio: number): void {
  currentTpsRatio = ratio;
}

/** 1 − (cpuLoadPercent / 100). Higher = more tick-budget headroom. */
export function setSimCpuRatio(ratio: number): void {
  currentCpuRatio = ratio;
}

export function setSimUnitCount(count: number): void {
  currentUnitCount = count;
}

export function setSimUnitCap(cap: number): void {
  if (cap > 0) currentUnitCap = cap;
}

// Per-tick cache for the resolved detail config. The hot paths
// (beam tracer, mirror solver) called getSimDetailConfig() per
// projectile / per turret which re-ran the AUTO resolver every
// invocation. With 100+ beams + mirrors that was hundreds of
// redundant ratioToRank passes per tick.
//
// `tickSimQuality()` is called once per tick by the host loop AFTER
// signals have been pushed; it resolves the tier and stores the
// answer here. `getSimDetailConfig()` returns the cached value.
let _cachedDetail: ServerSimDetailConfig | null = null;

export function tickSimQuality(): void {
  _cachedDetail = RESOLVED[getEffectiveSimQuality()];
}

export function getEffectiveSimQuality(): ConcreteServerSimQuality {
  switch (currentQuality) {
    case 'auto': {
      // AUTO = min over every ENABLED signal. Each sub-mode keeps
      // its own running rank so hysteresis state survives a swap to
      // the dedicated mode and back. A signal disabled in
      // SERVER_SIM_LOD_SIGNALS_ENABLED is skipped entirely; if all
      // signals are disabled the resolver falls back to MAX.
      let minRank = 4;
      if (SERVER_SIM_LOD_SIGNALS_ENABLED.tps) {
        prevTpsRank = ratioToRank(currentTpsRatio, TPS_THRESHOLDS, prevTpsRank, SERVER_SIM_HYSTERESIS.tps);
        if (prevTpsRank < minRank) minRank = prevTpsRank;
      }
      if (SERVER_SIM_LOD_SIGNALS_ENABLED.cpu) {
        prevCpuRank = ratioToRank(currentCpuRatio, CPU_THRESHOLDS, prevCpuRank, SERVER_SIM_HYSTERESIS.cpu);
        if (prevCpuRank < minRank) minRank = prevCpuRank;
      }
      if (SERVER_SIM_LOD_SIGNALS_ENABLED.units) {
        prevUnitsRank = ratioToRank(unitsRatio(), UNITS_THRESHOLDS, prevUnitsRank, SERVER_SIM_HYSTERESIS.units);
        if (prevUnitsRank < minRank) minRank = prevUnitsRank;
      }
      return RANK_TO_QUALITY[minRank];
    }
    case 'auto-tps':
      if (!SERVER_SIM_LOD_SIGNALS_ENABLED.tps) return RANK_TO_QUALITY[4];
      prevTpsRank = ratioToRank(currentTpsRatio, TPS_THRESHOLDS, prevTpsRank, SERVER_SIM_HYSTERESIS.tps);
      return RANK_TO_QUALITY[prevTpsRank];
    case 'auto-cpu':
      if (!SERVER_SIM_LOD_SIGNALS_ENABLED.cpu) return RANK_TO_QUALITY[4];
      prevCpuRank = ratioToRank(currentCpuRatio, CPU_THRESHOLDS, prevCpuRank, SERVER_SIM_HYSTERESIS.cpu);
      return RANK_TO_QUALITY[prevCpuRank];
    case 'auto-units':
      if (!SERVER_SIM_LOD_SIGNALS_ENABLED.units) return RANK_TO_QUALITY[4];
      prevUnitsRank = ratioToRank(unitsRatio(), UNITS_THRESHOLDS, prevUnitsRank, SERVER_SIM_HYSTERESIS.units);
      return RANK_TO_QUALITY[prevUnitsRank];
    case 'min':
    case 'low':
    case 'medium':
    case 'high':
    case 'max':
      return currentQuality;
  }
}

function buildDetail(tier: ConcreteServerSimQuality): ServerSimDetailConfig {
  return {
    tier,
    targetingReacquireStride: SERVER_SIM_DETAIL.TARGETING_REACQUIRE_STRIDE[tier],
    beamPathStride: SERVER_SIM_DETAIL.BEAM_PATH_STRIDE[tier],
    mirrorBisectorIterations: SERVER_SIM_DETAIL.MIRROR_BISECTOR_ITERATIONS[tier],
    targetingDensityThreshold: SERVER_SIM_DETAIL.TARGETING_DENSITY_THRESHOLD[tier],
    targetingDensityStride: SERVER_SIM_DETAIL.TARGETING_DENSITY_STRIDE[tier],
    forceFieldStride: SERVER_SIM_DETAIL.FORCE_FIELD_STRIDE[tier],
    captureStride: SERVER_SIM_DETAIL.CAPTURE_STRIDE[tier],
  };
}

const RESOLVED: Record<ConcreteServerSimQuality, ServerSimDetailConfig> = {
  min: buildDetail('min'),
  low: buildDetail('low'),
  medium: buildDetail('medium'),
  high: buildDetail('high'),
  max: buildDetail('max'),
};

export function getSimDetailConfig(): ServerSimDetailConfig {
  // Fast path: return the cache that tickSimQuality() filled at the
  // top of this tick. Fallback to the live resolver for paths that
  // run before the first tickSimQuality() (e.g. very first tick of a
  // new session) — costs one extra resolver pass, then the cache
  // takes over.
  return _cachedDetail ?? RESOLVED[getEffectiveSimQuality()];
}

export function getSimDetailConfigFor(
  quality: ConcreteServerSimQuality,
): ServerSimDetailConfig {
  return RESOLVED[quality];
}
