export type UnitBuildingSlotRangeResult = {
  slots: Uint32Array;
  total: number;
  unitStart: number;
  unitCount: number;
  buildingStart: number;
  buildingCount: number;
};

/** Populate the shared unit/building range view emitted by combined WASM
 * spatial queries. Callers retain ownership of the reusable result object. */
export function assignUnitBuildingSlotRangeResult(
  slots: Uint32Array,
  total: number,
  result: UnitBuildingSlotRangeResult,
): UnitBuildingSlotRangeResult {
  const unitCount = slots[0];
  const buildingCount = slots[1];
  result.slots = slots;
  result.total = total;
  result.unitStart = 2;
  result.unitCount = unitCount;
  result.buildingStart = 2 + unitCount;
  result.buildingCount = buildingCount;
  return result;
}
