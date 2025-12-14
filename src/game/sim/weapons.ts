import type { WeaponConfig } from './types';

// Predefined weapon configurations
// These can be extended or modified for different unit types

// Target DPS: ~40-50 for all weapons, with trade-offs for special abilities
export const WEAPON_CONFIGS: Record<string, WeaponConfig> = {
  // Laser - continuous beam, deals damage while on target
  // DPS: 40 (continuous damage over beam duration)
  laser: {
    id: 'laser',
    damage: 40, // Total damage dealt over beam duration (40 DPS continuous)
    range: 180,
    cooldown: 0, // No cooldown - fires continuously
    beamDuration: 1000, // 1 second beam duration
    beamWidth: 3,
    color: 0xff0000,
  },

  // Minigun - fast firing small projectiles (baseline weapon)
  // DPS: 50 (5 damage * 10 shots/sec)
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

  // Shotgun - multiple pellets with spread, short range
  // DPS: 40 (8*5=40 per shot, 1s cooldown) - requires close range
  shotgun: {
    id: 'shotgun',
    damage: 8,
    range: 100,
    cooldown: 1000,
    projectileSpeed: 500,
    projectileRadius: 4,
    projectileLifespan: 250,
    pelletCount: 5,
    spreadAngle: Math.PI / 6,
    color: 0xffaa00,
  },

  // Cannon - slow, heavy projectile, long range
  // DPS: 35 (70 damage / 2s) - compensated by range
  cannon: {
    id: 'cannon',
    damage: 70,
    range: 280,
    cooldown: 2000,
    projectileSpeed: 350,
    projectileRadius: 8,
    projectileLifespan: 1500,
    color: 0x888888,
  },

  // Grenade - splash damage, good vs groups
  // DPS: 30 base (90 / 3s), but splash multiplies effective damage
  grenade: {
    id: 'grenade',
    damage: 90,
    range: 160,
    cooldown: 3000,
    projectileSpeed: 280,
    projectileRadius: 6,
    projectileLifespan: 1500,
    splashRadius: 60,
    splashDamageFalloff: 0.4,
    color: 0x44ff44,
  },

  // Railgun - instant hitscan, pierces targets
  // DPS: 35 (70 / 2s), piercing compensates for lower DPS
  railgun: {
    id: 'railgun',
    damage: 70,
    range: 300,
    cooldown: 2000,
    beamDuration: 120,
    beamWidth: 2,
    color: 0x00ffff,
    piercing: true,
  },

  // Burst rifle - fires 3 shots in quick succession
  // DPS: 40 (20*3=60 / 1.5s)
  burstRifle: {
    id: 'burstRifle',
    damage: 20,
    range: 170,
    cooldown: 1500,
    projectileSpeed: 550,
    projectileRadius: 4,
    projectileLifespan: 500,
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
