import rawWindConfig from './windConfig.json';

type WindParticleConfig = {
  enabled: boolean;
  speedMultiplier: number;
  maxParticles: number;
  colorHex: string;
  alpha: number;
  radiusWorld: number;
  fieldPaddingWorld: number;
  heightAboveSurfaceWorld: {
    min: number;
    max: number;
  };
  lifetimeSeconds: {
    min: number;
    max: number;
  };
  fadeFraction: number;
};

const config = rawWindConfig.particles as WindParticleConfig;

assertBoolean(config.enabled, 'windConfig.particles.enabled');
assertPositive(config.speedMultiplier, 'windConfig.particles.speedMultiplier');
assertPositiveInteger(config.maxParticles, 'windConfig.particles.maxParticles');
assertCssHex(config.colorHex, 'windConfig.particles.colorHex');
assertUnitInterval(config.alpha, 'windConfig.particles.alpha');
assertPositive(config.radiusWorld, 'windConfig.particles.radiusWorld');
assertNonNegative(config.fieldPaddingWorld, 'windConfig.particles.fieldPaddingWorld');
assertRange(
  config.heightAboveSurfaceWorld.min,
  config.heightAboveSurfaceWorld.max,
  'windConfig.particles.heightAboveSurfaceWorld',
  0,
);
assertRange(
  config.lifetimeSeconds.min,
  config.lifetimeSeconds.max,
  'windConfig.particles.lifetimeSeconds',
  Number.EPSILON,
);
assertUnitInterval(config.fadeFraction, 'windConfig.particles.fadeFraction');

export const WIND_PARTICLE_CONFIG = config;

function assertBoolean(value: unknown, fieldName: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new Error(`${fieldName} must be a boolean`);
}

function assertPositiveInteger(value: unknown, fieldName: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
}

function assertPositive(value: unknown, fieldName: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive finite number`);
  }
}

function assertNonNegative(value: unknown, fieldName: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative finite number`);
  }
}

function assertUnitInterval(value: unknown, fieldName: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${fieldName} must be a finite number from 0 through 1`);
  }
}

function assertCssHex(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`${fieldName} must be a six-digit CSS hex color`);
  }
}

function assertRange(min: unknown, max: unknown, fieldName: string, floor: number): void {
  if (
    typeof min !== 'number' || !Number.isFinite(min) || min < floor ||
    typeof max !== 'number' || !Number.isFinite(max) || max < min
  ) {
    throw new Error(`${fieldName} must have finite min/max values with ${floor} <= min <= max`);
  }
}
