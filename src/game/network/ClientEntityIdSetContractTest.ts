import type { EntityId } from '../sim/types';
import { ClientEntityIdSet } from './ClientEntityIdSet';
import {
  IndexedEntityIdBooleanMemo,
  IndexedEntityIdMap,
} from './IndexedEntityIdCollections';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[client entity id set contract] ${message}`);
  }
}

export function runClientEntityIdSetContractTest(): void {
  const set = new ClientEntityIdSet();
  const first = 42 as EntityId;
  const second = 7 as EntityId;

  assertContract(set.add(first) === set, 'add returns the set');
  assertContract(set.has(first), 'has sees indexed id');
  assertContract(set.size === 1, 'indexed add updates Set storage');

  set.add(first);
  assertContract(set.size === 1, 'duplicate indexed add keeps Set semantics');

  set.add(second);
  assertContract([...set].join(',') === '42,7', 'iteration preserves insertion order');

  assertContract(set.delete(first), 'delete reports existing indexed id');
  assertContract(!set.has(first), 'delete clears indexed id');
  assertContract([...set].join(',') === '7', 'delete updates Set storage');

  const highId = 1_000_001 as EntityId;
  set.add(highId);
  assertContract(set.has(highId), 'high id falls back to Set storage');

  const restored = new ClientEntityIdSet([first, highId]);
  assertContract(restored.has(first), 'constructor indexes iterable values');
  assertContract(restored.has(highId), 'constructor stores high iterable values');
  assertContract([...restored].join(',') === '42,1000001', 'constructor preserves iterable order');

  set.clear();
  const clearedSize: number = set.size;
  assertContract(clearedSize === 0, 'clear empties Set storage');
  assertContract(!set.has(second), 'clear empties indexed storage');
  assertContract(!set.has(highId), 'clear empties fallback storage');

  set.add(second);
  assertContract(set.has(second), 'indexed id can be re-added after clear');
  assertContract([...set].join(',') === '7', 're-add after clear keeps Set iteration semantics');

  const memo = new IndexedEntityIdBooleanMemo();
  assertContract(memo.get(first) === undefined, 'boolean memo starts unset');
  memo.set(first, false);
  assertContract(memo.get(first) === false, 'boolean memo stores indexed false');
  memo.set(first, true);
  assertContract(memo.get(first) === true, 'boolean memo overwrites indexed true');
  memo.set(highId, false);
  assertContract(memo.get(highId) === false, 'boolean memo stores fallback false');
  memo.clear();
  assertContract(memo.get(first) === undefined, 'boolean memo clear empties indexed value');
  assertContract(memo.get(highId) === undefined, 'boolean memo clear empties fallback value');

  const map = new IndexedEntityIdMap<string>();
  assertContract(map.set(first, 'first') === map, 'indexed map set returns map');
  assertContract(map.get(first) === 'first', 'indexed map gets indexed value');
  map.set(first, 'second');
  assertContract(map.get(first) === 'second', 'indexed map replaces indexed value');
  assertContract([...map.values()].join(',') === 'second', 'indexed map preserves Map iteration');
  map.set(highId, 'fallback');
  assertContract(map.get(highId) === 'fallback', 'indexed map gets fallback value');
  assertContract(map.delete(first), 'indexed map delete reports indexed value');
  assertContract(map.get(first) === undefined, 'indexed map delete clears indexed value');
  map.clear();
  assertContract(map.get(highId) === undefined, 'indexed map clear empties fallback value');
}
