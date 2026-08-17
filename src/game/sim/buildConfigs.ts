import type { BuildingConfig, BuildingBlueprintId, UnitBuildConfig } from './types';
import { COST_MULTIPLIER } from '../../config';
import { BUILDING_BLUEPRINTS, getUnitBlueprint, getUnitLocomotion } from './blueprints';
import { cloneUnitSupportSurface } from './unitSupportSurface';
import {
  BUILDING_BLUEPRINT_IDS,
} from '../../types/blueprintIds';
import { parseBuildingPlacementFootprint } from './buildGrid';
import { getBuildingPlacementAnchor } from '../../types/buildingTypes';

function buildBuildingConfig(buildingBlueprintId: BuildingBlueprintId): BuildingConfig {
  const bp = BUILDING_BLUEPRINTS[buildingBlueprintId];
  const placementFootprint = parseBuildingPlacementFootprint(
    bp.footprintMask,
    `building blueprint ${buildingBlueprintId}`,
  );
  return {
    buildingBlueprintId: bp.buildingBlueprintId,
    name: bp.name,
    shortName: bp.shortName,
    tinyName: bp.tinyName,
    gridWidth: bp.gridWidth,
    gridHeight: bp.gridHeight,
    gridDepth: bp.gridDepth,
    placementGridWidth: placementFootprint.gridWidth,
    placementGridHeight: placementFootprint.gridHeight,
    placementFootprint,
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
    placementSets: bp.placementSets,
    hoveringType: bp.hoveringType,
    hovering: getBuildingPlacementAnchor(bp.placementSets) === 'hover-surface',
    hud: bp.hud,
    radius: { ...bp.base.radius },
  };
}

// Canonical runtime table for every static structure blueprint.
export const STRUCTURE_CONFIGS = {} as Record<BuildingBlueprintId, BuildingConfig>;
const ALL_STRUCTURE_CONFIGS: BuildingConfig[] = [];
for (const buildingBlueprintId in BUILDING_BLUEPRINTS) {
  const config = buildBuildingConfig(buildingBlueprintId as BuildingBlueprintId);
  STRUCTURE_CONFIGS[buildingBlueprintId as BuildingBlueprintId] = config;
  ALL_STRUCTURE_CONFIGS.push(config);
}

const BUILDING_CONFIGS = {} as Record<BuildingBlueprintId, BuildingConfig>;
const ALL_BUILDING_CONFIGS = new Array<BuildingConfig>(BUILDING_BLUEPRINT_IDS.length);
for (let i = 0; i < BUILDING_BLUEPRINT_IDS.length; i++) {
  const buildingBlueprintId = BUILDING_BLUEPRINT_IDS[i];
  const config = STRUCTURE_CONFIGS[buildingBlueprintId as BuildingBlueprintId];
  BUILDING_CONFIGS[buildingBlueprintId] = config;
  ALL_BUILDING_CONFIGS[i] = config;
}

export function getBuildingConfig(buildingBlueprintId: BuildingBlueprintId): BuildingConfig {
  return STRUCTURE_CONFIGS[buildingBlueprintId];
}


// Derived build-cost view used by reclaim and construction accounting.
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
    supportPointOffsetZ: bp.supportPointOffsetZ,
    supportSurface: cloneUnitSupportSurface(bp.supportSurface),
    locomotion: getUnitLocomotion(unitBlueprintId),
    mass: bp.mass,
    hp: bp.hp,
    fireRange: undefined,
  };
}


// Get list of all buildings
export function getAllBuildings(): BuildingConfig[] {
  return copyBuildingConfigArray(ALL_BUILDING_CONFIGS);
}

export function getAllStructures(): BuildingConfig[] {
  return copyBuildingConfigArray(ALL_STRUCTURE_CONFIGS);
}

function copyBuildingConfigArray(configs: readonly BuildingConfig[]): BuildingConfig[] {
  const copy = new Array<BuildingConfig>(configs.length);
  for (let i = 0; i < configs.length; i++) copy[i] = configs[i];
  return copy;
}
