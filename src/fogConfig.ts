import rawFogConfig from './fogConfig.json';

export type FogCapPolicy = 'evictOldest' | 'skipWhenFull';

export type FogOfWarProfile = {
  maxPoolSize: number;
  capPolicy: FogCapPolicy;
  densitySamples: number;
  maxSpawnsPerFrame: number;
  spawnAttemptsPerFog: number;
  fadeInMs: number;
  fadeOutMs: number;
  radius: number;
  maxAlpha: number;
  transparentOuterFraction: number;
  colorHex: string;
  zMin: number;
  zRange: number;
};

export type FogSphereGeometryConfig = {
  widthSegments: number;
  heightSegments: number;
};

export type FogConfig = {
  fogOfWar: FogOfWarProfile;
  sphereGeometry: FogSphereGeometryConfig;
};

const FOG_CONFIG_RAW = rawFogConfig as FogConfig;
const FOG_CAP_POLICY_SET = new Set<string>(['evictOldest', 'skipWhenFull']);

function assertFogCapPolicy(value: unknown, fieldName: string): asserts value is FogCapPolicy {
  if (typeof value === 'string' && FOG_CAP_POLICY_SET.has(value)) return;
  throw new Error(`${fieldName} must be "evictOldest" or "skipWhenFull"`);
}

assertFogCapPolicy(FOG_CONFIG_RAW.fogOfWar.capPolicy, 'fogConfig.fogOfWar.capPolicy');

export const FOG_CONFIG = FOG_CONFIG_RAW;

export function cssHexToNumber(value: string, fieldName: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) throw new Error(`${fieldName} must be a CSS hex color like #cccccc`);
  return Number.parseInt(match[1], 16);
}
