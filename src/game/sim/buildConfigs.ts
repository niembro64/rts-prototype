import type { BuildingConfig, BuildingType } from './types';
import {
  COST_MULTIPLIER,
  BUILDING_STATS,
  SOLAR_ENERGY_PER_SECOND,
} from '../../config';
import { getUnitBlueprint, BUILDABLE_UNIT_IDS } from './blueprints';

// Building configurations (costs are multiplied by COST_MULTIPLIER)
export const BUILDING_CONFIGS: Record<BuildingType, BuildingConfig> = {
  solar: {
    id: 'solar',
    name: 'Solar Panel',
    gridWidth: 3,
    gridHeight: 3,
    // Solar panels are short and low-slung — a single cell tall.
    gridDepth: 1,
    hp: BUILDING_STATS.solar.hp,
    energyCost: BUILDING_STATS.solar.energyCost * COST_MULTIPLIER,
    manaCost: 20 * COST_MULTIPLIER,
    energyProduction: SOLAR_ENERGY_PER_SECOND,
  },
  factory: {
    id: 'factory',
    name: 'Factory',
    gridWidth: 5,
    gridHeight: 4,
    // Factories are multi-story structures — taller than they are wide.
    gridDepth: 3,
    hp: BUILDING_STATS.factory.hp,
    energyCost: BUILDING_STATS.factory.energyCost * COST_MULTIPLIER,
    manaCost: 50 * COST_MULTIPLIER,
    maxEnergyUseRate: 100,
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
    energyCost: bp.energyCost * COST_MULTIPLIER,
    manaCost: bp.manaCost * COST_MULTIPLIER,
    unitRadiusCollider: { ...bp.unitRadiusCollider },
    moveSpeed: bp.moveSpeed,
    mass: bp.mass,
    hp: bp.hp,
    seeRange: bp.seeRange,
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
