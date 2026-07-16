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

type EconomyConeHalfAnglesByBuilding = {
  readonly buildingExtractor: number;
  readonly buildingExtractorT2: number;
  readonly buildingSolar: number;
  readonly buildingWind: number;
  readonly buildingResourceConverter: number;
};

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

function rgb01Tuple(label: string, value: readonly number[]): readonly [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`resourceConfig.${label} must be a 3-component RGB tuple in [0, 1]`);
  }
  return [
    frac01(`${label}[0]`, value[0]),
    frac01(`${label}[1]`, value[1]),
    frac01(`${label}[2]`, value[2]),
  ] as const;
}

function posInt(label: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`resourceConfig.${label} must be an integer > 0; received ${value}`);
  }
  return value;
}

function economyConeHalfAnglesByBuilding(
  label: string,
  value: EconomyConeHalfAnglesByBuilding,
): EconomyConeHalfAnglesByBuilding {
  return {
    buildingExtractor: posNum(`${label}.buildingExtractor`, value.buildingExtractor),
    buildingExtractorT2: posNum(`${label}.buildingExtractorT2`, value.buildingExtractorT2),
    buildingSolar: posNum(`${label}.buildingSolar`, value.buildingSolar),
    buildingWind: posNum(`${label}.buildingWind`, value.buildingWind),
    buildingResourceConverter: posNum(
      `${label}.buildingResourceConverter`,
      value.buildingResourceConverter,
    ),
  };
}

const defaultBallsPerResourcePerSecond = posNum(
  'ballsPerResourcePerSecond',
  rawConfig.ballsPerResourcePerSecond,
);

export const RESOURCE_CONFIG = {
  /** balls/second spawned per (resource/second) of transfer. The single
   *  global resource-ball density across every pylon. */
  ballsPerResourcePerSecond: defaultBallsPerResourcePerSecond,
  metalExtractor: {
    rotorRadPerSecPerMetalRate: posNum(
      'metalExtractor.rotorRadPerSecPerMetalRate',
      rawConfig.metalExtractor.rotorRadPerSecPerMetalRate,
    ),
    rotorSpinMultiplier: posNum(
      'metalExtractor.rotorSpinMultiplier',
      rawConfig.metalExtractor.rotorSpinMultiplier,
    ),
    rotorSpinReflectsActualProduction:
      rawConfig.metalExtractor.rotorSpinReflectsActualProduction !== false,
    rotorPotentialRadPerSec: posNum(
      'metalExtractor.rotorPotentialRadPerSec',
      rawConfig.metalExtractor.rotorPotentialRadPerSec,
    ),
  },
  /** Resource-ball spray-cone half-angles (radians). Every pylon aims a
   *  ray from its tip at a lock-on spot and disperses its resource balls
   *  inside a cone of this half-angle around that ray (see
   *  budget_design_philosophy.html "Resource Movement Flows Through
   *  Pylons"). Construction emitters spray a tight cone at the build
   *  site; each economy building can tune its own cone at its environment
   *  source. */
  cone: {
    constructionHalfAngleRad: posNum('cone.constructionHalfAngleRad', rawConfig.cone.constructionHalfAngleRad),
    economyHalfAngleRad: economyConeHalfAnglesByBuilding(
      'cone.economyHalfAngleRad',
      rawConfig.cone.economyHalfAngleRad,
    ),
  },
  spray: {
    /** Default trail altitude for legacy 2D spray targets. */
    trailY: nonNegNum('spray.trailY', rawConfig.spray.trailY),
    minFlightSec: posNum('spray.minFlightSec', rawConfig.spray.minFlightSec),
    maxSpawnsPerSprayFrame: posInt('spray.maxSpawnsPerSprayFrame', rawConfig.spray.maxSpawnsPerSprayFrame),
    maxParticlesPerSpray: posInt('spray.maxParticlesPerSpray', rawConfig.spray.maxParticlesPerSpray),
    maxParticles: posInt('spray.maxParticles', rawConfig.spray.maxParticles),
    healRgb01: rgb01Tuple('spray.healRgb01', rawConfig.spray.healRgb01),
    particleAlpha: frac01('spray.particleAlpha', rawConfig.spray.particleAlpha),
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

/** Visual extractor rotor speed, in radians per second per (metal/second)
 *  of live extraction, before the authored visual-only spin multiplier.
 *  Spin is tied directly to throughput — no per-tier normalization — so a
 *  higher-yield (e.g. advanced) extractor spins proportionally faster. */
export const EXTRACTOR_ROTOR_RAD_PER_SEC_PER_METAL_RATE =
  RESOURCE_CONFIG.metalExtractor.rotorRadPerSecPerMetalRate;
export const METAL_EXTRACTOR_ROTOR_SPIN_MULTIPLIER =
  RESOURCE_CONFIG.metalExtractor.rotorSpinMultiplier;
/** When true the extractor rotor spins proportional to its live (actual)
 *  metal throughput; when false every deposit-covered extractor spins at the
 *  flat "potential" rate below regardless of how much it is currently pulling. */
export const EXTRACTOR_ROTOR_SPIN_REFLECTS_ACTUAL_PRODUCTION =
  RESOURCE_CONFIG.metalExtractor.rotorSpinReflectsActualProduction;
export const EXTRACTOR_ROTOR_POTENTIAL_RAD_PER_SEC =
  RESOURCE_CONFIG.metalExtractor.rotorPotentialRadPerSec;

/** Spray-cone half-angle (radians) for construction emitters — the tight
 *  cone a builder/factory tip aims at its build site. */
export const PYLON_CONSTRUCTION_CONE_HALF_ANGLE_RAD = RESOURCE_CONFIG.cone.constructionHalfAngleRad;

/** Spray-cone half-angle (radians), keyed by economy building blueprint id. */
const PYLON_ECONOMY_CONE_HALF_ANGLE_RAD_BY_BUILDING =
  RESOURCE_CONFIG.cone.economyHalfAngleRad;

/** Spray-cone half-angle (radians) for an extractor pylon aimed at its
 *  metal deposit source. */
export const PYLON_BUILDING_EXTRACTOR_CONE_HALF_ANGLE_RAD =
  PYLON_ECONOMY_CONE_HALF_ANGLE_RAD_BY_BUILDING.buildingExtractor;

/** Spray-cone half-angle (radians) for a solar pylon aimed at its sky
 *  source. */
export const PYLON_BUILDING_SOLAR_CONE_HALF_ANGLE_RAD =
  PYLON_ECONOMY_CONE_HALF_ANGLE_RAD_BY_BUILDING.buildingSolar;

/** Spray-cone half-angle (radians) for a wind pylon aimed at its wind
 *  source. */
export const PYLON_BUILDING_WIND_CONE_HALF_ANGLE_RAD =
  PYLON_ECONOMY_CONE_HALF_ANGLE_RAD_BY_BUILDING.buildingWind;

/** Spray-cone half-angle (radians) for a resource converter pylon aimed
 *  at the opposing converter pylon. */
export const PYLON_BUILDING_RESOURCE_CONVERTER_CONE_HALF_ANGLE_RAD =
  PYLON_ECONOMY_CONE_HALF_ANGLE_RAD_BY_BUILDING.buildingResourceConverter;

/** Convert an absolute resource transfer rate (resources/second) into a
 *  ball spawn rate (balls/second). Negative/zero rates produce 0. */
export function ballSpawnRateForResourceRate(resourceRatePerSecond: number): number {
  if (!Number.isFinite(resourceRatePerSecond) || resourceRatePerSecond <= 0) return 0;
  return resourceRatePerSecond * RESOURCE_CONFIG.ballsPerResourcePerSecond;
}
