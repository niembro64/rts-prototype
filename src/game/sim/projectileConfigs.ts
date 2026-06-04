import type { ActiveProjectileShot, ProjectileConfig, TurretConfig } from './types';
import { getEmissionBlueprintId } from './types';
import { isShotBlueprintId, isTurretBlueprintId, type ShotBlueprintId, type TurretBlueprintId } from '../../types/blueprintIds';
import { buildProjectileShotConfig } from './blueprints';
import { TURRET_CONFIGS } from './turretConfigs';
import { getShotProfile } from './shotProfiles';

const _shotConfigCache = new Map<ShotBlueprintId, ActiveProjectileShot>();

function getShotOnlyConfig(shotBlueprintId: ShotBlueprintId): ActiveProjectileShot {
  const cached = _shotConfigCache.get(shotBlueprintId);
  if (cached) return cached;
  const shot = buildProjectileShotConfig(shotBlueprintId);
  _shotConfigCache.set(shotBlueprintId, shot);
  return shot;
}

export function createProjectileConfigFromTurret(
  turretConfig: TurretConfig,
  turretIndex: number | undefined = undefined,
): ProjectileConfig {
  const shot = turretConfig.shot;
  if (!shot || shot.type === 'shield') {
    // Force-field emitters and visual-only construction emitters never
    // spawn projectile entities through this path. The firing pipeline
    // keeps them out at runtime; the type guard here mirrors that
    // contract for the type system.
    throw new Error(
      `Turret ${turretConfig.turretBlueprintId} (shot.type=${shot === undefined ? 'none' : shot.type}) cannot create a projectile config`,
    );
  }
  return {
    shot,
    shotProfile: getShotProfile(shot),
    sourceTurretBlueprintId: turretConfig.turretBlueprintId,
    range: turretConfig.range,
    cooldown: turretConfig.cooldown,
    barrel: turretConfig.barrel,
    radius: { ...turretConfig.radius },
    turretIndex,
  };
}

export function createProjectileConfigFromShot(
  shotBlueprintId: ShotBlueprintId,
  sourceTurretBlueprintId: TurretBlueprintId | undefined = undefined,
): ProjectileConfig {
  const shot = getShotOnlyConfig(shotBlueprintId);
  return {
    shot,
    shotProfile: getShotProfile(shot),
    sourceTurretBlueprintId,
    range: 0,
    cooldown: null,
    barrel: undefined,
    radius: undefined,
    turretIndex: undefined,
  };
}

/** Resolve the runtime config for a projectile spawn.
 *
 *  Normal turret-fired shots hydrate from the real source turret so barrel
 *  geometry, range, cooldown, and source smoothing stay blueprint-authored.
 *  Submunitions hydrate from their child shot blueprint id and keep sourceTurretBlueprintId as
 *  provenance only; they do not become fake turrets. */
export function getProjectileConfigForSpawn(
  sourceTurretBlueprintId: string | undefined,
  shotBlueprintId: string | undefined,
  turretIndex: number | undefined = undefined,
): ProjectileConfig {
  const validSourceTurretBlueprintId = sourceTurretBlueprintId && isTurretBlueprintId(sourceTurretBlueprintId)
    ? sourceTurretBlueprintId
    : undefined;
  const validShotBlueprintId = shotBlueprintId && isShotBlueprintId(shotBlueprintId)
    ? shotBlueprintId
    : undefined;

  if (validSourceTurretBlueprintId) {
    const source = TURRET_CONFIGS[validSourceTurretBlueprintId];
    if (
      source &&
      source.shot &&
      source.shot.type !== 'shield'
    ) {
      if (!validShotBlueprintId || getEmissionBlueprintId(source.shot) === validShotBlueprintId) {
        return createProjectileConfigFromTurret(source, turretIndex);
      }
      return createProjectileConfigFromShot(validShotBlueprintId, validSourceTurretBlueprintId);
    }
  }
  if (validShotBlueprintId) return createProjectileConfigFromShot(validShotBlueprintId, validSourceTurretBlueprintId);
  throw new Error('Projectile spawn missing sourceTurretBlueprintId and shotBlueprintId');
}
