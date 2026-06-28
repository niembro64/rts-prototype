import type { Entity, EntityId } from '../sim/types';

const FAST_ENTITY_ID_LIMIT = 1_000_000;

function canIndexEntityId(id: EntityId): boolean {
  return Number.isInteger(id) && id >= 0 && id <= FAST_ENTITY_ID_LIMIT;
}

export class ClientEntityStore extends Map<EntityId, Entity> {
  private readonly byId: Array<Entity | undefined> = [];

  override get(id: EntityId): Entity | undefined {
    if (canIndexEntityId(id)) return this.byId[id] ?? super.get(id);
    return super.get(id);
  }

  override has(id: EntityId): boolean {
    if (canIndexEntityId(id) && this.byId[id] !== undefined) return true;
    return super.has(id);
  }

  override set(id: EntityId, entity: Entity): this {
    if (canIndexEntityId(id)) this.byId[id] = entity;
    return super.set(id, entity);
  }

  override delete(id: EntityId): boolean {
    if (canIndexEntityId(id)) this.byId[id] = undefined;
    return super.delete(id);
  }

  override clear(): void {
    this.byId.length = 0;
    super.clear();
  }
}
