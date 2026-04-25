/**
 * Projectile Blueprints
 *
 * Static data for all projectile types.
 * Moved from PROJECTILE_STATS in config.ts.
 */

const beam_width: number = 4.8;

const beam_recoil: number = 2000;

import { AUDIO, harmonicSeries } from '../../../audioConfig';
import type { ShotBlueprint, BeamShotBlueprint } from './types';

// Generate beam shot blueprints for all harmonic series indices
// Index 0 = most powerful (lowest pitch, biggest beam), index 13 = weakest (highest pitch, smallest)
function generateBeamShots(): Record<string, BeamShotBlueprint> {
  const result: Record<string, BeamShotBlueprint> = {};

  for (let i = 0; i < harmonicSeries.length; i++) {
    const dps = 30;

    result[`beamShot${i}`] = {
      type: 'beam',
      id: `beamShot${i}`,
      dps,
      force: 2000,
      recoil: beam_recoil,
      radius: beam_width / 2,
      width: beam_width,
      hitSound: AUDIO.event.hit[`beamShot${i}`],
    };
  }
  return result;
}

export const SHOT_BLUEPRINTS: Record<string, ShotBlueprint> = {
  lightShot: {
    type: 'projectile',
    id: 'lightShot',
    mass: 3,
    collision: { radius: 1.6, damage: 2 },
    explosion: {
      primary: { radius: 5, damage: 2, force: 500 },
      secondary: { radius: 7, damage: 0.4, force: 500 },
    },
    splashOnExpiry: false,
    lifespan: 1200,
    hitSound: AUDIO.event.hit.lightShot,
  },
  mediumShot: {
    type: 'projectile',
    id: 'mediumShot',
    mass: 8,
    collision: { radius: 2.2, damage: 6 },
    explosion: {
      primary: { radius: 8, damage: 6, force: 1000 },
      secondary: { radius: 15, damage: 1.2, force: 1000 },
    },
    splashOnExpiry: false,
    lifespan: 2000,
    hitSound: AUDIO.event.hit.mediumShot,
  },
  // Rocket-class projectile. Flies in a straight line on pure thrust
  // (ignoresGravity=true) and is bent only by homing — every salvo-
  // rocket turret pairs this shot with a homingTurnRate so the rocket
  // tracks its locked target. splashOnExpiry=true gives the volley a
  // "dumb-fire detonates at end of lifespan" fallback when the seeker
  // loses lock (target dies mid-flight).
  lightRocket: {
    type: 'projectile',
    id: 'lightRocket',
    mass: 8,
    collision: { radius: 2.5, damage: 3 },
    explosion: {
      primary: { radius: 10, damage: 4, force: 800 },
      secondary: { radius: 18, damage: 1, force: 800 },
    },
    splashOnExpiry: true,
    lifespan: 5500,
    ignoresGravity: true,
    // Render as a velocity-aligned cylinder (purely cosmetic — sim
    // collision is still sphere-based via collision.radius).
    shape: 'cylinder',
    cylinderShape: {
      lengthMult: 4.0,
      diameterMult: 0.5,
    },
    smokeTrail: {
      emitIntervalMs: 30,   // ~33 puffs/sec at max LOD
      lifespanMs: 1400,     // each puff lingers ~1.4s
      startRadius: 1.5,
      endRadius: 8.0,
      startAlpha: 0.75,
      color: 0xcccccc,
    },
    hitSound: AUDIO.event.hit.lightRocket,
  },
  heavyShot: {
    type: 'projectile',
    id: 'heavyShot',
    mass: 30.0,
    collision: { radius: 4, damage: 100 },
    explosion: {
      primary: { radius: 25, damage: 100, force: 7_000 },
      secondary: { radius: 45, damage: 70, force: 7_000 },
    },
    splashOnExpiry: true,
    lifespan: 3000,
    hitSound: AUDIO.event.hit.heavyShot,
  },
  mortarShot: {
    type: 'projectile',
    id: 'mortarShot',
    // Mortar is a pure carrier: it does no damage of its own and has
    // no splash explosion. Its only job is to fly to a point and
    // release submunitions on impact / lifespan expiry. All damage
    // comes from the lightShot fragments sprayed below.
    mass: 30,
    collision: { radius: 7, damage: 0 },
    splashOnExpiry: true,
    lifespan: 5000,
    hitSound: AUDIO.event.hit.mortarShot,
    submunitions: {
      shotId: 'lightShot',
      count: 15,
      speed: 100,
    },
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
    recoil: beam_recoil, // mass * launchForce
    radius: beam_width / 2,
    width: beam_width,
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
