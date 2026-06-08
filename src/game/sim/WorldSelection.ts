import type { Entity, EntityId, PlayerId } from './types';

function isOwnedSelectable(entity: Entity, playerId: PlayerId): boolean {
  return entity.selectable !== null &&
    entity.ownership !== null &&
    entity.ownership.playerId === playerId;
}

function isOwnedSelected(entity: Entity, playerId: PlayerId): boolean {
  return isOwnedSelectable(entity, playerId) && entity.selectable!.selected;
}

export function collectSelectedOwnedEntities(
  entities: readonly Entity[],
  playerId: PlayerId,
  out: Entity[],
): Entity[] {
  out.length = 0;
  for (const entity of entities) {
    if (isOwnedSelected(entity, playerId)) out.push(entity);
  }
  return out;
}

export function clearOwnedSelection(
  entities: Iterable<Entity>,
  playerId: PlayerId,
): void {
  for (const entity of entities) {
    if (isOwnedSelectable(entity, playerId)) {
      entity.selectable!.selected = false;
    }
  }
}

export function selectOwnedEntities(
  ids: readonly EntityId[],
  entities: ReadonlyMap<EntityId, Entity>,
  playerId: PlayerId,
): void {
  for (const id of ids) {
    const entity = entities.get(id);
    if (entity !== undefined && isOwnedSelectable(entity, playerId)) {
      entity.selectable!.selected = true;
    }
  }
}
