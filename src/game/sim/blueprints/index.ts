/**
 * Blueprint System — Re-exports + derived config builders
 */

export * from './types';
export * from './shots';
export * from './turrets';
export * from './units';

import type { TurretConfig, ShotConfig, ForceFieldZoneConfig } from '../types';
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

/** Build a ShotConfig from a ShotBlueprint */
function buildShotConfig(bp: ShotBlueprint, launchForce?: number): ShotConfig {
  const shot: ShotConfig = {
    type: bp.id,
    collision: bp.collision,
    explosion: bp.explosion,
    mass: bp.mass,
    splashOnExpiry: bp.splashOnExpiry,
  };
  if (bp.lifespan != null) shot.lifespan = bp.lifespan;
  if (bp.piercing != null) shot.piercing = bp.piercing;
  if (bp.beamDuration != null || bp.beamWidth != null) {
    shot.beam = {
      ...(bp.beamDuration != null && { duration: bp.beamDuration }),
      ...(bp.beamWidth != null && { width: bp.beamWidth }),
    };
  }
  if (launchForce != null && bp.mass) {
    shot.speed = launchForce / bp.mass;
  }
  return shot;
}

/**
 * Build a TurretConfig (for runtime sim) from a TurretBlueprint.
 */
export function buildTurretConfig(turretId: string): TurretConfig {
  const wb = TURRET_BLUEPRINTS[turretId];
  if (!wb) throw new Error(`Unknown turret blueprint: ${turretId}`);

  const base: TurretConfig = {
    id: wb.id,
    range: wb.range,
    cooldown: wb.cooldown ?? 0,
    color: wb.color,
    barrel: wb.barrel,
    angular: { turnAccel: wb.turretTurnAccel, drag: wb.turretDrag },
    rangeOverrides: wb.rangeMultiplierOverrides,
  };

  // Build shot config if turret has a projectile
  if (wb.projectileId) {
    const pb = SHOT_BLUEPRINTS[wb.projectileId];
    if (!pb)
      throw new Error(
        `Unknown projectile in turret ${turretId}: ${wb.projectileId}`,
      );
    base.shot = buildShotConfig(pb, wb.launchForce);

    // Derive barrelThickness from shot size, scaled by global multiplier
    if (base.barrel && base.barrel.type !== 'complexSingleEmitter') {
      const rawThickness = pb.beamWidth ?? (pb.collision.radius > 0 ? pb.collision.radius * 2 : 2);
      base.barrel = { ...base.barrel, barrelThickness: rawThickness * BARREL_THICKNESS_MULTIPLIER };
    }

    if (wb.homingTurnRate != null) base.shot.homingTurnRate = wb.homingTurnRate;
  }

  // Force field: compute zone configs from ratios
  if (wb.forceField) {
    base.forceField = {
      angle: wb.forceField.angle,
      transitionTime: wb.forceField.transitionTime,
      push: computeZoneConfig(wb.forceField.push, wb.range),
      pull: computeZoneConfig(wb.forceField.pull, wb.range),
    };
    // Force field collision damage stored in shot config
    base.shot = {
      collision: { radius: 0, damage: Math.max(wb.forceField.push?.damage ?? 0, wb.forceField.pull?.damage ?? 0) },
    };
  }

  // Optional firing modifiers
  if (wb.spread) base.spread = { ...wb.spread };
  if (wb.burst) base.burst = { ...wb.burst };
  if (wb.isManualFire != null) base.isManualFire = wb.isManualFire;

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
