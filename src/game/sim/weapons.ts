import type { WeaponConfig } from './types';

// Predefined weapon configurations
// These can be extended or modified for different unit types

export const WEAPON_CONFIGS: Record<string, WeaponConfig> = {
  // Laser - instant hitscan beam, persists briefly
  laser: {
    id: 'laser',
    damage: 15,
    range: 200,
    cooldown: 1500,
    beamDuration: 150,
    beamWidth: 3,
    color: 0xff0000,
  },

  // Minigun - fast firing small projectiles
  minigun: {
    id: 'minigun',
    damage: 5,
    range: 150,
    cooldown: 100,
    projectileSpeed: 600,
    projectileRadius: 3,
    projectileLifespan: 500,
    color: 0xffff00,
  },

  // Shotgun - multiple pellets with spread
  shotgun: {
    id: 'shotgun',
    damage: 8,
    range: 120,
    cooldown: 1200,
    projectileSpeed: 500,
    projectileRadius: 4,
    projectileLifespan: 300,
    pelletCount: 5,
    spreadAngle: Math.PI / 6, // 30 degrees total spread
    color: 0xffaa00,
  },

  // Cannon - slow, heavy projectile
  cannon: {
    id: 'cannon',
    damage: 40,
    range: 250,
    cooldown: 2500,
    projectileSpeed: 300,
    projectileRadius: 8,
    projectileLifespan: 1500,
    color: 0x888888,
  },

  // Grenade - slow projectile with splash damage
  grenade: {
    id: 'grenade',
    damage: 30,
    range: 180,
    cooldown: 3000,
    projectileSpeed: 250,
    projectileRadius: 6,
    projectileLifespan: 2000,
    splashRadius: 50,
    splashDamageFalloff: 0.3,
    color: 0x44ff44,
  },

  // Railgun - instant hitscan, pierces targets
  railgun: {
    id: 'railgun',
    damage: 35,
    range: 300,
    cooldown: 2000,
    beamDuration: 100,
    beamWidth: 2,
    color: 0x00ffff,
    piercing: true,
  },

  // Burst rifle - fires 3 shots in quick succession
  burstRifle: {
    id: 'burstRifle',
    damage: 12,
    range: 180,
    cooldown: 1800,
    projectileSpeed: 550,
    projectileRadius: 4,
    projectileLifespan: 600,
    burstCount: 3,
    burstDelay: 80,
    color: 0xff88ff,
  },
};

// Helper to get a weapon config by ID
export function getWeaponConfig(id: string): WeaponConfig {
  const config = WEAPON_CONFIGS[id];
  if (!config) {
    throw new Error(`Unknown weapon config: ${id}`);
  }
  return { ...config }; // Return a copy
}

// Helper to create a custom weapon config
export function createWeaponConfig(base: Partial<WeaponConfig> & { id: string }): WeaponConfig {
  return {
    damage: 10,
    range: 100,
    cooldown: 1000,
    color: 0xffffff,
    ...base,
  };
}
