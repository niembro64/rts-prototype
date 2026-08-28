import rawSplashConfig from './splashConfig.json';
import { COLORS } from './colorsConfig';

// Physical/shape values live in splashConfig.json; shared visual colours live
// in colorsConfig.json. This shim converts authored degrees to radians and
// freezes one resolved table so renderer code cannot mutate either source.
//
// New tuning knobs should be authored in the JSON first; this file
// only mirrors the schema and applies the deg→rad conversions.

const DEG_TO_RAD = Math.PI / 180;

type GroupAngular = {
  // Spawn-direction cone bounds for this group, expressed as a base
  // angle from the upward axis plus a uniform-random range added on
  // top. Crown uses both; jet/spray use just the max (base = 0).
  thetaMinRad: number;
  thetaRangeRad: number;
};

type JetProfile = GroupAngular & {
  speedScaleMin: number;
  speedScaleRange: number;
  lateralCarryFactor: number;
  widthMultMin: number;
  widthMultRange: number;
  lifetimeMinMs: number;
  lifetimeRangeMs: number;
  lengthScale: number;
};

type LateralProfile = GroupAngular & {
  speedScaleMin: number;
  speedScaleRange: number;
  lateralCarryMultMin: number;
  lateralCarryMultRange: number;
  widthMultMin: number;
  widthMultRange: number;
  lifetimeMinMs: number;
  lifetimeRangeMs: number;
  lengthScale: number;
};

type SplashConfig = {
  pool: {
    maxDroplets: number;
    maxDropletsPerSpawn: number;
  };
  appearance: {
    waterBirthColorHex: number;
    waterDeathColorHex: number;
    waterRingColorHex: number;
    lavaBirthColorHex: number;
    lavaDeathColorHex: number;
    lavaRingColorHex: number;
    maxAlpha: number;
    fadeInFraction: number;
  };
  physics: {
    gravity: number;
  };
  descent: {
    minSpeed: number;
    velocityScale: number;
    downwardScale: number;
    massScale: number;
  };
  rebound: {
    verticalFraction: number;
    lateralCarryFraction: number;
  };
  count: {
    minTotal: number;
    massScale: number;
    energyDivisor: number;
    jetFraction: number;
    crownFraction: number;
  };
  dropletWidth: {
    min: number;
    massScale: number;
  };
  streak: {
    base: number;
    speedScale: number;
    widthFadePerLife: number;
    lengthFadePerLife: number;
  };
  jet: JetProfile;
  crown: LateralProfile;
  spray: LateralProfile;
  forwardBias: {
    weightedFraction: number;
    weightedHalfRangeRad: number;
  };
};

function buildConfig(): SplashConfig {
  const raw = rawSplashConfig as unknown as Record<string, any>;
  return Object.freeze<SplashConfig>({
    pool: Object.freeze({
      maxDroplets: raw.pool.maxDroplets,
      maxDropletsPerSpawn: raw.pool.maxDropletsPerSpawn,
    }),
    appearance: Object.freeze({
      waterBirthColorHex: COLORS.effects.liquidSplash.water.birthColorHex,
      waterDeathColorHex: COLORS.effects.liquidSplash.water.deathColorHex,
      waterRingColorHex: COLORS.effects.liquidSplash.water.ringColorHex,
      lavaBirthColorHex: COLORS.effects.liquidSplash.lava.birthColorHex,
      lavaDeathColorHex: COLORS.effects.liquidSplash.lava.deathColorHex,
      lavaRingColorHex: COLORS.effects.liquidSplash.lava.ringColorHex,
      maxAlpha: raw.appearance.maxAlpha,
      fadeInFraction: raw.appearance.fadeInFraction,
    }),
    physics: Object.freeze({ gravity: raw.physics.gravity }),
    descent: Object.freeze({
      minSpeed: raw.descent.minSpeed,
      velocityScale: raw.descent.velocityScale,
      downwardScale: raw.descent.downwardScale,
      massScale: raw.descent.massScale,
    }),
    rebound: Object.freeze({
      verticalFraction: raw.rebound.verticalFraction,
      lateralCarryFraction: raw.rebound.lateralCarryFraction,
    }),
    count: Object.freeze({
      minTotal: raw.count.minTotal,
      massScale: raw.count.massScale,
      energyDivisor: raw.count.energyDivisor,
      jetFraction: raw.count.jetFraction,
      crownFraction: raw.count.crownFraction,
    }),
    dropletWidth: Object.freeze({
      min: raw.dropletWidth.min,
      massScale: raw.dropletWidth.massScale,
    }),
    streak: Object.freeze({
      base: raw.streak.base,
      speedScale: raw.streak.speedScale,
      widthFadePerLife: raw.streak.widthFadePerLife,
      lengthFadePerLife: raw.streak.lengthFadePerLife,
    }),
    jet: Object.freeze({
      thetaMinRad: 0,
      thetaRangeRad: raw.jet.thetaMaxDeg * DEG_TO_RAD,
      speedScaleMin: raw.jet.speedScaleMin,
      speedScaleRange: raw.jet.speedScaleRange,
      lateralCarryFactor: raw.jet.lateralCarryFactor,
      widthMultMin: raw.jet.widthMultMin,
      widthMultRange: raw.jet.widthMultRange,
      lifetimeMinMs: raw.jet.lifetimeMinMs,
      lifetimeRangeMs: raw.jet.lifetimeRangeMs,
      lengthScale: raw.jet.lengthScale,
    }),
    crown: Object.freeze({
      thetaMinRad: raw.crown.thetaMinDeg * DEG_TO_RAD,
      thetaRangeRad: raw.crown.thetaRangeDeg * DEG_TO_RAD,
      speedScaleMin: raw.crown.speedScaleMin,
      speedScaleRange: raw.crown.speedScaleRange,
      lateralCarryMultMin: raw.crown.lateralCarryMultMin,
      lateralCarryMultRange: raw.crown.lateralCarryMultRange,
      widthMultMin: raw.crown.widthMultMin,
      widthMultRange: raw.crown.widthMultRange,
      lifetimeMinMs: raw.crown.lifetimeMinMs,
      lifetimeRangeMs: raw.crown.lifetimeRangeMs,
      lengthScale: raw.crown.lengthScale,
    }),
    spray: Object.freeze({
      thetaMinRad: 0,
      thetaRangeRad: raw.spray.thetaMaxDeg * DEG_TO_RAD,
      speedScaleMin: raw.spray.speedScaleMin,
      speedScaleRange: raw.spray.speedScaleRange,
      lateralCarryMultMin: raw.spray.lateralCarryMultMin,
      lateralCarryMultRange: raw.spray.lateralCarryMultRange,
      widthMultMin: raw.spray.widthMultMin,
      widthMultRange: raw.spray.widthMultRange,
      lifetimeMinMs: raw.spray.lifetimeMinMs,
      lifetimeRangeMs: raw.spray.lifetimeRangeMs,
      lengthScale: raw.spray.lengthScale,
    }),
    forwardBias: Object.freeze({
      weightedFraction: raw.forwardBias.weightedFraction,
      weightedHalfRangeRad: raw.forwardBias.weightedHalfRangeDeg * DEG_TO_RAD,
    }),
  });
}

export const SPLASH_CONFIG: SplashConfig = buildConfig();

export type SplashLiquidMode = 'water' | 'lava';

export function liquidSplashRingColor(mode: SplashLiquidMode): number {
  return mode === 'lava'
    ? SPLASH_CONFIG.appearance.lavaRingColorHex
    : SPLASH_CONFIG.appearance.waterRingColorHex;
}
