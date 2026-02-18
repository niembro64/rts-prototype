import type { WeaponConfig, ForceFieldZoneConfig } from './types';
import { WEAPON_STATS, PROJECTILE_STATS, RANGE_MULTIPLIERS } from '../../config';

type ProjectileKey = keyof typeof PROJECTILE_STATS;

/** Compute a ForceFieldZoneConfig from ratio-based stats and weapon range */
function computeZoneConfig(
  zone: { innerRatio: number; outerRatio: number; color: number; alpha: number; particleAlpha: number; power: number; damage: number } | null | undefined,
  range: number
): ForceFieldZoneConfig | null {
  if (!zone) return null;
  return {
    innerRange: range * zone.innerRatio,
    outerRange: range * zone.outerRatio,
    color: zone.color,
    alpha: zone.alpha,
    particleAlpha: zone.particleAlpha,
    power: zone.power,
    damage: zone.damage,
  };
}

/** Map PROJECTILE_STATS fields → WeaponConfig fields (renamed where needed) */
function getProjectileConfig(key: ProjectileKey) {
  const p = PROJECTILE_STATS[key];
  return {
    damage: p.damage,
    ...('speed' in p && { projectileSpeed: p.speed }),
    ...('mass' in p && { projectileMass: p.mass }),
    ...('radius' in p && { projectileRadius: p.radius }),
    ...('lifespan' in p && { projectileLifespan: p.lifespan }),
    ...('primaryDamageRadius' in p && { primaryDamageRadius: p.primaryDamageRadius }),
    ...('secondaryDamageRadius' in p && { secondaryDamageRadius: p.secondaryDamageRadius }),
    ...('splashOnExpiry' in p && { splashOnExpiry: p.splashOnExpiry }),
    ...('piercing' in p && { piercing: p.piercing }),
    ...('beamDuration' in p && { beamDuration: p.beamDuration }),
    ...('beamWidth' in p && { beamWidth: p.beamWidth }),
    ...('collisionRadius' in p && { collisionRadius: p.collisionRadius }),
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
    rangeMultipliers: ws.gatling.rangeMultipliers,
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
    rangeMultipliers: ws.pulse.rangeMultipliers,
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
    rangeMultipliers: ws.beam.rangeMultipliers,
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
    rangeMultipliers: ws.shotgun.rangeMultipliers,
    color: 0xffffff,
  },

  mortar: {
    id: 'mortar',
    ...getProjectileConfig(ws.mortar.projectile),
    audioId: ws.mortar.audioId,
    range: ws.mortar.range,
    cooldown: ws.mortar.cooldown,
    rangeMultipliers: ws.mortar.rangeMultipliers,
    color: 0xffffff,
  },

  railgun: {
    id: 'railgun',
    ...getProjectileConfig(ws.railgun.projectile),
    audioId: ws.railgun.audioId,
    range: ws.railgun.range,
    cooldown: ws.railgun.cooldown,
    rangeMultipliers: ws.railgun.rangeMultipliers,
    color: 0xffffff,
  },

  cannon: {
    id: 'cannon',
    ...getProjectileConfig(ws.cannon.projectile),
    audioId: ws.cannon.audioId,
    range: ws.cannon.range,
    cooldown: ws.cannon.cooldown,
    rangeMultipliers: ws.cannon.rangeMultipliers,
    color: 0xffffff,
  },

  disruptor: {
    id: 'disruptor',
    ...getProjectileConfig(ws.disruptor.projectile),
    audioId: ws.disruptor.audioId,
    range: ws.disruptor.range,
    cooldown: ws.disruptor.cooldown,
    rangeMultipliers: ws.disruptor.rangeMultipliers,
    color: 0xff8800,
  },

  // Force fields — no projectile, all fields from WEAPON_STATS directly
  forceField: {
    id: 'forceField',
    audioId: ws.forceField.audioId,
    damage: Math.max(ws.forceField.push?.damage ?? 0, ws.forceField.pull?.damage ?? 0),
    range: ws.forceField.range,
    cooldown: ws.forceField.cooldown,
    turretTurnAccel: ws.forceField.turretTurnAccel,
    turretDrag: ws.forceField.turretDrag,
    forceFieldAngle: ws.forceField.forceFieldAngle,
    forceFieldTransitionTime: ws.forceField.forceFieldTransitionTime,
    isForceField: true,
    push: computeZoneConfig(ws.forceField.push, ws.forceField.range),
    pull: computeZoneConfig(ws.forceField.pull, ws.forceField.range),
    rangeMultipliers: ws.forceField.rangeMultipliers,
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
    rangeMultipliers: ws.megaBeam.rangeMultipliers,
    color: 0xffffff,
  },

  megaForceField: {
    id: 'megaForceField',
    audioId: ws.megaForceField.audioId,
    damage: Math.max(ws.megaForceField.push?.damage ?? 0, ws.megaForceField.pull?.damage ?? 0),
    range: ws.megaForceField.range,
    cooldown: ws.megaForceField.cooldown,
    turretTurnAccel: ws.megaForceField.turretTurnAccel,
    turretDrag: ws.megaForceField.turretDrag,
    forceFieldAngle: ws.megaForceField.forceFieldAngle,
    forceFieldTransitionTime: ws.megaForceField.forceFieldTransitionTime,
    isForceField: true,
    push: computeZoneConfig(ws.megaForceField.push, ws.megaForceField.range),
    pull: computeZoneConfig(ws.megaForceField.pull, ws.megaForceField.range),
    rangeMultipliers: ws.megaForceField.rangeMultipliers,
    color: 0xffffff,
  },
};

// Compute all range tiers for a weapon, using per-weapon overrides with global fallback
export function computeWeaponRanges(config: WeaponConfig) {
  const fireRange = config.range;
  const m = config.rangeMultipliers;
  return {
    seeRange:       fireRange * (m?.see ?? RANGE_MULTIPLIERS.see),
    fireRange,
    releaseRange:   fireRange * (m?.release ?? RANGE_MULTIPLIERS.release),
    lockRange:      fireRange * (m?.lock ?? RANGE_MULTIPLIERS.lock),
    fightstopRange: fireRange * (m?.fightstop ?? RANGE_MULTIPLIERS.fightstop),
  };
}

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
