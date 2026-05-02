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
import type { TurretBlueprint } from './types';

const COLOR_WHITE = 0xffffff;
const STANDARD_MAX_FIRE_RANGE = { acquire: 0.9, release: 0.95 };
const NO_MINIMUM_FIRE_RANGE = { acquire: 0, release: 0 };

function fireEnvelope(
  engageRangeMin = NO_MINIMUM_FIRE_RANGE,
): TurretBlueprint['rangeMultiplierOverrides'] {
  return {
    engageRangeMax: { ...STANDARD_MAX_FIRE_RANGE },
    engageRangeMin: { ...engageRangeMin },
  };
}

export const TURRET_BLUEPRINTS: Record<string, TurretBlueprint> = {
  lightTurret: {
    id: 'lightTurret',
    projectileId: 'lightShot',
    range: 120,
    cooldown: 450,
    launchForce: 380,
    turretTurnAccel: 200,
    turretDrag: 0.5,
    barrel: { type: 'simpleSingleBarrel', barrelLength: 0.2 },
    rangeMultiplierOverrides: fireEnvelope(),
    eventsSmooth: false,
    color: COLOR_WHITE,
    spread: { angle: 0 },
    bodyRadius: 4,
    audio: { fireSound: AUDIO.event.fire.lightTurret },
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
    cooldown: 1_500,
    launchForce: 1000,
    homingTurnRate: 1,
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
    rangeMultiplierOverrides: fireEnvelope({ acquire: 0.3, release: 0.15 }),
    eventsSmooth: false,
    color: COLOR_WHITE,
    // 90° max deviation from vertical — rockets launch anywhere from
    // straight up to horizontal; homing then bends each one onto the
    // target's line.
    spread: { angle: Math.PI / 2, pelletCount: 3 },
    bodyRadius: 8,
    audio: { fireSound: AUDIO.event.fire.salvoRocketTurret },
    verticalLauncher: true,
  },
  cannonTurret: {
    id: 'cannonTurret',
    projectileId: 'heavyShot',
    range: 610,
    cooldown: 2300,
    launchForce: 10_000,
    turretTurnAccel: 200,
    turretDrag: 0.5,
    barrel: { type: 'simpleSingleBarrel', barrelLength: 1.4 },
    rangeMultiplierOverrides: fireEnvelope({ acquire: 0.3, release: 0.25 }),
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
    launchForce: 25000,
    turretTurnAccel: 90,
    turretDrag: 0.4,
    barrel: { type: 'simpleSingleBarrel', barrelLength: 0.75 },
    // Artillery keeps tracking close enemies, but only fires once
    // the target intersects this inner/outer fire annulus.
    rangeMultiplierOverrides: fireEnvelope({ acquire: 0.5, release: 0.45 }),
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
    cooldown: 1_400,
    launchForce: 4_200,
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
    rangeMultiplierOverrides: fireEnvelope(),
    eventsSmooth: false,
    color: COLOR_WHITE,
    spread: { angle: Math.PI / 32 },
    burst: { count: 2, delay: 80 },
    bodyRadius: 7,
    audio: { fireSound: AUDIO.event.fire.pulseTurret },
  },
  // Gatling mortar — multi-barrel rotating cluster that lobs
  // mortarShot carrier rounds. Each carrier releases 5 mediumShot
  // fragments on detonation, so the turret has high area pressure
  // without spawning a second nested cluster tier.
  gatlingMortarTurret: {
    id: 'gatlingMortarTurret',
    projectileId: 'mortarShot',
    range: 3000,
    cooldown: 200,
    launchForce: 30000,
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
    // Keep only a short safety dead zone. This turret's very long
    // base range makes artillery-style ratios create a huge no-fire
    // annulus that looks like broken targeting in dense battles.
    rangeMultiplierOverrides: fireEnvelope({ acquire: 0.08, release: 0.06 }),
    eventsSmooth: true,
    color: COLOR_WHITE,
    spread: { angle: 0 },
    bodyRadius: 14,
    audio: { fireSound: AUDIO.event.fire.gatlingMortarTurret },
    // Uses the low ballistic solution; the submunitions do the area spread.
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
    launchForce: 4_200,
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
    rangeMultiplierOverrides: fireEnvelope(),
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
    launchForce: 7000,
    turretTurnAccel: 40,
    turretDrag: 0.15,
    barrel: {
      type: 'simpleSingleBarrel',
      barrelLength: 1.0,
      barrelThickness: 8,
    },
    isManualFire: true,
    rangeMultiplierOverrides: fireEnvelope(),
    eventsSmooth: false,
    color: 0xff8800,
    bodyRadius: 7,
    audio: { fireSound: AUDIO.event.fire.dgunTurret },
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
    launchForce: 1000,
    rangeMultiplierOverrides: fireEnvelope(),
    eventsSmooth: false,
    color: COLOR_WHITE,
    spread: { angle: 0 },
    bodyRadius: 5,
    audio: { fireSound: AUDIO.event.fire.laserTurret },
  },
  mirrorTurret: {
    id: 'mirrorTurret',
    projectileId: 'beamShot',
    range: 400,
    turretTurnAccel: 50,
    turretDrag: 1,
    barrel: { type: 'simpleSingleBarrel', barrelLength: 0 },
    launchForce: 0,
    passive: true,
    spread: { angle: Math.PI / 2 },
    rangeMultiplierOverrides: fireEnvelope(),
    eventsSmooth: false,
    color: COLOR_WHITE,
    // The mirror-host turret's head sphere is hidden (panels are the
    // visual), so bodyRadius is set for consistency with sibling
    // turrets but has no rendered effect.
    bodyRadius: 5,
    // Single forward-facing square reflector. angle=0 ⇒ panel normal
    // points along the turret's facing direction; the panel's edge runs
    // left-right across the turret's front. Size is regularized — the
    // panel is always a perfect square whose side equals its vertical
    // extent (topY − baseY = bodyTop + 2·hostHeadRadius +
    // MIRROR_EXTRA_HEIGHT − MIRROR_BASE_Y), so sim collision and the
    // visible mesh share one canonical rectangle.
    mirrorPanels: [{ offsetX: 18, offsetY: 0, angle: 0 }],
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
    launchForce: 1000,
    rangeMultiplierOverrides: fireEnvelope(),
    eventsSmooth: false,
    color: COLOR_WHITE,
    bodyRadius: 6,
    audio: {
      fireSound: AUDIO.event.fire.beamTurret,
      laserSound: AUDIO.event.laser.beamTurret,
    },
  },
  // megaBeamTurret — bigger beam mount for "boss" beam units. Same
  // direction as beamTurret but a much thicker head sphere and
  // longer barrel so it visually reads as a heavy weapon and
  // naturally fills a head slot when the host's body head segment
  // is removed (see widow body shape). Fires the megaBeamShot, which
  // does roughly 3× the dps and a wider beam radius.
  megaBeamTurret: {
    id: 'megaBeamTurret',
    projectileId: 'megaBeamShot',
    range: 350,
    turretTurnAccel: 60,
    turretDrag: 0.5,
    barrel: {
      type: 'simpleSingleBarrel',
      barrelLength: 0.6,
      barrelThickness: 8,
    },
    launchForce: 1500,
    rangeMultiplierOverrides: fireEnvelope(),
    eventsSmooth: false,
    color: COLOR_WHITE,
    bodyRadius: 14,
    audio: {
      fireSound: AUDIO.event.fire.megaBeamTurret,
      laserSound: AUDIO.event.laser.megaBeamTurret,
    },
  },
  forceTurretLarge: {
    id: 'forceTurretLarge',
    range: SPATIAL_GRID_CELL_SIZE * 3 * 0.9,
    turretTurnAccel: 30,
    turretDrag: 0.5,
    barrel: {
      type: 'complexSingleEmitter',
      grate: FORCE_FIELD_TURRET.forceField,
    },
    rangeMultiplierOverrides: fireEnvelope(),
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
    audio: { fireSound: AUDIO.event.fire.forceTurretLarge },
  },
  forceTurretMedium: {
    id: 'forceTurretMedium',
    range: SPATIAL_GRID_CELL_SIZE * 2 * 0.9,
    turretTurnAccel: 30,
    turretDrag: 0.5,
    barrel: {
      type: 'complexSingleEmitter',
      grate: FORCE_FIELD_TURRET.megaForceField,
    },
    rangeMultiplierOverrides: fireEnvelope(),
    eventsSmooth: false,
    color: COLOR_WHITE,
    // Force-field emitter — head is hidden, see forceTurretLarge.
    bodyRadius: 10,
    forceField: {
      angle: Math.PI * 2,
      transitionTime: 1000,
      push: { ...FORCE_PUSH },
    },
    audio: { fireSound: AUDIO.event.fire.forceTurretMedium },
  },
};

export function getTurretBlueprint(id: string): TurretBlueprint {
  const turretBlueprint = TURRET_BLUEPRINTS[id];
  if (!turretBlueprint) throw new Error(`Unknown weapon blueprint: ${id}`);
  return turretBlueprint;
}
