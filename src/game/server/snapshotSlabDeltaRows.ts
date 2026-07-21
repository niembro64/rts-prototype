import {
  appendBasicEntityWireRowDirectFromState,
  appendBuildingHotEntityWireRowDirectFromState,
  appendUnitMotionEntityWireRowDirectFromState,
} from '../network/stateSerializerEntities';
import { entitySlotRegistry, type EntityStateViews } from '../sim/EntitySlotRegistry';
import type { EntityId } from '../sim/types';
import {
  ENTITY_BASIC_TRANSFORM_DELTA_FIELDS,
  ENTITY_UNIT_SLAB_DELTA_FIELDS,
} from './snapshotMotionDeltaPolicy';

function resolveEntityStateSlot(
  id: EntityId,
  entityViews: EntityStateViews | null,
  slot: number,
): number {
  if (entityViews === null) return -1;
  let resolvedSlot = slot;
  if (
    resolvedSlot < 0 ||
    resolvedSlot >= entityViews.capacity ||
    entityViews.entityId[resolvedSlot] !== id
  ) {
    resolvedSlot = entitySlotRegistry.getSlot(id);
  }
  return (
    resolvedSlot >= 0 &&
    resolvedSlot < entityViews.capacity &&
    entityViews.entityId[resolvedSlot] === id
  )
    ? resolvedSlot
    : -1;
}

export function tryAppendUnitSlabDeltaRowFromState(
  id: EntityId,
  changedFields: number,
  entityViews: EntityStateViews | null,
  slot = -1,
): boolean {
  if (changedFields === 0 || (changedFields & ~ENTITY_UNIT_SLAB_DELTA_FIELDS) !== 0) {
    return false;
  }
  const resolvedSlot = resolveEntityStateSlot(id, entityViews, slot);
  return resolvedSlot >= 0 && entityViews !== null
    ? appendUnitMotionEntityWireRowDirectFromState(entityViews, resolvedSlot, changedFields)
    : false;
}

export function tryAppendBuildingSlabDeltaRowFromState(
  id: EntityId,
  changedFields: number,
  entityViews: EntityStateViews | null,
  slot = -1,
): boolean {
  const resolvedSlot = resolveEntityStateSlot(id, entityViews, slot);
  if (resolvedSlot < 0 || entityViews === null) return false;
  if ((changedFields & ~ENTITY_BASIC_TRANSFORM_DELTA_FIELDS) === 0) {
    return appendBasicEntityWireRowDirectFromState(entityViews, resolvedSlot, changedFields);
  }
  return appendBuildingHotEntityWireRowDirectFromState(entityViews, resolvedSlot, changedFields);
}
