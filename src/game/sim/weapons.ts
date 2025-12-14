import type { WeaponConfig } from './types';
import { WEAPON_STATS } from '../../config';

// Weapon configurations using values from config.ts
export const WEAPON_CONFIGS: Record<string, WeaponConfig> = {
  // Laser - continuous beam, deals damage while on target
  laser: {
    id: 'laser',
    damage: WEAPON_STATS.laser.damage,
    range: WEAPON_STATS.laser.range,
    cooldown: WEAPON_STATS.laser.cooldown,
    beamDuration: WEAPON_STATS.laser.beamDuration,
    beamWidth: WEAPON_STATS.laser.beamWidth,
    color: 0xff0000,
  },

  // Minigun - fast firing small projectiles (baseline weapon)
  minigun: {
    id: 'minigun',
    damage: WEAPON_STATS.minigun.damage,
    range: WEAPON_STATS.minigun.range,
    cooldown: WEAPON_STATS.minigun.cooldown,
    projectileSpeed: WEAPON_STATS.minigun.projectileSpeed,
    projectileRadius: 3,
    projectileLifespan: 500,
    color: 0xffff00,
  },

  // Shotgun - multiple pellets with spread, short range
  shotgun: {
    id: 'shotgun',
    damage: WEAPON_STATS.shotgun.damage,
    range: WEAPON_STATS.shotgun.range,
    cooldown: WEAPON_STATS.shotgun.cooldown,
    projectileSpeed: WEAPON_STATS.shotgun.projectileSpeed,
    projectileRadius: 4,
    projectileLifespan: 250,
    pelletCount: WEAPON_STATS.shotgun.pelletCount,
    spreadAngle: Math.PI / 6,
    color: 0xffaa00,
  },

  // Cannon - slow, heavy projectile, long range
  cannon: {
    id: 'cannon',
    damage: WEAPON_STATS.cannon.damage,
    range: WEAPON_STATS.cannon.range,
    cooldown: WEAPON_STATS.cannon.cooldown,
    projectileSpeed: WEAPON_STATS.cannon.projectileSpeed,
    projectileRadius: 8,
    projectileLifespan: 1500,
    color: 0x888888,
  },

  // Grenade - splash damage, good vs groups
  grenade: {
    id: 'grenade',
    damage: WEAPON_STATS.grenade.damage,
    range: WEAPON_STATS.grenade.range,
    cooldown: WEAPON_STATS.grenade.cooldown,
    projectileSpeed: WEAPON_STATS.grenade.projectileSpeed,
    projectileRadius: 6,
    projectileLifespan: 1500,
    splashRadius: WEAPON_STATS.grenade.splashRadius,
    splashDamageFalloff: 0.4,
    color: 0x44ff44,
  },

  // Railgun - instant hitscan, pierces targets
  railgun: {
    id: 'railgun',
    damage: WEAPON_STATS.railgun.damage,
    range: WEAPON_STATS.railgun.range,
    cooldown: WEAPON_STATS.railgun.cooldown,
    beamDuration: WEAPON_STATS.railgun.beamDuration,
    beamWidth: WEAPON_STATS.railgun.beamWidth,
    color: 0x00ffff,
    piercing: true,
  },

  // Burst rifle - fires 3 shots in quick succession
  burstRifle: {
    id: 'burstRifle',
    damage: WEAPON_STATS.burstRifle.damage,
    range: WEAPON_STATS.burstRifle.range,
    cooldown: WEAPON_STATS.burstRifle.cooldown,
    projectileSpeed: WEAPON_STATS.burstRifle.projectileSpeed,
    projectileRadius: 4,
    projectileLifespan: 500,
    burstCount: WEAPON_STATS.burstRifle.burstCount,
    burstDelay: WEAPON_STATS.burstRifle.burstDelay,
    color: 0xff88ff,
  },

  // D-gun - Commander's special weapon, destroys everything
  dgun: {
    id: 'dgun',
    damage: WEAPON_STATS.dgun.damage,
    range: WEAPON_STATS.dgun.range,
    cooldown: 0,
    projectileSpeed: WEAPON_STATS.dgun.projectileSpeed,
    projectileRadius: 25,
    projectileLifespan: 2000,
    color: 0xff8800,
    splashRadius: WEAPON_STATS.dgun.splashRadius,
    splashDamageFalloff: 0,
    piercing: true,
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
