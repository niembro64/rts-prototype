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
  const maxI = harmonicSeries.length - 1;
  for (let i = 0; i < harmonicSeries.length; i++) {
    const p = (maxI - i) / maxI; // 1.0 at i=0, 0.0 at i=13
    const dps = Math.round(20 + 60 * p);

    result[`beamShot${i}`] = {
      type: 'beam',
      id: `beamShot${i}`,
      dps,
      force: 2000,
      recoil: 10000,
      radius: 8,
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
    collision: { radius: 2.2, damage: 6 },
    explosion: {
      primary: { radius: 8, damage: 6, force: 1500 },
      secondary: { radius: 15, damage: 1.2, force: 300 },
    },
    splashOnExpiry: false,
    lifespan: 1000,
    hitSound: AUDIO.event.hit.mediumShot,
  },
  heavyShot: {
    type: 'projectile',
    id: 'heavyShot',
    mass: 30.0,
    collision: { radius: 4, damage: 80 },
    explosion: {
      primary: { radius: 25, damage: 350, force: 87500 },
      secondary: { radius: 45, damage: 70, force: 17500 },
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
  hippoShot: {
    type: 'projectile',
    id: 'hippoShot',
    mass: 6,
    collision: { radius: 2.5, damage: 20 },
    explosion: {
      primary: { radius: 8, damage: 20, force: 1200 },
      secondary: { radius: 12, damage: 5, force: 250 },
    },
    splashOnExpiry: false,
    lifespan: 1000,
    hitSound: AUDIO.event.hit.hippoShot,
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
