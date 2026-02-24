/**
 * Projectile Blueprints
 *
 * Static data for all projectile types.
 * Moved from PROJECTILE_STATS in config.ts.
 */

import { AUDIO, harmonicSeries } from '../../../audioConfig';
import type { ShotBlueprint, BeamShotBlueprint } from './types';

// Generate beam shot blueprints for all harmonic series indices
// Index 0 = most powerful (lowest pitch, biggest beam), index 13 = weakest (highest pitch, smallest)
function generateBeamShots(): Record<string, BeamShotBlueprint> {
  const result: Record<string, BeamShotBlueprint> = {};
  for (let i = 0; i < harmonicSeries.length; i++) {
    const baseDps = 25;
    const beamRadius = 8;
    const beamForce = 2000;
    const recoil = 10000;

    result[`beamShot${i}`] = {
      type: 'beam',
      id: `beamShot${i}`,
      dps: baseDps,
      force: beamForce,
      recoil: recoil,
      radius: beamRadius,
      width: 5,
      hitSound: AUDIO.event.hit[`beamShot${i}`],
    };
  }
  return result;
}

export const SHOT_BLUEPRINTS: Record<string, ShotBlueprint> = {
  lightShot: {
    type: 'projectile',
    id: 'lightShot',
    mass: 2,
    collision: { radius: 1.6, damage: 2 },
    explosion: {
      primary: { radius: 5, damage: 2, force: 500 },
      secondary: { radius: 7, damage: 0.4, force: 100 },
    },
    splashOnExpiry: false,
    lifespan: 800,
    hitSound: AUDIO.event.hit.lightShot,
  },
  mediumShot: {
    type: 'projectile',
    id: 'mediumShot',
    mass: 8,
    collision: { radius: 2.2, damage: 4 },
    explosion: {
      primary: { radius: 8, damage: 4, force: 1000 },
      secondary: { radius: 15, damage: 0.8, force: 200 },
    },
    splashOnExpiry: false,
    lifespan: 1000,
    hitSound: AUDIO.event.hit.mediumShot,
  },
  heavyShot: {
    type: 'projectile',
    id: 'heavyShot',
    mass: 30.0,
    collision: { radius: 4, damage: 60 },
    explosion: {
      primary: { radius: 25, damage: 260, force: 65000 },
      secondary: { radius: 45, damage: 52, force: 13000 },
    },
    splashOnExpiry: true,
    lifespan: 1400,
    hitSound: AUDIO.event.hit.heavyShot,
  },
  mortarShot: {
    type: 'projectile',
    id: 'mortarShot',
    mass: 400,
    collision: { radius: 5, damage: 30 },
    explosion: {
      primary: { radius: 70, damage: 30, force: 7500 },
      secondary: { radius: 110, damage: 6, force: 1500 },
    },
    splashOnExpiry: true,
    lifespan: 2300,
    hitSound: AUDIO.event.hit.mortarShot,
  },
  disruptorShot: {
    type: 'projectile',
    id: 'disruptorShot',
    mass: 20.0,
    collision: { radius: 25, damage: 9999 },
    explosion: {
      primary: { radius: 40, damage: 10_000, force: 2499750 },
      secondary: { radius: 50, damage: 1000, force: 499950 },
    },
    splashOnExpiry: true,
    lifespan: 2000,
    hitSound: AUDIO.event.hit.disruptorShot,
  },
  laserShot: {
    type: 'laser',
    id: 'laserShot',
    dps: 10 / (300 / 1000), // collision.damage / (beamDuration/1000) ≈ 33.3 dps
    force: 2500,
    recoil: 2000, // mass * launchForce
    radius: 3,
    width: 2,
    duration: 300,
    hitSound: AUDIO.event.hit.laserShot,
  },
  ...generateBeamShots(),
};

export function getShotBlueprint(id: string): ShotBlueprint {
  const bp = SHOT_BLUEPRINTS[id];
  if (!bp) throw new Error(`Unknown projectile blueprint: ${id}`);
  return bp;
}
