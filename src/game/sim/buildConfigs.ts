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
    energyProduction: SOLAR_ENERGY_PER_SECOND,
  },
  factory: {
    id: 'factory',
    name: 'Factory',
    gridWidth: 5,
    gridHeight: 4,
    hp: BUILDING_STATS.factory.hp,
    energyCost: BUILDING_STATS.factory.baseCost * COST_MULTIPLIER,
  },
};

// Unit build configurations (costs are multiplied by COST_MULTIPLIER)
// Keys are unit type IDs, weaponId references the weapon type
export const UNIT_BUILD_CONFIGS: Record<string, UnitBuildConfig> = {
  jackal: {
    weaponId: 'gatling',
    name: 'Jackal',
    energyCost: UNIT_STATS.jackal.baseCost * COST_MULTIPLIER,
    collisionRadius: UNIT_STATS.jackal.collisionRadius,
    moveSpeed: UNIT_STATS.jackal.moveSpeed,
    mass: UNIT_STATS.jackal.mass,
    hp: UNIT_STATS.jackal.hp,
  },
  lynx: {
    weaponId: 'pulse',
    name: 'Lynx',
    energyCost: UNIT_STATS.lynx.baseCost * COST_MULTIPLIER,
    collisionRadius: UNIT_STATS.lynx.collisionRadius,
    moveSpeed: UNIT_STATS.lynx.moveSpeed,
    mass: UNIT_STATS.lynx.mass,
    hp: UNIT_STATS.lynx.hp,
  },
  daddy: {
    weaponId: 'forceField',
    name: 'Daddy',
    energyCost: UNIT_STATS.daddy.baseCost * COST_MULTIPLIER,
    collisionRadius: UNIT_STATS.daddy.collisionRadius,
    moveSpeed: UNIT_STATS.daddy.moveSpeed,
    mass: UNIT_STATS.daddy.mass,
    hp: UNIT_STATS.daddy.hp,
  },
  badger: {
    weaponId: 'shotgun',
    name: 'Badger',
    energyCost: UNIT_STATS.badger.baseCost * COST_MULTIPLIER,
    collisionRadius: UNIT_STATS.badger.collisionRadius,
    moveSpeed: UNIT_STATS.badger.moveSpeed,
    mass: UNIT_STATS.badger.mass,
    hp: UNIT_STATS.badger.hp,
  },
  mongoose: {
    weaponId: 'mortar',
    name: 'Mongoose',
    energyCost: UNIT_STATS.mongoose.baseCost * COST_MULTIPLIER,
    collisionRadius: UNIT_STATS.mongoose.collisionRadius,
    moveSpeed: UNIT_STATS.mongoose.moveSpeed,
    mass: UNIT_STATS.mongoose.mass,
    hp: UNIT_STATS.mongoose.hp,
  },
  recluse: {
    weaponId: 'railgun',
    name: 'Recluse',
    energyCost: UNIT_STATS.recluse.baseCost * COST_MULTIPLIER,
    collisionRadius: UNIT_STATS.recluse.collisionRadius,
    moveSpeed: UNIT_STATS.recluse.moveSpeed,
    mass: UNIT_STATS.recluse.mass,
    hp: UNIT_STATS.recluse.hp,
  },
  mammoth: {
    weaponId: 'cannon',
    name: 'Mammoth',
    energyCost: UNIT_STATS.mammoth.baseCost * COST_MULTIPLIER,
    collisionRadius: UNIT_STATS.mammoth.collisionRadius,
    moveSpeed: UNIT_STATS.mammoth.moveSpeed,
    mass: UNIT_STATS.mammoth.mass,
    hp: UNIT_STATS.mammoth.hp,
  },
  widow: {
    weaponId: 'beam',
    name: 'Widow',
    energyCost: UNIT_STATS.widow.baseCost * COST_MULTIPLIER,
    collisionRadius: UNIT_STATS.widow.collisionRadius,
    moveSpeed: UNIT_STATS.widow.moveSpeed,
    mass: UNIT_STATS.widow.mass,
    hp: UNIT_STATS.widow.hp,
    weaponSeeRange: 400,
  },
  tarantula: {
    weaponId: 'beam',
    name: 'Tarantula',
    energyCost: UNIT_STATS.tarantula.baseCost * COST_MULTIPLIER,
    collisionRadius: UNIT_STATS.tarantula.collisionRadius,
    moveSpeed: UNIT_STATS.tarantula.moveSpeed,
    mass: UNIT_STATS.tarantula.mass,
    hp: UNIT_STATS.tarantula.hp,
  },
};

// Commander stats (from config)
export const COMMANDER_CONFIG = {
  hp: COMMANDER_STATS.hp,
  maxHp: COMMANDER_STATS.hp,
  collisionRadius: COMMANDER_STATS.collisionRadius,
  moveSpeed: COMMANDER_STATS.moveSpeed,
  mass: COMMANDER_STATS.mass,
  buildRange: COMMANDER_STATS.buildRange,
  weaponId: 'beam',  // Commander uses beam weapon (continuous beam)
  dgunCost: COMMANDER_STATS.dgunCost,
};

// Disruptor weapon config (Commander's special weapon)
export const DGUN_CONFIG = {
  id: 'disruptor',
  damage: 9999,
  range: 300,
  cooldown: 0,
  projectileSpeed: 350,
  projectileRadius: 25,
  projectileLifespan: 2000,
  color: 0xff8800,
  primaryDamageRadius: 40,
  secondaryDamageRadius: 70,
  splashOnExpiry: true,
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
