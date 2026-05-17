import type {
  ActiveProjectileShot,
  ProjectileShot,
  ShotProfile,
  ShotRuntimeProfile,
  ShotVisualProfile,
} from './types';
import {
  getShotMaxLifespan,
  isLineShot,
  isProjectileShot,
  isRocketLikeShot,
} from './types';
import shotProfileConfig from './shotProfileConfig.json';

export const PLASMA_TAIL_LENGTH_MULT = shotProfileConfig.plasmaTailLengthMult;
export const ROCKET_TAIL_LENGTH_MULT = shotProfileConfig.rocketTailLengthMult;
export const PROJECTILE_TAIL_RADIUS_MULT = shotProfileConfig.projectileTailRadiusMult;
export const ROCKET_FIN_SIZE_MULT = shotProfileConfig.rocketFinSizeMult;

const _profileCache = new WeakMap<ActiveProjectileShot, ShotProfile>();

function buildProjectileRuntimeProfile(shot: ProjectileShot): ShotRuntimeProfile {
  const collisionRadius = shot.collision.radius;
  const explosionRadius = shot.explosion?.radius ?? 0;
  return {
    id: shot.id,
    type: shot.type,
    projectileType: 'projectile',
    isProjectile: true,
    isLine: false,
    isRocketLike: isRocketLikeShot(shot),
    ignoresGravity: shot.ignoresGravity === true,
    collisionRadius,
    impactRadius: explosionRadius || collisionRadius,
    explosionRadius,
    damageRadius: collisionRadius,
    maxLifespan: getShotMaxLifespan(shot),
    detonateOnExpiry: shot.detonateOnExpiry === true,
    hasExplosion: explosionRadius > 0,
    hasSubmunitions: !!shot.submunitions,
  };
}

function buildProjectileVisualProfile(shot: ProjectileShot): ShotVisualProfile {
  const collisionRadius = shot.collision.radius;
  return {
    projectileBodyRadius: collisionRadius,
    projectileTailShape: shot.type === 'rocket' ? 'cylinder' : 'cone',
    projectileTailLengthMult:
      shot.type === 'rocket' ? ROCKET_TAIL_LENGTH_MULT : PLASMA_TAIL_LENGTH_MULT,
    projectileTailRadiusMult: PROJECTILE_TAIL_RADIUS_MULT,
    projectileFinSizeMult: shot.type === 'rocket' ? ROCKET_FIN_SIZE_MULT : 0,
    debugCollisionRadius: collisionRadius,
    debugExplosionRadius: shot.explosion?.radius ?? 0,
    smokeTrail: shot.smokeTrail,
    burnMarkWidth: collisionRadius * 1.5,
    lineRadius: 0,
    lineDamageSphereRadius: 0,
  };
}

function buildLineRuntimeProfile(shot: ActiveProjectileShot): ShotRuntimeProfile {
  if (!isLineShot(shot)) {
    throw new Error(`Cannot build line shot profile for shot.type=${shot.type}`);
  }
  return {
    id: shot.id,
    type: shot.type,
    projectileType: shot.type,
    isProjectile: false,
    isLine: true,
    isRocketLike: false,
    ignoresGravity: true,
    collisionRadius: shot.radius,
    impactRadius: shot.radius,
    explosionRadius: 0,
    damageRadius: shot.damageSphere.radius,
    maxLifespan: getShotMaxLifespan(shot),
    detonateOnExpiry: false,
    hasExplosion: false,
    hasSubmunitions: false,
  };
}

function buildLineVisualProfile(shot: ActiveProjectileShot): ShotVisualProfile {
  if (!isLineShot(shot)) {
    throw new Error(`Cannot build line shot visual profile for shot.type=${shot.type}`);
  }
  return {
    projectileBodyRadius: 0,
    projectileTailShape: 'none',
    projectileTailLengthMult: ROCKET_TAIL_LENGTH_MULT,
    projectileTailRadiusMult: PROJECTILE_TAIL_RADIUS_MULT,
    projectileFinSizeMult: 0,
    debugCollisionRadius: shot.radius,
    debugExplosionRadius: 0,
    burnMarkWidth: shot.width * 2,
    lineRadius: shot.radius,
    lineDamageSphereRadius: shot.damageSphere.radius,
  };
}

export function getShotProfile(shot: ActiveProjectileShot): ShotProfile {
  const cached = _profileCache.get(shot);
  if (cached) return cached;

  const profile: ShotProfile = isProjectileShot(shot)
    ? {
      runtime: buildProjectileRuntimeProfile(shot),
      visual: buildProjectileVisualProfile(shot),
    }
    : {
      runtime: buildLineRuntimeProfile(shot),
      visual: buildLineVisualProfile(shot),
    };
  _profileCache.set(shot, profile);
  return profile;
}
