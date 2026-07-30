// LIQUID = LAVA: molten rock burns anything touching its surface.
//
// Modelled exactly like the authored locomotion `waterDamagePerSecond` drain —
// a direct hp write on the fixed step, no per-tick damage event, no attacker —
// so it stays bit-identical across peers and routes deaths through the shared
// pendingDeathCheck cleanup the same way a self-destruct does.

import terrainConfig from './terrain/terrainConfig.json';
import { WATER_LEVEL } from './terrain/terrainConfig';
import { ENTITY_CHANGED_HP } from '../../types/network';
import type { WorldState } from './WorldState';

/** Drain health from every entity whose body reaches the lava surface.
 *  A no-op unless the battle is running with LIQUID = LAVA. */
export function applyLavaSurfaceDamage(world: WorldState, dtMs: number): void {
  if (world.liquidSurfaceMode !== 'lava') return;
  const damage = terrainConfig.water.lavaDamagePerSecond * (dtMs / 1000);
  if (damage <= 0) return;

  // Units keep their ground-contact point as the touch test, so an aircraft
  // only burns once it descends into the surface.
  const units = world.getUnits();
  for (let i = 0; i < units.length; i++) {
    const entity = units[i];
    const unit = entity.unit;
    if (unit === null || unit.hp <= 0) continue;
    if (entity.transform.z > WATER_LEVEL) continue;
    unit.hp = Math.max(0, unit.hp - damage);
    world.markSnapshotDirty(entity.id, ENTITY_CHANGED_HP);
  }

  // Buildings sit on the ground they were placed on; a footprint flooded by
  // lava (an underwater extractor, say) cooks along with everything else.
  const buildings = world.getBuildings();
  for (let i = 0; i < buildings.length; i++) {
    const entity = buildings[i];
    const building = entity.building;
    if (building === null || building.hp <= 0) continue;
    if (entity.transform.z > WATER_LEVEL) continue;
    building.hp = Math.max(0, building.hp - damage);
    world.markSnapshotDirty(entity.id, ENTITY_CHANGED_HP);
  }
}
