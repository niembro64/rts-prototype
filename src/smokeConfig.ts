import type { ShotBlueprintId } from './types/blueprintIds';
import type { SmokeTrailSpec } from './types/shotTypes';
import rawSmokeConfig from './smokeConfig.json';

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

export type SmokeCapPolicy = 'evictOldest' | 'skipWhenFull';

export type SmokeProfile = {
  maxPoolSize: number;
  capPolicy: SmokeCapPolicy;
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

const SMOKE_CONFIG_RAW = rawSmokeConfig as SmokeConfig;

const SMOKE_USE_ID_SET = new Set<string>(SMOKE_USE_IDS);
const SMOKE_CAP_POLICY_SET = new Set<string>(['evictOldest', 'skipWhenFull']);

function assertSmokeCapPolicy(value: unknown, fieldName: string): asserts value is SmokeCapPolicy {
  if (typeof value === 'string' && SMOKE_CAP_POLICY_SET.has(value)) return;
  throw new Error(`${fieldName} must be "evictOldest" or "skipWhenFull"`);
}

for (const useId of SMOKE_USE_IDS) {
  assertSmokeCapPolicy(SMOKE_CONFIG_RAW[useId].capPolicy, `smokeConfig.${useId}.capPolicy`);
}

export const SMOKE_CONFIG = SMOKE_CONFIG_RAW;

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
  shotBlueprintId: ShotBlueprintId,
  override?: SmokeTrailSpec,
): SmokeTrailSpec | undefined {
  if (!isSmokeUseId(shotBlueprintId)) return undefined;
  return {
    ...getSmokeProfile(shotBlueprintId),
    ...override,
  };
}
