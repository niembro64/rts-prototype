import type { Entity, EntityId } from '../sim/types';
import type { EntityMesh } from './EntityMesh3D';

export type AnimatedBuildingEntry = {
  id: EntityId;
  entity: Entity;
  mesh: EntityMesh;
};

export function addAnimatedBuildingEntry(
  list: AnimatedBuildingEntry[],
  indexById: Map<EntityId, number>,
  entity: Entity,
  mesh: EntityMesh,
): AnimatedBuildingEntry {
  const id = entity.id;
  const existingIndex = indexById.get(id);
  if (existingIndex !== undefined) {
    const entry = list[existingIndex];
    entry.entity = entity;
    entry.mesh = mesh;
    return entry;
  }
  const entry = { id, entity, mesh };
  indexById.set(id, list.length);
  list.push(entry);
  return entry;
}

export function removeAnimatedBuildingEntry<TEntry extends AnimatedBuildingEntry>(
  list: TEntry[],
  indexById: Map<EntityId, number>,
  id: EntityId,
): void {
  const index = indexById.get(id);
  if (index === undefined) return;
  indexById.delete(id);
  const lastIndex = list.length - 1;
  if (index !== lastIndex) {
    const last = list[lastIndex];
    list[index] = last;
    indexById.set(last.id, index);
  }
  list.pop();
}

export function clearAnimatedBuildingEntries<TEntry extends AnimatedBuildingEntry>(
  list: TEntry[],
  indexById: Map<EntityId, number>,
): void {
  list.length = 0;
  indexById.clear();
}

export function addActiveAnimatedBuildingEntry<TEntry extends AnimatedBuildingEntry>(
  activeList: TEntry[],
  activeIndexById: Map<EntityId, number>,
  entry: TEntry,
): void {
  const activeIndex = activeIndexById.get(entry.id);
  if (activeIndex !== undefined) {
    activeList[activeIndex] = entry;
    return;
  }
  activeIndexById.set(entry.id, activeList.length);
  activeList.push(entry);
}

export function updateAnimatedBuildingQueue<TEntry extends AnimatedBuildingEntry>(
  activeList: TEntry[],
  activeIndexById: Map<EntityId, number>,
  entry: TEntry,
  needsFrame: boolean,
): void {
  const activeIndex = activeIndexById.get(entry.id);
  if (!needsFrame) {
    if (activeIndex !== undefined) {
      removeAnimatedBuildingEntry(activeList, activeIndexById, entry.id);
    }
    return;
  }
  if (activeIndex !== undefined) {
    activeList[activeIndex] = entry;
    return;
  }
  activeIndexById.set(entry.id, activeList.length);
  activeList.push(entry);
}
