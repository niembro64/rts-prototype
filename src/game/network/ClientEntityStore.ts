import type { Entity, EntityId } from '../sim/types';
import { canIndexClientEntityId } from './ClientEntityIds';

export class ClientEntityStore extends Map<EntityId, Entity> {
  private readonly byId: Array<Entity | undefined> = [];

  override get(id: EntityId): Entity | undefined {
    if (canIndexClientEntityId(id)) return this.byId[id] ?? super.get(id);
    return super.get(id);
  }

  override has(id: EntityId): boolean {
    if (canIndexClientEntityId(id) && this.byId[id] !== undefined) return true;
    return super.has(id);
  }

  override set(id: EntityId, entity: Entity): this {
    if (canIndexClientEntityId(id)) this.byId[id] = entity;
    return super.set(id, entity);
  }

  override delete(id: EntityId): boolean {
    if (canIndexClientEntityId(id)) this.byId[id] = undefined;
    return super.delete(id);
  }

  override clear(): void {
    this.byId.length = 0;
    super.clear();
  }
}
