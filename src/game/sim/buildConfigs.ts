import type { BuildingConfig, BuildingType, UnitBuildConfig } from './types';
import {
  COST_MULTIPLIER,
  BUILDING_STATS,
  UNIT_STATS,
  COMMANDER_STATS,
  SOLAR_ENERGY_PER_SECOND,
} from '../../config';

// Building configurations (costs are multiplied by COST_MULTIPLIER)
export const BUILDING_CONFIGS: Record<BuildingType, BuildingConfig> = {
  solar: {
    id: 'solar',
    name: 'Solar Panel',
    gridWidth: 3,
    gridHeight: 3,
    hp: BUILDING_STATS.solar.hp,
    energyCost: BUILDING_STATS.solar.baseCost * COST_MULTIPLIER,
    maxBuildRate: BUILDING_STATS.solar.buildRate,
    energyProduction: SOLAR_ENERGY_PER_SECOND,
  },
  factory: {
    id: 'factory',
    name: 'Factory',
    gridWidth: 5,
    gridHeight: 4,
    hp: BUILDING_STATS.factory.hp,
    energyCost: BUILDING_STATS.factory.baseCost * COST_MULTIPLIER,
    maxBuildRate: BUILDING_STATS.factory.buildRate,
    unitBuildRate: BUILDING_STATS.factory.unitBuildRate,
  },
};

// Unit build configurations (costs are multiplied by COST_MULTIPLIER)
export const UNIT_BUILD_CONFIGS: Record<string, UnitBuildConfig> = {
  scout: {
    weaponId: 'scout',
    name: 'Scout',
    energyCost: UNIT_STATS.scout.baseCost * COST_MULTIPLIER,
    maxBuildRate: UNIT_STATS.scout.buildRate,
    collisionRadius: UNIT_STATS.scout.collisionRadius,
    moveSpeed: UNIT_STATS.scout.moveSpeed,
    mass: UNIT_STATS.scout.mass,
    hp: UNIT_STATS.scout.hp,
  },
  burst: {
    weaponId: 'burst',
    name: 'Burst',
    energyCost: UNIT_STATS.burst.baseCost * COST_MULTIPLIER,
    maxBuildRate: UNIT_STATS.burst.buildRate,
    collisionRadius: UNIT_STATS.burst.collisionRadius,
    moveSpeed: UNIT_STATS.burst.moveSpeed,
    mass: UNIT_STATS.burst.mass,
    hp: UNIT_STATS.burst.hp,
  },
  daddy: {
    weaponId: 'daddy',
    name: 'Daddy',
    energyCost: UNIT_STATS.daddy.baseCost * COST_MULTIPLIER,
    maxBuildRate: UNIT_STATS.daddy.buildRate,
    collisionRadius: UNIT_STATS.daddy.collisionRadius,
    moveSpeed: UNIT_STATS.daddy.moveSpeed,
    mass: UNIT_STATS.daddy.mass,
    hp: UNIT_STATS.daddy.hp,
  },
  brawl: {
    weaponId: 'brawl',
    name: 'Brawl',
    energyCost: UNIT_STATS.brawl.baseCost * COST_MULTIPLIER,
    maxBuildRate: UNIT_STATS.brawl.buildRate,
    collisionRadius: UNIT_STATS.brawl.collisionRadius,
    moveSpeed: UNIT_STATS.brawl.moveSpeed,
    mass: UNIT_STATS.brawl.mass,
    hp: UNIT_STATS.brawl.hp,
  },
  shotgun: {
    weaponId: 'shotgun',
    name: 'Shotgun',
    energyCost: UNIT_STATS.shotgun.baseCost * COST_MULTIPLIER,
    maxBuildRate: UNIT_STATS.shotgun.buildRate,
    collisionRadius: UNIT_STATS.shotgun.collisionRadius,
    moveSpeed: UNIT_STATS.shotgun.moveSpeed,
    mass: UNIT_STATS.shotgun.mass,
    hp: UNIT_STATS.shotgun.hp,
  },
  snipe: {
    weaponId: 'snipe',
    name: 'Snipe',
    energyCost: UNIT_STATS.snipe.baseCost * COST_MULTIPLIER,
    maxBuildRate: UNIT_STATS.snipe.buildRate,
    collisionRadius: UNIT_STATS.snipe.collisionRadius,
    moveSpeed: UNIT_STATS.snipe.moveSpeed,
    mass: UNIT_STATS.snipe.mass,
    hp: UNIT_STATS.snipe.hp,
  },
  tank: {
    weaponId: 'tank',
    name: 'Tank',
    energyCost: UNIT_STATS.tank.baseCost * COST_MULTIPLIER,
    maxBuildRate: UNIT_STATS.tank.buildRate,
    collisionRadius: UNIT_STATS.tank.collisionRadius,
    moveSpeed: UNIT_STATS.tank.moveSpeed,
    mass: UNIT_STATS.tank.mass,
    hp: UNIT_STATS.tank.hp,
  },
  widow: {
    weaponId: 'widow',
    name: 'Widow',
    energyCost: UNIT_STATS.widow.baseCost * COST_MULTIPLIER,
    maxBuildRate: UNIT_STATS.widow.buildRate,
    collisionRadius: UNIT_STATS.widow.collisionRadius,
    moveSpeed: UNIT_STATS.widow.moveSpeed,
    mass: UNIT_STATS.widow.mass,
    hp: UNIT_STATS.widow.hp,
    weaponSeeRange: 400,
  },
  insect: {
    weaponId: 'insect',
    name: 'Insect',
    energyCost: UNIT_STATS.insect.baseCost * COST_MULTIPLIER,
    maxBuildRate: UNIT_STATS.insect.buildRate,
    collisionRadius: UNIT_STATS.insect.collisionRadius,
    moveSpeed: UNIT_STATS.insect.moveSpeed,
    mass: UNIT_STATS.insect.mass,
    hp: UNIT_STATS.insect.hp,
    weaponSeeRange: 100,
    weaponFireRange: 150,
  },
};

// Commander stats (from config)
export const COMMANDER_CONFIG = {
  hp: COMMANDER_STATS.hp,
  maxHp: COMMANDER_STATS.hp,
  collisionRadius: COMMANDER_STATS.collisionRadius,
  moveSpeed: COMMANDER_STATS.moveSpeed,
  mass: COMMANDER_STATS.mass,
  buildRate: COMMANDER_STATS.buildRate,
  buildRange: COMMANDER_STATS.buildRange,
  weaponId: 'daddy',  // Commander uses daddy weapon (continuous beam)
  dgunCost: COMMANDER_STATS.dgunCost,
};

// D-gun weapon config
export const DGUN_CONFIG = {
  id: 'dgun',
  damage: 9999,
  range: 300,
  cooldown: 0,
  projectileSpeed: 350,
  projectileRadius: 25,
  projectileLifespan: 2000,
  color: 0xff8800,
  splashRadius: 40,
  splashDamageFalloff: 1, // Full damage at edge (no falloff)
};

// Helper to get building config
export function getBuildingConfig(type: BuildingType): BuildingConfig {
  return BUILDING_CONFIGS[type];
}

// Helper to get unit build config
export function getUnitBuildConfig(weaponId: string): UnitBuildConfig | undefined {
  return UNIT_BUILD_CONFIGS[weaponId];
}

// Get list of all buildable units
export function getBuildableUnits(): UnitBuildConfig[] {
  return Object.values(UNIT_BUILD_CONFIGS);
}

// Get list of all buildings
export function getAllBuildings(): BuildingConfig[] {
  return Object.values(BUILDING_CONFIGS);
}
