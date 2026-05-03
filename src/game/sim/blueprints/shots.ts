/**
 * Projectile Blueprints
 *
 * Static data for all projectile types.
 * Moved from PROJECTILE_STATS in config.ts.
 */

import { AUDIO } from '../../../audioConfig';
import type { ShotBlueprint } from './types';

const BEAM_WIDTH = 6;
const BEAM_RECOIL_AND_HIT_FORCE = 3000;
const FIRE_EXPLOSION_RADIUS_MULTIPLIER = 3;
const BEAM_DAMAGE_SPHERE_RADIUS = BEAM_WIDTH * 1.5;

const SHOT_MASS_LIGHT: number = 4;
const SHOT_MASS_MEDIUM: number = 10;
const SHOT_MASS_HEAVY: number = 30;

export const SHOT_BLUEPRINTS: Record<string, ShotBlueprint> = {
  lightShot: {
    type: 'projectile',
    id: 'lightShot',
    mass: SHOT_MASS_LIGHT,
    collision: { radius: 1.6 },
    // Single boolean explosion sphere. Anything whose shot collider
    // intersects this radius takes the FULL damage and force; nothing
    // outside it. No falloff. Trim the radius down if shots feel too
    // generous now that there's no near-zone bonus.
    explosion: {
      radius: 5 * FIRE_EXPLOSION_RADIUS_MULTIPLIER,
      damage: 6,
      force: 500,
    },
    detonateOnExpiry: true,
    lifespan: 10_000,
    hitSound: AUDIO.event.hit.lightShot,
  },
  mediumShot: {
    type: 'projectile',
    id: 'mediumShot',
    mass: SHOT_MASS_MEDIUM,
    collision: { radius: 2.2 },
    explosion: {
      radius: 8 * FIRE_EXPLOSION_RADIUS_MULTIPLIER,
      damage: 12,
      force: 1000,
    },
    detonateOnExpiry: true,
    lifespan: 10_000,
    hitSound: AUDIO.event.hit.mediumShot,
  },
  // Rocket-class projectile. Flies in a straight line on pure thrust
  // (ignoresGravity=true) and is bent only by homing — `homingTurnRate`
  // is a property of the rocket itself (yaw rad/sec the rocket can
  // bend toward its target), not of the turret that fires it. Any
  // turret that fires this shot produces a rocket that turns at this
  // rate. detonateOnExpiry=true gives the volley a "dumb-fire
  // detonates at end of lifespan" fallback when the seeker loses
  // lock (target dies mid-flight).
  lightRocket: {
    type: 'projectile',
    id: 'lightRocket',
    mass: SHOT_MASS_MEDIUM,
    collision: { radius: 2.5 },
    explosion: {
      radius: 10 * FIRE_EXPLOSION_RADIUS_MULTIPLIER,
      damage: 4,
      force: 800,
    },
    detonateOnExpiry: true,
    lifespan: 5500,
    ignoresGravity: true,
    homingTurnRate: 1,
    // Render as a velocity-aligned cylinder (purely cosmetic — sim
    // collision is still sphere-based via collision.radius).
    shape: 'cylinder',
    cylinderShape: {
      lengthMult: 2.0,
      diameterMult: 0.3,
    },
    smokeTrail: {
      emitIntervalMs: 30, // ~33 puffs/sec at max LOD
      lifespanMs: 1400, // each puff lingers ~1.4s
      startRadius: 0.5,
      endRadius: 8.0,
      startAlpha: 0.9,
      color: 0xcccccc,
    },
    hitSound: AUDIO.event.hit.lightRocket,
  },
  heavyShot: {
    type: 'projectile',
    id: 'heavyShot',
    mass: SHOT_MASS_HEAVY,
    collision: { radius: 4 },
    explosion: {
      radius: 25 * FIRE_EXPLOSION_RADIUS_MULTIPLIER,
      damage: 150,
      force: 7_000,
    },
    detonateOnExpiry: true,
    lifespan: 10_000,
    hitSound: AUDIO.event.hit.heavyShot,
  },
  // Cluster mortar — carries `mortarShot`s as submunitions. The
  // outer carrier follows its turret's selected arc and detonates on
  // impact / lifespan expiry; each spawned child is a mortarShot, so
  // it then runs mortarShot's own submunition chain (5 mediumShot
  // fragments) when it lands. Net effect: one trigger pull creates
  // 5 mortar bursts spread around the impact zone.
  mortarShot: {
    type: 'projectile',
    id: 'mortarShot',
    // Mortar is a pure carrier: it does no damage of its own and has
    // no splash explosion. Its only job is to fly to a point and
    // release submunitions on impact / lifespan expiry. All damage
    // comes from the mediumShot fragments sprayed below.
    mass: SHOT_MASS_MEDIUM * 3,
    collision: { radius: 4 },
    detonateOnExpiry: true,
    lifespan: 2000,
    // Per projectile instance, roll max lifespan within +/-20% of lifespan.
    lifespanVariance: 0.2,
    hitSound: AUDIO.event.hit.mortarShot,
    submunitions: {
      shotId: 'heavyShot',
      count: 3,
      // Wide horizontal sweep, lower vertical jitter so fragments
      // arc outward instead of fountaining mostly upward. Bump
      // horizontal for a wider fan, vertical for a more chaotic
      // mix of launch angles.
      randomSpreadSpeedHorizontal: 20,
      randomSpreadSpeedVertical: 20,
      // Soft bounce — submunitions retain 40% of the carrier's
      // reflected velocity so the burst still reads as a bounce off
      // the surface, without launching the fragments so far that
      // they leave the AOE the player expected. Tune up toward 1.0
      // for a more energetic bounce, down toward 0.0 to absorb the
      // momentum entirely.
      reflectedVelocityDamper: 0.4,
    },
  },
  advancedMortarShot: {
    type: 'projectile',
    id: 'advancedMortarShot',
    // Same physics profile as a single mortarShot — pure carrier, no
    // damage of its own, no splash. Slightly heavier so the arc
    // matches a "bigger payload" look.
    mass: SHOT_MASS_MEDIUM * 9,
    collision: { radius: 6 },
    detonateOnExpiry: true,
    lifespan: 2000,
    // Per projectile instance, roll max lifespan within +/-20% of lifespan.
    lifespanVariance: 0.2,
    hitSound: AUDIO.event.hit.advancedMortarShot,
    submunitions: {
      shotId: 'mortarShot',
      count: 3,
      // Wide horizontal sweep so the mortar children spread
      // around the carrier's ground impact, not stack on top of
      // each other. Vertical kick keeps them lofted long enough
      // to land in a ring around the original aim point.
      randomSpreadSpeedHorizontal: 20,
      randomSpreadSpeedVertical: 20,
      reflectedVelocityDamper: 0.4,
    },
  },
  disruptorShot: {
    type: 'projectile',
    id: 'disruptorShot',
    mass: 20,
    collision: { radius: 25 },
    explosion: {
      radius: 40 * FIRE_EXPLOSION_RADIUS_MULTIPLIER,
      damage: 999999,
      force: 2499750,
    },
    detonateOnExpiry: true,
    lifespan: 2000,
    hitSound: AUDIO.event.hit.disruptorShot,
  },
  laserShot: {
    type: 'laser',
    id: 'laserShot',
    dps: 10 / (300 / 1000), // collision.damage / (beamDuration/1000) ≈ 33.3 dps
    force: BEAM_RECOIL_AND_HIT_FORCE,
    recoil: BEAM_RECOIL_AND_HIT_FORCE,
    radius: BEAM_WIDTH / 2,
    width: BEAM_WIDTH,
    damageSphere: { radius: BEAM_DAMAGE_SPHERE_RADIUS },
    duration: 300,
    hitSound: AUDIO.event.hit.laserShot,
  },
  beamShot: {
    type: 'beam',
    id: 'beamShot',
    dps: 30,
    force: BEAM_RECOIL_AND_HIT_FORCE,
    recoil: BEAM_RECOIL_AND_HIT_FORCE,
    radius: BEAM_WIDTH / 2,
    width: BEAM_WIDTH,
    damageSphere: { radius: BEAM_DAMAGE_SPHERE_RADIUS },
    hitSound: AUDIO.event.hit.beamShot,
  },
  // megaBeam — beefy single-emitter beam used by the widow head and
  // any future "boss" beam mounts. Higher dps and a thicker beam,
  // same recoil so it doesn't shove the host unit harder than the
  // standard beams already do.
  megaBeamShot: {
    type: 'beam',
    id: 'megaBeamShot',
    dps: 90,
    force: 4000,
    recoil: BEAM_RECOIL_AND_HIT_FORCE,
    radius: BEAM_WIDTH,
    width: BEAM_WIDTH * 2,
    damageSphere: { radius: BEAM_DAMAGE_SPHERE_RADIUS * 1.6 },
    hitSound: AUDIO.event.hit.megaBeamShot,
  },
};

export function getShotBlueprint(id: string): ShotBlueprint {
  const shotBlueprint = SHOT_BLUEPRINTS[id];
  if (!shotBlueprint) throw new Error(`Unknown projectile blueprint: ${id}`);
  return shotBlueprint;
}

for (const [id, blueprint] of Object.entries(SHOT_BLUEPRINTS)) {
  if (blueprint.id !== id) {
    throw new Error(`Shot blueprint key/id mismatch: ${id} contains ${blueprint.id}`);
  }
}
