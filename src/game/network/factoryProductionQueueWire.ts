import {
  codeToUnitBlueprintId,
  unitBlueprintIdToCode,
} from '../../types/network';

export function decodeFactoryProductionQueue(codes: readonly number[] | null | undefined): string[] {
  if (codes === null || codes === undefined || codes.length === 0) return [];
  const queue: string[] = [];
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
