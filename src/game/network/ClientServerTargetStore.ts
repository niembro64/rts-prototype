import type { EntityId } from '../sim/types';
import {
  acquireServerTarget,
  releaseServerTarget,
  type ServerTarget,
} from './ClientPredictionTargets';
import { IndexedEntityIdMap } from './IndexedEntityIdCollections';

export class ClientServerTargetStore extends IndexedEntityIdMap<ServerTarget> {
  private readonly pooledTargets = new WeakSet<ServerTarget>();

  override set(id: EntityId, target: ServerTarget): this {
    const previous = this.get(id);
    if (previous !== undefined && previous !== target && this.pooledTargets.delete(previous)) {
      releaseServerTarget(previous);
    }
    return super.set(id, target);
  }

  override delete(id: EntityId): boolean {
    const target = this.get(id);
    if (target === undefined) return false;
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
    super.clear();
  }

  getOrCreate(id: EntityId): ServerTarget {
    let target = super.get(id);
    if (target !== undefined) return target;
    target = acquireServerTarget();
    this.pooledTargets.add(target);
    this.set(id, target);
    return target;
  }
}
