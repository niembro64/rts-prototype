/** Authored combat reach of a building BLUEPRINT, before any instance
 * exists. The placement preview needs these to draw range rings under the
 * ghost; live entities keep reading their resolved `turret.ranges` instead.
 * Sensor radii have their own blueprint helpers in `sensorCoverage.ts`. */
import type { BuildingBlueprintId } from './types';
import { getBuildingBlueprint } from './blueprints';
import { computeTurretRanges, getTurretConfig } from './turretConfigs';
import { isAttackEmitterConfig, isPassiveShieldFieldConfig } from './emitterKinds';

/** Outer weapon engagement radius: the max fire-envelope release radius over
 *  every target-acquiring attack emitter the blueprint mounts. Passive shield
 *  barriers are excluded — their range is a field radius, not weapon reach. */
export function getBuildingAuthoredWeaponRangeRadius(
  buildingBlueprintId: BuildingBlueprintId | null,
): number {
  let max = 0;
  if (buildingBlueprintId === null) return max;
  const blueprint = getBuildingBlueprint(buildingBlueprintId);
  for (const mount of blueprint.turrets) {
    const config = getTurretConfig(mount.turretBlueprintId);
    if (!isAttackEmitterConfig(config)) continue;
    max = Math.max(max, computeTurretRanges(config).fire.max.release);
  }
  return max;
}

/** Persistent shield-sphere barrier radius the blueprint would raise. */
export function getBuildingAuthoredShieldBarrierRadius(
  buildingBlueprintId: BuildingBlueprintId | null,
): number {
  let max = 0;
  if (buildingBlueprintId === null) return max;
  const blueprint = getBuildingBlueprint(buildingBlueprintId);
  for (const mount of blueprint.turrets) {
    const config = getTurretConfig(mount.turretBlueprintId);
    if (!isPassiveShieldFieldConfig(config)) continue;
    max = Math.max(max, config.targeting.engagement.range);
  }
  return max;
}
