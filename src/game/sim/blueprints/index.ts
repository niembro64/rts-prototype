/**
 * Blueprint System — Re-exports + derived config builders
 */

export * from './types';
export * from './shots';
export * from './turrets';
export * from './units';

import type {
  BeamShot,
  ForceFieldZoneConfig,
  ForceShot,
  LaserShot,
  ProjectileShot,
  ShotConfig,
  TurretConfig,
} from '../types';
import { SHOT_BLUEPRINTS } from './shots';
import { TURRET_BLUEPRINTS } from './turrets';
import type { ShotBlueprint, ForceFieldZoneRatioConfig, TurretBlueprint } from './types';
import { BARREL_THICKNESS_MULTIPLIER } from '../../../config';

function assertFiniteRangeMultiplier(
  turretId: string,
  path: string,
  value: number,
): void {
  if (!Number.isFinite(value)) {
    throw new Error(
      `Invalid turret range multiplier for ${turretId}: ${path} must be finite, got ${value}`,
    );
  }
}

function validateTurretRangeMultipliers(
  turretId: string,
  ranges: TurretBlueprint['rangeMultiplierOverrides'],
): void {
  const max = ranges.engageRangeMax;
  const min = ranges.engageRangeMin;
  const tracking = ranges.trackingRange;

  assertFiniteRangeMultiplier(turretId, 'engageRangeMax.acquire', max.acquire);
  assertFiniteRangeMultiplier(turretId, 'engageRangeMax.release', max.release);

  if (max.release <= max.acquire) {
    throw new Error(
      `Invalid turret range multipliers for ${turretId}: engageRangeMax.release (${max.release}) must be greater than engageRangeMax.acquire (${max.acquire})`,
    );
  }

  // engageRangeMin is `null` when the turret has no minimum firing
  // distance (most direct-fire weapons). When set, both edges must be
  // finite and acquire must be farther out than release so the turret
  // doesn't flicker when targets sit on the inner boundary.
  if (min) {
    assertFiniteRangeMultiplier(turretId, 'engageRangeMin.acquire', min.acquire);
    assertFiniteRangeMultiplier(turretId, 'engageRangeMin.release', min.release);
    if (min.acquire <= min.release) {
      throw new Error(
        `Invalid turret range multipliers for ${turretId}: engageRangeMin.acquire (${min.acquire}) must be greater than engageRangeMin.release (${min.release})`,
      );
    }
  }

  // trackingRange is `null` when the turret only ever cares about its
  // fire envelope (acquires + engages on contact). When set, the
  // tracking shell MUST sit strictly outside engageRangeMax — its
  // whole purpose is pre-rotation toward enemies that aren't yet in
  // fire range.
  if (tracking) {
    assertFiniteRangeMultiplier(turretId, 'trackingRange.acquire', tracking.acquire);
    assertFiniteRangeMultiplier(turretId, 'trackingRange.release', tracking.release);
    if (tracking.release <= tracking.acquire) {
      throw new Error(
        `Invalid turret range multipliers for ${turretId}: trackingRange.release (${tracking.release}) must be greater than trackingRange.acquire (${tracking.acquire})`,
      );
    }
    if (tracking.acquire <= max.acquire) {
      throw new Error(
        `Invalid turret range multipliers for ${turretId}: trackingRange.acquire (${tracking.acquire}) must sit OUTSIDE engageRangeMax.acquire (${max.acquire})`,
      );
    }
    if (tracking.release <= max.release) {
      throw new Error(
        `Invalid turret range multipliers for ${turretId}: trackingRange.release (${tracking.release}) must sit OUTSIDE engageRangeMax.release (${max.release})`,
      );
    }
  }
}

/** Compute a ForceFieldZoneConfig from ratio-based blueprint data and weapon range */
function computeZoneConfig(
  zone: ForceFieldZoneRatioConfig | undefined,
  range: number,
): ForceFieldZoneConfig | null {
  if (!zone) return null;
  const outerRange = zone.rimWidth != null
    ? zone.rimWidth
    : range * (zone.outerRatio ?? 1);
  return {
    innerRange: 0,
    outerRange,
    color: zone.color,
    alpha: zone.alpha,
    particleAlpha: zone.particleAlpha,
    power: zone.power,
  };
}

/** Build a ShotConfig from a ShotBlueprint + turret blueprint data.
 *
 *  `homingTurnRate` lives on the SHOT BLUEPRINT (it's a property of
 *  the rocket, not the turret), so it doesn't appear here as a
 *  parameter — `buildShotConfig` pulls it directly from
 *  `shotBlueprint.homingTurnRate` for projectile shots. */
function buildShotConfig(
  shotBlueprint: ShotBlueprint,
  launchForce?: number,
): ShotConfig {
  if (shotBlueprint.type === 'beam') {
    const shot: BeamShot = {
      type: 'beam',
      id: shotBlueprint.id,
      dps: shotBlueprint.dps,
      force: shotBlueprint.force,
      recoil: shotBlueprint.recoil,
      radius: shotBlueprint.radius,
      width: shotBlueprint.width,
      damageSphere: { radius: shotBlueprint.damageSphere.radius },
    };
    return shot;
  }

  if (shotBlueprint.type === 'laser') {
    const shot: LaserShot = {
      type: 'laser',
      id: shotBlueprint.id,
      dps: shotBlueprint.dps,
      force: shotBlueprint.force,
      recoil: shotBlueprint.recoil,
      radius: shotBlueprint.radius,
      width: shotBlueprint.width,
      damageSphere: { radius: shotBlueprint.damageSphere.radius },
      duration: shotBlueprint.duration,
    };
    return shot;
  }

  // Projectile shot
  const shot: ProjectileShot = {
    type: 'projectile',
    id: shotBlueprint.id,
    mass: shotBlueprint.mass,
    launchForce: launchForce ?? 0,
    collision: shotBlueprint.collision,
    explosion: shotBlueprint.explosion,
    detonateOnExpiry: shotBlueprint.detonateOnExpiry || undefined,
    lifespan: shotBlueprint.lifespan,
    lifespanVariance: shotBlueprint.lifespanVariance,
    homingTurnRate: shotBlueprint.homingTurnRate,
    submunitions: shotBlueprint.submunitions,
    ignoresGravity: shotBlueprint.ignoresGravity,
    smokeTrail: shotBlueprint.smokeTrail,
    shape: shotBlueprint.shape,
    cylinderShape: shotBlueprint.cylinderShape,
  };
  return shot;
}

/**
 * Build a synthetic TurretConfig for spawning a child projectile as
 * a submunition. Used by the collision handler when a parent shot
 * with `submunitions` explodes. This is NOT a turret anyone owns or
 * fires — it's only a vehicle for carrying the child shot's actual
 * blueprint into world.createProjectile, so fields like range and
 * cooldown are irrelevant and left at 0.
 *
 * Cached per childShotId so repeated explosions reuse the same config
 * object (stable identity for renderers / audio that key by config).
 */
const _submunitionConfigCache = new Map<string, TurretConfig>();
export function getSubmunitionTurretConfig(childShotId: string): TurretConfig {
  const cached = _submunitionConfigCache.get(childShotId);
  if (cached) return cached;

  const shotBlueprint = SHOT_BLUEPRINTS[childShotId];
  if (!shotBlueprint) throw new Error(`Unknown submunition shot: ${childShotId}`);
  if (shotBlueprint.type !== 'projectile') {
    throw new Error(`Submunition must be a projectile shot: ${childShotId}`);
  }

  const shot = buildShotConfig(shotBlueprint) as ProjectileShot;
  const config: TurretConfig = {
    id: `__sub:${childShotId}`,
    range: 0,
    cooldown: 0,
    angular: { turnAccel: 0, drag: 0 },
    rangeOverrides: {
      engageRangeMax: { acquire: 0, release: 0 },
      engageRangeMin: null,
      trackingRange: null,
    },
    eventsSmooth: false,
    shot,
  };
  _submunitionConfigCache.set(childShotId, config);
  return config;
}

/**
 * Build a TurretConfig (for runtime sim) from a TurretBlueprint.
 */
export function buildTurretConfig(turretId: string): TurretConfig {
  const turretBlueprint = TURRET_BLUEPRINTS[turretId];
  if (!turretBlueprint) throw new Error(`Unknown turret blueprint: ${turretId}`);
  validateTurretRangeMultipliers(turretId, turretBlueprint.rangeMultiplierOverrides);

  // Determine shot config
  let shot: ShotConfig;

  if (turretBlueprint.forceField) {
    // Force field turret: build ForceShot
    const fieldShot: ForceShot = {
      type: 'force',
      angle: turretBlueprint.forceField.angle ?? Math.PI * 2,
      transitionTime: turretBlueprint.forceField.transitionTime ?? 1000,
      push: computeZoneConfig(turretBlueprint.forceField.push, turretBlueprint.range) ?? undefined,
      pull: computeZoneConfig(turretBlueprint.forceField.pull, turretBlueprint.range) ?? undefined,
    };
    shot = fieldShot;
  } else if (turretBlueprint.projectileId) {
    // Projectile or beam turret
    const shotBlueprint = SHOT_BLUEPRINTS[turretBlueprint.projectileId];
    if (!shotBlueprint)
      throw new Error(
        `Unknown projectile in turret ${turretId}: ${turretBlueprint.projectileId}`,
      );
    shot = buildShotConfig(shotBlueprint, turretBlueprint.launchForce);
  } else {
    throw new Error(`Turret ${turretId} has neither projectileId nor forceField`);
  }

  const config: TurretConfig = {
    id: turretBlueprint.id,
    range: turretBlueprint.range,
    cooldown: turretBlueprint.cooldown ?? 0,
    color: turretBlueprint.color,
    barrel: turretBlueprint.barrel,
    angular: {
      turnAccel: turretBlueprint.turretTurnAccel,
      drag: turretBlueprint.turretDrag,
    },
    rangeOverrides: turretBlueprint.rangeMultiplierOverrides,
    eventsSmooth: turretBlueprint.eventsSmooth,
    shot,
    highArc: turretBlueprint.highArc ?? false,
    verticalLauncher: turretBlueprint.verticalLauncher ?? false,
    groundAimFraction: turretBlueprint.groundAimFraction,
    bodyRadius: turretBlueprint.bodyRadius,
  };

  // Derive barrelThickness from shot size, scaled by global multiplier
  if (
    turretBlueprint.projectileId &&
    config.barrel &&
    config.barrel.type !== 'complexSingleEmitter'
  ) {
    const shotBlueprint = SHOT_BLUEPRINTS[turretBlueprint.projectileId];
    const rawThickness = shotBlueprint.type === 'beam' || shotBlueprint.type === 'laser'
      ? shotBlueprint.width
      : (shotBlueprint.collision.radius > 0 ? shotBlueprint.collision.radius * 2 : 2);
    config.barrel = {
      ...config.barrel,
      barrelThickness: config.barrel.barrelThickness ??
        rawThickness * BARREL_THICKNESS_MULTIPLIER,
    };
  }

  // Optional firing modifiers
  if (turretBlueprint.spread) config.spread = { ...turretBlueprint.spread };
  if (turretBlueprint.burst) config.burst = { ...turretBlueprint.burst };
  if (turretBlueprint.isManualFire != null) {
    config.isManualFire = turretBlueprint.isManualFire;
  }
  if (turretBlueprint.passive != null) config.passive = turretBlueprint.passive;

  return config;
}

/**
 * Build all turret configs from blueprints.
 */
export function buildAllTurretConfigs(): Record<string, TurretConfig> {
  const result: Record<string, TurretConfig> = {};
  for (const id of Object.keys(TURRET_BLUEPRINTS)) {
    result[id] = buildTurretConfig(id);
  }
  return result;
}
