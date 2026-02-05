import type { WeaponConfig } from './types';
import { WEAPON_STATS } from '../../config';

// Weapon configurations using values from config.ts
// Note: color is no longer used - colors are team-based in renderer
export const WEAPON_CONFIGS: Record<string, WeaponConfig> = {
  // Gatling - rapid fire small projectiles (Jackal's weapon)
  gatling: {
    id: 'gatling',
    audioId: 'minigun',
    damage: WEAPON_STATS.gatling.damage,
    range: WEAPON_STATS.gatling.range,
    cooldown: WEAPON_STATS.gatling.cooldown,
    projectileSpeed: WEAPON_STATS.gatling.projectileSpeed,
    projectileRadius: 2,
    projectileLifespan: 400,
    color: 0xffffff, // Not used - team colors applied
  },

  // Pulse - fires 3 shots in quick succession (Mantis's weapon)
  pulse: {
    id: 'pulse',
    audioId: 'burst-rifle',
    damage: WEAPON_STATS.pulse.damage,
    range: WEAPON_STATS.pulse.range,
    cooldown: WEAPON_STATS.pulse.cooldown,
    projectileSpeed: WEAPON_STATS.pulse.projectileSpeed,
    projectileRadius: 3,
    projectileLifespan: 500,
    burstCount: WEAPON_STATS.pulse.burstCount,
    burstDelay: WEAPON_STATS.pulse.burstDelay,
    color: 0xffffff,
  },

  // Beam - continuous beam, deals damage while on target (Strider's weapon)
  beam: {
    id: 'beam',
    audioId: 'beam',
    damage: WEAPON_STATS.beam.damage,
    range: WEAPON_STATS.beam.range,
    cooldown: WEAPON_STATS.beam.cooldown,
    beamDuration: WEAPON_STATS.beam.beamDuration,
    beamWidth: WEAPON_STATS.beam.beamWidth,
    turretTurnAccel: WEAPON_STATS.beam.turretTurnAccel,
    turretDrag: WEAPON_STATS.beam.turretDrag,
    color: 0xffffff,
  },

  // Shotgun - spread pellets, multiple pellets (Badger's weapon)
  shotgun: {
    id: 'shotgun',
    audioId: 'shotgun',
    damage: WEAPON_STATS.shotgun.damage,
    range: WEAPON_STATS.shotgun.range,
    cooldown: WEAPON_STATS.shotgun.cooldown,
    projectileSpeed: WEAPON_STATS.shotgun.projectileSpeed,
    projectileRadius: 4,
    projectileLifespan: 300,
    pelletCount: WEAPON_STATS.shotgun.pelletCount,
    spreadAngle: Math.PI / 5,
    color: 0xffffff,
  },

  // Mortar - splash damage artillery (Scorpion's weapon)
  mortar: {
    id: 'mortar',
    audioId: 'grenade',
    damage: WEAPON_STATS.mortar.damage,
    range: WEAPON_STATS.mortar.range,
    cooldown: WEAPON_STATS.mortar.cooldown,
    projectileSpeed: WEAPON_STATS.mortar.projectileSpeed,
    projectileRadius: 7,
    projectileLifespan: 2000,
    splashRadius: WEAPON_STATS.mortar.splashRadius,
    splashDamageFalloff: 0.4,
    color: 0xffffff,
  },

  // Railgun - instant hitscan, pierces targets (Viper's weapon)
  railgun: {
    id: 'railgun',
    audioId: 'railgun',
    damage: WEAPON_STATS.railgun.damage,
    range: WEAPON_STATS.railgun.range,
    cooldown: WEAPON_STATS.railgun.cooldown,
    beamDuration: WEAPON_STATS.railgun.beamDuration,
    beamWidth: WEAPON_STATS.railgun.beamWidth,
    color: 0xffffff,
    piercing: true,
  },

  // Cannon - slow, heavy projectile (Mammoth's weapon)
  cannon: {
    id: 'cannon',
    audioId: 'cannon',
    damage: WEAPON_STATS.cannon.damage,
    range: WEAPON_STATS.cannon.range,
    cooldown: WEAPON_STATS.cannon.cooldown,
    projectileSpeed: WEAPON_STATS.cannon.projectileSpeed,
    projectileRadius: 10,
    projectileLifespan: 1800,
    color: 0xffffff,
  },

  // Disruptor - Commander's special weapon, destroys everything
  disruptor: {
    id: 'disruptor',
    audioId: 'cannon',
    damage: WEAPON_STATS.disruptor.damage,
    range: WEAPON_STATS.disruptor.range,
    cooldown: 0,
    projectileSpeed: WEAPON_STATS.disruptor.projectileSpeed,
    projectileRadius: 25,
    projectileLifespan: 2000,
    color: 0xff8800,
    splashRadius: WEAPON_STATS.disruptor.splashRadius,
    splashDamageFalloff: 1, // Full damage at edge (no falloff)
    piercing: true,
  },

  // Sonic - Continuous pie-slice wave weapon (Cricket's weapon)
  // Damages all enemies within the slice, no projectiles created
  sonic: {
    id: 'sonic',
    audioId: 'sonic-wave',
    damage: WEAPON_STATS.sonic.damage,
    range: WEAPON_STATS.sonic.range,
    cooldown: WEAPON_STATS.sonic.cooldown,
    turretTurnAccel: WEAPON_STATS.sonic.turretTurnAccel,
    turretDrag: WEAPON_STATS.sonic.turretDrag,
    waveAngleIdle: WEAPON_STATS.sonic.waveAngleIdle,
    waveAngleAttack: WEAPON_STATS.sonic.waveAngleAttack,
    waveTransitionTime: WEAPON_STATS.sonic.waveTransitionTime,
    pullPower: WEAPON_STATS.sonic.pullPower,
    isWaveWeapon: true,
    color: 0xffffff,
  },

  // Widow's beam lasers - extended range continuous beams
  widowBeam: {
    id: 'widowBeam',
    audioId: 'beam',
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
    audioId: 'beam',
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
    audioId: 'sonic-wave',
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
export function createWeaponConfig(base: Partial<WeaponConfig> & { id: string; audioId: WeaponConfig['audioId'] }): WeaponConfig {
  return {
    damage: 10,
    range: 100,
    cooldown: 1000,
    color: 0xffffff,
    ...base,
  };
}
