import type { CameraSphereRadii, ConcreteGraphicsQuality, GraphicsConfig } from '@/types/graphics';

export type RenderObjectLodTier =
  // Outside the impostor sphere. World objects draw cheap marker
  // spheres at this tier; effects may still skip it for budget reasons.
  | 'marker'
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
  marker: 'min',
  impostor: 'low',
  mass: 'medium',
  simple: 'high',
  rich: 'max',
  hero: 'max',
};

const CAMERA_SPHERE_GRAPHICS_TIER_BY_OBJECT: Record<RenderObjectLodTier, ConcreteGraphicsQuality> = {
  marker: 'min',
  impostor: 'low',
  mass: 'medium',
  simple: 'high',
  rich: 'max',
  hero: 'max',
};

export type RenderObjectLodShellDistances = CameraSphereRadii;

function normalizeEnabledShellRadius(rawRadius: number, minEnabledRadius: number): number {
  if (!Number.isFinite(rawRadius) || rawRadius <= 0) return 0;
  return Math.max(minEnabledRadius, rawRadius);
}

export function getRenderObjectLodShellDistances(gfx: GraphicsConfig): RenderObjectLodShellDistances {
  // A radius <= 0 means that shell is intentionally disabled. Preserve
  // that zero so both the LOD resolver and the debug ground-ring renderer
  // skip it. Enabled shells are still clamped outward so accidental
  // out-of-order radii cannot invert the LOD bands.
  const rich = normalizeEnabledShellRadius(gfx.cameraSphereRadii.rich, 0);
  const simple = normalizeEnabledShellRadius(gfx.cameraSphereRadii.simple, rich);
  const mass = normalizeEnabledShellRadius(gfx.cameraSphereRadii.mass, Math.max(rich, simple));
  const impostor = normalizeEnabledShellRadius(
    gfx.cameraSphereRadii.impostor,
    Math.max(rich, simple, mass),
  );
  return {
    rich,
    simple,
    mass,
    impostor,
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
  return 'marker';
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

export function objectLodToCameraSphereGraphicsTier(
  objectTier: RenderObjectLodTier,
): ConcreteGraphicsQuality {
  return CAMERA_SPHERE_GRAPHICS_TIER_BY_OBJECT[objectTier];
}
