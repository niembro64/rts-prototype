import type { EntityId } from '../sim/types';
import { createServerTarget } from './ClientPredictionTargets';
import { ClientServerTargetStore } from './ClientServerTargetStore';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[client server target store contract] ${message}`);
  }
}

export function runClientServerTargetStoreContractTest(): void {
  const store = new ClientServerTargetStore();
  const id = 42 as EntityId;
  const first = createServerTarget();
  const second = createServerTarget();
  second.x = 100;

  assertContract(store.set(id, first) === store, 'set returns the store');
  assertContract(store.get(id) === first, 'get returns indexed target');
  assertContract(store.has(id), 'has sees indexed target');

  store.set(id, second);
  assertContract(store.get(id) === second, 'set replaces indexed target');
  assertContract([...store.values()][0] === second, 'Map iteration sees replacement');

  assertContract(store.delete(id), 'delete reports existing target');
  assertContract(store.get(id) === undefined, 'delete clears indexed target');
  assertContract(!store.has(id), 'has clears after delete');

  const highId = 1_000_001 as EntityId;
  const high = createServerTarget();
  high.y = 200;
  store.set(highId, high);
  assertContract(store.get(highId) === high, 'high id falls back to Map storage');

  store.clear();
  assertContract(store.size === 0, 'clear empties Map storage');
  assertContract(store.get(highId) === undefined, 'clear empties fallback storage');
}
