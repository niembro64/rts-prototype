// Per-tick pass that mirrors a shell's HP onto its avg-of-three resource
// fill ratio. While `buildable.isComplete === false`, the entity's hp is
// driven from the bars so a half-built shell sits at exactly half HP. As
// soon as the shell flips complete, the regular damage / heal systems
// take over and this pass leaves it alone.

import type { WorldState } from './WorldState';
import { getBuildFraction } from './buildableHelpers';
import { ENTITY_CHANGED_HP } from '../../types/network';

export function syncShellHpToBuildFraction(world: WorldState): void {
  // Iterate units (factory shells) and buildings (construction shells)
  // — both can carry a non-complete buildable.
  const sources: ReadonlyArray<readonly { id: number }[]> = [
    world.getUnits() as readonly { id: number }[],
    world.getBuildings() as readonly { id: number }[],
  ];
  for (const list of sources) {
    for (const item of list) {
      const entity = world.getEntity(item.id);
      if (!entity) continue;
      const buildable = entity.buildable;
      if (!buildable || buildable.isComplete || buildable.isGhost) continue;
      const frac = getBuildFraction(buildable);
      if (entity.unit) {
        const target = frac * entity.unit.maxHp;
        if (entity.unit.hp !== target) {
          entity.unit.hp = target;
          world.markSnapshotDirty(entity.id, ENTITY_CHANGED_HP);
        }
      } else if (entity.building) {
        const target = frac * entity.building.maxHp;
        if (entity.building.hp !== target) {
          entity.building.hp = target;
          world.markSnapshotDirty(entity.id, ENTITY_CHANGED_HP);
        }
      }
    }
  }
}
