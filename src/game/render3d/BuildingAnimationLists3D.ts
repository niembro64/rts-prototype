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

export function removeAnimatedBuildingEntry(
  list: AnimatedBuildingEntry[],
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
