import { COST_MULTIPLIER } from '../../../config';
import type { ResourceCost } from '@/types/economyTypes';
import type { BuildingType } from '../types';
import { BUILDING_BLUEPRINTS } from './buildings';
import { BUILDABLE_UNIT_IDS } from './unitRoster';
import { UNIT_BLUEPRINTS } from './units';

export type UnitRosterDisplay = {
  unitId: string;
  label: string;
  shortName: string;
  cost: number;
  locomotion: string;
};

export type BuildingRosterDisplay = {
  type: BuildingType;
  label: string;
  key: string;
  cost: number;
};

function scaledTotalCost(cost: ResourceCost): number {
  return (cost.energy + cost.mana + cost.metal) * COST_MULTIPLIER;
}

function fallbackShortName(id: string): string {
  return id.toUpperCase().slice(0, 3);
}

export const unitRosterDisplay: UnitRosterDisplay[] = BUILDABLE_UNIT_IDS.map((id) => {
  const bp = UNIT_BLUEPRINTS[id];
  if (!bp) {
    return {
      unitId: id,
      label: id,
      shortName: fallbackShortName(id),
      cost: 0,
      locomotion: 'unknown',
    };
  }
  return {
    unitId: bp.id,
    label: bp.name,
    shortName: bp.shortName,
    cost: scaledTotalCost(bp.cost),
    locomotion: bp.locomotion.type,
  };
});

const unitRosterDisplayById = new Map<string, UnitRosterDisplay>(
  unitRosterDisplay.map((unit) => [unit.unitId, unit]),
);

export function getUnitDisplayShortName(unitType: string): string {
  return unitRosterDisplayById.get(unitType)?.shortName ?? fallbackShortName(unitType);
}

export const buildingRosterDisplay: BuildingRosterDisplay[] = (
  Object.keys(BUILDING_BLUEPRINTS) as BuildingType[]
).map((type, index) => {
  const bp = BUILDING_BLUEPRINTS[type];
  return {
    type,
    label: bp.name,
    key: `${index + 1}`,
    cost: scaledTotalCost(bp.cost),
  };
});
