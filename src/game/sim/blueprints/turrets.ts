/**
 * Weapon Blueprints
 *
 * Static data for all weapon types.
 * Merges WEAPON_STATS + turret visuals + audio from config.ts and audioConfig.ts.
 */

import {
  SPATIAL_GRID_CELL_SIZE,
  FORCE_FIELD_TURRET,
  FORCE_PUSH,
} from '../../../config';
import { AUDIO } from '../../../audioConfig';
import type { HysteresisRangeMultiplier } from '../../../types/sim';
import type { TurretBlueprint } from './types';

const COLOR_WHITE = 0xffffff;

/** Outer awareness shell for turrets that need to rotate toward
 *  enemies BEFORE the enemy enters fire range. Multiplied by the
 *  turret's base `range`, so 1.1/1.2 = 110% acquire / 120% release —
 *  strictly outside the standard 0.9/0.95 fire envelope. Currently
 *  used only by the mirror turret, which has to be already pointed
 *  when an incoming beam crosses its fire boundary. */
const RANGE_TRACK: HysteresisRangeMultiplier = {
  acquire: 1.1,
  release: 1.2,
};

const RANGE_FIRE_MAX: HysteresisRangeMultiplier = {
  acquire: 0.95,
  release: 1.0,
};

const RANGE_FIRE_MIN: HysteresisRangeMultiplier = {
  acquire: 0.4,
  release: 0.35,
};

function fireEnvelope(params: {
  engageRangeMin: HysteresisRangeMultiplier | null;
  trackingRange: HysteresisRangeMultiplier | null;
}): TurretBlueprint['rangeMultiplierOverrides'] {
  const { engageRangeMin, trackingRange } = params;

  return {
    engageRangeMax: { ...RANGE_FIRE_MAX },
    engageRangeMin: engageRangeMin ? { ...engageRangeMin } : null,
    trackingRange: trackingRange ? { ...trackingRange } : null,
  };
}

export const TURRET_BLUEPRINTS: Record<string, TurretBlueprint> = {
  lightTurret: {
    id: 'lightTurret',
    projectileId: 'lightShot',
    range: 120,
    cooldown: 450,
    launchForce: 456,
    turretTurnAccel: 200,
    turretDrag: 0.5,
    barrel: { type: 'simpleSingleBarrel', barrelLength: 0.5 },
    rangeMultiplierOverrides: fireEnvelope({
      engageRangeMin: null,
      trackingRange: null,
    }),
    eventsSmooth: false,
    color: COLOR_WHITE,
    spread: { angle: 0 },
    bodyRadius: 1,
    audio: { fireSound: AUDIO.event.fire.lightTurret },
    highArc: true,
  },
  // Salvo rocket pod — vertical-launch system. The turret is pinned
  // pointing straight up (verticalLauncher=true → turretSystem locks
  // pitch to π/2) so the original cone-cluster of barrels stays
  // visibly aimed at the sky, with the cluster spin still driven by
  // engagement state. Each volley fires 3 rockets straight up into
  // a random cone (`spread.angle` is the half-angle from vertical);
  // `lightRocket` ignores gravity so each rocket climbs on thrust,
  // then `homingTurnRate` bends them onto the acquired target.
  salvoRocketTurret: {
    id: 'salvoRocketTurret',
    projectileId: 'lightRocket',
    range: 360,
    cooldown: 2000,
    launchForce: 1500,
    turretTurnAccel: 20,
    turretDrag: 0.15,
    barrel: {
      type: 'coneMultiBarrel',
      barrelCount: 3,
      // Long tubes splayed out in a wide ~90° cone (45° per side from
      // the firing axis). `tipOrbit` is specified explicitly so the
      // visible barrel angles are decoupled from `spread.angle` — the
      // latter governs the random firing cone around vertical, and
      // the explicit value is no longer clamped by TURRET_HEIGHT.
      barrelLength: 0.5,
      baseOrbit: 0.01,
      tipOrbit: 0.5,
      depthScale: 0.02,
      spin: { idle: 2, max: 20, accel: 10, decel: 5 },
    },
    rangeMultiplierOverrides: fireEnvelope({
      engageRangeMin: RANGE_FIRE_MIN,
      trackingRange: null,
    }),
    eventsSmooth: false,
    color: COLOR_WHITE,
    // 90° max deviation from vertical — rockets launch anywhere from
    // straight up to horizontal; homing then bends each one onto the
    // target's line.
    spread: { angle: Math.PI / 2, pelletCount: 3 },
    // spread: { angle: Math.PI / 2, pelletCount: 1 },
    bodyRadius: 8,
    audio: { fireSound: AUDIO.event.fire.salvoRocketTurret },
    verticalLauncher: true,
  },
  cannonTurret: {
    id: 'cannonTurret',
    projectileId: 'heavyShot',
    range: 600,
    cooldown: 2300,
    launchForce: 30_000,
    turretTurnAccel: 200,
    turretDrag: 0.5,
    barrel: { type: 'simpleSingleBarrel', barrelLength: 1.4 },
    rangeMultiplierOverrides: fireEnvelope({
      engageRangeMin: RANGE_FIRE_MIN,
      trackingRange: null,
    }),
    eventsSmooth: false,
    color: COLOR_WHITE,
    spread: { angle: 0 },
    bodyRadius: 10,
    audio: { fireSound: AUDIO.event.fire.cannonTurret },
  },
  mortarTurret: {
    id: 'mortarTurret',
    projectileId: 'mortarShot',
    range: 600,
    cooldown: 6000,
    launchForce: 20_000,
    turretTurnAccel: 90,
    turretDrag: 0.4,
    barrel: { type: 'simpleSingleBarrel', barrelLength: 0.75 },
    rangeMultiplierOverrides: fireEnvelope({
      engageRangeMin: RANGE_FIRE_MIN,
      trackingRange: null,
    }),
    eventsSmooth: false,
    color: COLOR_WHITE,
    spread: { angle: 0 },
    bodyRadius: 9,
    audio: { fireSound: AUDIO.event.fire.mortarTurret },
    // Mortars lob — high-arc solution from the ballistic solver so
    // shells sail up and over whatever's in front of them.
    highArc: true,
    // Aim directly at the target point. mortarShot detonates on
    // ground impact and releases mediumShot fragments from there.
    groundAimFraction: 1.0,
  },
  pulseTurret: {
    id: 'pulseTurret',
    projectileId: 'mediumShot',
    range: 160,
    cooldown: 1_000,
    launchForce: 2_000,
    turretTurnAccel: 40,
    turretDrag: 0.15,
    barrel: {
      type: 'simpleMultiBarrel',
      barrelCount: 2,
      barrelLength: 1.7,
      orbitRadius: 0.35,
      depthScale: 0.1,
      spin: { idle: 2, max: 30, accel: 80, decel: 30 },
    },
    rangeMultiplierOverrides: fireEnvelope({
      engageRangeMin: null,
      trackingRange: null,
    }),
    eventsSmooth: true,
    color: COLOR_WHITE,
    spread: { angle: Math.PI / 8 },
    burst: { count: 4, delay: 100 },
    bodyRadius: 7,
    audio: { fireSound: AUDIO.event.fire.pulseTurret },
    highArc: false,
  },
  // Gatling mortar — multi-barrel rotating cluster that lobs
  // mortarShot carrier rounds. Each carrier releases 5 mediumShot
  // fragments on detonation, so the turret has high area pressure
  // without spawning a second nested cluster tier.
  gatlingMortarTurret: {
    id: 'gatlingMortarTurret',
    projectileId: 'mortarShot',
    range: 1000,
    cooldown: 200,
    launchForce: 8_000,
    turretTurnAccel: 80,
    turretDrag: 0.4,
    barrel: {
      type: 'simpleMultiBarrel',
      barrelCount: 6,
      barrelLength: 1.0,
      orbitRadius: 0.5,
      depthScale: 0.12,
      spin: { idle: 2, max: 18, accel: 80, decel: 10 },
    },
    rangeMultiplierOverrides: fireEnvelope({
      engageRangeMin: RANGE_FIRE_MIN,
      trackingRange: null,
    }),
    eventsSmooth: true,
    color: COLOR_WHITE,
    spread: { angle: 0 },
    bodyRadius: 14,
    audio: { fireSound: AUDIO.event.fire.gatlingMortarTurret },
    // Fast low-arc carrier. The submunitions do the area spread; a
    // high arc makes the carrier spend too long in flight for a gatling
    // role and amplifies recoil/moving-target error.
    highArc: true,
    // Aim directly at the target group; the carrier's fragment spray
    // creates the area coverage.
    groundAimFraction: 1.0,
  },
  hippoGatlingTurret: {
    id: 'hippoGatlingTurret',
    projectileId: 'mediumShot',
    range: 300,
    cooldown: 50,
    launchForce: 5_040,
    turretTurnAccel: 100,
    turretDrag: 0.4,
    barrel: {
      type: 'simpleMultiBarrel',
      barrelCount: 5,
      barrelLength: 0.8,
      orbitRadius: 0.4,
      depthScale: 0.1,
      spin: { idle: 2, max: 20, accel: 100, decel: 10 },
    },
    rangeMultiplierOverrides: fireEnvelope({
      engageRangeMin: RANGE_FIRE_MIN,
      trackingRange: null,
    }),
    eventsSmooth: true,
    color: COLOR_WHITE,
    spread: { angle: Math.PI / 16 },
    burst: { count: 1, delay: 80 },
    bodyRadius: 12,
    audio: { fireSound: AUDIO.event.fire.hippoGatlingTurret },
  },
  dgunTurret: {
    id: 'dgunTurret',
    projectileId: 'disruptorShot',
    range: 150,
    cooldown: 0,
    launchForce: 8_400,
    turretTurnAccel: 40,
    turretDrag: 0.15,
    barrel: {
      type: 'simpleSingleBarrel',
      barrelLength: 1.0,
      barrelThickness: 8,
    },
    isManualFire: true,
    rangeMultiplierOverrides: fireEnvelope({
      engageRangeMin: null,
      trackingRange: null,
    }),
    eventsSmooth: false,
    color: 0xff8800,
    bodyRadius: 7,
    audio: { fireSound: AUDIO.event.fire.dgunTurret },
  },
  mirrorTurret: {
    id: 'mirrorTurret',
    projectileId: 'beamShot',
    range: 300,
    turretTurnAccel: 60,
    turretDrag: 1,
    barrel: { type: 'simpleSingleBarrel', barrelLength: 0 },
    passive: true,
    spread: { angle: Math.PI / 2 },
    // Mirror turrets need to be already pointed when an enemy beam
    // arrives, so they get an awareness shell strictly outside their
    // fire envelope. The targeting system rotates the panel toward
    // any tracked enemy without triggering fire, then drops it back
    // to idle when the enemy leaves the tracking-release distance.
    rangeMultiplierOverrides: fireEnvelope({
      engageRangeMin: null,
      trackingRange: RANGE_TRACK,
    }),
    eventsSmooth: false,
    color: COLOR_WHITE,
    // The mirror-host turret's head sphere is hidden (panels are the
    // visual), so bodyRadius is set for consistency with sibling
    // turrets but has no rendered effect.
    bodyRadius: 5,
    // Single fully-regularized square reflector. The panel ATTACHMENT
    // POINT is the unit/turret center (offsetX = offsetY = 0); the
    // panel's normal points along the turret's facing direction
    // (angle = 0); the panel size is `2 × bodyRadius` square,
    // vertically centered on `bodyCenterHeight`. mirrorPanelCache
    // ignores these per-panel fields entirely — they're declared as
    // a count of 1 so the cache builder emits one panel per host.
    mirrorPanels: [{ offsetX: 0, offsetY: 0, angle: 0 }],
  },
  laserTurret: {
    id: 'laserTurret',
    projectileId: 'laserShot',
    range: 100,
    cooldown: 1500,
    turretTurnAccel: 100,
    turretDrag: 0.6,
    barrel: {
      type: 'simpleSingleBarrel',
      barrelLength: 0.5,
    },
    rangeMultiplierOverrides: fireEnvelope({
      engageRangeMin: null,
      trackingRange: null,
    }),
    eventsSmooth: false,
    color: COLOR_WHITE,
    spread: { angle: 0 },
    bodyRadius: 5,
    audio: { fireSound: AUDIO.event.fire.laserTurret },
  },
  beamTurret: {
    id: 'beamTurret',
    projectileId: 'beamShot',
    range: 250,
    turretTurnAccel: 100,
    turretDrag: 0.4,
    barrel: {
      type: 'simpleSingleBarrel',
      barrelLength: 0.6,
    },
    rangeMultiplierOverrides: fireEnvelope({
      engageRangeMin: null,
      trackingRange: null,
    }),
    eventsSmooth: false,
    color: COLOR_WHITE,
    bodyRadius: 6,
    audio: {
      fireSound: AUDIO.event.fire.beamTurret,
      laserSound: AUDIO.event.laser.beamTurret,
    },
  },
  // megaBeamTurret — bigger beam mount for "boss" beam units. Same
  // direction as beamTurret but a much thicker head sphere and longer
  // barrel so it visually reads as a heavy back-mounted weapon. Fires
  // the megaBeamShot, which does roughly 3× the dps and a wider beam
  // radius.
  megaBeamTurret: {
    id: 'megaBeamTurret',
    projectileId: 'megaBeamShot',
    range: 350,
    turretTurnAccel: 100,
    turretDrag: 0.5,
    barrel: {
      type: 'simpleSingleBarrel',
      barrelLength: 0.6,
      barrelThickness: 8,
    },
    rangeMultiplierOverrides: fireEnvelope({
      engageRangeMin: null,
      trackingRange: null,
    }),
    eventsSmooth: false,
    color: COLOR_WHITE,
    bodyRadius: 14,
    audio: {
      fireSound: AUDIO.event.fire.megaBeamTurret,
      laserSound: AUDIO.event.laser.megaBeamTurret,
    },
  },
  // Single force-field turret used by every unit that mounts one.
  // Previously split into forceTurretLarge / forceTurretMedium with
  // slightly different ranges, transition times, emitter grates, and
  // audio playSpeed; the variation wasn't carrying its weight, so
  // we collapsed to one entry here.
  forceTurret: {
    id: 'forceTurret',
    range: SPATIAL_GRID_CELL_SIZE * 3 * 0.9,
    turretTurnAccel: 30,
    turretDrag: 0.5,
    barrel: {
      type: 'complexSingleEmitter',
      grate: FORCE_FIELD_TURRET.forceField,
    },
    rangeMultiplierOverrides: fireEnvelope({
      engageRangeMin: null,
      trackingRange: null,
    }),
    eventsSmooth: false,
    color: COLOR_WHITE,
    // Force-field emitters render via ForceFieldRenderer3D's glowing
    // sphere; the turret head itself is hidden, so this value has no
    // rendered effect — set for consistency with sibling turrets.
    bodyRadius: 12,
    forceField: {
      angle: Math.PI * 2,
      transitionTime: 500,
      push: { ...FORCE_PUSH },
    },
    audio: { fireSound: AUDIO.event.fire.forceTurret },
  },
};

export function getTurretBlueprint(id: string): TurretBlueprint {
  const turretBlueprint = TURRET_BLUEPRINTS[id];
  if (!turretBlueprint) throw new Error(`Unknown weapon blueprint: ${id}`);
  return turretBlueprint;
}

for (const [id, blueprint] of Object.entries(TURRET_BLUEPRINTS)) {
  if (blueprint.id !== id) {
    throw new Error(
      `Turret blueprint key/id mismatch: ${id} contains ${blueprint.id}`,
    );
  }
}
