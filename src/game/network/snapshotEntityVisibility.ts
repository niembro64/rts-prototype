import type { Entity } from '../sim/types';
import type { SnapshotVisibility } from './stateSerializerVisibility';

export function isSerializableSnapshotEntity(entity: Entity): boolean {
  return entity.type === 'unit' || entity.type === 'building';
}

export function acceptsSerializedEntity(
  entity: Entity,
  visibility: SnapshotVisibility,
): boolean {
  return isSerializableSnapshotEntity(entity) &&
    (!visibility.isFiltered || visibility.isEntityVisible(entity));
}
