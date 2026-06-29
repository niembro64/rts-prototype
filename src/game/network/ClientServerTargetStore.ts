import type { EntityId } from '../sim/types';
import {
  acquireServerTarget,
  releaseServerTarget,
  type ServerTarget,
} from './ClientPredictionTargets';
import { canIndexClientEntityId } from './ClientEntityIds';

export class ClientServerTargetStore extends Map<EntityId, ServerTarget> {
  private readonly byId: Array<ServerTarget | undefined> = [];
  private readonly pooledTargets = new WeakSet<ServerTarget>();

  override get(id: EntityId): ServerTarget | undefined {
    if (canIndexClientEntityId(id)) return this.byId[id] ?? super.get(id);
    return super.get(id);
  }

  override has(id: EntityId): boolean {
    if (canIndexClientEntityId(id) && this.byId[id] !== undefined) return true;
    return super.has(id);
  }

  override set(id: EntityId, target: ServerTarget): this {
    const previous = this.get(id);
    if (previous !== undefined && previous !== target && this.pooledTargets.delete(previous)) {
      releaseServerTarget(previous);
    }
    if (canIndexClientEntityId(id)) this.byId[id] = target;
    return super.set(id, target);
  }

  override delete(id: EntityId): boolean {
    const target = this.get(id);
    if (canIndexClientEntityId(id)) this.byId[id] = undefined;
    const deleted = super.delete(id);
    if (deleted && target !== undefined && this.pooledTargets.delete(target)) {
      releaseServerTarget(target);
    }
    return deleted;
  }

  override clear(): void {
    for (const target of super.values()) {
      if (this.pooledTargets.delete(target)) releaseServerTarget(target);
    }
    this.byId.length = 0;
    super.clear();
  }

  getOrCreate(id: EntityId): ServerTarget {
    if (canIndexClientEntityId(id)) {
      let target = this.byId[id];
      if (target !== undefined) return target;
      target = super.get(id);
      if (target !== undefined) {
        this.byId[id] = target;
        return target;
      }
      target = acquireServerTarget();
      this.pooledTargets.add(target);
      this.byId[id] = target;
      super.set(id, target);
      return target;
    }
    let target = super.get(id);
    if (target !== undefined) return target;
    target = acquireServerTarget();
    this.pooledTargets.add(target);
    this.set(id, target);
    return target;
  }
}
