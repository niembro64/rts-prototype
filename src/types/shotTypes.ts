import type {
  ForceFieldReflectionMode,
  LineShot,
  LineShotBlueprint,
  LineShotType,
  ProjectileShot,
  ShotBlueprint,
  ShotConfig,
} from './blueprintSchema.generated';

export type {
  ActiveProjectileShot,
  BeamPoint,
  BeamReflectorKind,
  BeamShot,
  BeamShotBlueprint,
  ForceFieldBarrierConfig,
  ForceFieldBarrierRatioConfig,
  ForceFieldMaterialBlueprint,
  ForceFieldMaterialVisualConfig,
  ForceFieldReflectionMode,
  ForceFieldShotBlueprint,
  ForceFieldSurfaceResponse,
  ForceShot,
  LaserShot,
  LaserShotBlueprint,
  LineShot,
  LineShotBlueprint,
  LineShotType,
  ProjectileShot,
  ProjectileShotBlueprint,
  ProjectileShotKind,
  ProjectileTailShape,
  ProjectileType,
  ShotBlueprint,
  ShotCollision,
  ShotConfig,
  ShotExplosion,
  ShotProfile,
  ShotRuntimeProfile,
  ShotRuntimeType,
  ShotVisualProfile,
  SmokeTrailSpec,
  SubmunitionSpec,
} from './blueprintSchema.generated';

/** The set of `shot.type` values that force-field panels reflect. Adding
 *  one here automatically wires the new type into the aim solver,
 *  panel hit collision, and beam-trace reflection. */
export const LINE_SHOT_TYPES = ['beam', 'laser'] as const;

/** Predicate on raw `shot.type` strings, used at network / projectile
 *  layer boundaries where we have a string but not the full ShotConfig. */
export function isLineShotType(t: string): t is LineShotType {
  return t === 'beam' || t === 'laser';
}

export const FORCE_FIELD_SURFACE_RESPONSES = ['reflect', 'absorb', 'passThrough'] as const;

export const FORCE_FIELD_REFLECTION_MODES = ['outside-in', 'inside-out', 'both'] as const;

export function isForceFieldReflectionMode(value: unknown): value is ForceFieldReflectionMode {
  return value === 'outside-in' || value === 'inside-out' || value === 'both';
}

/** Blueprint-side counterpart of `isLineShot`. */
export function isLineShotBlueprint(sb: ShotBlueprint): sb is LineShotBlueprint {
  return isLineShotType(sb.type);
}

/** Predicate on a full ShotConfig. */
export function isLineShot(shot: ShotConfig): shot is LineShot {
  return isLineShotType(shot.type);
}

export function isProjectileShot(shot: ShotConfig): shot is ProjectileShot {
  return shot.type === 'plasma' || shot.type === 'rocket';
}

/** Rocket-class predicate used for seeker behavior and visuals. */
export function isRocketLikeShot(shot: ShotConfig): boolean {
  return isProjectileShot(shot) && shot.type === 'rocket';
}

/** Static max active time for runtime shot entities. Traveling shots
 *  can opt into authored time-to-live values; otherwise they terminate
 *  through collision/ground physics. */
export function getShotMaxLifespan(shot: ShotConfig, fallbackLifespan: number = 2000): number {
  if (shot.type === 'beam') return Infinity;
  if (shot.type === 'laser') return shot.duration;
  if (shot.type === 'plasma' || shot.type === 'rocket') {
    return Number.isFinite(shot.maxLifespan) ? shot.maxLifespan! : Infinity;
  }
  return fallbackLifespan;
}
