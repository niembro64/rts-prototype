import type { EntityId } from '../sim/types';
import { canIndexClientEntityId } from './ClientEntityIds';

const INITIAL_MARK_CAPACITY = 1024;
const MAX_MARK = 0xffffffff;

export class IndexedEntityIdSet extends Set<EntityId> {
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

export class IndexedEntityIdBooleanMemo {
  private states = new Uint8Array(0);
  private readonly fallback = new Map<EntityId, boolean>();

  get(id: EntityId): boolean | undefined {
    if (canIndexClientEntityId(id)) {
      const state = id < this.states.length ? this.states[id] : 0;
      if (state === 0) return this.fallback.get(id);
      return state === 2;
    }
    return this.fallback.get(id);
  }

  set(id: EntityId, value: boolean): void {
    if (canIndexClientEntityId(id)) {
      this.ensureStateCapacity(id + 1);
      this.states[id] = value ? 2 : 1;
      return;
    }
    this.fallback.set(id, value);
  }

  clear(): void {
    this.states.fill(0);
    this.fallback.clear();
  }

  private ensureStateCapacity(required: number): void {
    if (this.states.length >= required) return;
    let next = this.states.length > 0 ? this.states.length : INITIAL_MARK_CAPACITY;
    while (next < required) next *= 2;
    const states = new Uint8Array(next);
    states.set(this.states);
    this.states = states;
  }
}

export class IndexedEntityIdMap<T> extends Map<EntityId, T> {
  private readonly byId: Array<T | undefined> = [];

  override get(id: EntityId): T | undefined {
    if (canIndexClientEntityId(id)) return this.byId[id] ?? super.get(id);
    return super.get(id);
  }

  override has(id: EntityId): boolean {
    if (canIndexClientEntityId(id) && this.byId[id] !== undefined) return true;
    return super.has(id);
  }

  override set(id: EntityId, value: T): this {
    if (canIndexClientEntityId(id)) this.byId[id] = value;
    return super.set(id, value);
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
