import { COST_MULTIPLIER } from '../../../config';
import type { ResourceCost } from '@/types/economyTypes';
import type { BuildingBlueprintId } from '../types';
import { getAllBuildings, getAllTowers } from '../buildConfigs';
import { BUILDABLE_UNIT_BLUEPRINT_IDS } from './unitRoster';
import { UNIT_BLUEPRINTS } from './units';

export type UnitRosterDisplay = {
  unitBlueprintId: string;
  label: string;
  shortName: string;
  cost: number;
  locomotion: string;
};

export type BuildingRosterDisplay = {
  buildingBlueprintId: BuildingBlueprintId;
  label: string;
  key: string;
  cost: number;
  category: BuildMenuCategory;
};

export type BuildMenuCategory = 'Economy' | 'Intel' | 'Production' | 'Defense';

export const BUILD_MENU_CATEGORY_ORDER: readonly BuildMenuCategory[] = [
  'Economy',
  'Intel',
  'Production',
  'Defense',
];

function scaledTotalCost(cost: ResourceCost): number {
  return (cost.energy + cost.metal) * COST_MULTIPLIER;
}

function fallbackShortName(id: string): string {
  return id.toUpperCase().slice(0, 3);
}

function buildUnitRosterDisplay(): UnitRosterDisplay[] {
  const display = new Array<UnitRosterDisplay>(BUILDABLE_UNIT_BLUEPRINT_IDS.length);
  for (let i = 0; i < BUILDABLE_UNIT_BLUEPRINT_IDS.length; i++) {
    const id = BUILDABLE_UNIT_BLUEPRINT_IDS[i];
    const bp = UNIT_BLUEPRINTS[id];
    if (!bp) {
      display[i] = {
        unitBlueprintId: id,
        label: id,
        shortName: fallbackShortName(id),
        cost: 0,
        locomotion: 'unknown',
      };
      continue;
    }
    display[i] = {
      unitBlueprintId: bp.unitBlueprintId,
      label: bp.name,
      shortName: bp.shortName,
      cost: scaledTotalCost(bp.cost),
      locomotion: bp.locomotion.type,
    };
  }
  return display;
}

export const unitRosterDisplay: UnitRosterDisplay[] = buildUnitRosterDisplay();

function buildUnitRosterDisplayById(display: readonly UnitRosterDisplay[]): Map<string, UnitRosterDisplay> {
  const byId = new Map<string, UnitRosterDisplay>();
  for (let i = 0; i < display.length; i++) {
    const unit = display[i];
    byId.set(unit.unitBlueprintId, unit);
  }
  return byId;
}

const unitRosterDisplayById = buildUnitRosterDisplayById(unitRosterDisplay);

export function getUnitDisplayShortName(unitBlueprintId: string): string {
  const display = unitRosterDisplayById.get(unitBlueprintId);
  return display !== undefined ? display.shortName : fallbackShortName(unitBlueprintId);
}

function buildStructureRosterDisplay(
  configs: readonly { buildingBlueprintId: BuildingBlueprintId; name: string; cost: ResourceCost }[],
  keyOffset: number,
): BuildingRosterDisplay[] {
  const display = new Array<BuildingRosterDisplay>(configs.length);
  for (let i = 0; i < configs.length; i++) {
    const bp = configs[i];
    display[i] = {
      buildingBlueprintId: bp.buildingBlueprintId,
      label: bp.name,
      key: `${keyOffset + i + 1}`,
      cost: scaledTotalCost(bp.cost),
      category: structureBuildCategory(bp.buildingBlueprintId),
    };
  }
  return display;
}

export function structureBuildCategory(buildingBlueprintId: BuildingBlueprintId): BuildMenuCategory {
  switch (buildingBlueprintId) {
    case 'buildingRadar':
      return 'Intel';
    case 'towerFabricator':
      return 'Production';
    case 'towerBeamMega':
    case 'towerCannon':
    case 'towerAntiAir':
      return 'Defense';
    default:
      return 'Economy';
  }
}

export const buildingRosterDisplay: BuildingRosterDisplay[] = buildStructureRosterDisplay(
  getAllBuildings(),
  0,
);

export const towerRosterDisplay: BuildingRosterDisplay[] = buildStructureRosterDisplay(
  getAllTowers(),
  buildingRosterDisplay.length,
);

// Compatibility roster for the current build menu. Builder-authored
// allowed rosters filter this combined surface before display.
export const structureRosterDisplay: BuildingRosterDisplay[] = new Array<BuildingRosterDisplay>(
  buildingRosterDisplay.length + towerRosterDisplay.length,
);
for (let i = 0; i < buildingRosterDisplay.length; i++) {
  structureRosterDisplay[i] = buildingRosterDisplay[i];
}
for (let i = 0; i < towerRosterDisplay.length; i++) {
  structureRosterDisplay[buildingRosterDisplay.length + i] = towerRosterDisplay[i];
}
