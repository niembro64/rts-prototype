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

export const PROJECTILE_CYLINDER_LENGTH_MULT_DEFAULT = 4.0;
export const PROJECTILE_CYLINDER_DIAMETER_MULT_DEFAULT = 0.5;

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
    projectileShape: shot.shape ?? 'sphere',
    projectileBodyRadius: collisionRadius,
    cylinderLengthMult:
      shot.cylinderShape?.lengthMult ?? PROJECTILE_CYLINDER_LENGTH_MULT_DEFAULT,
    cylinderDiameterMult:
      shot.cylinderShape?.diameterMult ?? PROJECTILE_CYLINDER_DIAMETER_MULT_DEFAULT,
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
    projectileShape: 'sphere',
    projectileBodyRadius: 0,
    cylinderLengthMult: PROJECTILE_CYLINDER_LENGTH_MULT_DEFAULT,
    cylinderDiameterMult: PROJECTILE_CYLINDER_DIAMETER_MULT_DEFAULT,
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
