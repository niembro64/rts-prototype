import type { WeaponConfig } from './types';
import { WEAPON_STATS } from '../../config';


// Union type of all registered weapon config keys
export type WeaponId = 'gatling' | 'pulse' | 'beam' | 'shotgun' | 'mortar' | 'railgun'
  | 'cannon' | 'disruptor' | 'forceField' | 'megaBeam' | 'megaForceField';

// Weapon configurations using values from config.ts
// Note: color is no longer used - colors are team-based in renderer
export const WEAPON_CONFIGS: Record<WeaponId, WeaponConfig> = {
  // Gatling - rapid fire small projectiles (Jackal's weapon)
  gatling: {
    id: 'gatling',
    audioId: 'minigun',
    damage: WEAPON_STATS.gatling.damage,
    range: WEAPON_STATS.gatling.range,
    cooldown: WEAPON_STATS.gatling.cooldown,
    projectileSpeed: WEAPON_STATS.gatling.projectileSpeed,
    projectileMass: WEAPON_STATS.gatling.projectileMass,
    projectileRadius: 2,
    projectileLifespan: 400,
    color: 0xffffff, // Not used - team colors applied
  },

  // Pulse - fires 3 shots in quick succession (Lynx's weapon)
  pulse: {
    id: 'pulse',
    audioId: 'burst-rifle',
    damage: WEAPON_STATS.pulse.damage,
    range: WEAPON_STATS.pulse.range,
    cooldown: WEAPON_STATS.pulse.cooldown,
    projectileSpeed: WEAPON_STATS.pulse.projectileSpeed,
    projectileMass: WEAPON_STATS.pulse.projectileMass,
    projectileRadius: 3,
    projectileLifespan: 500,
    burstCount: WEAPON_STATS.pulse.burstCount,
    burstDelay: WEAPON_STATS.pulse.burstDelay,
    color: 0xffffff,
  },

  // Beam - continuous beam, deals damage while on target (Daddy's weapon)
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
    projectileMass: WEAPON_STATS.shotgun.projectileMass,
    projectileRadius: 4,
    projectileLifespan: 300,
    pelletCount: WEAPON_STATS.shotgun.pelletCount,
    spreadAngle: WEAPON_STATS.shotgun.spreadAngle,
    color: 0xffffff,
  },

  // Mortar - splash damage artillery (Mongoose's weapon)
  mortar: {
    id: 'mortar',
    audioId: 'grenade',
    damage: WEAPON_STATS.mortar.damage,
    range: WEAPON_STATS.mortar.range,
    cooldown: WEAPON_STATS.mortar.cooldown,
    projectileSpeed: WEAPON_STATS.mortar.projectileSpeed,
    projectileMass: WEAPON_STATS.mortar.projectileMass,
    projectileRadius: 7,
    projectileLifespan: 2000,
    splashRadius: WEAPON_STATS.mortar.splashRadius,
    splashDamageFalloff: 0.4,
    color: 0xffffff,
  },

  // Railgun - instant hitscan, pierces targets (Recluse's weapon)
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
    projectileMass: WEAPON_STATS.cannon.projectileMass,
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
    projectileMass: WEAPON_STATS.disruptor.projectileMass,
    projectileRadius: 25,
    projectileLifespan: 2000,
    color: 0xff8800,
    splashRadius: WEAPON_STATS.disruptor.splashRadius,
    splashDamageFalloff: 1, // Full damage at edge (no falloff)
    piercing: true,
  },

  // Force field - Dual push/pull zones (Tarantula)
  // Inner zone (innerRadius→middleRadius) pushes outward
  // Outer zone (middleRadius→outerRadius) pulls inward
  forceField: {
    id: 'forceField',
    audioId: 'force-field',
    damage: WEAPON_STATS.forceField.damage,
    range: WEAPON_STATS.forceField.forceFieldOuterRadius,
    forceFieldInnerRange: WEAPON_STATS.forceField.forceFieldInnerRadius,
    forceFieldMiddleRadius: WEAPON_STATS.forceField.forceFieldMiddleRadius,
    cooldown: WEAPON_STATS.forceField.cooldown,
    turretTurnAccel: WEAPON_STATS.forceField.turretTurnAccel,
    turretDrag: WEAPON_STATS.forceField.turretDrag,
    forceFieldAngle: WEAPON_STATS.forceField.forceFieldAngle,
    forceFieldTransitionTime: WEAPON_STATS.forceField.forceFieldTransitionTime,
    pullPower: WEAPON_STATS.forceField.pullPower,
    isForceField: true,
    color: 0xffffff,
  },

  // Mega beam - heavy beam, mounted at head center (Widow)
  megaBeam: {
    id: 'megaBeam',
    audioId: 'beam',
    damage: WEAPON_STATS.megaBeam.damage,
    range: WEAPON_STATS.megaBeam.range,
    cooldown: WEAPON_STATS.megaBeam.cooldown,
    beamDuration: WEAPON_STATS.megaBeam.beamDuration,
    beamWidth: WEAPON_STATS.megaBeam.beamWidth,
    turretTurnAccel: WEAPON_STATS.megaBeam.turretTurnAccel,
    turretDrag: WEAPON_STATS.megaBeam.turretDrag,
    color: 0xffffff,
  },

  // Mega force field - Dual push/pull zones (Widow)
  megaForceField: {
    id: 'megaForceField',
    audioId: 'force-field',
    damage: WEAPON_STATS.megaForceField.damage,
    range: WEAPON_STATS.megaForceField.forceFieldOuterRadius,
    forceFieldInnerRange: WEAPON_STATS.megaForceField.forceFieldInnerRadius,
    forceFieldMiddleRadius: WEAPON_STATS.megaForceField.forceFieldMiddleRadius,
    cooldown: WEAPON_STATS.megaForceField.cooldown,
    turretTurnAccel: WEAPON_STATS.megaForceField.turretTurnAccel,
    turretDrag: WEAPON_STATS.megaForceField.turretDrag,
    forceFieldAngle: WEAPON_STATS.megaForceField.forceFieldAngle,
    forceFieldTransitionTime: WEAPON_STATS.megaForceField.forceFieldTransitionTime,
    pullPower: WEAPON_STATS.megaForceField.pullPower,
    isForceField: true,
    color: 0xffffff,
  },
};

// Helper to get a weapon config by ID
export function getWeaponConfig(id: string): WeaponConfig {
  const config = WEAPON_CONFIGS[id as WeaponId];
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
