/**
 * Blueprint System — Re-exports + derived config builders
 */

export * from './types';
export * from './shots';
export * from './turrets';
export * from './units';

import type { TurretConfig, ShotConfig, ForceFieldZoneConfig, ProjectileShot, BeamShot, LaserShot, ForceShot } from '../types';
import { SHOT_BLUEPRINTS } from './shots';
import { TURRET_BLUEPRINTS } from './turrets';
import type { ShotBlueprint, ForceFieldZoneRatioConfig } from './types';
import { BARREL_THICKNESS_MULTIPLIER } from '../../../config';

/** Compute a ForceFieldZoneConfig from ratio-based blueprint data and weapon range */
function computeZoneConfig(
  zone: ForceFieldZoneRatioConfig | undefined,
  range: number,
): ForceFieldZoneConfig | null {
  if (!zone) return null;
  const innerRange = range * zone.innerRatio;
  const outerRange = zone.rimWidth != null
    ? innerRange + zone.rimWidth
    : range * (zone.outerRatio ?? zone.innerRatio);
  return {
    innerRange,
    outerRange,
    color: zone.color,
    alpha: zone.alpha,
    particleAlpha: zone.particleAlpha,
    power: zone.power,
    damage: zone.damage,
  };
}

/** Build a ShotConfig from a ShotBlueprint + turret blueprint data */
function buildShotConfig(bp: ShotBlueprint, launchForce?: number, homingTurnRate?: number): ShotConfig {
  if (bp.type === 'beam') {
    const shot: BeamShot = {
      type: 'beam',
      id: bp.id,
      dps: bp.dps,
      force: bp.force,
      recoil: bp.recoil,
      radius: bp.radius,
      width: bp.width,
    };
    return shot;
  }

  if (bp.type === 'laser') {
    const shot: LaserShot = {
      type: 'laser',
      id: bp.id,
      dps: bp.dps,
      force: bp.force,
      recoil: bp.recoil,
      radius: bp.radius,
      width: bp.width,
      duration: bp.duration,
    };
    return shot;
  }

  // Projectile shot
  const shot: ProjectileShot = {
    type: 'projectile',
    id: bp.id,
    mass: bp.mass,
    launchForce: launchForce ?? 0,
    collision: bp.collision,
    explosion: bp.explosion,
    splashOnExpiry: bp.splashOnExpiry || undefined,
    lifespan: bp.lifespan,
    homingTurnRate: homingTurnRate,
    submunitions: bp.submunitions,
    ignoresGravity: bp.ignoresGravity,
    leavesSmokeTrail: bp.leavesSmokeTrail,
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

  const bp = SHOT_BLUEPRINTS[childShotId];
  if (!bp) throw new Error(`Unknown submunition shot: ${childShotId}`);
  if (bp.type !== 'projectile') {
    throw new Error(`Submunition must be a projectile shot: ${childShotId}`);
  }

  const shot = buildShotConfig(bp) as ProjectileShot;
  const config: TurretConfig = {
    id: `__sub:${childShotId}`,
    range: 0,
    cooldown: 0,
    angular: { turnAccel: 0, drag: 0 },
    shot,
  };
  _submunitionConfigCache.set(childShotId, config);
  return config;
}

/**
 * Build a TurretConfig (for runtime sim) from a TurretBlueprint.
 */
export function buildTurretConfig(turretId: string): TurretConfig {
  const wb = TURRET_BLUEPRINTS[turretId];
  if (!wb) throw new Error(`Unknown turret blueprint: ${turretId}`);

  // Determine shot config
  let shot: ShotConfig;

  if (wb.forceField) {
    // Force field turret: build ForceShot
    const fieldShot: ForceShot = {
      type: 'force',
      angle: wb.forceField.angle ?? Math.PI * 2,
      transitionTime: wb.forceField.transitionTime ?? 1000,
      push: computeZoneConfig(wb.forceField.push, wb.range) ?? undefined,
      pull: computeZoneConfig(wb.forceField.pull, wb.range) ?? undefined,
    };
    shot = fieldShot;
  } else if (wb.projectileId) {
    // Projectile or beam turret
    const pb = SHOT_BLUEPRINTS[wb.projectileId];
    if (!pb)
      throw new Error(
        `Unknown projectile in turret ${turretId}: ${wb.projectileId}`,
      );
    shot = buildShotConfig(pb, wb.launchForce, wb.homingTurnRate);
  } else {
    throw new Error(`Turret ${turretId} has neither projectileId nor forceField`);
  }

  const base: TurretConfig = {
    id: wb.id,
    range: wb.range,
    cooldown: wb.cooldown ?? 0,
    color: wb.color,
    barrel: wb.barrel,
    angular: { turnAccel: wb.turretTurnAccel, drag: wb.turretDrag },
    rangeOverrides: wb.rangeMultiplierOverrides,
    shot,
    highArc: wb.highArc ?? false,
    verticalLauncher: wb.verticalLauncher ?? false,
  };

  // Derive barrelThickness from shot size, scaled by global multiplier
  if (wb.projectileId && base.barrel && base.barrel.type !== 'complexSingleEmitter') {
    const pb = SHOT_BLUEPRINTS[wb.projectileId];
    const rawThickness = pb.type === 'beam' || pb.type === 'laser'
      ? pb.width
      : (pb.collision.radius > 0 ? pb.collision.radius * 2 : 2);
    base.barrel = { ...base.barrel, barrelThickness: rawThickness * BARREL_THICKNESS_MULTIPLIER };
  }

  // Optional firing modifiers
  if (wb.spread) base.spread = { ...wb.spread };
  if (wb.burst) base.burst = { ...wb.burst };
  if (wb.isManualFire != null) base.isManualFire = wb.isManualFire;
  if (wb.passive != null) base.passive = wb.passive;

  return base;
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
