import type { EntityId } from '../sim/types';
import type { ServerTarget } from './ClientPredictionTargets';
import { canIndexClientEntityId } from './ClientEntityIds';

export class ClientServerTargetStore extends Map<EntityId, ServerTarget> {
  private readonly byId: Array<ServerTarget | undefined> = [];

  override get(id: EntityId): ServerTarget | undefined {
    if (canIndexClientEntityId(id)) return this.byId[id] ?? super.get(id);
    return super.get(id);
  }

  override has(id: EntityId): boolean {
    if (canIndexClientEntityId(id) && this.byId[id] !== undefined) return true;
    return super.has(id);
  }

  override set(id: EntityId, target: ServerTarget): this {
    if (canIndexClientEntityId(id)) this.byId[id] = target;
    return super.set(id, target);
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
