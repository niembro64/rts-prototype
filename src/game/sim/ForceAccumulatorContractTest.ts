import { ForceAccumulator } from './ForceAccumulator';
import type { KnockbackInfo } from '@/types/damage';
import type { EntityId } from './types';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[force accumulator contract] ${message}`);
  }
}

export function runForceAccumulatorContractTest(): void {
  const accumulator = new ForceAccumulator();
  accumulator.addForce(10 as EntityId, 1, 2, 'a', 3, 2);
  accumulator.addForce(10 as EntityId, 4, 5, 'b', 6, 2);
  accumulator.addForce(11 as EntityId, 7, 8, 'c', 0, 5);
  accumulator.finalize();

  const slots = new Uint32Array(4);
  const count = accumulator.collectActiveEntitySlots(slots);
  assertContract(count === 2, 'direct slot collection must return active mapped slots');

  const rows = new Float64Array(8);
  assertContract(accumulator.copyFinalForceBySlot(2, rows, 1, 10 as EntityId), 'copy must find active slot');
  assertContract(rows[1] === 5 && rows[2] === 7 && rows[3] === 9, 'copy must write summed xyz force');
  assertContract(
    !accumulator.copyFinalForceBySlot(2, rows, 1, 11 as EntityId),
    'copy must reject stale entity id for a slot',
  );
  assertContract(accumulator.copyFinalForceBySlot(5, rows, 4, 11 as EntityId), 'copy must find second active slot');
  assertContract(rows[4] === 7 && rows[5] === 8 && rows[6] === 0, 'copy must write zero z when omitted');
  assertContract(!accumulator.copyFinalForceBySlot(5, rows, 6), 'copy must reject out-of-bounds output');

  accumulator.clear();
  assertContract(!accumulator.copyFinalForceBySlot(2, rows, 1), 'clear must invalidate slot cache');

  accumulator.addForce(20 as EntityId, 1, 0, 'd', 0.5, 3);
  accumulator.addForce(21 as EntityId, 2, 3, 'e', 4, 3);
  accumulator.finalize();
  const duplicateCount = accumulator.collectActiveEntitySlots(slots);
  assertContract(duplicateCount === 1 && slots[0] === 3, 'slot cache must dedupe shared slots');
  assertContract(accumulator.copyFinalForceBySlot(3, rows, 0), 'copy must find deduped slot');
  assertContract(rows[0] === 3 && rows[1] === 3 && rows[2] === 4.5, 'deduped slot must sum all forces');

  const resolverFallback = new ForceAccumulator();
  resolverFallback.addForce(30 as EntityId, 1, 1, 'resolver');
  resolverFallback.finalize();
  const fallbackCount = resolverFallback.collectActiveEntitySlots(slots, (id) => id === 30 ? 7 : -1);
  assertContract(
    fallbackCount === 1 && slots[0] === 7,
    'resolver fallback must still map uncached entity ids',
  );

  const knockbackAccumulator = new ForceAccumulator();
  const knockbacks: KnockbackInfo[] = [{
    entityId: 40 as EntityId,
    entitySlot: 9,
    force: { x: 2, y: 4 },
    forceZ: 6,
  }];
  knockbackAccumulator.addKnockbackForces(knockbacks);
  knockbackAccumulator.finalize();
  const knockbackCount = knockbackAccumulator.collectActiveEntitySlots(slots);
  assertContract(knockbackCount === 1 && slots[0] === 9, 'knockback batch must preserve producer slot');
  assertContract(
    knockbackAccumulator.copyFinalForceBySlot(9, rows, 0, 40 as EntityId),
    'knockback batch must copy by producer slot and entity id',
  );
  assertContract(rows[0] === 2 && rows[1] === 4 && rows[2] === 6, 'knockback batch must copy xyz force');
}
