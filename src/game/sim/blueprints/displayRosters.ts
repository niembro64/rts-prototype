import { COST_MULTIPLIER } from '../../../config';
import type { ResourceCost } from '@/types/economyTypes';
import type { BuildingBlueprintId } from '../types';
import { BUILDING_BLUEPRINTS } from './buildings';
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

export const buildingRosterDisplay: BuildingRosterDisplay[] = (
  Object.keys(BUILDING_BLUEPRINTS) as BuildingBlueprintId[]
).map((buildingBlueprintId, index) => {
    const bp = BUILDING_BLUEPRINTS[buildingBlueprintId];
    return {
      buildingBlueprintId,
      label: bp.name,
      key: `${index + 1}`,
      cost: scaledTotalCost(bp.cost),
    };
  });
