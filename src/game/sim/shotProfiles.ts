import type {
  ActiveProjectileShot,
  EmissionConfig,
  ProjectileShot,
  ShotProfile,
  ShotRuntimeProfile,
  ShotVisualProfile,
} from './types';
import {
  getEmissionBlueprintId,
  getShotMaxLifespan,
  isRayConfig,
  isProjectileShot,
  isRocketLikeShot,
} from './types';
import { getProjectileSmokeTrailSpec } from '@/smokeConfig';
import shotProfileConfig from './shotProfileConfig.json';
import beamConfig from '@/beamConfig.json';

type BeamConfigForShotProfiles = {
  startPointSphere: { emissionOffset: Record<string, number> | undefined } | undefined;
};

// Beam emission offset (forward distance from the turret mount where the
// beam visually + physically "generates") is tuned per-shot in
// beamConfig.json. The sim reads from there so both the start-point orb
// and the damage start stay in lockstep with a single source of truth.
const beamStartPointSphere = (beamConfig as BeamConfigForShotProfiles).startPointSphere;
const BEAM_EMISSION_OFFSET_BY_SHOT: Readonly<Record<string, number>> =
  beamStartPointSphere !== undefined && beamStartPointSphere.emissionOffset !== undefined
    ? beamStartPointSphere.emissionOffset
    : {};

/** Forward distance from the turret mount where a beam visually + physically
 *  "generates" — the position of the start-point orb. 0 for non-beam
 *  emissions. Shared so the beam-turret cone barrel can extend its tip out
 *  to that same orb (so the beam looks like it leaves the barrel tip). */
export function getBeamEmissionOffset(shot: EmissionConfig | null | undefined): number {
  if (shot === null || shot === undefined || !isRayConfig(shot) || shot.type !== 'beam') return 0;
  return BEAM_EMISSION_OFFSET_BY_SHOT[shot.rayBlueprintId] ?? 0;
}

export const PLASMA_TAIL_LENGTH_MULT = shotProfileConfig.plasmaTailLengthMult;
export const ROCKET_TAIL_LENGTH_MULT = shotProfileConfig.rocketTailLengthMult;
export const PROJECTILE_TAIL_RADIUS_MULT = shotProfileConfig.projectileTailRadiusMult;
export const ROCKET_FIN_SIZE_MULT = shotProfileConfig.rocketFinSizeMult;

const _profileCache = new WeakMap<ActiveProjectileShot, ShotProfile>();

function buildProjectileRuntimeProfile(shot: ProjectileShot): ShotRuntimeProfile {
  const explosion = shot.explosion;
  const explosionRadius = explosion === undefined ? 0 : explosion.radius;
  return {
    shotBlueprintId: getEmissionBlueprintId(shot),
    type: shot.type,
    projectileType: 'projectile',
    isProjectile: true,
    isLine: false,
    isRocketLike: isRocketLikeShot(shot),
    radius: shot.radius,
    deathExplosionRadius: explosionRadius,
    maxLifespan: getShotMaxLifespan(shot),
    detonateOnExpiry: shot.detonateOnExpiry === true,
    hasExplosion: explosionRadius > 0,
    hasSubmunitions: !!shot.submunitions,
  };
}

function buildProjectileVisualProfile(shot: ProjectileShot): ShotVisualProfile {
  return {
    projectileTailShape: shot.type === 'rocket' ? 'cylinder' : 'cone',
    projectileTailLengthMult:
      shot.type === 'rocket' ? ROCKET_TAIL_LENGTH_MULT : PLASMA_TAIL_LENGTH_MULT,
    projectileTailRadiusMult: PROJECTILE_TAIL_RADIUS_MULT,
    projectileFinSizeMult: shot.type === 'rocket' ? ROCKET_FIN_SIZE_MULT : 0,
    smokeTrail: getProjectileSmokeTrailSpec(shot.shotBlueprintId, shot.smokeTrail),
    burnMarkWidth: shot.radius.collision * 1.5,
    lineRadius: 0,
    lineDamageSphereRadius: 0,
    lineEmissionOffset: 0,
  };
}

function buildLineRuntimeProfile(shot: ActiveProjectileShot): ShotRuntimeProfile {
  if (!isRayConfig(shot)) {
    throw new Error(`Cannot build line shot profile for shot.type=${shot.type}`);
  }
  return {
    shotBlueprintId: getEmissionBlueprintId(shot),
    type: shot.type,
    projectileType: shot.type,
    isProjectile: false,
    isLine: true,
    isRocketLike: false,
    radius: {
      visual: shot.radius,
      hitbox: shot.damageSphere.radius,
      collision: shot.radius,
    },
    deathExplosionRadius: 0,
    maxLifespan: getShotMaxLifespan(shot),
    detonateOnExpiry: false,
    hasExplosion: false,
    hasSubmunitions: false,
  };
}

function buildLineVisualProfile(shot: ActiveProjectileShot): ShotVisualProfile {
  if (!isRayConfig(shot)) {
    throw new Error(`Cannot build line shot visual profile for shot.type=${shot.type}`);
  }
  return {
    projectileTailShape: 'none',
    projectileTailLengthMult: ROCKET_TAIL_LENGTH_MULT,
    projectileTailRadiusMult: PROJECTILE_TAIL_RADIUS_MULT,
    projectileFinSizeMult: 0,
    burnMarkWidth: shot.width * 2,
    lineRadius: shot.radius,
    lineDamageSphereRadius: shot.damageSphere.radius,
    lineEmissionOffset:
      shot.type === 'beam' ? (BEAM_EMISSION_OFFSET_BY_SHOT[shot.rayBlueprintId] ?? 0) : 0,
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
