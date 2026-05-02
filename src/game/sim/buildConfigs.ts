import type { BuildingConfig, BuildingType } from './types';
import {
  COST_MULTIPLIER,
  BUILDING_STATS,
  SOLAR_ENERGY_PER_SECOND,
  WIND_ENERGY_PER_SECOND,
  EXTRACTOR_METAL_PER_SECOND,
} from '../../config';
import { getUnitBlueprint, BUILDABLE_UNIT_IDS } from './blueprints';

// Building configurations (costs are multiplied by COST_MULTIPLIER)
export const BUILDING_CONFIGS: Record<BuildingType, BuildingConfig> = {
  solar: {
    id: 'solar',
    name: 'Solar',
    gridWidth: 3,
    gridHeight: 3,
    // Solar panels are short and low-slung — a single cell tall.
    gridDepth: 1,
    hp: BUILDING_STATS.solar.hp,
    resourceCost: BUILDING_STATS.solar.resourceCost * COST_MULTIPLIER,
    energyProduction: SOLAR_ENERGY_PER_SECOND,
  },
  wind: {
    id: 'wind',
    name: 'Wind',
    gridWidth: 2,
    gridHeight: 2,
    gridDepth: 5,
    hp: BUILDING_STATS.wind.hp,
    resourceCost: BUILDING_STATS.wind.resourceCost * COST_MULTIPLIER,
    energyProduction: WIND_ENERGY_PER_SECOND,
  },
  factory: {
    id: 'factory',
    name: 'Fabricator',
    // Fabricators are just their construction tower. Units are assembled
    // outside this small blocking footprint, not inside a reserved yard.
    gridWidth: 2,
    gridHeight: 2,
    gridDepth: 6,
    hp: BUILDING_STATS.factory.hp,
    resourceCost: BUILDING_STATS.factory.resourceCost * COST_MULTIPLIER,
    maxEnergyUseRate: 100,
  },
  extractor: {
    id: 'extractor',
    name: 'Extractor',
    // Squat metal pump. Small footprint so it fits inside a deposit's
    // flat zone without crowding adjacent buildings.
    gridWidth: 2,
    gridHeight: 2,
    gridDepth: 2,
    hp: BUILDING_STATS.extractor.hp,
    resourceCost: BUILDING_STATS.extractor.resourceCost * COST_MULTIPLIER,
    metalProduction: EXTRACTOR_METAL_PER_SECOND,
  },
};

// Helper to get building config
export function getBuildingConfig(type: BuildingType): BuildingConfig {
  return BUILDING_CONFIGS[type];
}

// Helper to get unit build config (now backed by blueprints)
// Returns a shim matching the old UnitBuildConfig shape for backward compatibility
export function getUnitBuildConfig(unitId: string) {
  const bp = getUnitBlueprint(unitId);
  if (!bp) return undefined;
  return {
    unitId: bp.turrets[0]?.turretId ?? 'lightTurret',
    name: bp.name,
    resourceCost: bp.resourceCost * COST_MULTIPLIER,
    unitRadiusCollider: { ...bp.unitRadiusCollider },
    bodyCenterHeight: bp.bodyCenterHeight,
    moveSpeed: bp.moveSpeed,
    mass: bp.mass,
    hp: bp.hp,
  };
}

// Get list of all buildable units
export function getBuildableUnits() {
  return BUILDABLE_UNIT_IDS.map(id => getUnitBuildConfig(id)!);
}

// Get list of all buildings
export function getAllBuildings(): BuildingConfig[] {
  return Object.values(BUILDING_CONFIGS);
}
