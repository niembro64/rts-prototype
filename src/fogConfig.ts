import rawFogConfig from './fogConfig.json';

type FogCapPolicy = 'evictOldest' | 'skipWhenFull';

type FogOfWarProfile = {
  maxPoolSize: number;
  capPolicy: FogCapPolicy;
  densitySamples: number;
  maxSpawnsPerFrame: number;
  spawnAttemptsPerFog: number;
  fadeInMs: number;
  fadeOutMs: number;
  radius: number;
  transparentOuterFraction: number;
  zMin: number;
  zRange: number;
};

type FogConfig = {
  fogOfWar: FogOfWarProfile;
};

const FOG_CONFIG_RAW = rawFogConfig as FogConfig;
const FOG_CAP_POLICY_SET = new Set<string>(['evictOldest', 'skipWhenFull']);

function assertFogCapPolicy(value: unknown, fieldName: string): asserts value is FogCapPolicy {
  if (typeof value === 'string' && FOG_CAP_POLICY_SET.has(value)) return;
  throw new Error(`${fieldName} must be "evictOldest" or "skipWhenFull"`);
}

assertFogCapPolicy(FOG_CONFIG_RAW.fogOfWar.capPolicy, 'fogConfig.fogOfWar.capPolicy');

export const FOG_CONFIG = FOG_CONFIG_RAW;
