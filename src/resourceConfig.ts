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

export type ResourceBallDensityOption = {
  readonly value: number;
  readonly label: string;
};

export type EconomyConeHalfAnglesByBuilding = {
  readonly buildingExtractor: number;
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

function resourceBallDensityOptions(
  label: string,
  value: readonly { readonly value: number; readonly label: string }[],
  defaultValue: number,
): readonly ResourceBallDensityOption[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`resourceConfig.${label} must be a non-empty option array`);
  }
  let defaultFound = false;
  const options: ResourceBallDensityOption[] = [];
  for (let i = 0; i < value.length; i++) {
    const rawOption = value[i];
    const optionValue = posNum(`${label}[${i}].value`, rawOption.value);
    const optionLabel = rawOption.label;
    if (typeof optionLabel !== 'string' || optionLabel.length === 0) {
      throw new Error(`resourceConfig.${label}[${i}].label must be a non-empty string`);
    }
    if (optionValue === defaultValue) defaultFound = true;
    options.push({ value: optionValue, label: optionLabel });
  }
  if (!defaultFound) {
    throw new Error(`resourceConfig.${label} must include ballsPerResourcePerSecond default ${defaultValue}`);
  }
  return options;
}

function economyConeHalfAnglesByBuilding(
  label: string,
  value: EconomyConeHalfAnglesByBuilding,
): EconomyConeHalfAnglesByBuilding {
  return {
    buildingExtractor: posNum(`${label}.buildingExtractor`, value.buildingExtractor),
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
   *  global toggle for resource-ball density across every pylon. */
  ballsPerResourcePerSecond: defaultBallsPerResourcePerSecond,
  ballsPerResourcePerSecondOptions: resourceBallDensityOptions(
    'ballsPerResourcePerSecondOptions',
    rawConfig.ballsPerResourcePerSecondOptions,
    defaultBallsPerResourcePerSecond,
  ),
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

export const RESOURCE_BALL_DENSITY_OPTIONS = RESOURCE_CONFIG.ballsPerResourcePerSecondOptions;

/** Spray-cone half-angle (radians) for construction emitters — the tight
 *  cone a builder/factory tip aims at its build site. */
export const PYLON_CONSTRUCTION_CONE_HALF_ANGLE_RAD = RESOURCE_CONFIG.cone.constructionHalfAngleRad;

/** Spray-cone half-angle (radians), keyed by economy building blueprint id. */
export const PYLON_ECONOMY_CONE_HALF_ANGLE_RAD_BY_BUILDING =
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

/** Default balls/second spawned per (resource/second) of transfer. */
export const DEFAULT_BALLS_PER_RESOURCE_PER_SECOND = RESOURCE_CONFIG.ballsPerResourcePerSecond;

let activeBallsPerResourcePerSecond = DEFAULT_BALLS_PER_RESOURCE_PER_SECOND;

export function getBallsPerResourcePerSecond(): number {
  return activeBallsPerResourcePerSecond;
}

export function setBallsPerResourcePerSecond(value: number): void {
  activeBallsPerResourcePerSecond = posNum('activeBallsPerResourcePerSecond', value);
}

export function isResourceBallDensityOption(value: number): boolean {
  return RESOURCE_BALL_DENSITY_OPTIONS.some((opt) => opt.value === value);
}

/** Convert an absolute resource transfer rate (resources/second) into a
 *  ball spawn rate (balls/second). Negative/zero rates produce 0. */
export function ballSpawnRateForResourceRate(resourceRatePerSecond: number): number {
  if (!Number.isFinite(resourceRatePerSecond) || resourceRatePerSecond <= 0) return 0;
  return resourceRatePerSecond * activeBallsPerResourcePerSecond;
}
