import { entitySlotRegistry } from './EntitySlotRegistry';
import type { Entity, EntityId } from './types';
import type { WorldState } from './WorldState';

export function resolveEntityFromSlotOrWorld(
  world: WorldState,
  id: EntityId,
  slot: number,
): Entity | undefined {
  if (slot >= 0) {
    const entity = entitySlotRegistry.resolveSlot(slot);
    if (entity !== undefined && entity.id === id) return entity;
  }
  return world.getEntity(id);
}
