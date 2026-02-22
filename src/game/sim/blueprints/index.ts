/**
 * Blueprint System — Re-exports + derived config builders
 */

export * from './types';
export * from './shots';
export * from './turrets';
export * from './units';

import type { WeaponConfig, ForceFieldZoneConfig } from '../types';
import { SHOT_BLUEPRINTS } from './shots';
import { TURRET_BLUEPRINTS } from './turrets';
import type { ShotBlueprint, ForceFieldZoneRatioConfig } from './types';

/** Compute a ForceFieldZoneConfig from ratio-based blueprint data and weapon range */
function computeZoneConfig(
  zone: ForceFieldZoneRatioConfig | undefined,
  range: number,
): ForceFieldZoneConfig | null {
  if (!zone) return null;
  return {
    innerRange: range * zone.innerRatio,
    outerRange: range * zone.outerRatio,
    color: zone.color,
    alpha: zone.alpha,
    particleAlpha: zone.particleAlpha,
    power: zone.power,
    damage: zone.damage,
  };
}

/** Map ShotBlueprint fields to the WeaponConfig projectile fields */
function getProjectileFields(bp: ShotBlueprint) {
  return {
    projectileType: bp.id,
    collision: bp.collision,
    explosion: bp.explosion,
    projectileMass: bp.mass,
    ...(bp.lifespan != null && { projectileLifespan: bp.lifespan }),
    splashOnExpiry: bp.splashOnExpiry,
    ...(bp.piercing != null && { piercing: bp.piercing }),
    ...((bp.beamDuration != null || bp.beamWidth != null) && {
      beam: {
        ...(bp.beamDuration != null && { duration: bp.beamDuration }),
        ...(bp.beamWidth != null && { width: bp.beamWidth }),
      },
    }),
  };
}

/**
 * Build a flat WeaponConfig (for runtime sim) from a WeaponBlueprint.
 * This produces the same shape as TURRET_CONFIGS entries in weapons.ts.
 */
export function buildWeaponConfig(weaponId: string): WeaponConfig {
  const wb = TURRET_BLUEPRINTS[weaponId];
  if (!wb) throw new Error(`Unknown weapon blueprint: ${weaponId}`);

  const base: WeaponConfig = {
    id: wb.id,
    range: wb.range,
    cooldown: wb.cooldown ?? 0,
    color: wb.color,
    turretTurnAccel: wb.turretTurnAccel,
    turretDrag: wb.turretDrag,
    turretShape: wb.turretShape,
    rangeMultiplierOverrides: wb.rangeMultiplierOverrides,
    collision: { radius: 0, damage: 0 },
  };

  // Merge projectile fields if weapon has a projectile
  if (wb.projectileId) {
    const pb = SHOT_BLUEPRINTS[wb.projectileId];
    if (!pb)
      throw new Error(
        `Unknown projectile in weapon ${weaponId}: ${wb.projectileId}`,
      );
    Object.assign(base, getProjectileFields(pb));

    // Derive barrelThickness from shot size
    // Projectiles: diameter (collision.radius * 2), beams: beam width directly
    if (base.turretShape && base.turretShape.type !== 'complexSingleEmitter') {
      const thickness = pb.beamWidth ?? (pb.collision.radius > 0 ? pb.collision.radius * 2 : 2);
      base.turretShape = { ...base.turretShape, barrelThickness: thickness };
    }
  }

  // Force field: compute zone configs from ratios
  if (wb.forceField) {
    base.forceField = {
      angle: wb.forceField.angle,
      transitionTime: wb.forceField.transitionTime,
      push: computeZoneConfig(wb.forceField.push, wb.range),
      pull: computeZoneConfig(wb.forceField.pull, wb.range),
    };
    base.collision = { radius: 0, damage: Math.max(wb.forceField.push?.damage ?? 0, wb.forceField.pull?.damage ?? 0) };
  }

  // Optional firing modifiers
  if (wb.spread) base.spread = { ...wb.spread };
  if (wb.burst) base.burst = { ...wb.burst };
  if (wb.homingTurnRate != null) base.homingTurnRate = wb.homingTurnRate;
  if (wb.isManualFire != null) base.isManualFire = wb.isManualFire;
  if (wb.launchForce != null && base.projectileMass) {
    base.projectileSpeed = wb.launchForce / base.projectileMass;
  }

  return base;
}

/**
 * Build all weapon configs from blueprints.
 * Returns same shape as the current TURRET_CONFIGS record.
 */
export function buildAllWeaponConfigs(): Record<string, WeaponConfig> {
  const result: Record<string, WeaponConfig> = {};
  for (const id of Object.keys(TURRET_BLUEPRINTS)) {
    result[id] = buildWeaponConfig(id);
  }
  return result;
}
