/**
 * Projectile Blueprints
 *
 * Static data for all projectile types.
 * Moved from PROJECTILE_STATS in config.ts.
 */

import { AUDIO, harmonicSeries } from '../../../audioConfig';
import type { ShotBlueprint } from './types';

// Generate beam shot blueprints for all harmonic series indices
// Index 0 = most powerful (lowest pitch, biggest beam), index 13 = weakest (highest pitch, smallest)
function generateBeamShots(): Record<string, ShotBlueprint> {
  const result: Record<string, ShotBlueprint> = {};
  const maxI = harmonicSeries.length - 1;
  for (let i = 0; i < harmonicSeries.length; i++) {
    const p = (maxI - i) / maxI; // 1.0 at i=0, 0.0 at i=13
    const baseDamage = Math.max(2, Math.round(2 + 28 * p));
    result[`beamShot${i}`] = {
      id: `beamShot${i}`,
      collisionDamage: baseDamage,
      primaryRadiusDamage: baseDamage,
      secondaryRadiusDamage: Math.max(1, Math.round(baseDamage * 0.2)),
      mass: Math.max(0.01, Math.round((0.01 + 0.09 * p) * 100) / 100),
      beamWidth: Math.max(1, Math.round(1 + 9 * p)),
      collisionRadius: Math.max(2, Math.round(2 + 18 * p)),
      primaryDamageRadius: Math.max(4, Math.round(4 + 26 * p)),
      secondaryDamageRadius: Math.max(15, Math.round(15 + 105 * p)),
      splashOnExpiry: false,
      hitSound: AUDIO.event.hit[`beamShot${i}`],
    };
  }
  return result;
}

export const SHOT_BLUEPRINTS: Record<string, ShotBlueprint> = {
  lightShot: {
    id: 'lightShot',
    collisionDamage: 2,
    primaryRadiusDamage: 2,
    secondaryRadiusDamage: 0.4,
    mass: 0.3,
    lifespan: 900,
    radius: 1.2,
    primaryDamageRadius: 5,
    secondaryDamageRadius: 7,
    splashOnExpiry: false,
    hitSound: AUDIO.event.hit.lightShot,
  },
  mediumShot: {
    id: 'mediumShot',
    collisionDamage: 4,
    primaryRadiusDamage: 4,
    secondaryRadiusDamage: 0.8,
    mass: 3,
    radius: 2.2,
    lifespan: 600,
    primaryDamageRadius: 8,
    secondaryDamageRadius: 15,
    splashOnExpiry: false,
    hitSound: AUDIO.event.hit.mediumShot,
  },
  mortarShot: {
    id: 'mortarShot',
    collisionDamage: 30,
    primaryRadiusDamage: 30,
    secondaryRadiusDamage: 6,
    mass: 2,
    radius: 3.4,
    lifespan: 3000,
    primaryDamageRadius: 70,
    secondaryDamageRadius: 110,
    splashOnExpiry: true,
    hitSound: AUDIO.event.hit.mortarShot,
  },
  heavyShot: {
    id: 'heavyShot',
    collisionDamage: 260,
    primaryRadiusDamage: 260,
    secondaryRadiusDamage: 52,
    mass: 200.0,
    radius: 5,
    lifespan: 1800,
    primaryDamageRadius: 25,
    secondaryDamageRadius: 45,
    splashOnExpiry: true,
    hitSound: AUDIO.event.hit.heavyShot,
  },
  laserShot: {
    id: 'laserShot',
    collisionDamage: 10,
    primaryRadiusDamage: 10,
    secondaryRadiusDamage: 2,
    mass: 0.05,
    beamDuration: 300,
    beamWidth: 2,
    primaryDamageRadius: 8,
    secondaryDamageRadius: 15,
    splashOnExpiry: false,
    piercing: false,
    hitSound: AUDIO.event.hit.laserShot,
  },
  ...generateBeamShots(),
  disruptorShot: {
    id: 'disruptorShot',
    collisionDamage: 9999,
    primaryRadiusDamage: 9999,
    secondaryRadiusDamage: 1999.8,
    mass: 20.0,
    radius: 25,
    lifespan: 2000,
    primaryDamageRadius: 40,
    secondaryDamageRadius: 70,
    splashOnExpiry: true,
    piercing: true,
    hitSound: AUDIO.event.hit.disruptorShot,
  },
};

export function getShotBlueprint(id: string): ShotBlueprint {
  const bp = SHOT_BLUEPRINTS[id];
  if (!bp) throw new Error(`Unknown projectile blueprint: ${id}`);
  return bp;
}
