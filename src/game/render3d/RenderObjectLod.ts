import type { ConcreteGraphicsQuality, GraphicsConfig } from '@/types/graphics';

export type RenderObjectLodTier =
  | 'hidden'
  | 'impostor'
  | 'mass'
  | 'simple'
  | 'rich'
  | 'hero';

const GRAPHICS_TIER_ORDER: Record<ConcreteGraphicsQuality, number> = {
  min: 0,
  low: 1,
  medium: 2,
  high: 3,
  max: 4,
};

const GRAPHICS_TIER_BY_ORDER: ConcreteGraphicsQuality[] = [
  'min',
  'low',
  'medium',
  'high',
  'max',
];

const MAX_GRAPHICS_TIER_BY_OBJECT: Record<RenderObjectLodTier, ConcreteGraphicsQuality> = {
  hidden: 'min',
  impostor: 'low',
  mass: 'medium',
  simple: 'high',
  rich: 'max',
  hero: 'max',
};

const SIMPLE_DISTANCE_MULTIPLIER = 1.6;
const MASS_DISTANCE_MULTIPLIER = 2.2;
const IMPOSTOR_DISTANCE_MULTIPLIER = 2.8;

export type RenderObjectLodShellDistances = {
  rich: number;
  simple: number;
  mass: number;
  impostor: number;
};

export function getRenderObjectLodShellDistances(gfx: GraphicsConfig): RenderObjectLodShellDistances {
  const rich = Math.max(0, gfx.richObjectDistance);
  return {
    rich,
    simple: rich * SIMPLE_DISTANCE_MULTIPLIER,
    mass: rich * MASS_DISTANCE_MULTIPLIER,
    impostor: rich * IMPOSTOR_DISTANCE_MULTIPLIER,
  };
}

export function resolveRenderObjectLodForDistanceSq(
  distanceSq: number,
  shells: RenderObjectLodShellDistances,
): RenderObjectLodTier {
  if (shells.rich > 0 && distanceSq <= shells.rich * shells.rich) return 'rich';
  if (shells.simple > 0 && distanceSq <= shells.simple * shells.simple) return 'simple';
  if (shells.mass > 0 && distanceSq <= shells.mass * shells.mass) return 'mass';
  if (shells.impostor > 0 && distanceSq <= shells.impostor * shells.impostor) return 'impostor';
  return 'hidden';
}

export function isRichObjectLod(tier: RenderObjectLodTier): boolean {
  return tier === 'rich' || tier === 'hero';
}

export function objectLodToGraphicsTier(
  objectTier: RenderObjectLodTier,
  globalTier: ConcreteGraphicsQuality,
): ConcreteGraphicsQuality {
  const objectMaxTier = MAX_GRAPHICS_TIER_BY_OBJECT[objectTier];
  const order = Math.min(GRAPHICS_TIER_ORDER[globalTier], GRAPHICS_TIER_ORDER[objectMaxTier]);
  return GRAPHICS_TIER_BY_ORDER[order];
}
