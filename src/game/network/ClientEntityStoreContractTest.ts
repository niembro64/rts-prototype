import type { Entity, EntityId } from '../sim/types';
import { ClientEntityStore } from './ClientEntityStore';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[client entity store contract] ${message}`);
  }
}

function entity(id: EntityId): Entity {
  return { id } as Entity;
}

export function runClientEntityStoreContractTest(): void {
  const store = new ClientEntityStore();
  const id = 42 as EntityId;
  const first = entity(id);
  const second = entity(id);

  assertContract(store.set(id, first) === store, 'set returns the store');
  assertContract(store.get(id) === first, 'get returns indexed entity');
  assertContract(store.has(id), 'has sees indexed entity');

  store.set(id, second);
  assertContract(store.get(id) === second, 'set replaces indexed entity');
  assertContract([...store.values()][0] === second, 'Map iteration sees replacement');

  assertContract(store.delete(id), 'delete reports existing entity');
  assertContract(store.get(id) === undefined, 'delete clears indexed entity');
  assertContract(!store.has(id), 'has clears after delete');

  const highId = 1_000_001 as EntityId;
  const high = entity(highId);
  store.set(highId, high);
  assertContract(store.get(highId) === high, 'high id falls back to Map storage');

  store.clear();
  assertContract(store.size === 0, 'clear empties Map storage');
  assertContract(store.get(highId) === undefined, 'clear empties fallback storage');
}
