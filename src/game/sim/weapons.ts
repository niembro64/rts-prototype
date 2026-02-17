import type { WeaponConfig } from './types';
import { WEAPON_STATS, PROJECTILE_STATS } from '../../config';

type ProjectileKey = keyof typeof PROJECTILE_STATS;

/** Map PROJECTILE_STATS fields → WeaponConfig fields (renamed where needed) */
function getProjectileConfig(key: ProjectileKey) {
  const p = PROJECTILE_STATS[key];
  return {
    damage: p.damage,
    ...('speed' in p && { projectileSpeed: p.speed }),
    ...('mass' in p && { projectileMass: p.mass }),
    ...('radius' in p && { projectileRadius: p.radius }),
    ...('lifespan' in p && { projectileLifespan: p.lifespan }),
    ...('splashRadius' in p && { splashRadius: p.splashRadius }),
    ...('piercing' in p && { piercing: p.piercing }),
    ...('beamDuration' in p && { beamDuration: p.beamDuration }),
    ...('beamWidth' in p && { beamWidth: p.beamWidth }),
  };
}

// Union type of all registered weapon config keys
export type WeaponId = 'gatling' | 'pulse' | 'beam' | 'shotgun' | 'mortar' | 'railgun'
  | 'cannon' | 'disruptor' | 'forceField' | 'megaBeam' | 'megaForceField';

const ws = WEAPON_STATS;

// Weapon configurations — merges PROJECTILE_STATS + WEAPON_STATS into flat WeaponConfig
export const WEAPON_CONFIGS: Record<WeaponId, WeaponConfig> = {
  gatling: {
    id: 'gatling',
    ...getProjectileConfig(ws.gatling.projectile),
    audioId: ws.gatling.audioId,
    range: ws.gatling.range,
    cooldown: ws.gatling.cooldown,
    color: 0xffffff,
  },

  pulse: {
    id: 'pulse',
    ...getProjectileConfig(ws.pulse.projectile),
    audioId: ws.pulse.audioId,
    range: ws.pulse.range,
    cooldown: ws.pulse.cooldown,
    burstCount: ws.pulse.burstCount,
    burstDelay: ws.pulse.burstDelay,
    color: 0xffffff,
  },

  beam: {
    id: 'beam',
    ...getProjectileConfig(ws.beam.projectile),
    audioId: ws.beam.audioId,
    range: ws.beam.range,
    cooldown: ws.beam.cooldown,
    turretTurnAccel: ws.beam.turretTurnAccel,
    turretDrag: ws.beam.turretDrag,
    color: 0xffffff,
  },

  shotgun: {
    id: 'shotgun',
    ...getProjectileConfig(ws.shotgun.projectile),
    audioId: ws.shotgun.audioId,
    range: ws.shotgun.range,
    cooldown: ws.shotgun.cooldown,
    pelletCount: ws.shotgun.pelletCount,
    spreadAngle: ws.shotgun.spreadAngle,
    color: 0xffffff,
  },

  mortar: {
    id: 'mortar',
    ...getProjectileConfig(ws.mortar.projectile),
    audioId: ws.mortar.audioId,
    range: ws.mortar.range,
    cooldown: ws.mortar.cooldown,
    color: 0xffffff,
  },

  railgun: {
    id: 'railgun',
    ...getProjectileConfig(ws.railgun.projectile),
    audioId: ws.railgun.audioId,
    range: ws.railgun.range,
    cooldown: ws.railgun.cooldown,
    color: 0xffffff,
  },

  cannon: {
    id: 'cannon',
    ...getProjectileConfig(ws.cannon.projectile),
    audioId: ws.cannon.audioId,
    range: ws.cannon.range,
    cooldown: ws.cannon.cooldown,
    color: 0xffffff,
  },

  disruptor: {
    id: 'disruptor',
    ...getProjectileConfig(ws.disruptor.projectile),
    audioId: ws.disruptor.audioId,
    range: ws.disruptor.range,
    cooldown: ws.disruptor.cooldown,
    color: 0xff8800,
  },

  // Force fields — no projectile, all fields from WEAPON_STATS directly
  forceField: {
    id: 'forceField',
    audioId: ws.forceField.audioId,
    damage: ws.forceField.damage,
    range: ws.forceField.forceFieldOuterRadius,
    forceFieldInnerRange: ws.forceField.forceFieldInnerRadius,
    forceFieldMiddleRadius: ws.forceField.forceFieldMiddleRadius,
    cooldown: ws.forceField.cooldown,
    turretTurnAccel: ws.forceField.turretTurnAccel,
    turretDrag: ws.forceField.turretDrag,
    forceFieldAngle: ws.forceField.forceFieldAngle,
    forceFieldTransitionTime: ws.forceField.forceFieldTransitionTime,
    pullPower: ws.forceField.pullPower,
    isForceField: true,
    color: 0xffffff,
  },

  megaBeam: {
    id: 'megaBeam',
    ...getProjectileConfig(ws.megaBeam.projectile),
    audioId: ws.megaBeam.audioId,
    range: ws.megaBeam.range,
    cooldown: ws.megaBeam.cooldown,
    turretTurnAccel: ws.megaBeam.turretTurnAccel,
    turretDrag: ws.megaBeam.turretDrag,
    color: 0xffffff,
  },

  megaForceField: {
    id: 'megaForceField',
    audioId: ws.megaForceField.audioId,
    damage: ws.megaForceField.damage,
    range: ws.megaForceField.forceFieldOuterRadius,
    forceFieldInnerRange: ws.megaForceField.forceFieldInnerRadius,
    forceFieldMiddleRadius: ws.megaForceField.forceFieldMiddleRadius,
    cooldown: ws.megaForceField.cooldown,
    turretTurnAccel: ws.megaForceField.turretTurnAccel,
    turretDrag: ws.megaForceField.turretDrag,
    forceFieldAngle: ws.megaForceField.forceFieldAngle,
    forceFieldTransitionTime: ws.megaForceField.forceFieldTransitionTime,
    pullPower: ws.megaForceField.pullPower,
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
