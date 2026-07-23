import type { UnitBlueprint } from './blueprints/types';
import { getUnitBlueprint } from './blueprints';
import { TURRET_BLUEPRINTS } from './blueprints/turrets';
import type { Entity, StructureBlueprintId } from './types';

export type StructureSpawnCapability = {
  mountId: string;
  allowedBlueprintIds: readonly StructureBlueprintId[];
  producesNanoframe: boolean;
};

export type ConstructionEmitterCapability = {
  mountId: string;
  resource: 'metal' | 'energy';
  transferRate: number;
};

export type UnitHostCapabilities = {
  structureSpawners: readonly StructureSpawnCapability[];
  constructors: readonly ConstructionEmitterCapability[];
  /** Shared work-rate ceiling. Parallel metal/energy pylons are resource
   *  lanes for one construction job, so their rates do not sum. */
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

const EMPTY_STRUCTURE_IDS: readonly StructureBlueprintId[] = Object.freeze([]);
const CAPABILITIES_BY_UNIT_BLUEPRINT = new Map<string, UnitHostCapabilities>();

function compileUnitHostCapabilities(unitBlueprint: UnitBlueprint): UnitHostCapabilities {
  const structureSpawners: StructureSpawnCapability[] = [];
  const constructors: ConstructionEmitterCapability[] = [];
  const allowedBuildBlueprintIds: StructureBlueprintId[] = [];
  const seenBuildBlueprintIds = new Set<StructureBlueprintId>();
  let constructionRate = 0;

  for (let i = 0; i < unitBlueprint.turrets.length; i++) {
    const mount = unitBlueprint.turrets[i];
    const emitter = TURRET_BLUEPRINTS[mount.turretBlueprintId];
    if (emitter === undefined) continue;

    if (emitter.kind === 'spawn' && emitter.spawn?.producedKind === 'buildings') {
      const roster = mount.allowedBuildBlueprintIds ?? EMPTY_STRUCTURE_IDS;
      structureSpawners.push(Object.freeze({
        mountId: mount.mountId,
        allowedBlueprintIds: roster,
        producesNanoframe: emitter.spawn.producesNanoframe,
      }));
      for (let rosterIndex = 0; rosterIndex < roster.length; rosterIndex++) {
        const blueprintId = roster[rosterIndex];
        if (seenBuildBlueprintIds.has(blueprintId)) continue;
        seenBuildBlueprintIds.add(blueprintId);
        allowedBuildBlueprintIds.push(blueprintId);
      }
      continue;
    }

    if (emitter.kind === 'resourcePylon' && emitter.resourcePylon?.role === 'construction') {
      const transferRate = mount.constructionRate ?? 0;
      constructors.push(Object.freeze({
        mountId: mount.mountId,
        resource: emitter.resourcePylon.resource,
        transferRate,
      }));
      constructionRate = Math.max(constructionRate, transferRate);
    }
  }

  return Object.freeze({
    structureSpawners: Object.freeze(structureSpawners),
    constructors: Object.freeze(constructors),
    constructionRate,
    allowedBuildBlueprintIds: Object.freeze(allowedBuildBlueprintIds),
  });
}

export function getUnitHostCapabilities(unitBlueprint: UnitBlueprint): UnitHostCapabilities {
  let capabilities = CAPABILITIES_BY_UNIT_BLUEPRINT.get(unitBlueprint.unitBlueprintId);
  if (capabilities === undefined) {
    capabilities = compileUnitHostCapabilities(unitBlueprint);
    CAPABILITIES_BY_UNIT_BLUEPRINT.set(unitBlueprint.unitBlueprintId, capabilities);
  }
  return capabilities;
}

export function getEntityHostCapabilities(
  entity: Entity | null | undefined,
): UnitHostCapabilities | null {
  if (entity?.unit === null || entity?.unit === undefined) return null;
  return getUnitHostCapabilities(getUnitBlueprint(entity.unit.unitBlueprintId));
}

export function entityCanConstruct(entity: Entity | null | undefined): boolean {
  if (entity?.builder === null || entity?.builder === undefined) return false;
  const capability = getEntityHostCapabilities(entity);
  return capability !== null && capability.constructors.length > 0 && capability.constructionRate > 0;
}

export function entityCanSpawnStructure(
  entity: Entity | null | undefined,
  buildingBlueprintId: StructureBlueprintId | string | null | undefined,
): boolean {
  if (buildingBlueprintId === null || buildingBlueprintId === undefined) return false;
  const capability = getEntityHostCapabilities(entity);
  return capability?.allowedBuildBlueprintIds.includes(buildingBlueprintId as StructureBlueprintId) === true;
}

export function resolveStructureSpawnCapability(
  entity: Entity | null | undefined,
  buildingBlueprintId: StructureBlueprintId | string | null | undefined,
): StructureSpawnCapability | null {
  if (buildingBlueprintId === null || buildingBlueprintId === undefined) return null;
  const capabilities = getEntityHostCapabilities(entity);
  if (capabilities === null) return null;
  for (let i = 0; i < capabilities.structureSpawners.length; i++) {
    const spawner = capabilities.structureSpawners[i];
    if (spawner.allowedBlueprintIds.includes(buildingBlueprintId as StructureBlueprintId)) return spawner;
  }
  return null;
}

/** A Build order is the composed Spawn → Construct workflow. Pure spawners
 *  use a spawn order; pure constructors can assist existing nanoframes. */
export function entityCanBuild(
  entity: Entity | null | undefined,
  buildingBlueprintId: StructureBlueprintId | string | null | undefined,
): boolean {
  const spawner = resolveStructureSpawnCapability(entity, buildingBlueprintId);
  return spawner !== null && (!spawner.producesNanoframe || entityCanConstruct(entity));
}

export function getBuilderConstructionRate(entity: Entity): number {
  if (!entityCanConstruct(entity)) return 0;
  return getEntityHostCapabilities(entity)?.constructionRate ?? 0;
}

export function getBuilderAllowedBuildBlueprintIds(
  entity: Entity | null | undefined,
): readonly StructureBlueprintId[] {
  if (entity?.builder === null || entity?.builder === undefined) return EMPTY_STRUCTURE_IDS;
  return getEntityHostCapabilities(entity)?.allowedBuildBlueprintIds ?? EMPTY_STRUCTURE_IDS;
}

export function getUnitBuilderAllowedBuildBlueprintIds(
  unitBlueprint: UnitBlueprint,
): readonly StructureBlueprintId[] {
  return getUnitHostCapabilities(unitBlueprint).allowedBuildBlueprintIds;
}

export function getUnitBuilderConstructionRate(unitBlueprint: UnitBlueprint): number {
  return getUnitHostCapabilities(unitBlueprint).constructionRate;
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
  )?.allowedBuildBlueprintIds ?? EMPTY_STRUCTURE_IDS;
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
  let order: readonly StructureBlueprintId[] = EMPTY_STRUCTURE_IDS;

  for (let i = 0; i < selectedUnits.length; i++) {
    if (selectedUnits[i].builder === null) continue;
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

  if (allowed === null) return EMPTY_STRUCTURE_IDS;
  const result: StructureBlueprintId[] = [];
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    if (allowed.has(id)) result.push(id);
  }
  return result;
}
