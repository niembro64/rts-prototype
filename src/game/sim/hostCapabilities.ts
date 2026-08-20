import type { UnitBlueprint } from './blueprints/types';
import { getUnitBlueprint } from './blueprints';
import type { Entity, StructureBlueprintId } from './types';
import type { ConstructionCapability } from '../../types/constructionTypes';
import { buildingBlueprintIdsWithoutWaterOnly } from './mapRoster';
import { mapHasWater } from './mapWater';

type UnitHostCapabilities = {
  construction: ConstructionCapability | null;
  /** Shared build-power ceiling owned by the host, not a mounted emitter. */
  constructionRate: number;
  allowedBuildBlueprintIds: readonly StructureBlueprintId[];
  /** The same roster minus the structures that only stand on water. Compiled
   *  beside the authored one — not swapped in — because which of the two
   *  applies is a property of the MAP, and this table is compiled once for the
   *  life of the process. `allowedBuildBlueprintIdsForMap` picks. */
  allowedBuildBlueprintIdsWithoutWater: readonly StructureBlueprintId[];
};

type SelectedBuilderTypeInfo = {
  unitBlueprintId: string;
  count: number;
  firstEntity: Entity;
  allowedBuildBlueprintIds: readonly StructureBlueprintId[];
};

export const BAR_MAX_SELECTED_BUILDER_TYPES = 5;

const EMPTY_STRUCTURE_IDS: readonly StructureBlueprintId[] = Object.freeze([]);
const CAPABILITIES_BY_UNIT_BLUEPRINT = new Map<string, UnitHostCapabilities>();

function compileUnitHostCapabilities(unitBlueprint: UnitBlueprint): UnitHostCapabilities {
  const constructionRate = unitBlueprint.constructionRate ?? 0;
  const allowedBuildBlueprintIds =
    unitBlueprint.allowedBuildBlueprintIds ?? EMPTY_STRUCTURE_IDS;
  const construction = constructionRate > 0
    ? Object.freeze({
      rate: constructionRate,
      channels: Object.freeze([
        'build',
        'repair',
        'reclaim',
        'resurrect',
      ] as const),
      workEmitter: unitBlueprint.workEmitter ?? null,
    })
    : null;

  return Object.freeze({
    construction,
    constructionRate,
    allowedBuildBlueprintIds: Object.freeze([...allowedBuildBlueprintIds]),
    allowedBuildBlueprintIdsWithoutWater: Object.freeze(
      [...buildingBlueprintIdsWithoutWaterOnly(allowedBuildBlueprintIds)],
    ),
  });
}

/** The build list this host actually offers on the installed map. Every build
 *  menu, hotkey list, and placement authorization reads through here, so a
 *  structure with nowhere to stand is gone from the UI and refused by the
 *  server for the same reason, at the same moment. */
function allowedBuildBlueprintIdsForMap(
  capabilities: UnitHostCapabilities,
): readonly StructureBlueprintId[] {
  return mapHasWater()
    ? capabilities.allowedBuildBlueprintIds
    : capabilities.allowedBuildBlueprintIdsWithoutWater;
}

function getUnitHostCapabilities(unitBlueprint: UnitBlueprint): UnitHostCapabilities {
  let capabilities = CAPABILITIES_BY_UNIT_BLUEPRINT.get(unitBlueprint.unitBlueprintId);
  if (capabilities === undefined) {
    capabilities = compileUnitHostCapabilities(unitBlueprint);
    CAPABILITIES_BY_UNIT_BLUEPRINT.set(unitBlueprint.unitBlueprintId, capabilities);
  }
  return capabilities;
}

function getEntityHostCapabilities(
  entity: Entity | null | undefined,
): UnitHostCapabilities | null {
  if (entity?.unit === null || entity?.unit === undefined) return null;
  return getUnitHostCapabilities(getUnitBlueprint(entity.unit.unitBlueprintId));
}

function entityCanConstruct(entity: Entity | null | undefined): boolean {
  if (entity?.builder === null || entity?.builder === undefined) return false;
  const capability = getEntityHostCapabilities(entity);
  return capability !== null && capability.constructionRate > 0;
}

function entityCanSpawnStructure(
  entity: Entity | null | undefined,
  buildingBlueprintId: StructureBlueprintId | string | null | undefined,
): boolean {
  if (buildingBlueprintId === null || buildingBlueprintId === undefined) return false;
  const capability = getEntityHostCapabilities(entity);
  if (capability === null) return false;
  return allowedBuildBlueprintIdsForMap(capability)
    .includes(buildingBlueprintId as StructureBlueprintId);
}

/** Build placement creates a nanoframe directly; the host then applies build
 *  power to it. There is no separate spawn-emitter capability. */
export function entityCanBuild(
  entity: Entity | null | undefined,
  buildingBlueprintId: StructureBlueprintId | string | null | undefined,
): boolean {
  return entityCanConstruct(entity) && entityCanSpawnStructure(entity, buildingBlueprintId);
}

export function getBuilderConstructionRate(entity: Entity): number {
  if (!entityCanConstruct(entity)) return 0;
  return getEntityHostCapabilities(entity)?.constructionRate ?? 0;
}

function getBuilderAllowedBuildBlueprintIds(
  entity: Entity | null | undefined,
): readonly StructureBlueprintId[] {
  if (entity?.builder === null || entity?.builder === undefined) return EMPTY_STRUCTURE_IDS;
  const capabilities = getEntityHostCapabilities(entity);
  if (capabilities === null) return EMPTY_STRUCTURE_IDS;
  return allowedBuildBlueprintIdsForMap(capabilities);
}

/** What this builder offers on the installed map. */
export function getUnitBuilderAllowedBuildBlueprintIds(
  unitBlueprint: UnitBlueprint,
): readonly StructureBlueprintId[] {
  return allowedBuildBlueprintIdsForMap(getUnitHostCapabilities(unitBlueprint));
}

/** What this builder's BLUEPRINT authors, whatever map is installed. For code
 *  asking about the authored roster itself — BAR parity, command coverage,
 *  "is this unit a builder at all" — rather than about what a player can place
 *  right now. */
export function getUnitAuthoredBuildBlueprintIds(
  unitBlueprint: UnitBlueprint,
): readonly StructureBlueprintId[] {
  return getUnitHostCapabilities(unitBlueprint).allowedBuildBlueprintIds;
}

export function getUnitBuilderConstructionRate(unitBlueprint: UnitBlueprint): number {
  return getUnitHostCapabilities(unitBlueprint).constructionRate;
}

function getSelectedBuilderTypeInfos(
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

