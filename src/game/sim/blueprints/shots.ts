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
    const secondaryDamage = Math.max(1, Math.round(baseDamage * 0.2));
    const collisionRadius = Math.max(2, Math.round(2 + 18 * p));
    const primaryRadius = Math.max(4, Math.round(4 + 26 * p));
    const secondaryRadius = Math.max(15, Math.round(15 + 105 * p));
    result[`beamShot${i}`] = {
      id: `beamShot${i}`,
      mass: Math.max(0.01, Math.round((0.01 + 0.09 * p) * 100) / 100),
      collision: { radius: collisionRadius, damage: baseDamage },
      explosion: {
        primary: { radius: primaryRadius, damage: baseDamage, force: baseDamage * 250 },
        secondary: { radius: secondaryRadius, damage: secondaryDamage, force: secondaryDamage * 250 },
      },
      splashOnExpiry: false,
      beamWidth: Math.max(1, Math.round(1 + 9 * p)),
      hitSound: AUDIO.event.hit[`beamShot${i}`],
    };
  }
  return result;
}

export const SHOT_BLUEPRINTS: Record<string, ShotBlueprint> = {
  lightShot: {
    id: 'lightShot',
    mass: 0.3,
    collision: { radius: 1.2, damage: 2 },
    explosion: {
      primary: { radius: 5, damage: 2, force: 500 },
      secondary: { radius: 7, damage: 0.4, force: 100 },
    },
    splashOnExpiry: false,
    lifespan: 900,
    hitSound: AUDIO.event.hit.lightShot,
  },
  mediumShot: {
    id: 'mediumShot',
    mass: 3,
    collision: { radius: 2.2, damage: 4 },
    explosion: {
      primary: { radius: 8, damage: 4, force: 1000 },
      secondary: { radius: 15, damage: 0.8, force: 200 },
    },
    splashOnExpiry: false,
    lifespan: 600,
    hitSound: AUDIO.event.hit.mediumShot,
  },
  mortarShot: {
    id: 'mortarShot',
    mass: 2,
    collision: { radius: 3.4, damage: 30 },
    explosion: {
      primary: { radius: 70, damage: 30, force: 7500 },
      secondary: { radius: 110, damage: 6, force: 1500 },
    },
    splashOnExpiry: true,
    lifespan: 3000,
    hitSound: AUDIO.event.hit.mortarShot,
  },
  heavyShot: {
    id: 'heavyShot',
    mass: 200.0,
    collision: { radius: 5, damage: 260 },
    explosion: {
      primary: { radius: 25, damage: 260, force: 65000 },
      secondary: { radius: 45, damage: 52, force: 13000 },
    },
    splashOnExpiry: true,
    lifespan: 1800,
    hitSound: AUDIO.event.hit.heavyShot,
  },
  laserShot: {
    id: 'laserShot',
    mass: 0.05,
    collision: { radius: 2, damage: 10 },
    explosion: {
      primary: { radius: 8, damage: 10, force: 2500 },
      secondary: { radius: 15, damage: 2, force: 500 },
    },
    splashOnExpiry: false,
    piercing: false,
    beamDuration: 300,
    beamWidth: 2,
    hitSound: AUDIO.event.hit.laserShot,
  },
  ...generateBeamShots(),
  disruptorShot: {
    id: 'disruptorShot',
    mass: 20.0,
    collision: { radius: 25, damage: 9999 },
    explosion: {
      primary: { radius: 40, damage: 9999, force: 2499750 },
      secondary: { radius: 70, damage: 1999.8, force: 499950 },
    },
    splashOnExpiry: true,
    piercing: true,
    lifespan: 2000,
    hitSound: AUDIO.event.hit.disruptorShot,
  },
};

export function getShotBlueprint(id: string): ShotBlueprint {
  const bp = SHOT_BLUEPRINTS[id];
  if (!bp) throw new Error(`Unknown projectile blueprint: ${id}`);
  return bp;
}
