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

/** Map ProjectileBlueprint fields to the flat WeaponConfig projectile fields */
function getProjectileFields(bp: ShotBlueprint) {
  return {
    projectileType: bp.id,
    damage: bp.damage,
    ...(bp.mass != null && { projectileMass: bp.mass }),
    ...(bp.radius != null && { projectileRadius: bp.radius }),
    ...(bp.lifespan != null && { projectileLifespan: bp.lifespan }),
    primaryDamageRadius: bp.primaryDamageRadius,
    secondaryDamageRadius: bp.secondaryDamageRadius,
    splashOnExpiry: bp.splashOnExpiry,
    ...(bp.piercing != null && { piercing: bp.piercing }),
    ...(bp.beamDuration != null && { beamDuration: bp.beamDuration }),
    ...(bp.beamWidth != null && { beamWidth: bp.beamWidth }),
    ...(bp.collisionRadius != null && { collisionRadius: bp.collisionRadius }),
    ...(bp.hitForce != null && { hitForce: bp.hitForce }),
    ...(bp.knockBackForce != null && { knockBackForce: bp.knockBackForce }),
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
    damage: 0, // will be overridden below
  };

  // Merge projectile fields if weapon has a projectile
  if (wb.projectileId) {
    const pb = SHOT_BLUEPRINTS[wb.projectileId];
    if (!pb)
      throw new Error(
        `Unknown projectile in weapon ${weaponId}: ${wb.projectileId}`,
      );
    Object.assign(base, getProjectileFields(pb));
  }

  // Force field: compute zone configs from ratios
  if (wb.isForceField) {
    base.isForceField = true;
    base.forceFieldAngle = wb.forceFieldAngle;
    base.forceFieldTransitionTime = wb.forceFieldTransitionTime;
    base.push = computeZoneConfig(wb.push, wb.range);
    base.pull = computeZoneConfig(wb.pull, wb.range);
    base.damage = Math.max(wb.push?.damage ?? 0, wb.pull?.damage ?? 0);
  }

  // Optional firing modifiers
  if (wb.spreadAngle != null) base.spreadAngle = wb.spreadAngle;
  if (wb.burstCount != null) base.burstCount = wb.burstCount;
  if (wb.burstDelay != null) base.burstDelay = wb.burstDelay;
  if (wb.pelletCount != null) base.pelletCount = wb.pelletCount;
  if (wb.homingTurnRate != null) base.homingTurnRate = wb.homingTurnRate;
  if (wb.isManualFire != null) base.isManualFire = wb.isManualFire;
  if (wb.projectileSpeed != null) base.projectileSpeed = wb.projectileSpeed;

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
