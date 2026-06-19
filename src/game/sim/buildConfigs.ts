import type { BuildingConfig, BuildingBlueprintId, UnitBuildConfig } from './types';
import { COST_MULTIPLIER } from '../../config';
import { BUILDING_BLUEPRINTS, getUnitBlueprint, getUnitLocomotion } from './blueprints';
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
export const STRUCTURE_CONFIGS = {} as Record<BuildingBlueprintId, BuildingConfig>;
const ALL_STRUCTURE_CONFIGS: BuildingConfig[] = [];
for (const buildingBlueprintId in BUILDING_BLUEPRINTS) {
  const config = buildBuildingConfig(buildingBlueprintId as BuildingBlueprintId);
  STRUCTURE_CONFIGS[buildingBlueprintId as BuildingBlueprintId] = config;
  ALL_STRUCTURE_CONFIGS.push(config);
}

const BUILDING_CONFIGS = {} as Record<PureBuildingBlueprintId, BuildingConfig>;
const ALL_BUILDING_CONFIGS = new Array<BuildingConfig>(PURE_BUILDING_BLUEPRINT_IDS.length);
for (let i = 0; i < PURE_BUILDING_BLUEPRINT_IDS.length; i++) {
  const buildingBlueprintId = PURE_BUILDING_BLUEPRINT_IDS[i];
  const config = STRUCTURE_CONFIGS[buildingBlueprintId as BuildingBlueprintId];
  BUILDING_CONFIGS[buildingBlueprintId] = config;
  ALL_BUILDING_CONFIGS[i] = config;
}

const TOWER_CONFIGS = {} as Record<TowerBlueprintId, BuildingConfig>;
const ALL_TOWER_CONFIGS = new Array<BuildingConfig>(TOWER_BLUEPRINT_IDS.length);
for (let i = 0; i < TOWER_BLUEPRINT_IDS.length; i++) {
  const towerBlueprintId = TOWER_BLUEPRINT_IDS[i];
  const config = STRUCTURE_CONFIGS[towerBlueprintId as BuildingBlueprintId];
  TOWER_CONFIGS[towerBlueprintId] = config;
  ALL_TOWER_CONFIGS[i] = config;
}

// Compatibility helper. New UI/config code should prefer
// BUILDING_CONFIGS/getAllBuildings or TOWER_CONFIGS/getAllTowers.
export function getBuildingConfig(buildingBlueprintId: BuildingBlueprintId): BuildingConfig {
  return STRUCTURE_CONFIGS[buildingBlueprintId];
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
    airFrictionPer60HzFrame: bp.airFrictionPer60HzFrame,
    hp: bp.hp,
    fireRange: undefined,
  };
}


// Get list of all buildings
export function getAllBuildings(): BuildingConfig[] {
  return copyBuildingConfigArray(ALL_BUILDING_CONFIGS);
}

export function getAllTowers(): BuildingConfig[] {
  return copyBuildingConfigArray(ALL_TOWER_CONFIGS);
}

export function getAllStructures(): BuildingConfig[] {
  return copyBuildingConfigArray(ALL_STRUCTURE_CONFIGS);
}

function copyBuildingConfigArray(configs: readonly BuildingConfig[]): BuildingConfig[] {
  const copy = new Array<BuildingConfig>(configs.length);
  for (let i = 0; i < configs.length; i++) copy[i] = configs[i];
  return copy;
}
