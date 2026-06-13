import type { BuildingConfig, BuildingBlueprintId, UnitBuildConfig } from './types';
import { COST_MULTIPLIER } from '../../config';
import { BUILDING_BLUEPRINTS, getUnitBlueprint, getUnitLocomotion, BUILDABLE_UNIT_BLUEPRINT_IDS } from './blueprints';
import { cloneUnitSupportSurface } from './unitSupportSurface';
import {
  BUILDING_BLUEPRINT_IDS as PURE_BUILDING_BLUEPRINT_IDS,
  TOWER_BLUEPRINT_IDS,
  type BuildingBlueprintId as PureBuildingBlueprintId,
  type TowerBlueprintId,
} from '../../types/blueprintIds';

function buildBuildingConfig(buildingBlueprintId: BuildingBlueprintId): BuildingConfig {
  const bp = BUILDING_BLUEPRINTS[buildingBlueprintId];
  return {
    buildingBlueprintId: bp.buildingBlueprintId,
    name: bp.name,
    gridWidth: bp.gridWidth,
    gridHeight: bp.gridHeight,
    gridDepth: bp.gridDepth,
    placementGridWidth: bp.placementGridWidth ?? bp.gridWidth,
    placementGridHeight: bp.placementGridHeight ?? bp.gridHeight,
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
    sensors: { ...bp.sensors },
    radius: { ...bp.base.radius },
  };
}

// Compatibility table for runtime code that still receives a static
// structure id via the historical `buildingBlueprintId` field.
export const STRUCTURE_CONFIGS: Record<BuildingBlueprintId, BuildingConfig> =
  Object.fromEntries(
    Object.keys(BUILDING_BLUEPRINTS).map((buildingBlueprintId) => [
      buildingBlueprintId,
      buildBuildingConfig(buildingBlueprintId as BuildingBlueprintId),
    ]),
  ) as Record<BuildingBlueprintId, BuildingConfig>;

export const BUILDING_CONFIGS: Record<PureBuildingBlueprintId, BuildingConfig> =
  Object.fromEntries(
    PURE_BUILDING_BLUEPRINT_IDS.map((buildingBlueprintId) => [
      buildingBlueprintId,
      STRUCTURE_CONFIGS[buildingBlueprintId as BuildingBlueprintId],
    ]),
  ) as Record<PureBuildingBlueprintId, BuildingConfig>;

export const TOWER_CONFIGS: Record<TowerBlueprintId, BuildingConfig> =
  Object.fromEntries(
    TOWER_BLUEPRINT_IDS.map((towerBlueprintId) => [
      towerBlueprintId,
      STRUCTURE_CONFIGS[towerBlueprintId as BuildingBlueprintId],
    ]),
  ) as Record<TowerBlueprintId, BuildingConfig>;

// Compatibility helper. New UI/config code should prefer
// BUILDING_CONFIGS/getAllBuildings or TOWER_CONFIGS/getAllTowers.
export function getBuildingConfig(buildingBlueprintId: BuildingBlueprintId): BuildingConfig {
  return STRUCTURE_CONFIGS[buildingBlueprintId];
}

export function getTowerConfig(towerBlueprintId: TowerBlueprintId): BuildingConfig {
  return TOWER_CONFIGS[towerBlueprintId];
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
    supportSurface: cloneUnitSupportSurface(bp.supportSurface),
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

export function getAllTowers(): BuildingConfig[] {
  return Object.values(TOWER_CONFIGS);
}

export function getAllStructures(): BuildingConfig[] {
  return Object.values(STRUCTURE_CONFIGS);
}
