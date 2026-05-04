import type { ActiveProjectileShot, ProjectileConfig, TurretConfig } from './types';
import { buildProjectileShotConfig } from './blueprints';
import { TURRET_CONFIGS } from './turretConfigs';

const _shotConfigCache = new Map<string, ActiveProjectileShot>();

function getShotOnlyConfig(shotId: string): ActiveProjectileShot {
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
    bodyRadius: turretConfig.bodyRadius,
    turretIndex,
  };
}

export function createProjectileConfigFromShot(
  shotId: string,
  sourceTurretId?: string,
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
  if (sourceTurretId) {
    const source = TURRET_CONFIGS[sourceTurretId];
    if (source && source.shot.type !== 'force') {
      if (!shotId || source.shot.id === shotId) {
        return createProjectileConfigFromTurret(source, turretIndex);
      }
      return createProjectileConfigFromShot(shotId, sourceTurretId);
    }
  }
  if (shotId) return createProjectileConfigFromShot(shotId, sourceTurretId);
  throw new Error('Projectile spawn missing sourceTurretId and shotId');
}
