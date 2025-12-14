import type { BuildingConfig, BuildingType, UnitBuildConfig } from './types';

// Building configurations
export const BUILDING_CONFIGS: Record<BuildingType, BuildingConfig> = {
  solar: {
    id: 'solar',
    name: 'Solar Panel',
    gridWidth: 3,           // 60x60 world units
    gridHeight: 3,
    hp: 200,
    energyCost: 150,
    maxBuildRate: 20,       // Min 7.5 seconds to build
    energyProduction: 15,   // Energy/sec when complete
  },
  factory: {
    id: 'factory',
    name: 'Factory',
    gridWidth: 5,           // 100x80 world units
    gridHeight: 4,
    hp: 800,
    energyCost: 400,
    maxBuildRate: 25,       // Min 16 seconds to build
    unitBuildRate: 20,      // Max energy/sec for unit production
  },
};

// Unit build configurations
export const UNIT_BUILD_CONFIGS: Record<string, UnitBuildConfig> = {
  minigun: {
    weaponId: 'minigun',
    name: 'Minigun Trooper',
    energyCost: 100,
    maxBuildRate: 15,       // Min 6.7 seconds
    radius: 12,
    moveSpeed: 120,
    hp: 100,
  },
  laser: {
    weaponId: 'laser',
    name: 'Laser Trooper',
    energyCost: 120,
    maxBuildRate: 15,       // Min 8 seconds
    radius: 14,
    moveSpeed: 100,
    hp: 100,
  },
  shotgun: {
    weaponId: 'shotgun',
    name: 'Shotgunner',
    energyCost: 110,
    maxBuildRate: 15,       // Min 7.3 seconds
    radius: 13,
    moveSpeed: 110,
    hp: 100,
  },
  cannon: {
    weaponId: 'cannon',
    name: 'Cannon',
    energyCost: 180,
    maxBuildRate: 12,       // Min 15 seconds
    radius: 16,
    moveSpeed: 80,
    hp: 150,
  },
  grenade: {
    weaponId: 'grenade',
    name: 'Grenadier',
    energyCost: 200,
    maxBuildRate: 10,       // Min 20 seconds
    radius: 14,
    moveSpeed: 90,
    hp: 120,
  },
  railgun: {
    weaponId: 'railgun',
    name: 'Railgun',
    energyCost: 220,
    maxBuildRate: 10,       // Min 22 seconds
    radius: 14,
    moveSpeed: 85,
    hp: 100,
  },
  burstRifle: {
    weaponId: 'burstRifle',
    name: 'Burst Rifle',
    energyCost: 140,
    maxBuildRate: 15,       // Min 9.3 seconds
    radius: 12,
    moveSpeed: 115,
    hp: 100,
  },
};

// Commander stats
export const COMMANDER_CONFIG = {
  hp: 500,
  maxHp: 500,
  radius: 20,
  moveSpeed: 80,
  buildRate: 25,            // Energy/sec for construction
  buildRange: 150,          // Max distance to build
  weaponId: 'laser',        // Uses laser weapon
  dgunCost: 200,            // Energy cost for D-gun (20% of 1000)
};

// D-gun weapon config
export const DGUN_CONFIG = {
  id: 'dgun',
  damage: 9999,             // Instant kill
  range: 300,
  cooldown: 0,              // No cooldown, limited by energy
  projectileSpeed: 350,     // Medium speed
  projectileRadius: 25,     // Large projectile
  projectileLifespan: 2000, // Long range
  color: 0xff8800,          // Orange/fire color
  splashRadius: 40,         // Destroys area
  splashDamageFalloff: 0,   // Full damage in splash
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
