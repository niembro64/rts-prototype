import type { ShotId } from './types/blueprintIds';
import type { SmokeTrailSpec } from './types/shotTypes';
import rawSmokeConfig from './smoke_config.json';

export const SMOKE_USE_IDS = [
  'lightRocket',
  'fastRocket',
  'hovercraft',
  'dragonflyHovercraft',
  'eagleFlying',
] as const;

export type SmokeUseId = typeof SMOKE_USE_IDS[number];
export type HoverSmokeUseId = Extract<SmokeUseId, 'hovercraft' | 'dragonflyHovercraft'>;
export type FlyingSmokeUseId = Extract<SmokeUseId, 'eagleFlying'>;

export type SmokePuffGeometryConfig = {
  widthSegments: number;
  heightSegments: number;
};

export type SmokeProfile = {
  maxPoolSize: number;
  emitFramesSkip: number;
  exhaustSpeed: number;
  fadeInMs: number;
  fadeOutMs: number;
  startRadius: number;
  endRadiusMultiplier: number;
  maxAlpha: number;
  color?: number;
};

export type ResolvedSmokeProfile = SmokeProfile & {
  useId: SmokeUseId;
};

export type SmokeConfig = Record<SmokeUseId, SmokeProfile> & {
  puffGeometry: SmokePuffGeometryConfig;
};

export const SMOKE_CONFIG = rawSmokeConfig as SmokeConfig;

const SMOKE_USE_ID_SET = new Set<string>(SMOKE_USE_IDS);

export function isSmokeUseId(value: string): value is SmokeUseId {
  return SMOKE_USE_ID_SET.has(value);
}

export function getSmokeProfile(useId: SmokeUseId): ResolvedSmokeProfile {
  return {
    useId,
    ...SMOKE_CONFIG[useId],
  };
}

export function getSmokePoolMaxParticles(): number {
  let total = 0;
  for (const profile of Object.values(SMOKE_CONFIG)) {
    if ('maxPoolSize' in profile) total += profile.maxPoolSize;
  }
  return Math.max(1, total);
}

export function getSmokePuffGeometryConfig(): SmokePuffGeometryConfig {
  return SMOKE_CONFIG.puffGeometry;
}

export function getProjectileSmokeTrailSpec(
  shotId: ShotId,
  override?: SmokeTrailSpec,
): SmokeTrailSpec | undefined {
  if (!isSmokeUseId(shotId)) return undefined;
  return {
    ...getSmokeProfile(shotId),
    ...override,
  };
}
