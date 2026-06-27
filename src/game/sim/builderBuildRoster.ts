import type { Builder, Entity, StructureBlueprintId } from './types';
import { getUnitBlueprint } from './blueprints';
import type { UnitBlueprint } from './blueprints/types';

type BuilderCapability = {
  constructionRate: number;
  allowedBuildBlueprintIds: readonly StructureBlueprintId[];
};

function getUnitBuilderCapability(unitBlueprint: UnitBlueprint): BuilderCapability {
  let constructionRate = 0;
  let allowedBuildBlueprintIds: readonly StructureBlueprintId[] = [];

  for (let i = 0; i < unitBlueprint.turrets.length; i++) {
    const mount = unitBlueprint.turrets[i];
    if (mount.constructionRate !== undefined) {
      constructionRate = Math.max(constructionRate, mount.constructionRate);
    }
    if (mount.allowedBuildBlueprintIds !== undefined) {
      allowedBuildBlueprintIds = mount.allowedBuildBlueprintIds;
    }
  }

  return {
    constructionRate,
    allowedBuildBlueprintIds,
  };
}

function getBuilderCapability(entity: Entity | null | undefined): BuilderCapability | null {
  if (entity === null || entity === undefined || entity.builder === null || entity.unit === null) {
    return null;
  }
  return getUnitBuilderCapability(getUnitBlueprint(entity.unit.unitBlueprintId));
}

function builderCanBuild(
  builder: Builder | null | undefined,
  allowedBuildBlueprintIds: readonly StructureBlueprintId[],
  buildingBlueprintId: StructureBlueprintId | string | null | undefined,
): boolean {
  if (builder === null || builder === undefined || buildingBlueprintId === null || buildingBlueprintId === undefined) {
    return false;
  }
  return allowedBuildBlueprintIds.includes(buildingBlueprintId as StructureBlueprintId);
}

export function entityCanBuild(
  entity: Entity | null | undefined,
  buildingBlueprintId: StructureBlueprintId | string | null | undefined,
): boolean {
  const capability = getBuilderCapability(entity);
  return builderCanBuild(entity?.builder, capability?.allowedBuildBlueprintIds ?? [], buildingBlueprintId);
}

export function getBuilderConstructionRate(entity: Entity): number {
  return getBuilderCapability(entity)?.constructionRate ?? 0;
}

export function getBuilderAllowedBuildBlueprintIds(
  entity: Entity | null | undefined,
): readonly StructureBlueprintId[] {
  return getBuilderCapability(entity)?.allowedBuildBlueprintIds ?? [];
}

export function getUnitBuilderAllowedBuildBlueprintIds(
  unitBlueprint: UnitBlueprint,
): readonly StructureBlueprintId[] {
  return getUnitBuilderCapability(unitBlueprint).allowedBuildBlueprintIds;
}

export function getUnitBuilderConstructionRate(unitBlueprint: UnitBlueprint): number {
  return getUnitBuilderCapability(unitBlueprint).constructionRate;
}

export function getSelectedBuilderAllowedBuildBlueprintIds(
  selectedUnits: readonly Entity[],
): readonly StructureBlueprintId[] {
  let allowed: Set<StructureBlueprintId> | null = null;
  let order: readonly StructureBlueprintId[] = [];

  for (let i = 0; i < selectedUnits.length; i++) {
    const builder = selectedUnits[i].builder;
    if (builder === null) continue;
    const ids = getBuilderAllowedBuildBlueprintIds(selectedUnits[i]);
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
