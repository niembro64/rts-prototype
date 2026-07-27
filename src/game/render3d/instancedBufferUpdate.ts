import * as THREE from 'three';

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

export function hasDirtySlotSpan(span: DirtySlotSpan): boolean {
  return span.maxSlot >= span.minSlot;
}

export function uploadDirtySlotSpan(
  attribute: THREE.BufferAttribute,
  span: DirtySlotSpan,
  itemSize: number,
  activeSlots?: number,
): void {
  if (
    !hasDirtySlotSpan(span) ||
    (activeSlots !== undefined && activeSlots <= 0)
  ) {
    if (activeSlots !== undefined) clearDirtySlotSpan(span);
    return;
  }
  const minSlot = activeSlots === undefined
    ? span.minSlot
    : Math.max(0, Math.min(span.minSlot, activeSlots - 1));
  const maxSlot = activeSlots === undefined
    ? span.maxSlot
    : Math.max(minSlot, Math.min(span.maxSlot, activeSlots - 1));
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(
    minSlot * itemSize,
    (maxSlot - minSlot + 1) * itemSize,
  );
  attribute.needsUpdate = true;
  clearDirtySlotSpan(span);
}

export function setInstancedMeshCount(
  mesh: THREE.InstancedMesh,
  count: number,
): void {
  if (mesh.count !== count) mesh.count = count;
}

export function writeInstancedMatrix(
  mesh: THREE.InstancedMesh,
  slot: number,
  matrix: THREE.Matrix4,
  dirty: DirtySlotSpan,
): void {
  const source = matrix.elements;
  writeInstancedMatrixValues(mesh, slot, source, 0, dirty, true);
}

export function writeInstancedMatrixArray(
  mesh: THREE.InstancedMesh,
  slot: number,
  source: ArrayLike<number>,
  sourceOffset: number,
  dirty: DirtySlotSpan,
): void {
  writeInstancedMatrixValues(mesh, slot, source, sourceOffset, dirty, false);
}

function writeInstancedMatrixValues(
  mesh: THREE.InstancedMesh,
  slot: number,
  source: ArrayLike<number>,
  sourceOffset: number,
  dirty: DirtySlotSpan,
  roundToFloat32: boolean,
): void {
  const output = mesh.instanceMatrix.array;
  const offset = slot * 16;
  const s0 = floatValue(source[sourceOffset], roundToFloat32);
  const s1 = floatValue(source[sourceOffset + 1], roundToFloat32);
  const s2 = floatValue(source[sourceOffset + 2], roundToFloat32);
  const s3 = floatValue(source[sourceOffset + 3], roundToFloat32);
  const s4 = floatValue(source[sourceOffset + 4], roundToFloat32);
  const s5 = floatValue(source[sourceOffset + 5], roundToFloat32);
  const s6 = floatValue(source[sourceOffset + 6], roundToFloat32);
  const s7 = floatValue(source[sourceOffset + 7], roundToFloat32);
  const s8 = floatValue(source[sourceOffset + 8], roundToFloat32);
  const s9 = floatValue(source[sourceOffset + 9], roundToFloat32);
  const s10 = floatValue(source[sourceOffset + 10], roundToFloat32);
  const s11 = floatValue(source[sourceOffset + 11], roundToFloat32);
  const s12 = floatValue(source[sourceOffset + 12], roundToFloat32);
  const s13 = floatValue(source[sourceOffset + 13], roundToFloat32);
  const s14 = floatValue(source[sourceOffset + 14], roundToFloat32);
  const s15 = floatValue(source[sourceOffset + 15], roundToFloat32);
  if (
    output[offset] === s0 &&
    output[offset + 1] === s1 &&
    output[offset + 2] === s2 &&
    output[offset + 3] === s3 &&
    output[offset + 4] === s4 &&
    output[offset + 5] === s5 &&
    output[offset + 6] === s6 &&
    output[offset + 7] === s7 &&
    output[offset + 8] === s8 &&
    output[offset + 9] === s9 &&
    output[offset + 10] === s10 &&
    output[offset + 11] === s11 &&
    output[offset + 12] === s12 &&
    output[offset + 13] === s13 &&
    output[offset + 14] === s14 &&
    output[offset + 15] === s15
  ) {
    return;
  }
  output[offset] = s0;
  output[offset + 1] = s1;
  output[offset + 2] = s2;
  output[offset + 3] = s3;
  output[offset + 4] = s4;
  output[offset + 5] = s5;
  output[offset + 6] = s6;
  output[offset + 7] = s7;
  output[offset + 8] = s8;
  output[offset + 9] = s9;
  output[offset + 10] = s10;
  output[offset + 11] = s11;
  output[offset + 12] = s12;
  output[offset + 13] = s13;
  output[offset + 14] = s14;
  output[offset + 15] = s15;
  markDirtySlot(dirty, slot);
}

function floatValue(value: number, roundToFloat32: boolean): number {
  return roundToFloat32 ? Math.fround(value) : value;
}
