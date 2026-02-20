import type { WeaponConfig, ForceFieldZoneConfig } from './types';
import { WEAPON_STATS, PROJECTILE_STATS, RANGE_MULTIPLIERS } from '../../config';

type ProjectileKey = keyof typeof PROJECTILE_STATS;

/** Compute a ForceFieldZoneConfig from ratio-based stats and weapon range */
function computeZoneConfig(
  zone: { innerRatio: number; outerRatio: number; color: number; alpha: number; particleAlpha: number; power: number | null; damage: number } | null | undefined,
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
    projectileType: key,
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
  | 'cannon' | 'disruptor' | 'forceField' | 'megaBeam' | 'megaForceField' | 'dgun';

const ws = WEAPON_STATS;

// Turret configurations — merges PROJECTILE_STATS + WEAPON_STATS into flat WeaponConfig
export const TURRET_CONFIGS: Record<WeaponId, WeaponConfig> = {
  gatling: {
    id: 'gatling',
    ...getProjectileConfig(ws.gatling.projectile),
    range: ws.gatling.range,
    cooldown: ws.gatling.cooldown,
    spreadAngle: ws.gatling.spreadAngle,
    turretTurnAccel: ws.gatling.turretTurnAccel,
    turretDrag: ws.gatling.turretDrag,
    turret: ws.gatling.turret,
    rangeMultiplierOverrides: ws.gatling.rangeMultiplierOverrides,
    color: 0xffffff,
  },

  pulse: {
    id: 'pulse',
    ...getProjectileConfig(ws.pulse.projectile),
    range: ws.pulse.range,
    cooldown: ws.pulse.cooldown,
    burstCount: ws.pulse.burstCount,
    burstDelay: ws.pulse.burstDelay,
    spreadAngle: ws.pulse.spreadAngle,
    turretTurnAccel: ws.pulse.turretTurnAccel,
    turretDrag: ws.pulse.turretDrag,
    turret: ws.pulse.turret,
    rangeMultiplierOverrides: ws.pulse.rangeMultiplierOverrides,
    color: 0xffffff,
  },

  beam: {
    id: 'beam',
    ...getProjectileConfig(ws.beam.projectile),
    range: ws.beam.range,
    cooldown: ws.beam.cooldown,
    turretTurnAccel: ws.beam.turretTurnAccel,
    turretDrag: ws.beam.turretDrag,
    turret: ws.beam.turret,
    rangeMultiplierOverrides: ws.beam.rangeMultiplierOverrides,
    color: 0xffffff,
  },

  shotgun: {
    id: 'shotgun',
    ...getProjectileConfig(ws.shotgun.projectile),
    range: ws.shotgun.range,
    cooldown: ws.shotgun.cooldown,
    pelletCount: ws.shotgun.pelletCount,
    spreadAngle: ws.shotgun.spreadAngle,
    homingTurnRate: ws.shotgun.homingTurnRate,
    turretTurnAccel: ws.shotgun.turretTurnAccel,
    turretDrag: ws.shotgun.turretDrag,
    turret: ws.shotgun.turret,
    rangeMultiplierOverrides: ws.shotgun.rangeMultiplierOverrides,
    color: 0xffffff,
  },

  mortar: {
    id: 'mortar',
    ...getProjectileConfig(ws.mortar.projectile),
    range: ws.mortar.range,
    cooldown: ws.mortar.cooldown,
    spreadAngle: ws.mortar.spreadAngle,
    turretTurnAccel: ws.mortar.turretTurnAccel,
    turretDrag: ws.mortar.turretDrag,
    turret: ws.mortar.turret,
    rangeMultiplierOverrides: ws.mortar.rangeMultiplierOverrides,
    color: 0xffffff,
  },

  railgun: {
    id: 'railgun',
    ...getProjectileConfig(ws.railgun.projectile),
    range: ws.railgun.range,
    cooldown: ws.railgun.cooldown,
    spreadAngle: ws.railgun.spreadAngle,
    turretTurnAccel: ws.railgun.turretTurnAccel,
    turretDrag: ws.railgun.turretDrag,
    turret: ws.railgun.turret,
    rangeMultiplierOverrides: ws.railgun.rangeMultiplierOverrides,
    color: 0xffffff,
  },

  cannon: {
    id: 'cannon',
    ...getProjectileConfig(ws.cannon.projectile),
    range: ws.cannon.range,
    cooldown: ws.cannon.cooldown,
    spreadAngle: ws.cannon.spreadAngle,
    turretTurnAccel: ws.cannon.turretTurnAccel,
    turretDrag: ws.cannon.turretDrag,
    turret: ws.cannon.turret,
    rangeMultiplierOverrides: ws.cannon.rangeMultiplierOverrides,
    color: 0xffffff,
  },

  disruptor: {
    id: 'disruptor',
    ...getProjectileConfig(ws.disruptor.projectile),
    range: ws.disruptor.range,
    cooldown: ws.disruptor.cooldown,
    turretTurnAccel: ws.disruptor.turretTurnAccel,
    turretDrag: ws.disruptor.turretDrag,
    turret: ws.disruptor.turret,
    rangeMultiplierOverrides: ws.disruptor.rangeMultiplierOverrides,
    color: 0xff8800,
  },

  // Force fields — no projectile, all fields from WEAPON_STATS directly
  forceField: {
    id: 'forceField',
    damage: Math.max(ws.forceField.push?.damage ?? 0, ws.forceField.pull?.damage ?? 0),
    range: ws.forceField.range,
    cooldown: ws.forceField.cooldown,
    turretTurnAccel: ws.forceField.turretTurnAccel,
    turretDrag: ws.forceField.turretDrag,
    forceFieldAngle: ws.forceField.forceFieldAngle,
    forceFieldTransitionTime: ws.forceField.forceFieldTransitionTime,
    turret: ws.forceField.turret,
    isForceField: true,
    push: computeZoneConfig(ws.forceField.push, ws.forceField.range),
    pull: computeZoneConfig(ws.forceField.pull, ws.forceField.range),
    rangeMultiplierOverrides: ws.forceField.rangeMultiplierOverrides,
    color: 0xffffff,
  },

  megaBeam: {
    id: 'megaBeam',
    ...getProjectileConfig(ws.megaBeam.projectile),
    range: ws.megaBeam.range,
    cooldown: ws.megaBeam.cooldown,
    turretTurnAccel: ws.megaBeam.turretTurnAccel,
    turretDrag: ws.megaBeam.turretDrag,
    turret: ws.megaBeam.turret,
    rangeMultiplierOverrides: ws.megaBeam.rangeMultiplierOverrides,
    color: 0xffffff,
  },

  megaForceField: {
    id: 'megaForceField',
    damage: Math.max(ws.megaForceField.push?.damage ?? 0, ws.megaForceField.pull?.damage ?? 0),
    range: ws.megaForceField.range,
    cooldown: ws.megaForceField.cooldown,
    turretTurnAccel: ws.megaForceField.turretTurnAccel,
    turretDrag: ws.megaForceField.turretDrag,
    forceFieldAngle: ws.megaForceField.forceFieldAngle,
    forceFieldTransitionTime: ws.megaForceField.forceFieldTransitionTime,
    turret: ws.megaForceField.turret,
    isForceField: true,
    push: computeZoneConfig(ws.megaForceField.push, ws.megaForceField.range),
    pull: computeZoneConfig(ws.megaForceField.pull, ws.megaForceField.range),
    rangeMultiplierOverrides: ws.megaForceField.rangeMultiplierOverrides,
    color: 0xffffff,
  },

  dgun: {
    id: 'dgun',
    ...getProjectileConfig(ws.disruptor.projectile),
    range: ws.disruptor.range,
    cooldown: ws.disruptor.cooldown,
    turretTurnAccel: ws.disruptor.turretTurnAccel,
    turretDrag: ws.disruptor.turretDrag,
    turret: ws.disruptor.turret,
    rangeMultiplierOverrides: ws.disruptor.rangeMultiplierOverrides,
    isManualFire: true,
    color: 0xff8800,
  },
};

// Compute all range tiers for a weapon, using per-weapon overrides with global fallback
export function computeWeaponRanges(config: WeaponConfig) {
  const fireRange = config.range;
  const m = config.rangeMultiplierOverrides;
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
  const config = TURRET_CONFIGS[id as WeaponId];
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
