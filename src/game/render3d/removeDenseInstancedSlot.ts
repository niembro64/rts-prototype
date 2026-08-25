import { markDirtySlot, type DirtySlotSpan } from './instancedBufferUpdate';

type DenseInstancedScalarChannel = Readonly<{
  values: Float32Array;
  dirty: DirtySlotSpan;
}>;

/**
 * Remove one item from a dense instanced pool by moving its final slot.
 *
 * `byKey` stores the item object itself, so changing the moved object's slot
 * keeps the existing map entry current without a redundant delete/set pair.
 */
export function removeDenseInstancedSlot<
  Key,
  Item extends { readonly key: Key; slot: number },
>(
  items: Item[],
  byKey: Map<Key, Item>,
  slot: number,
  matrices: Float32Array,
  matrixDirty: DirtySlotSpan,
  scalarChannels: readonly DenseInstancedScalarChannel[],
): number {
  const last = items.length - 1;
  const removed = items[slot];
  byKey.delete(removed.key);
  if (slot !== last) {
    const moved = items[last];
    moved.slot = slot;
    items[slot] = moved;
    matrices.copyWithin(slot * 16, last * 16, last * 16 + 16);
    markDirtySlot(matrixDirty, slot);
    for (const channel of scalarChannels) {
      channel.values[slot] = channel.values[last];
      markDirtySlot(channel.dirty, slot);
    }
  }
  items.pop();
  return items.length;
}
