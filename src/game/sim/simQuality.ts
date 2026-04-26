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

export function getEffectiveSimQuality(): ConcreteServerSimQuality {
  switch (currentQuality) {
    case 'auto': {
      // AUTO = min over every signal. Each sub-mode keeps its own
      // running rank so hysteresis state survives a swap to the
      // dedicated mode and back.
      prevTpsRank = ratioToRank(currentTpsRatio, TPS_THRESHOLDS, prevTpsRank, SERVER_SIM_HYSTERESIS.tps);
      prevCpuRank = ratioToRank(currentCpuRatio, CPU_THRESHOLDS, prevCpuRank, SERVER_SIM_HYSTERESIS.cpu);
      prevUnitsRank = ratioToRank(unitsRatio(), UNITS_THRESHOLDS, prevUnitsRank, SERVER_SIM_HYSTERESIS.units);
      return RANK_TO_QUALITY[Math.min(prevTpsRank, prevCpuRank, prevUnitsRank)];
    }
    case 'auto-tps':
      prevTpsRank = ratioToRank(currentTpsRatio, TPS_THRESHOLDS, prevTpsRank, SERVER_SIM_HYSTERESIS.tps);
      return RANK_TO_QUALITY[prevTpsRank];
    case 'auto-cpu':
      prevCpuRank = ratioToRank(currentCpuRatio, CPU_THRESHOLDS, prevCpuRank, SERVER_SIM_HYSTERESIS.cpu);
      return RANK_TO_QUALITY[prevCpuRank];
    case 'auto-units':
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

const RESOLVED: Record<ConcreteServerSimQuality, ServerSimDetailConfig> = {
  min: buildDetail('min'),
  low: buildDetail('low'),
  medium: buildDetail('medium'),
  high: buildDetail('high'),
  max: buildDetail('max'),
};

function buildDetail(tier: ConcreteServerSimQuality): ServerSimDetailConfig {
  return {
    tier,
    targetingReacquireStride: SERVER_SIM_DETAIL.TARGETING_REACQUIRE_STRIDE[tier],
    beamPathStride: SERVER_SIM_DETAIL.BEAM_PATH_STRIDE[tier],
    mirrorBisectorIterations: SERVER_SIM_DETAIL.MIRROR_BISECTOR_ITERATIONS[tier],
    targetingDensityThreshold: SERVER_SIM_DETAIL.TARGETING_DENSITY_THRESHOLD[tier],
    targetingDensityStride: SERVER_SIM_DETAIL.TARGETING_DENSITY_STRIDE[tier],
  };
}

export function getSimDetailConfig(): ServerSimDetailConfig {
  return RESOLVED[getEffectiveSimQuality()];
}

export function getSimDetailConfigFor(
  quality: ConcreteServerSimQuality,
): ServerSimDetailConfig {
  return RESOLVED[quality];
}
