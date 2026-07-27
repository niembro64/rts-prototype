import {
  codeToUnitBlueprintId,
  unitBlueprintIdToCode,
} from '../../types/network';

type FactoryProductionQueueCodes = readonly number[] | Uint32Array;
type FactoryProductionQuotaCodes = readonly number[] | Uint32Array;

export function decodeFactoryProductionQueue(codes: FactoryProductionQueueCodes | null | undefined): string[] {
  return decodeFactoryProductionQueueInto(codes, []);
}

export function decodeFactoryProductionQueueInto(
  codes: FactoryProductionQueueCodes | null | undefined,
  queue: string[],
): string[] {
  queue.length = 0;
  if (codes === null || codes === undefined || codes.length === 0) return queue;
  for (const code of codes) {
    const unitBlueprintId = codeToUnitBlueprintId(code);
    if (unitBlueprintId !== null && unitBlueprintId !== undefined) {
      queue.push(unitBlueprintId);
    }
  }
  return queue;
}

export function encodeFactoryProductionQueue(unitBlueprintIds: readonly string[]): number[] | null {
  if (unitBlueprintIds.length === 0) return null;
  const queue: number[] = new Array(unitBlueprintIds.length);
  for (let i = 0; i < unitBlueprintIds.length; i++) {
    queue[i] = unitBlueprintIdToCode(unitBlueprintIds[i]);
  }
  return queue;
}

export function decodeFactoryProductionQuotas(
  codes: FactoryProductionQuotaCodes | null | undefined,
): Record<string, number> {
  return decodeFactoryProductionQuotasInto(codes, {});
}

export function decodeFactoryProductionQuotasInto(
  codes: FactoryProductionQuotaCodes | null | undefined,
  quotas: Record<string, number>,
): Record<string, number> {
  for (const key in quotas) delete quotas[key];
  if (codes === null || codes === undefined || codes.length < 2) return quotas;
  for (let i = 0; i + 1 < codes.length; i += 2) {
    const unitBlueprintId = codeToUnitBlueprintId(codes[i]);
    const quota = Math.floor(codes[i + 1]);
    if (unitBlueprintId !== null && unitBlueprintId !== undefined && quota > 0) {
      quotas[unitBlueprintId] = quota;
    }
  }
  return quotas;
}

export function decodeFactoryProductionQuotaCounts(
  codes: FactoryProductionQuotaCodes | null | undefined,
): Record<string, number> {
  return decodeFactoryProductionQuotaCountsInto(codes, {});
}

export function decodeFactoryProductionQuotaCountsInto(
  codes: FactoryProductionQuotaCodes | null | undefined,
  counts: Record<string, number>,
): Record<string, number> {
  for (const key in counts) delete counts[key];
  if (codes === null || codes === undefined || codes.length < 2) return counts;
  for (let i = 0; i + 1 < codes.length; i += 2) {
    const unitBlueprintId = codeToUnitBlueprintId(codes[i]);
    const count = Math.floor(codes[i + 1]);
    if (unitBlueprintId !== null && unitBlueprintId !== undefined && count >= 0) {
      counts[unitBlueprintId] = count;
    }
  }
  return counts;
}

const compareBlueprintIds = (a: string, b: string): number => a.localeCompare(b);

// Scratch for the encode helpers below: the returned encoded arrays are
// retained by callers (they become snapshot payload), but the sorted-id
// working set is not, so it is reused across calls.
const _positiveQuotaIds: string[] = [];

function collectPositiveQuotaIdsSorted(
  quotas: Readonly<Record<string, number>>,
): string[] {
  const ids = _positiveQuotaIds;
  ids.length = 0;
  for (const unitBlueprintId in quotas) {
    const quota = quotas[unitBlueprintId];
    if (Number.isFinite(quota) && quota > 0) ids.push(unitBlueprintId);
  }
  ids.sort(compareBlueprintIds);
  return ids;
}

export function encodeFactoryProductionQuotas(quotas: Readonly<Record<string, number>>): number[] | null {
  const ids = collectPositiveQuotaIdsSorted(quotas);
  if (ids.length === 0) return null;
  const encoded: number[] = new Array(ids.length * 2);
  for (let i = 0; i < ids.length; i++) {
    encoded[i * 2] = unitBlueprintIdToCode(ids[i]);
    encoded[i * 2 + 1] = Math.floor(quotas[ids[i]]);
  }
  return encoded;
}

export function encodeFactoryProductionQuotaCounts(
  quotas: Readonly<Record<string, number>>,
  counts: Readonly<Record<string, number>>,
): number[] | null {
  const ids = collectPositiveQuotaIdsSorted(quotas);
  if (ids.length === 0) return null;
  const encoded: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    const unitBlueprintId = ids[i];
    const count = Math.max(0, Math.floor(counts[unitBlueprintId] ?? 0));
    if (count <= 0) continue;
    encoded.push(unitBlueprintIdToCode(unitBlueprintId), count);
  }
  return encoded.length === 0 ? null : encoded;
}
