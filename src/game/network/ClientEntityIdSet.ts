import type { EntityId } from '../sim/types';
import { canIndexClientEntityId } from './ClientEntityIds';

const INITIAL_MARK_CAPACITY = 1024;
const MAX_MARK = 0xffffffff;

export class ClientEntityIdSet extends Set<EntityId> {
  private marks = new Uint32Array(0);
  private mark = 1;

  constructor(values?: Iterable<EntityId>) {
    super();
    if (values !== undefined) {
      for (const value of values) this.add(value);
    }
  }

  override add(id: EntityId): this {
    if (canIndexClientEntityId(id)) {
      this.ensureMarkCapacity(id + 1);
      if (this.marks[id] === this.mark) return this;
      this.marks[id] = this.mark;
    }
    return super.add(id);
  }

  override has(id: EntityId): boolean {
    if (canIndexClientEntityId(id) && id < this.marks.length && this.marks[id] === this.mark) {
      return true;
    }
    return super.has(id);
  }

  override delete(id: EntityId): boolean {
    if (canIndexClientEntityId(id) && id < this.marks.length) this.marks[id] = 0;
    return super.delete(id);
  }

  override clear(): void {
    this.advanceMark();
    super.clear();
  }

  private ensureMarkCapacity(required: number): void {
    if (this.marks.length >= required) return;
    let next = this.marks.length > 0 ? this.marks.length : INITIAL_MARK_CAPACITY;
    while (next < required) next *= 2;
    const marks = new Uint32Array(next);
    marks.set(this.marks);
    this.marks = marks;
  }

  private advanceMark(): void {
    if (this.mark < MAX_MARK) {
      this.mark++;
      return;
    }
    this.marks.fill(0);
    this.mark = 1;
  }
}
