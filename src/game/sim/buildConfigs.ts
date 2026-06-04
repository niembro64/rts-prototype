import type { BuildingConfig, BuildingBlueprintId, UnitBuildConfig } from './types';
import { COST_MULTIPLIER } from '../../config';
import { BUILDING_BLUEPRINTS, getUnitBlueprint, getUnitLocomotion, BUILDABLE_UNIT_BLUEPRINT_IDS } from './blueprints';

function buildBuildingConfig(buildingBlueprintId: BuildingBlueprintId): BuildingConfig {
  const bp = BUILDING_BLUEPRINTS[buildingBlueprintId];
  return {
    buildingBlueprintId: bp.buildingBlueprintId,
    name: bp.name,
    gridWidth: bp.gridWidth,
    gridHeight: bp.gridHeight,
    gridDepth: bp.gridDepth,
    hp: bp.hp,
    cost: {
      energy: bp.cost.energy * COST_MULTIPLIER,
      metal: bp.cost.metal * COST_MULTIPLIER,
    },
    energyProduction: bp.energyProduction,
    metalProduction: bp.metalProduction,
    constructionRate: bp.constructionRate,
    conversionRate: bp.conversionRate,
    renderProfile: bp.renderProfile,
    visualHeight: bp.visualHeight,
    anchorProfile: bp.anchorProfile,
    supportSurface: bp.supportSurface,
    hud: bp.hud,
  };
}

// Building configurations derived from BUILDING_BLUEPRINTS.
export const BUILDING_CONFIGS: Record<BuildingBlueprintId, BuildingConfig> =
  Object.fromEntries(
    Object.keys(BUILDING_BLUEPRINTS).map((buildingBlueprintId) => [
      buildingBlueprintId,
      buildBuildingConfig(buildingBlueprintId as BuildingBlueprintId),
    ]),
  ) as Record<BuildingBlueprintId, BuildingConfig>;

// Helper to get building config
export function getBuildingConfig(buildingBlueprintId: BuildingBlueprintId): BuildingConfig {
  return BUILDING_CONFIGS[buildingBlueprintId];
}

// Helper to get unit build config (now backed by blueprints)
// Returns a shim matching the old UnitBuildConfig shape for backward compatibility
export function getUnitBuildConfig(unitBlueprintId: string): UnitBuildConfig | undefined {
  const bp = getUnitBlueprint(unitBlueprintId);
  if (!bp) return undefined;
  return {
    unitBlueprintId: bp.unitBlueprintId,
    name: bp.name,
    cost: {
      energy: bp.cost.energy * COST_MULTIPLIER,
      metal: bp.cost.metal * COST_MULTIPLIER,
    },
    radius: { ...bp.radius },
    bodyCenterHeight: bp.bodyCenterHeight,
    locomotion: getUnitLocomotion(unitBlueprintId),
    mass: bp.mass,
    hp: bp.hp,
    fireRange: undefined,
  };
}

// Get list of all buildable units
export function getBuildableUnits() {
  return BUILDABLE_UNIT_BLUEPRINT_IDS.map((unitBlueprintId) => getUnitBuildConfig(unitBlueprintId)!);
}

// Get list of all buildings
export function getAllBuildings(): BuildingConfig[] {
  return Object.values(BUILDING_CONFIGS);
}
