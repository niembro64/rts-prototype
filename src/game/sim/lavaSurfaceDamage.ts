// LIQUID = LAVA: molten rock burns anything touching its surface.
//
// Modelled exactly like the authored locomotion `waterDamagePerSecond` drain —
// a direct hp write on the fixed step, no per-tick damage event, no attacker —
// so it stays bit-identical across peers and routes deaths through the shared
// pendingDeathCheck cleanup the same way a self-destruct does.

import {
  LAVA_MAX_HEALTH_FRACTION_PER_SECOND,
  LAVA_MINIMUM_DAMAGE_PER_SECOND,
  WATER_LEVEL,
} from './terrain/terrainConfig';
import { ENTITY_CHANGED_HP } from '../../types/network';
import type { Entity } from './types';
import type { WorldState } from './WorldState';

/** P1-18: buildings never move, so which ones sit at or below the lava
 *  surface is a pure function of the building roster. Rebuilt only when the
 *  world's building version moves. */
const submergedBuildingCache = new WeakMap<WorldState, {
  version: number;
  list: Entity[];
}>();

/** The fixed floor makes lava decisive against tiny objects while the
 * max-health term prevents heavy units and structures from tanking it longer
 * than ordinary land units drown. A zero multiplier is explicit immunity. */
export function lavaDamagePerSecondFor(
  maxHp: number,
  lavaDamageMultiplier: number,
): number {
  if (!Number.isFinite(maxHp) || maxHp <= 0) return 0;
  if (!Number.isFinite(lavaDamageMultiplier) || lavaDamageMultiplier <= 0) return 0;
  return Math.max(
    LAVA_MINIMUM_DAMAGE_PER_SECOND,
    maxHp * LAVA_MAX_HEALTH_FRACTION_PER_SECOND,
  ) * lavaDamageMultiplier;
}

/** Drain health from every entity whose body reaches the lava surface.
 *  A no-op unless the battle is running with LIQUID = LAVA. */
export function applyLavaSurfaceDamage(world: WorldState, dtMs: number): void {
  if (world.liquidSurfaceMode !== 'lava') return;
  const dtSeconds = dtMs / 1000;
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return;

  // Units keep their ground-contact point as the touch test, so an aircraft
  // only burns once it descends into the surface.
  const units = world.getUnits();
  for (let i = 0; i < units.length; i++) {
    const entity = units[i];
    const unit = entity.unit;
    if (unit === null || unit.hp <= 0) continue;
    if (entity.transform.z > WATER_LEVEL) continue;
    const damage = lavaDamagePerSecondFor(
      unit.maxHp,
      unit.locomotion?.environmentalHazards.lavaDamageMultiplier ?? 1,
    ) * dtSeconds;
    if (damage <= 0) continue;
    unit.hp = Math.max(0, unit.hp - damage);
    world.markSnapshotDirty(entity.id, ENTITY_CHANGED_HP);
  }

  // Buildings sit on the ground they were placed on; a footprint flooded by
  // lava (an underwater extractor, say) cooks along with everything else.
  // Static placement means the submerged subset only changes with the
  // building roster (P1-18).
  const buildingVersion = world.getBuildingVersion();
  let cache = submergedBuildingCache.get(world);
  if (cache === undefined || cache.version !== buildingVersion) {
    const list: Entity[] = [];
    const buildings = world.getBuildings();
    for (let i = 0; i < buildings.length; i++) {
      const entity = buildings[i];
      if (entity.building === null) continue;
      if (entity.transform.z > WATER_LEVEL) continue;
      list.push(entity);
    }
    cache = { version: buildingVersion, list };
    submergedBuildingCache.set(world, cache);
  }
  const submerged = cache.list;
  for (let i = 0; i < submerged.length; i++) {
    const entity = submerged[i];
    const building = entity.building;
    if (building === null || building.hp <= 0) continue;
    const damage = lavaDamagePerSecondFor(building.maxHp, 1) * dtSeconds;
    building.hp = Math.max(0, building.hp - damage);
    world.markSnapshotDirty(entity.id, ENTITY_CHANGED_HP);
  }
}
