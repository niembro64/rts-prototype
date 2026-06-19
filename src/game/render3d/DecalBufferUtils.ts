// DecalBufferUtils — dirty-slot-range tracking for the merged decal
// geometries (BurnMark3D, GroundPrint3D). Both renderers pack their
// quads into a single BufferGeometry and update only the slots that
// changed each frame. A DirtySlotSpan records the [min, max] slot range
// touched since the last upload so we can flush one contiguous
// addUpdateRange instead of re-uploading the whole attribute.

import type * as THREE from 'three';

export type DirtySlotSpan = {
  minSlot: number;
  maxSlot: number;
};

export function createDirtySlotSpan(): DirtySlotSpan {
  return { minSlot: Number.POSITIVE_INFINITY, maxSlot: -1 };
}

export function markDirtySlot(span: DirtySlotSpan, slot: number): void {
  if (slot < span.minSlot) span.minSlot = slot;
  if (slot > span.maxSlot) span.maxSlot = slot;
}

export function clearDirtySlotSpan(span: DirtySlotSpan): void {
  span.minSlot = Number.POSITIVE_INFINITY;
  span.maxSlot = -1;
}

export function uploadDirtySlotSpan(
  attr: THREE.BufferAttribute,
  span: DirtySlotSpan,
  componentsPerSlot: number,
  activeSlots: number,
): void {
  if (span.maxSlot < span.minSlot || activeSlots <= 0) {
    clearDirtySlotSpan(span);
    return;
  }
  const minSlot = Math.max(0, Math.min(span.minSlot, activeSlots - 1));
  const maxSlot = Math.max(minSlot, Math.min(span.maxSlot, activeSlots - 1));
  attr.clearUpdateRanges();
  attr.addUpdateRange(
    minSlot * componentsPerSlot,
    (maxSlot - minSlot + 1) * componentsPerSlot,
  );
  attr.needsUpdate = true;
  clearDirtySlotSpan(span);
}
