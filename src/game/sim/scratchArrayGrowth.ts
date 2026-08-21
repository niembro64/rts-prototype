// scratchArrayGrowth — capacity growth for module-scope scratch typed
// arrays that are populated ROW BY ROW, with the growth check running per
// appended row.
//
// A bare `new Float64Array(next)` reallocation discards every row already
// written this tick. That is not just wrong output — it is a determinism
// leak: the scratch arrays live at module scope, so their capacity carries
// over from one battle to the next in the same process. The first battle
// crosses its capacity boundaries mid-population and computes on zeroed
// rows, while a later battle inherits the grown arrays and computes on the
// real rows — identical inputs, different results. The deterministic-replay
// harness caught exactly this as a run1-vs-run2 hash split the first time a
// case queued more than one capacity chunk of turret-articulation rows on
// its opening tick (the demo base opening). Growing WITH contents makes a
// cold process compute the same thing as a warm one.
//
// Helpers that size their arrays ONCE before the fill loop (final count
// known up front) don't need this — nothing is written before that growth.

type GrowableScratchArray =
  | Float64Array
  | Float32Array
  | Int32Array
  | Uint32Array
  | Uint16Array
  | Uint8Array;

/** Reallocate `old` to `capacity` slots, preserving its contents. */
export function growScratchArray<T extends GrowableScratchArray>(
  old: T,
  capacity: number,
): T {
  const next = new (old.constructor as new (length: number) => T)(capacity);
  (next as GrowableScratchArray).set(old as GrowableScratchArray & ArrayLike<number>);
  return next;
}
