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
};

function scaledTotalCost(cost: ResourceCost): number {
  return (cost.energy + cost.metal) * COST_MULTIPLIER;
}

function fallbackShortName(id: string): string {
  return id.toUpperCase().slice(0, 3);
}

export const unitRosterDisplay: UnitRosterDisplay[] = BUILDABLE_UNIT_BLUEPRINT_IDS.map((id) => {
  const bp = UNIT_BLUEPRINTS[id];
  if (!bp) {
    return {
      unitBlueprintId: id,
      label: id,
      shortName: fallbackShortName(id),
      cost: 0,
      locomotion: 'unknown',
    };
  }
  return {
    unitBlueprintId: bp.unitBlueprintId,
    label: bp.name,
    shortName: bp.shortName,
    cost: scaledTotalCost(bp.cost),
    locomotion: bp.locomotion.type,
  };
});

const unitRosterDisplayById = new Map<string, UnitRosterDisplay>(
  unitRosterDisplay.map((unit) => [unit.unitBlueprintId, unit]),
);

export function getUnitDisplayShortName(unitBlueprintId: string): string {
  const display = unitRosterDisplayById.get(unitBlueprintId);
  return display !== undefined ? display.shortName : fallbackShortName(unitBlueprintId);
}

function buildStructureRosterDisplay(
  configs: readonly { buildingBlueprintId: BuildingBlueprintId; name: string; cost: ResourceCost }[],
  keyOffset: number,
): BuildingRosterDisplay[] {
  return configs.map((bp, index) => {
    return {
      buildingBlueprintId: bp.buildingBlueprintId,
      label: bp.name,
      key: `${keyOffset + index + 1}`,
      cost: scaledTotalCost(bp.cost),
    };
  });
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
export const structureRosterDisplay: BuildingRosterDisplay[] = [
  ...buildingRosterDisplay,
  ...towerRosterDisplay,
];
