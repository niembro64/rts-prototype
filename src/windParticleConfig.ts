import rawWindConfig from './windConfig.json';

type WindParticleConfig = {
  enabled: boolean;
  speedMultiplier: number;
  maxParticles: number;
  colorHex: string;
  alpha: number;
  /** Streak tail alpha as a fraction of the tip alpha (bright tip → dim tail). */
  tailAlphaFraction: number;
  streakWidthWorld: number;
  /** Streak length = wind speed (world/s, after speedMultiplier) × this. */
  streakSecondsOfTravel: number;
  /** Minimum projected streak length so far streaks never collapse into
   *  sub-pixel shimmer. */
  minScreenLengthPx: number;
  lowerPlaneDistanceAboveWaterLevelWorld: number;
  upperPlaneDistanceAboveHighestTerrainWorld: number;
  /** Follow-volume half-extent = viewScale × this. */
  viewRangeMultiplier: number;
  minViewScaleWorld: number;
  maxViewScaleWorld: number;
  /** World size of one gust band in the visibility noise field. */
  gustScaleWorld: number;
  /** Approximate fraction of streaks visible at any moment (gust bands). */
  gustVisibleFraction: number;
  /** Near-camera fade distance as a fraction of viewScale. */
  nearFadeFraction: number;
  /** Distance (fraction of the follow-volume reach) where the far fade starts. */
  farFadeStartFraction: number;
};

const config = rawWindConfig.particles as WindParticleConfig;

assertBoolean(config.enabled, 'windConfig.particles.enabled');
assertPositive(config.speedMultiplier, 'windConfig.particles.speedMultiplier');
assertPositiveInteger(config.maxParticles, 'windConfig.particles.maxParticles');
assertCssHex(config.colorHex, 'windConfig.particles.colorHex');
assertUnitInterval(config.alpha, 'windConfig.particles.alpha');
assertUnitInterval(config.tailAlphaFraction, 'windConfig.particles.tailAlphaFraction');
assertPositive(config.streakWidthWorld, 'windConfig.particles.streakWidthWorld');
assertPositive(config.streakSecondsOfTravel, 'windConfig.particles.streakSecondsOfTravel');
assertPositive(config.minScreenLengthPx, 'windConfig.particles.minScreenLengthPx');
assertNonNegative(
  config.lowerPlaneDistanceAboveWaterLevelWorld,
  'windConfig.particles.lowerPlaneDistanceAboveWaterLevelWorld',
);
assertNonNegative(
  config.upperPlaneDistanceAboveHighestTerrainWorld,
  'windConfig.particles.upperPlaneDistanceAboveHighestTerrainWorld',
);
assertPositive(config.viewRangeMultiplier, 'windConfig.particles.viewRangeMultiplier');
assertPositive(config.minViewScaleWorld, 'windConfig.particles.minViewScaleWorld');
assertPositive(config.maxViewScaleWorld, 'windConfig.particles.maxViewScaleWorld');
if (config.maxViewScaleWorld < config.minViewScaleWorld) {
  throw new Error('windConfig.particles.maxViewScaleWorld must be >= minViewScaleWorld');
}
assertPositive(config.gustScaleWorld, 'windConfig.particles.gustScaleWorld');
assertUnitInterval(config.gustVisibleFraction, 'windConfig.particles.gustVisibleFraction');
assertUnitInterval(config.nearFadeFraction, 'windConfig.particles.nearFadeFraction');
assertUnitInterval(config.farFadeStartFraction, 'windConfig.particles.farFadeStartFraction');

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
