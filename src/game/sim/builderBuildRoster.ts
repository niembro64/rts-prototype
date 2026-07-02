import type { Builder, Entity, StructureBlueprintId } from './types';
import { getUnitBlueprint } from './blueprints';
import type { UnitBlueprint } from './blueprints/types';

type BuilderCapability = {
  constructionRate: number;
  allowedBuildBlueprintIds: readonly StructureBlueprintId[];
};

export type SelectedBuilderTypeInfo = {
  unitBlueprintId: string;
  count: number;
  firstEntity: Entity;
  allowedBuildBlueprintIds: readonly StructureBlueprintId[];
};

export const BAR_MAX_SELECTED_BUILDER_TYPES = 5;

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

export function getSelectedBuilderTypeInfos(
  selectedUnits: readonly Entity[],
): readonly SelectedBuilderTypeInfo[] {
  const byUnitBlueprintId = new Map<string, SelectedBuilderTypeInfo>();

  for (let i = 0; i < selectedUnits.length; i++) {
    const unit = selectedUnits[i];
    if (unit.builder === null || unit.unit === null) continue;
    const unitBlueprintId = unit.unit.unitBlueprintId;
    const existing = byUnitBlueprintId.get(unitBlueprintId);
    if (existing !== undefined) {
      existing.count++;
      continue;
    }
    byUnitBlueprintId.set(unitBlueprintId, {
      unitBlueprintId,
      count: 1,
      firstEntity: unit,
      allowedBuildBlueprintIds: getBuilderAllowedBuildBlueprintIds(unit),
    });
  }

  return Array.from(byUnitBlueprintId.values())
    .sort((a, b) => a.unitBlueprintId.localeCompare(b.unitBlueprintId));
}

export function getBarVisibleSelectedBuilderTypeInfos(
  selectedUnits: readonly Entity[],
): readonly SelectedBuilderTypeInfo[] {
  return getSelectedBuilderTypeInfos(selectedUnits).slice(0, BAR_MAX_SELECTED_BUILDER_TYPES);
}

export function getActiveSelectedBuilderTypeInfo(
  selectedUnits: readonly Entity[],
  activeBuilderUnitBlueprintId: string | null | undefined,
): SelectedBuilderTypeInfo | null {
  const builderTypes = getBarVisibleSelectedBuilderTypeInfos(selectedUnits);
  if (builderTypes.length === 0) return null;
  if (activeBuilderUnitBlueprintId !== null && activeBuilderUnitBlueprintId !== undefined) {
    for (let i = 0; i < builderTypes.length; i++) {
      if (builderTypes[i].unitBlueprintId === activeBuilderUnitBlueprintId) return builderTypes[i];
    }
  }
  return builderTypes[0];
}

export function getActiveSelectedBuilderAllowedBuildBlueprintIds(
  selectedUnits: readonly Entity[],
  activeBuilderUnitBlueprintId: string | null | undefined,
): readonly StructureBlueprintId[] {
  return getActiveSelectedBuilderTypeInfo(
    selectedUnits,
    activeBuilderUnitBlueprintId,
  )?.allowedBuildBlueprintIds ?? [];
}

export function getActiveSelectedBuilder(
  selectedUnits: readonly Entity[],
  activeBuilderUnitBlueprintId: string | null | undefined,
): Entity | null {
  return getActiveSelectedBuilderTypeInfo(
    selectedUnits,
    activeBuilderUnitBlueprintId,
  )?.firstEntity ?? null;
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
