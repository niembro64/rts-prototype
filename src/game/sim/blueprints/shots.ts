/**
 * Projectile Blueprints
 *
 * Static data for all projectile types.
 * Moved from PROJECTILE_STATS in config.ts.
 */

import { AUDIO } from '../../../audioConfig';
import { isShotId, type ShotId } from '../../../types/blueprintIds';
import { createBeamShot } from './beamShotFactory';
import type { ShotBlueprint } from './types';

const BEAM_RECOIL_AND_HIT_FORCE = 200;
const FIRE_EXPLOSION_RADIUS_MULTIPLIER = 3;

const SHOT_MASS_LIGHT: number = 4;
const SHOT_MASS_MEDIUM: number = 10;
const SHOT_MASS_HEAVY: number = 30;

export const SHOT_BLUEPRINTS = {
  lightShot: {
    type: 'projectile',
    id: 'lightShot',
    mass: SHOT_MASS_LIGHT,
    collision: { radius: 2 },
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
    lifespan: 2_000,
    hitSound: AUDIO.event.hit.lightShot,
  },
  mediumShot: {
    type: 'projectile',
    id: 'mediumShot',
    mass: SHOT_MASS_MEDIUM,
    collision: { radius: 3 },
    explosion: {
      radius: 8 * FIRE_EXPLOSION_RADIUS_MULTIPLIER,
      damage: 12,
      force: 1000,
    },
    detonateOnExpiry: true,
    lifespan: 3_000,
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
    type: 'rocket',
    id: 'lightRocket',
    mass: SHOT_MASS_LIGHT,
    collision: { radius: 2.5 },
    explosion: {
      radius: 10 * FIRE_EXPLOSION_RADIUS_MULTIPLIER,
      damage: 10,
      force: 800,
    },
    detonateOnExpiry: true,
    lifespan: 4000,
    ignoresGravity: true,
    homingTurnRate: 1,
    // Render as a velocity-aligned cylinder (purely cosmetic — sim
    // collision is still sphere-based via collision.radius).
    shape: 'cylinder',
    cylinderShape: {
      lengthMult: 2.0,
      diameterMult: 0.4,
    },
    smokeTrail: {
      emitFramesSkip: 0, // every render frame at MAX; LOD raises this
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
    lifespan: 5_000,
    hitSound: AUDIO.event.hit.heavyShot,
  },
  // Mortar carrier. The turret fires this shot directly; it follows
  // the turret's selected ballistic arc and detonates on impact or
  // lifespan expiry, then releases the mediumShot submunitions below.
  mortarShot: {
    type: 'projectile',
    id: 'mortarShot',
    mass: SHOT_MASS_MEDIUM * 3,
    collision: { radius: 6 },
    // Mortars now behave like normal explosive projectiles first,
    // then release their mediumShot fragments from the same impact
    // point. The carrier splash gives a reliable central hit while
    // the children provide area pressure.
    explosion: {
      radius: 35 * FIRE_EXPLOSION_RADIUS_MULTIPLIER,
      damage: 100,
      force: 10_000,
    },
    detonateOnExpiry: true,
    lifespan: 5000,
    // Per projectile instance, roll max lifespan within +/-20% of lifespan.
    lifespanVariance: 0.2,
    hitSound: AUDIO.event.hit.mortarShot,
    submunitions: {
      shotId: 'mediumShot',
      count: 3,
      // Wide horizontal sweep, lower vertical jitter so submunitions
      // arc outward instead of fountaining mostly upward. Bump
      // horizontal for a wider fan, vertical for a more chaotic
      // mix of launch angles.
      randomSpreadSpeedHorizontal: 60,
      randomSpreadSpeedVertical: 50,
      // Soft bounce: submunitions retain 40% of the carrier's
      // reflected velocity so the burst still reads as a bounce off
      // the surface, without launching the fragments so far that
      // they leave the AOE the player expected. Tune up toward 1.0
      // for a more energetic bounce, down toward 0.0 to absorb the
      // momentum entirely.
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
  miniBeamShot: createBeamShot('miniBeamShot', {
    preset: 'mini',
    dps: 15,
    force: BEAM_RECOIL_AND_HIT_FORCE * 0.5,
    hitSound: AUDIO.event.hit.miniBeamShot,
  }),
  beamShot: createBeamShot('beamShot', {
    preset: 'base',
    dps: 30,
    force: BEAM_RECOIL_AND_HIT_FORCE,
    hitSound: AUDIO.event.hit.beamShot,
  }),
  // megaBeam: beefy single-emitter beam used by Widow's rear abdomen
  // mount and any future heavy beam mounts. Higher dps and a thicker
  // beam, with stronger force/recoil than the standard beam.
  megaBeamShot: createBeamShot('megaBeamShot', {
    preset: 'mega',
    dps: 300,
    force: BEAM_RECOIL_AND_HIT_FORCE * 10,
    hitSound: AUDIO.event.hit.megaBeamShot,
  }),
  // Tower beam — same physical shape, force/recoil, and audio as
  // megaBeamShot, but 10× the dps. Mounted on the static megaBeam
  // tower so its damage doesn't drift onto the Widow (which still fires
  // the regular megaBeamShot from its own megaBeamTurret).
  towerBeamShot: createBeamShot('towerBeamShot', {
    preset: 'mega',
    dps: 3000,
    force: BEAM_RECOIL_AND_HIT_FORCE * 10,
    hitSound: AUDIO.event.hit.megaBeamShot,
  }),
} satisfies Record<ShotId, ShotBlueprint>;

export function getShotBlueprint(id: string): ShotBlueprint {
  if (!isShotId(id)) throw new Error(`Unknown projectile blueprint: ${id}`);
  const shotBlueprint = SHOT_BLUEPRINTS[id];
  return shotBlueprint;
}

for (const [id, blueprint] of Object.entries(SHOT_BLUEPRINTS)) {
  if (blueprint.id !== id) {
    throw new Error(
      `Shot blueprint key/id mismatch: ${id} contains ${blueprint.id}`,
    );
  }
}
