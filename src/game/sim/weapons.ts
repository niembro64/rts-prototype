import type { WeaponConfig } from './types';
import { WEAPON_STATS } from '../../config';

// Weapon configurations using values from config.ts
// Note: color is no longer used - colors are team-based in renderer
export const WEAPON_CONFIGS: Record<string, WeaponConfig> = {
  // Scout - rapid fire small projectiles
  scout: {
    id: 'scout',
    damage: WEAPON_STATS.scout.damage,
    range: WEAPON_STATS.scout.range,
    cooldown: WEAPON_STATS.scout.cooldown,
    projectileSpeed: WEAPON_STATS.scout.projectileSpeed,
    projectileRadius: 2,
    projectileLifespan: 400,
    color: 0xffffff, // Not used - team colors applied
  },

  // Burst - fires 3 shots in quick succession
  burst: {
    id: 'burst',
    damage: WEAPON_STATS.burst.damage,
    range: WEAPON_STATS.burst.range,
    cooldown: WEAPON_STATS.burst.cooldown,
    projectileSpeed: WEAPON_STATS.burst.projectileSpeed,
    projectileRadius: 3,
    projectileLifespan: 500,
    burstCount: WEAPON_STATS.burst.burstCount,
    burstDelay: WEAPON_STATS.burst.burstDelay,
    color: 0xffffff,
  },

  // Daddy - continuous beam, deals damage while on target (daddy long legs unit)
  daddy: {
    id: 'daddy',
    damage: WEAPON_STATS.daddy.damage,
    range: WEAPON_STATS.daddy.range,
    cooldown: WEAPON_STATS.daddy.cooldown,
    beamDuration: WEAPON_STATS.daddy.beamDuration,
    beamWidth: WEAPON_STATS.daddy.beamWidth,
    turretTurnAccel: WEAPON_STATS.daddy.turretTurnAccel,
    turretDrag: WEAPON_STATS.daddy.turretDrag,
    color: 0xffffff,
  },

  // Brawl - shotgun spread, multiple pellets
  brawl: {
    id: 'brawl',
    damage: WEAPON_STATS.brawl.damage,
    range: WEAPON_STATS.brawl.range,
    cooldown: WEAPON_STATS.brawl.cooldown,
    projectileSpeed: WEAPON_STATS.brawl.projectileSpeed,
    projectileRadius: 4,
    projectileLifespan: 300,
    pelletCount: WEAPON_STATS.brawl.pelletCount,
    spreadAngle: Math.PI / 5,
    color: 0xffffff,
  },

  // Shotgun - splash damage artillery
  shotgun: {
    id: 'shotgun',
    damage: WEAPON_STATS.shotgun.damage,
    range: WEAPON_STATS.shotgun.range,
    cooldown: WEAPON_STATS.shotgun.cooldown,
    projectileSpeed: WEAPON_STATS.shotgun.projectileSpeed,
    projectileRadius: 7,
    projectileLifespan: 2000,
    splashRadius: WEAPON_STATS.shotgun.splashRadius,
    splashDamageFalloff: 0.4,
    color: 0xffffff,
  },

  // Snipe - instant hitscan, pierces targets
  snipe: {
    id: 'snipe',
    damage: WEAPON_STATS.snipe.damage,
    range: WEAPON_STATS.snipe.range,
    cooldown: WEAPON_STATS.snipe.cooldown,
    beamDuration: WEAPON_STATS.snipe.beamDuration,
    beamWidth: WEAPON_STATS.snipe.beamWidth,
    color: 0xffffff,
    piercing: true,
  },

  // Tank - slow, heavy projectile
  tank: {
    id: 'tank',
    damage: WEAPON_STATS.tank.damage,
    range: WEAPON_STATS.tank.range,
    cooldown: WEAPON_STATS.tank.cooldown,
    projectileSpeed: WEAPON_STATS.tank.projectileSpeed,
    projectileRadius: 10,
    projectileLifespan: 1800,
    color: 0xffffff,
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
    splashDamageFalloff: 1, // Full damage at edge (no falloff)
    piercing: true,
  },

  // Insect - Continuous pie-slice wave weapon with expanding/contracting effect
  // Damages all enemies within the slice, no projectiles created
  insect: {
    id: 'insect',
    damage: WEAPON_STATS.insect.damage,
    range: WEAPON_STATS.insect.range,
    cooldown: WEAPON_STATS.insect.cooldown,
    turretTurnAccel: WEAPON_STATS.insect.turretTurnAccel,
    turretDrag: WEAPON_STATS.insect.turretDrag,
    waveAngleIdle: WEAPON_STATS.insect.waveAngleIdle,
    waveAngleAttack: WEAPON_STATS.insect.waveAngleAttack,
    waveTransitionTime: WEAPON_STATS.insect.waveTransitionTime,
    pullPower: WEAPON_STATS.insect.pullPower,
    isWaveWeapon: true,
    color: 0xffffff,
  },

  // Widow's beam lasers - extended range continuous beams
  widowBeam: {
    id: 'widowBeam',
    damage: WEAPON_STATS.widowBeam.damage,
    range: WEAPON_STATS.widowBeam.range,
    cooldown: WEAPON_STATS.widowBeam.cooldown,
    beamDuration: WEAPON_STATS.widowBeam.beamDuration,
    beamWidth: WEAPON_STATS.widowBeam.beamWidth,
    turretTurnAccel: WEAPON_STATS.widowBeam.turretTurnAccel,
    turretDrag: WEAPON_STATS.widowBeam.turretDrag,
    color: 0xffffff,
  },

  // Widow's center beam - 2x stats, mounted at head center
  widowCenterBeam: {
    id: 'widowCenterBeam',
    damage: WEAPON_STATS.widowCenterBeam.damage,
    range: WEAPON_STATS.widowCenterBeam.range,
    cooldown: WEAPON_STATS.widowCenterBeam.cooldown,
    beamDuration: WEAPON_STATS.widowCenterBeam.beamDuration,
    beamWidth: WEAPON_STATS.widowCenterBeam.beamWidth,
    turretTurnAccel: WEAPON_STATS.widowCenterBeam.turretTurnAccel,
    turretDrag: WEAPON_STATS.widowCenterBeam.turretDrag,
    color: 0xffffff,
  },

  // Widow's sonic wave - larger and wider than insect's wave
  widowSonic: {
    id: 'widowSonic',
    damage: WEAPON_STATS.widowSonic.damage,
    range: WEAPON_STATS.widowSonic.range,
    cooldown: WEAPON_STATS.widowSonic.cooldown,
    turretTurnAccel: WEAPON_STATS.widowSonic.turretTurnAccel,
    turretDrag: WEAPON_STATS.widowSonic.turretDrag,
    waveAngleIdle: WEAPON_STATS.widowSonic.waveAngleIdle,
    waveAngleAttack: WEAPON_STATS.widowSonic.waveAngleAttack,
    waveTransitionTime: WEAPON_STATS.widowSonic.waveTransitionTime,
    pullPower: WEAPON_STATS.widowSonic.pullPower,
    isWaveWeapon: true,
    color: 0xffffff,
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
