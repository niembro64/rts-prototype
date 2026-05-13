// Per-key DTO pool helper shared by the audio / spray / minimap
// snapshot serializers (issues.txt FOW-OPT-07 + FOW-OPT-20).
//
// Each serializer maintains a Map<trackingKey, SnapshotPool<T>>: one
// pool per snapshot listener. The pool grows lazily as the listener
// observes more events of that kind, and the head index resets to
// zero at the start of every serialize call so the previous emit's
// content can be safely reclaimed. Per-listener keying avoids the
// hidden coupling where two listeners reading the same module-global
// array would mutate each other's returned buffer.
//
// A pool entry has THREE slots:
//   - `pool`: the backing array of pooled DTOs. Grows over time as
//     larger emits are observed; never shrinks. Slot reuse is the
//     whole point.
//   - `buf`:  the output buffer the serializer returns. Pushed into
//     during one serialize call, truncated to length 0 at the start
//     of the next.
//   - `index`: head pointer into `pool`. Advanced by getPooledItem;
//     reset to 0 at the start of each serialize call.

import type { PlayerId } from '../sim/types';

export type SnapshotPool<T> = {
  buf: T[];
  pool: T[];
  index: number;
};

/** Lazily get-or-create the pool slot for `key`. The serializer calls
 *  this once per invocation and the returned state survives across
 *  emits, so the pool's slot reuse compounds over the listener's
 *  lifetime. */
export function getOrCreateSnapshotPool<T>(
  pools: Map<string, SnapshotPool<T>>,
  key: string,
): SnapshotPool<T> {
  let state = pools.get(key);
  if (!state) {
    state = { buf: [], pool: [], index: 0 };
    pools.set(key, state);
  }
  return state;
}

/** Pop the next DTO off the pool head, allocating a new one via
 *  `create` only when the head ran past the end of the backing
 *  array. Always advances `state.index`, so the caller never has
 *  to remember to do that. */
export function getPooledItem<T>(state: SnapshotPool<T>, create: () => T): T {
  let item = state.pool[state.index];
  if (!item) {
    item = create();
    state.pool[state.index] = item;
  }
  state.index++;
  return item;
}

/** Drop the pool entry for a tracking key — called from
 *  GameServer.removeSnapshotListener so per-listener pools don't
 *  accumulate forever across lobby joins / disconnects. The key may
 *  be a number (listener ids) or a string; both are normalized to
 *  string before lookup. No-op when the key was never seen. */
export function deleteSnapshotPoolForKey<T>(
  pools: Map<string, SnapshotPool<T>>,
  key: string | number | undefined,
): void {
  if (key === undefined) return;
  pools.delete(String(key));
}

/** Sentinel used when a serializer is invoked without a trackingKey
 *  (e.g. ad-hoc cloners, the admin / spectator path). Routes those
 *  callers through one shared pool — they pay the same hidden-coupling
 *  cost the per-listener split avoided, but no real call site does
 *  this today. */
export const DEFAULT_SNAPSHOT_POOL_KEY = '__default__';

/** Resolve a serializer trackingKey (string | number | undefined) to
 *  the string used as the pool map key. Centralized so the audio /
 *  spray / minimap call sites stay identical. */
export function resolveSnapshotPoolKey(
  trackingKey: string | number | PlayerId | undefined,
): string {
  return trackingKey !== undefined ? String(trackingKey) : DEFAULT_SNAPSHOT_POOL_KEY;
}
