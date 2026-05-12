import type { BuildingConfig, BuildingType } from './types';
import { COST_MULTIPLIER } from '../../config';
import { BUILDING_BLUEPRINTS, getUnitBlueprint, getUnitLocomotion, BUILDABLE_UNIT_IDS } from './blueprints';

function buildBuildingConfig(type: BuildingType): BuildingConfig {
  const bp = BUILDING_BLUEPRINTS[type];
  return {
    id: bp.id,
    name: bp.name,
    gridWidth: bp.gridWidth,
    gridHeight: bp.gridHeight,
    gridDepth: bp.gridDepth,
    hp: bp.hp,
    cost: {
      energy: bp.cost.energy * COST_MULTIPLIER,
      mana: bp.cost.mana * COST_MULTIPLIER,
      metal: bp.cost.metal * COST_MULTIPLIER,
    },
    energyProduction: bp.energyProduction,
    metalProduction: bp.metalProduction,
    constructionRate: bp.constructionRate,
    renderProfile: bp.renderProfile,
    visualHeight: bp.visualHeight,
    anchorProfile: bp.anchorProfile,
    hud: bp.hud,
  };
}

// Building configurations derived from BUILDING_BLUEPRINTS.
export const BUILDING_CONFIGS: Record<BuildingType, BuildingConfig> = {
  solar: buildBuildingConfig('solar'),
  wind: buildBuildingConfig('wind'),
  factory: buildBuildingConfig('factory'),
  extractor: buildBuildingConfig('extractor'),
  radar: buildBuildingConfig('radar'),
  megaBeamTower: buildBuildingConfig('megaBeamTower'),
  cannonTower: buildBuildingConfig('cannonTower'),
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
    unitId: bp.id,
    name: bp.name,
    cost: {
      energy: bp.cost.energy * COST_MULTIPLIER,
      mana: bp.cost.mana * COST_MULTIPLIER,
      metal: bp.cost.metal * COST_MULTIPLIER,
    },
    radius: { ...bp.radius },
    bodyCenterHeight: bp.bodyCenterHeight,
    locomotion: getUnitLocomotion(unitId),
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
