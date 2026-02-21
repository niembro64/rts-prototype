/**
 * Projectile Blueprints
 *
 * Static data for all projectile types.
 * Moved from PROJECTILE_STATS in config.ts.
 */

import type { ProjectileBlueprint } from './types';

export const SHOT_BLUEPRINTS: Record<string, ProjectileBlueprint> = {
  lightShot: {
    id: 'lightShot',
    damage: 2,
    speed: 200,
    mass: 0.3,
    lifespan: 900,
    radius: 1.5,
    primaryDamageRadius: 5,
    secondaryDamageRadius: 7,
    splashOnExpiry: false,
    hitSound: { synth: 'heavy', volume: 0.2, playSpeed: 0.5 },
  },
  heavyShot: {
    id: 'heavyShot',
    damage: 4,
    speed: 300,
    mass: 5,
    radius: 4,
    lifespan: 600,
    primaryDamageRadius: 8,
    secondaryDamageRadius: 15,
    splashOnExpiry: false,
    hitSound: { synth: 'heavy', volume: 0.5, playSpeed: 0.2 },
  },
  mortarShot: {
    id: 'mortarShot',
    damage: 30,
    speed: 200,
    mass: 2,
    radius: 13,
    lifespan: 3000,
    primaryDamageRadius: 70,
    secondaryDamageRadius: 110,
    splashOnExpiry: true,
    hitSound: { synth: 'heavy', volume: 1.0, playSpeed: 0.1 },
  },
  cannonShot: {
    id: 'cannonShot',
    damage: 260,
    speed: 400,
    mass: 200.0,
    radius: 10,
    lifespan: 1800,
    primaryDamageRadius: 25,
    secondaryDamageRadius: 45,
    splashOnExpiry: true,
    hitSound: { synth: 'heavy', volume: 1.0, playSpeed: 0.05 },
  },
  laserShot: {
    id: 'laserShot',
    damage: 10,
    beamDuration: 300,
    beamWidth: 1,
    primaryDamageRadius: 8,
    secondaryDamageRadius: 15,
    splashOnExpiry: false,
    piercing: false,
    // hitForce: 0,
    // knockBackForce: 0,
    hitForce: 1000,
    knockBackForce: 1000,
    hitSound: { synth: 'sizzle', volume: 1.0, playSpeed: 1.0 },
  },
  beamShot: {
    id: 'beamShot',
    damage: 10,
    beamWidth: 4,
    collisionRadius: 8,
    primaryDamageRadius: 12,
    secondaryDamageRadius: 60,
    splashOnExpiry: false,
    hitForce: 1000,
    knockBackForce: 1000,
    hitSound: { synth: 'sizzle', volume: 1.0, playSpeed: 1.0 },
  },

  disruptorShot: {
    id: 'disruptorShot',
    damage: 9999,
    speed: 350,
    mass: 20.0,
    radius: 25,
    lifespan: 2000,
    primaryDamageRadius: 40,
    secondaryDamageRadius: 70,
    splashOnExpiry: true,
    piercing: true,
    hitSound: { synth: 'heavy', volume: 1.0, playSpeed: 1.0 },
  },
};

export function getShotBlueprint(id: string): ProjectileBlueprint {
  const bp = SHOT_BLUEPRINTS[id];
  if (!bp) throw new Error(`Unknown projectile blueprint: ${id}`);
  return bp;
}
