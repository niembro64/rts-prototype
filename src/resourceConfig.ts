// Global resource-ball configuration. This is renderer-only tuning
// (resource balls are off-wire / anonymous — see budget_design_philosophy.html
// "Resource Movement Flows Through Pylons"), so there is no Rust side.
//
// The headline knob is `ballsPerResourcePerSecond`: resource balls are
// generated from the ABSOLUTE resource transfer rate, not from any per-unit
// cap. The renderers spawn balls at
//
//     ballsPerSecond = resourceTransferRatePerSecond * ballsPerResourcePerSecond
//
// so two pylons moving the same resources/second show the same ball density
// regardless of how big each host's cap is. Raise the scalar to make more
// balls appear globally for the same transfer rate; lower it for fewer.
//
// The remaining fields are the resource-ball visual tuning constants that
// previously lived as hardcoded literals inside SprayRenderer3D /
// PylonTubeFlowRenderer; they now live here as data (Config Is Data, Not Code).

import rawConfig from './resourceConfig.json';

function posNum(label: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`resourceConfig.${label} must be a finite number > 0; received ${value}`);
  }
  return value;
}

function nonNegNum(label: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`resourceConfig.${label} must be a finite number >= 0; received ${value}`);
  }
  return value;
}

function frac01(label: string, value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`resourceConfig.${label} must be a finite number in [0, 1]; received ${value}`);
  }
  return value;
}

function posInt(label: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`resourceConfig.${label} must be an integer > 0; received ${value}`);
  }
  return value;
}

export const RESOURCE_CONFIG = {
  /** balls/second spawned per (resource/second) of transfer. The single
   *  global toggle for resource-ball density across every pylon. */
  ballsPerResourcePerSecond: posNum('ballsPerResourcePerSecond', rawConfig.ballsPerResourcePerSecond),
  spray: {
    /** Default trail altitude for legacy 2D spray targets. */
    trailY: nonNegNum('spray.trailY', rawConfig.spray.trailY),
    minFlightSec: posNum('spray.minFlightSec', rawConfig.spray.minFlightSec),
    maxSpawnsPerSprayFrame: posInt('spray.maxSpawnsPerSprayFrame', rawConfig.spray.maxSpawnsPerSprayFrame),
    maxParticlesPerSpray: posInt('spray.maxParticlesPerSpray', rawConfig.spray.maxParticlesPerSpray),
    maxParticles: posInt('spray.maxParticles', rawConfig.spray.maxParticles),
    healParticleSpeed: posNum('spray.healParticleSpeed', rawConfig.spray.healParticleSpeed),
    healMaxFlightSec: posNum('spray.healMaxFlightSec', rawConfig.spray.healMaxFlightSec),
    healParticleBaseRadius: posNum('spray.healParticleBaseRadius', rawConfig.spray.healParticleBaseRadius),
  },
  tube: {
    maxBeads: posInt('tube.maxBeads', rawConfig.tube.maxBeads),
    maxBeadsPerTube: posInt('tube.maxBeadsPerTube', rawConfig.tube.maxBeadsPerTube),
    beadSpacingMult: posNum('tube.beadSpacingMult', rawConfig.tube.beadSpacingMult),
    endFadeFrac: frac01('tube.endFadeFrac', rawConfig.tube.endFadeFrac),
    baseAlpha: frac01('tube.baseAlpha', rawConfig.tube.baseAlpha),
    maxSpawnsPerFlowFrame: posInt('tube.maxSpawnsPerFlowFrame', rawConfig.tube.maxSpawnsPerFlowFrame),
    runtimePruneAfterFrames: posInt('tube.runtimePruneAfterFrames', rawConfig.tube.runtimePruneAfterFrames),
  },
} as const;

/** balls/second spawned per (resource/second) of transfer. */
export const BALLS_PER_RESOURCE_PER_SECOND = RESOURCE_CONFIG.ballsPerResourcePerSecond;

/** Convert an absolute resource transfer rate (resources/second) into a
 *  ball spawn rate (balls/second). Negative/zero rates produce 0. */
export function ballSpawnRateForResourceRate(resourceRatePerSecond: number): number {
  if (!Number.isFinite(resourceRatePerSecond) || resourceRatePerSecond <= 0) return 0;
  return resourceRatePerSecond * RESOURCE_CONFIG.ballsPerResourcePerSecond;
}
