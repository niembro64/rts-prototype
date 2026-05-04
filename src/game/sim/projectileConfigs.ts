import type { ActiveProjectileShot, ProjectileConfig, TurretConfig } from './types';
import { isShotId, isTurretId, type ShotId, type TurretId } from '../../types/blueprintIds';
import { buildProjectileShotConfig } from './blueprints';
import { TURRET_CONFIGS } from './turretConfigs';

const _shotConfigCache = new Map<ShotId, ActiveProjectileShot>();

function getShotOnlyConfig(shotId: ShotId): ActiveProjectileShot {
  const cached = _shotConfigCache.get(shotId);
  if (cached) return cached;
  const shot = buildProjectileShotConfig(shotId);
  _shotConfigCache.set(shotId, shot);
  return shot;
}

export function createProjectileConfigFromTurret(
  turretConfig: TurretConfig,
  turretIndex?: number,
): ProjectileConfig {
  if (turretConfig.shot.type === 'force') {
    throw new Error(`Force turret ${turretConfig.id} cannot create a projectile config`);
  }
  return {
    shot: turretConfig.shot,
    sourceTurretId: turretConfig.id,
    range: turretConfig.range,
    cooldown: turretConfig.cooldown,
    barrel: turretConfig.barrel,
    radius: { ...turretConfig.radius },
    turretIndex,
  };
}

export function createProjectileConfigFromShot(
  shotId: ShotId,
  sourceTurretId?: TurretId,
): ProjectileConfig {
  return {
    shot: getShotOnlyConfig(shotId),
    sourceTurretId,
    range: 0,
    cooldown: 0,
  };
}

/** Resolve the runtime config for a projectile spawn.
 *
 *  Normal turret-fired shots hydrate from the real source turret so barrel
 *  geometry, range, cooldown, and source smoothing stay blueprint-authored.
 *  Submunitions hydrate from their child shot id and keep sourceTurretId as
 *  provenance only; they do not become fake turrets. */
export function getProjectileConfigForSpawn(
  sourceTurretId: string | undefined,
  shotId: string | undefined,
  turretIndex?: number,
): ProjectileConfig {
  const validSourceTurretId = sourceTurretId && isTurretId(sourceTurretId)
    ? sourceTurretId
    : undefined;
  const validShotId = shotId && isShotId(shotId)
    ? shotId
    : undefined;

  if (validSourceTurretId) {
    const source = TURRET_CONFIGS[validSourceTurretId];
    if (source && source.shot.type !== 'force') {
      if (!validShotId || source.shot.id === validShotId) {
        return createProjectileConfigFromTurret(source, turretIndex);
      }
      return createProjectileConfigFromShot(validShotId, validSourceTurretId);
    }
  }
  if (validShotId) return createProjectileConfigFromShot(validShotId, validSourceTurretId);
  throw new Error('Projectile spawn missing sourceTurretId and shotId');
}
