import rawWindConfig from './windConfig.json';
import {
  assertBoolean,
  assertFiniteNumberInRange,
  assertNonNegativeFiniteNumber as assertNonNegative,
  assertPositiveFiniteNumber as assertPositive,
  assertPositiveInteger,
  assertSixDigitCssHex as assertCssHex,
} from './configValidation';

type WindParticleConfig = {
  enabled: boolean;
  speedMultiplier: number;
  maxParticles: number;
  colorHex: string;
  alpha: number;
  radiusWorld: number;
  /** Minimum projected particle size so far particles never collapse into
   *  sub-pixel shimmer. */
  minScreenSizePx: number;
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
assertFiniteNumberInRange(config.alpha, 'windConfig.particles.alpha', 0, 1);
assertPositive(config.radiusWorld, 'windConfig.particles.radiusWorld');
assertPositive(config.minScreenSizePx, 'windConfig.particles.minScreenSizePx');
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
assertFiniteNumberInRange(
  config.gustVisibleFraction,
  'windConfig.particles.gustVisibleFraction',
  0,
  1,
);
assertFiniteNumberInRange(
  config.nearFadeFraction,
  'windConfig.particles.nearFadeFraction',
  0,
  1,
);
assertFiniteNumberInRange(
  config.farFadeStartFraction,
  'windConfig.particles.farFadeStartFraction',
  0,
  1,
);

export const WIND_PARTICLE_CONFIG = config;
