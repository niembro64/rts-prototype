import type { Builder, Entity, StructureBlueprintId } from './types';

export function builderCanBuild(
  builder: Builder | null | undefined,
  buildingBlueprintId: StructureBlueprintId | string | null | undefined,
): boolean {
  if (builder === null || builder === undefined || buildingBlueprintId === null || buildingBlueprintId === undefined) {
    return false;
  }
  return builder.allowedBuildBlueprintIds.includes(buildingBlueprintId as StructureBlueprintId);
}

export function entityCanBuild(
  entity: Entity | null | undefined,
  buildingBlueprintId: StructureBlueprintId | string | null | undefined,
): boolean {
  return builderCanBuild(entity?.builder, buildingBlueprintId);
}

export function getSelectedBuilderAllowedBuildBlueprintIds(
  selectedUnits: readonly Entity[],
): readonly StructureBlueprintId[] {
  let allowed: Set<StructureBlueprintId> | null = null;
  let order: readonly StructureBlueprintId[] = [];

  for (let i = 0; i < selectedUnits.length; i++) {
    const builder = selectedUnits[i].builder;
    if (builder === null) continue;
    const ids = builder.allowedBuildBlueprintIds;
    if (allowed === null) {
      allowed = new Set(ids);
      order = ids;
      continue;
    }
    for (const id of allowed) {
      if (!ids.includes(id)) allowed.delete(id);
    }
  }

  if (allowed === null) return [];
  const result: StructureBlueprintId[] = [];
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    if (allowed.has(id)) result.push(id);
  }
  return result;
}
