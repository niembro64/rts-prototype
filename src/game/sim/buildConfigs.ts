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
  minigun: {
    weaponId: 'minigun',
    name: 'Minigun Trooper',
    energyCost: UNIT_STATS.minigun.baseCost * COST_MULTIPLIER,
    maxBuildRate: UNIT_STATS.minigun.buildRate,
    radius: UNIT_STATS.minigun.radius,
    moveSpeed: UNIT_STATS.minigun.moveSpeed,
    hp: UNIT_STATS.minigun.hp,
  },
  laser: {
    weaponId: 'laser',
    name: 'Laser Trooper',
    energyCost: UNIT_STATS.laser.baseCost * COST_MULTIPLIER,
    maxBuildRate: UNIT_STATS.laser.buildRate,
    radius: UNIT_STATS.laser.radius,
    moveSpeed: UNIT_STATS.laser.moveSpeed,
    hp: UNIT_STATS.laser.hp,
  },
  shotgun: {
    weaponId: 'shotgun',
    name: 'Shotgunner',
    energyCost: UNIT_STATS.shotgun.baseCost * COST_MULTIPLIER,
    maxBuildRate: UNIT_STATS.shotgun.buildRate,
    radius: UNIT_STATS.shotgun.radius,
    moveSpeed: UNIT_STATS.shotgun.moveSpeed,
    hp: UNIT_STATS.shotgun.hp,
  },
  cannon: {
    weaponId: 'cannon',
    name: 'Cannon',
    energyCost: UNIT_STATS.cannon.baseCost * COST_MULTIPLIER,
    maxBuildRate: UNIT_STATS.cannon.buildRate,
    radius: UNIT_STATS.cannon.radius,
    moveSpeed: UNIT_STATS.cannon.moveSpeed,
    hp: UNIT_STATS.cannon.hp,
  },
  grenade: {
    weaponId: 'grenade',
    name: 'Grenadier',
    energyCost: UNIT_STATS.grenade.baseCost * COST_MULTIPLIER,
    maxBuildRate: UNIT_STATS.grenade.buildRate,
    radius: UNIT_STATS.grenade.radius,
    moveSpeed: UNIT_STATS.grenade.moveSpeed,
    hp: UNIT_STATS.grenade.hp,
  },
  railgun: {
    weaponId: 'railgun',
    name: 'Railgun',
    energyCost: UNIT_STATS.railgun.baseCost * COST_MULTIPLIER,
    maxBuildRate: UNIT_STATS.railgun.buildRate,
    radius: UNIT_STATS.railgun.radius,
    moveSpeed: UNIT_STATS.railgun.moveSpeed,
    hp: UNIT_STATS.railgun.hp,
  },
  burstRifle: {
    weaponId: 'burstRifle',
    name: 'Burst Rifle',
    energyCost: UNIT_STATS.burstRifle.baseCost * COST_MULTIPLIER,
    maxBuildRate: UNIT_STATS.burstRifle.buildRate,
    radius: UNIT_STATS.burstRifle.radius,
    moveSpeed: UNIT_STATS.burstRifle.moveSpeed,
    hp: UNIT_STATS.burstRifle.hp,
  },
};

// Commander stats (from config)
export const COMMANDER_CONFIG = {
  hp: COMMANDER_STATS.hp,
  maxHp: COMMANDER_STATS.hp,
  radius: 20,
  moveSpeed: COMMANDER_STATS.moveSpeed,
  buildRate: COMMANDER_STATS.buildRate,
  buildRange: COMMANDER_STATS.buildRange,
  weaponId: 'laser',
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
  splashDamageFalloff: 0,
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
