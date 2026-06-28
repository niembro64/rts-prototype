import type { EntityId } from '../sim/types';
import { canIndexClientEntityId } from './ClientEntityIds';

const PRESENT = 1;

export class ClientEntityIdSet extends Set<EntityId> {
  private readonly byId: Array<typeof PRESENT | undefined> = [];

  constructor(values?: Iterable<EntityId>) {
    super();
    if (values !== undefined) {
      for (const value of values) this.add(value);
    }
  }

  override add(id: EntityId): this {
    if (canIndexClientEntityId(id)) this.byId[id] = PRESENT;
    return super.add(id);
  }

  override has(id: EntityId): boolean {
    if (canIndexClientEntityId(id) && this.byId[id] === PRESENT) return true;
    return super.has(id);
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
