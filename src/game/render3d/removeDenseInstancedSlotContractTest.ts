import {
  clearDirtySlotSpan,
  createDirtySlotSpan,
} from './instancedBufferUpdate';
import { removeDenseInstancedSlot } from './removeDenseInstancedSlot';

function assertContract(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[dense instanced removal contract] ${message}`);
}

export function runRemoveDenseInstancedSlotContractTest(): void {
  const a = { key: 'a', slot: 0 };
  const b = { key: 'b', slot: 1 };
  const c = { key: 'c', slot: 2 };
  const items = [a, b, c];
  const byKey = new Map(items.map((item) => [item.key, item]));
  const matrices = new Float32Array(3 * 16);
  for (let i = 0; i < matrices.length; i++) matrices[i] = i;
  const heat = new Float32Array([10, 20, 30]);
  const char = new Float32Array([1, 2, 3]);
  const matrixDirty = createDirtySlotSpan();
  const heatDirty = createDirtySlotSpan();
  const charDirty = createDirtySlotSpan();
  const channels = [
    { values: heat, dirty: heatDirty },
    { values: char, dirty: charDirty },
  ];

  const nextCount = removeDenseInstancedSlot(
    items,
    byKey,
    1,
    matrices,
    matrixDirty,
    channels,
  );
  assertContract(nextCount === 2 && items.length === 2, 'removal returns the dense pool count');
  assertContract(!byKey.has('b'), 'the removed key leaves the lookup map');
  assertContract(items[1] === c && c.slot === 1, 'the final object moves into the removed slot');
  assertContract(byKey.get('c') === c, 'the existing moved-object map entry remains current');
  assertContract(
    matrices[16] === 32 && matrices[31] === 47,
    'the final instance matrix moves into the removed slot',
  );
  assertContract(heat[1] === 30 && char[1] === 3, 'every scalar channel moves with the instance');
  assertContract(
    matrixDirty.minSlot === 1 && matrixDirty.maxSlot === 1 &&
      heatDirty.minSlot === 1 && heatDirty.maxSlot === 1 &&
      charDirty.minSlot === 1 && charDirty.maxSlot === 1,
    'every moved channel marks the destination slot dirty',
  );

  clearDirtySlotSpan(matrixDirty);
  clearDirtySlotSpan(heatDirty);
  clearDirtySlotSpan(charDirty);
  removeDenseInstancedSlot(items, byKey, 1, matrices, matrixDirty, channels);
  assertContract(!byKey.has('c') && items.length === 1, 'removing the final slot needs no swap');
  assertContract(
    matrixDirty.maxSlot === -1 && heatDirty.maxSlot === -1 && charDirty.maxSlot === -1,
    'removing the final slot does not dirty unchanged buffers',
  );
}
