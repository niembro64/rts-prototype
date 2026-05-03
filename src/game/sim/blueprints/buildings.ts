/**
 * Building Blueprints
 *
 * Single source of truth for authored building facts. Runtime building
 * configs, client render profiles, and targeting/hover anchors all derive
 * from this table.
 */

import type { BuildingAnchorProfile, BuildingRenderProfile, BuildingType } from '../types';
import {
  EXTRACTOR_METAL_PER_SECOND,
  METAL_DEPOSIT_RESOURCE_CELLS,
  SOLAR_ENERGY_PER_SECOND,
  WIND_ENERGY_PER_SECOND,
} from '../../../config';

export type BuildingBlueprint = {
  id: BuildingType;
  name: string;
  gridWidth: number;
  gridHeight: number;
  gridDepth: number;
  hp: number;
  /** Authored base resource cost. BUILDING_CONFIGS applies COST_MULTIPLIER. */
  resourceCost: number;
  energyProduction?: number;
  metalProduction?: number;
  maxEnergyUseRate?: number;
  renderProfile: BuildingRenderProfile;
  /** Primary visual/anchor height above ground, in world units. */
  visualHeight: number;
  anchorProfile: BuildingAnchorProfile;
};

export const DEFAULT_BUILDING_VISUAL_HEIGHT = 120;
export const SOLAR_BUILDING_VISUAL_HEIGHT = 52;
export const WIND_BUILDING_VISUAL_HEIGHT = 250;
export const FACTORY_BASE_VISUAL_HEIGHT = 30;
export const EXTRACTOR_BUILDING_VISUAL_HEIGHT = 50;

export const BUILDING_BLUEPRINTS: Record<BuildingType, BuildingBlueprint> = {
  solar: {
    id: 'solar',
    name: 'Solar',
    gridWidth: 3,
    gridHeight: 3,
    gridDepth: 1,
    hp: 200,
    resourceCost: 100,
    energyProduction: SOLAR_ENERGY_PER_SECOND,
    renderProfile: 'solar',
    visualHeight: SOLAR_BUILDING_VISUAL_HEIGHT,
    anchorProfile: 'constantVisualTop',
  },
  wind: {
    id: 'wind',
    name: 'Wind',
    gridWidth: 2,
    gridHeight: 2,
    gridDepth: 5,
    hp: 100,
    resourceCost: 60,
    energyProduction: WIND_ENERGY_PER_SECOND,
    renderProfile: 'wind',
    visualHeight: WIND_BUILDING_VISUAL_HEIGHT,
    anchorProfile: 'constantVisualTop',
  },
  factory: {
    id: 'factory',
    name: 'Fabricator',
    // Fabricators are just their construction tower. Units are assembled
    // outside this small blocking footprint, not inside a reserved yard.
    gridWidth: 2,
    gridHeight: 2,
    gridDepth: 6,
    hp: 800,
    resourceCost: 300,
    maxEnergyUseRate: 100,
    renderProfile: 'factory',
    visualHeight: FACTORY_BASE_VISUAL_HEIGHT,
    anchorProfile: 'factoryTower',
  },
  extractor: {
    id: 'extractor',
    name: 'Extractor',
    // Matches the logical square metal-deposit footprint exactly.
    gridWidth: METAL_DEPOSIT_RESOURCE_CELLS,
    gridHeight: METAL_DEPOSIT_RESOURCE_CELLS,
    gridDepth: 2,
    hp: 250,
    resourceCost: 80,
    metalProduction: EXTRACTOR_METAL_PER_SECOND,
    renderProfile: 'extractor',
    visualHeight: EXTRACTOR_BUILDING_VISUAL_HEIGHT,
    anchorProfile: 'constantVisualTop',
  },
};

for (const [id, blueprint] of Object.entries(BUILDING_BLUEPRINTS)) {
  if (id !== blueprint.id) {
    throw new Error(`Building blueprint key mismatch: key '${id}' has id '${blueprint.id}'`);
  }
  if (!Number.isFinite(blueprint.gridWidth) || blueprint.gridWidth <= 0) {
    throw new Error(`Invalid building blueprint ${id}: gridWidth must be positive`);
  }
  if (!Number.isFinite(blueprint.gridHeight) || blueprint.gridHeight <= 0) {
    throw new Error(`Invalid building blueprint ${id}: gridHeight must be positive`);
  }
  if (!Number.isFinite(blueprint.gridDepth) || blueprint.gridDepth <= 0) {
    throw new Error(`Invalid building blueprint ${id}: gridDepth must be positive`);
  }
  if (!Number.isFinite(blueprint.visualHeight) || blueprint.visualHeight <= 0) {
    throw new Error(`Invalid building blueprint ${id}: visualHeight must be positive`);
  }
}

export function getBuildingBlueprint(type: BuildingType): BuildingBlueprint {
  return BUILDING_BLUEPRINTS[type];
}

export function getAllBuildingBlueprints(): BuildingBlueprint[] {
  return Object.values(BUILDING_BLUEPRINTS);
}
