import type {
  ShieldReflectionMode,
  ShieldReflectionDirection,
  ActiveProjectileShot,
  RayConfig,
  RayType,
  EmissionConfig,
  ProjectileShot,
  ShieldConfig,
} from './blueprintSchema.generated';

export type {
  ActiveProjectileShot,
  BeamPoint,
  BeamReflectorKind,
  BeamRay,
  ShieldBarrierConfig,
  ShieldBarrierShape,
  
  ShieldReflectionDirection,
  
  ShieldReflectionPolicy,
  ShieldReflectionMode,
  
  ShieldConfig,
  EmissionConfig,
  LaserRay,

  ProjectileShot,
  
  ProjectileType,
  
  ShotConfig,
  ShotProfile,
  ShotRuntimeProfile,
  ShotVisualProfile,
  SmokeTrailSpec,
} from './blueprintSchema.generated';

/** Predicate on raw emission `type` strings, used at network / projectile
 *  layer boundaries where we have a string but not the full config. */
export function isRayType(t: string): t is RayType {
  return t === 'beam' || t === 'laser';
}

export const SHIELD_SURFACE_RESPONSES = ['reflect', 'absorb', 'passThrough'] as const;

export const SHIELD_REFLECTION_MODES = ['outside-in', 'inside-out', 'both'] as const;

export const SHIELD_REFLECTION_ENTITIES = [
  'plasma',
  'rocket',
  'missile',
  'beam',
  'laser',
] as const;

export function isShieldReflectionMode(value: unknown): value is ShieldReflectionMode {
  return value === 'outside-in' || value === 'inside-out' || value === 'both';
}

export function isShieldReflectionDirection(value: unknown): value is ShieldReflectionDirection {
  return (
    value === 'reflect-none' ||
    value === 'reflect-outside' ||
    value === 'reflect-inside' ||
    value === 'reflect-both'
  );
}

export function isRayConfig(emission: EmissionConfig): emission is RayConfig {
  return isRayType(emission.type);
}

export function isShieldConfig(emission: EmissionConfig): emission is ShieldConfig {
  return emission.type === 'shield';
}

export function isProjectileShot(emission: EmissionConfig): emission is ProjectileShot {
  return emission.type === 'plasma' || emission.type === 'rocket' || emission.type === 'missile';
}

export function getEmissionBlueprintId(emission: EmissionConfig | ActiveProjectileShot): string {
  if (emission.type === 'beam' || emission.type === 'laser') return emission.rayBlueprintId;
  if (emission.type === 'shield') return emission.shieldBlueprintId;
  return emission.shotBlueprintId;
}

/** Rocket-class predicate used for seeker behavior and visuals. */
export function isRocketLikeShot(emission: EmissionConfig): boolean {
  return isProjectileShot(emission) && (emission.type === 'rocket' || emission.type === 'missile');
}

/** Static max active time for runtime shot entities. Traveling shots
 *  can opt into authored time-to-live values; otherwise they terminate
 *  through collision/ground physics. */
export function getShotMaxLifespan(emission: EmissionConfig, fallbackLifespan: number = 2000): number {
  if (emission.type === 'beam') return Infinity;
  if (emission.type === 'laser') return emission.duration;
  if (emission.type === 'plasma' || emission.type === 'rocket' || emission.type === 'missile') {
    return Number.isFinite(emission.maxLifespan) ? emission.maxLifespan! : Infinity;
  }
  return fallbackLifespan;
}
