/**
 * Weapon Blueprints
 *
 * Static data for all weapon types.
 * Merges WEAPON_STATS + turret visuals + audio from config.ts and audioConfig.ts.
 */

import {
  LAND_CELL_SIZE,
  FORCE_FIELD_TURRET,
  FORCE_FIELD_BARRIER,
} from '../../../config';
import { AUDIO } from '../../../audioConfig';
import { isTurretId, type TurretId } from '../../../types/blueprintIds';
import type { HysteresisRangeMultiplier } from '../../../types/sim';
import type { TurretBlueprint } from './types';

const COLOR_WHITE = 0xffffff;
export const CONSTRUCTION_TURRET_HEAD_RADIUS = 8;

const CONSTRUCTION_EMITTER_VISUALS = {
  defaultSize: 'small',
  particleTravelSpeed: 50,
  particleRadius: 1.5,
  sizes: {
    small: {
      towerSize: 'small',
      pylonHeight: 10,
      pylonOffset: 3,
      innerPylonRadius: 1.5,
      showerRadius: 3.0,
    },
    large: {
      towerSize: 'large',
      pylonHeight: 50,
      pylonOffset: 15,
      innerPylonRadius: 2,
      showerRadius: 5,
    },
  },
} as const;

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
  acquire: 0.5,
  release: 0.45,
};

function fireEnvelope(params: {
  engageRangeMax?: HysteresisRangeMultiplier | null;
  engageRangeMin: HysteresisRangeMultiplier | null;
  trackingRange: HysteresisRangeMultiplier | null;
}): TurretBlueprint['rangeMultiplierOverrides'] {
  const { engageRangeMin, trackingRange, engageRangeMax } = params;

  if (engageRangeMax) {
    return {
      engageRangeMax: { ...engageRangeMax },
      engageRangeMin: engageRangeMin ? { ...engageRangeMin } : null,
      trackingRange: trackingRange ? { ...trackingRange } : null,
    };
  }

  return {
    engageRangeMax: { ...RANGE_FIRE_MAX },
    engageRangeMin: engageRangeMin ? { ...engageRangeMin } : null,
    trackingRange: trackingRange ? { ...trackingRange } : null,
  };
}

export const TURRET_BLUEPRINTS = {
  lightTurret: {
    id: 'lightTurret',
    projectileId: 'lightShot',
    range: 200,
    cooldown: 450,
    // Must cover the authored fire envelope: ballistic max range is
    // (launchForce / mass)^2 / GRAVITY, and lightShot.mass = 4.
    launchForce: 1_250,
    turretTurnAccel: 200,
    turretDrag: 0.15,
    barrel: { type: 'simpleSingleBarrel', barrelLength: 2 },
    rangeMultiplierOverrides: fireEnvelope({
      engageRangeMin: null,
      trackingRange: null,
    }),
    eventsSmooth: false,
    color: COLOR_WHITE,
    spread: { angle: 0 },
    radius: { body: 3 },
    audio: { fireSound: AUDIO.event.fire.lightTurret },
    aimStyle: 'lowArc',
  },
  pulseTurret: {
    id: 'pulseTurret',
    projectileId: 'mediumShot',
    range: 160,
    cooldown: 3_000,
    // mediumShot.mass = 10; this leaves headroom over the 160 wu
    // release range so Lynx fight-move stops only when it can fire.
    launchForce: 2_800,
    turretTurnAccel: 200,
    turretDrag: 0.15,
    barrel: {
      type: 'simpleMultiBarrel',
      barrelCount: 2,
      barrelLength: 1.2,
      orbitRadius: 0.65,
      spin: { idle: 2, max: 10, accel: 80, decel: 30 },
    },
    rangeMultiplierOverrides: fireEnvelope({
      engageRangeMin: null,
      trackingRange: null,
    }),
    eventsSmooth: true,
    color: COLOR_WHITE,
    spread: { angle: Math.PI / 8 },
    burst: { count: 4, delay: 100 },
    radius: { body: 9 },
    audio: { fireSound: AUDIO.event.fire.pulseTurret },
    aimStyle: 'lowArc',
  },
  cannonTurret: {
    id: 'cannonTurret',
    projectileId: 'heavyShot',
    range: 1000,
    cooldown: 2300,
    launchForce: 20_000,
    turretTurnAccel: 200,
    turretDrag: 0.15,
    barrel: { type: 'simpleSingleBarrel', barrelLength: 1.4 },
    rangeMultiplierOverrides: fireEnvelope({
      engageRangeMin: RANGE_FIRE_MIN,
      trackingRange: null,
    }),
    eventsSmooth: false,
    color: COLOR_WHITE,
    spread: { angle: 0 },
    radius: { body: 10 },
    audio: { fireSound: AUDIO.event.fire.cannonTurret },
    aimStyle: 'lowArc',
  },
  mortarTurret: {
    id: 'mortarTurret',
    projectileId: 'mortarShot',
    range: 1000,
    cooldown: 6000,
    launchForce: 30_000,
    turretTurnAccel: 200,
    turretDrag: 0.15,
    barrel: { type: 'simpleSingleBarrel', barrelLength: 0.75 },
    rangeMultiplierOverrides: fireEnvelope({
      engageRangeMin: RANGE_FIRE_MIN,
      trackingRange: null,
    }),
    eventsSmooth: false,
    color: COLOR_WHITE,
    spread: { angle: 0 },
    radius: { body: 9 },
    audio: { fireSound: AUDIO.event.fire.mortarTurret },
    aimStyle: 'highArc',
    // Aim directly at the target point. mortarShot detonates on
    // ground impact and releases mediumShot fragments from there.
    groundAimFraction: 1.0,
  },
  // Gatling mortar: multi-barrel rotating cluster that lobs mortarShot
  // carrier rounds. Each carrier releases three mediumShot children on
  // detonation, so the turret has area pressure without a nested
  // cluster tier.
  gatlingMortarTurret: {
    id: 'gatlingMortarTurret',
    projectileId: 'mortarShot',
    range: 2000,
    cooldown: 500,
    // Ballistic max range = (launchForce / mass)² / GRAVITY. With
    // mortarShot.mass = SHOT_MASS_MEDIUM × 3 = 30 and GRAVITY = 400,
    // a launchForce of 8 000 only reaches ~178 wu — far short of
    // the 1000 engagement range, so solveProjectileTurretAim was
    // returning hasBallisticSolution=false for every acquired
    // target and the fire-gate at projectileSystem.ts:257 skipped
    // every shot. 22 000 yields ~1344 wu max range with comfortable
    // headroom over the 1000 cap.
    launchForce: 40_000,
    turretTurnAccel: 20,
    turretDrag: 0.15,
    barrel: {
      type: 'simpleMultiBarrel',
      barrelCount: 6,
      barrelLength: 1.0,
      orbitRadius: 0.9,
      spin: { idle: 2, max: 10, accel: 30, decel: 10 },
    },
    rangeMultiplierOverrides: fireEnvelope({
      engageRangeMin: RANGE_FIRE_MIN,
      trackingRange: null,
    }),
    eventsSmooth: false,
    color: COLOR_WHITE,
    spread: { angle: 0 },
    radius: { body: 32 },
    audio: { fireSound: AUDIO.event.fire.gatlingMortarTurret },
    // Fast high-arc carrier. The submunitions do the area spread; this
    // keeps the gatling role readable without adding another cluster
    // layer.
    aimStyle: 'highArc',
    // Aim directly at the target group; the carrier's submunition spray
    // creates the area coverage.
    groundAimFraction: 1.0,
  },
  hippoGatlingTurret: {
    id: 'hippoGatlingTurret',
    projectileId: 'lightShot',
    range: 300,
    cooldown: 30,
    launchForce: 2_000,
    turretTurnAccel: 200,
    turretDrag: 0.15,
    barrel: {
      type: 'simpleMultiBarrel',
      barrelCount: 5,
      barrelLength: 0.8,
      orbitRadius: 0.4,
      spin: { idle: 2, max: 10, accel: 20, decel: 10 },
    },
    rangeMultiplierOverrides: fireEnvelope({
      engageRangeMin: null,
      trackingRange: null,
    }),
    eventsSmooth: true,
    color: COLOR_WHITE,
    spread: { angle: Math.PI / 16 },
    burst: { count: 1, delay: 80 },
    radius: { body: 12 },
    audio: { fireSound: AUDIO.event.fire.hippoGatlingTurret },
    aimStyle: 'lowArc',
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
    range: 800,
    cooldown: 2000,
    launchForce: 500,
    turretTurnAccel: 200,
    turretDrag: 0.15,
    barrel: {
      type: 'coneMultiBarrel',
      // 3 long tubes splayed out from the firing axis, with their tips
      // 2.5× headRadius out to the side. The forward extension
      // (`barrelLength`) is set to 0.01 so the cylinders run almost
      // entirely sideways from the head — visible length is dominated
      // by the radial spread (tipOrbit − baseOrbit), not by forward
      // run. Authoring `tipOrbit` explicitly decouples the visible
      // splay from `spread.angle` (which controls the random firing
      // cone around vertical, not the rendered barrel angles).
      barrelCount: 3,
      barrelLength: 0.01,
      baseOrbit: 0.0,
      tipOrbit: 0.9,
      spin: { idle: 2, max: 10, accel: 10, decel: 5 },
    },
    rangeMultiplierOverrides: fireEnvelope({
      engageRangeMin: {
        acquire: 0.6,
        release: 0.55,
      },
      trackingRange: null,
    }),
    eventsSmooth: false,
    color: COLOR_WHITE,
    // 90° max deviation from vertical — rockets launch anywhere from
    // straight up to horizontal; homing then bends each one onto the
    // target's line.
    spread: { angle: Math.PI / 4, pelletCount: 3 },
    // spread: { angle: Math.PI / 2, pelletCount: 1 },
    radius: { body: 8 },
    audio: { fireSound: AUDIO.event.fire.salvoRocketTurret },
    aimStyle: 'none',
    verticalLauncher: true,
    // Spawn pointing straight up. verticalLauncher pins pitch to π/2
    // every tick once combat runs, but during construction (shell
    // state) and the first frame before turretSystem ticks the pose
    // comes from idlePitch — without this the cluster spawned aimed
    // forward and snapped up on first activate.
    idlePitch: Math.PI / 2,
  },
  dgunTurret: {
    id: 'dgunTurret',
    projectileId: 'disruptorShot',
    range: 150,
    cooldown: 0,
    launchForce: 8_400,
    turretTurnAccel: 200,
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
    radius: { body: 8 },
    audio: { fireSound: AUDIO.event.fire.dgunTurret },
    aimStyle: 'none',
  },
  mirrorTurret: {
    id: 'mirrorTurret',
    projectileId: 'beamShot',
    range: 300,
    turretTurnAccel: 200,
    turretDrag: 0.15,
    barrel: { type: 'simpleSingleBarrel', barrelLength: 0 },
    passive: true,
    mountMode: 'unitBodyCenter',
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
    // Rest pose: panel pitched straight up so a freshly-spawned mirror
    // unit reads as "scanning the sky" until it acquires an actual
    // threat. As soon as the aim solver runs, the damper takes over
    // and pitches the panel to the bisector solution.
    idlePitch: Math.PI / 2,
    // The mirror-host turret's head sphere is hidden; radius.body
    // defines the panel half-side used by the mirror visual/collision.
    radius: { body: 8 },
    // Single fully-regularized square reflector. The panel ATTACHMENT
    // POINT is the unit/turret center (offsetX = offsetY = 0); the
    // panel's normal points along the turret's facing direction
    // (angle = 0); the panel size is `2 × radius.body` square,
    // vertically centered on `bodyCenterHeight`. mirrorPanelCache
    // ignores these per-panel fields entirely — they're declared as
    // a count of 1 so the cache builder emits one panel per host.
    mirrorPanels: [{ offsetX: 0, offsetY: 0, angle: 0 }],
    aimStyle: 'direct',
  },
  beamTurret: {
    id: 'beamTurret',
    projectileId: 'beamShot',
    range: 250,
    turretTurnAccel: 200,
    turretDrag: 0.15,
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
    radius: { body: 8 },
    aimStyle: 'direct',
    audio: {
      fireSound: AUDIO.event.fire.beamTurret,
    },
  },
  // miniBeam — Tick-scale beam mount. Keeps the same direct-fire
  // behavior as beamTurret but with a smaller head/barrel, shorter
  // reach, and the thinner miniBeamShot profile.
  miniBeam: {
    id: 'miniBeam',
    projectileId: 'miniBeamShot',
    range: 180,
    turretTurnAccel: 200,
    turretDrag: 0.15,
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
    radius: { body: 3 },
    aimStyle: 'direct',
    audio: {
      fireSound: AUDIO.event.fire.miniBeam,
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
    turretTurnAccel: 200,
    turretDrag: 0.15,
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
    radius: { body: 14 },
    aimStyle: 'direct',
    audio: {
      fireSound: AUDIO.event.fire.megaBeamTurret,
    },
  },
  // Single force-field turret used by every unit that mounts one.
  // Previously split into forceTurretLarge / forceTurretMedium with
  // slightly different ranges, transition times, emitter grates, and
  // audio playSpeed; the variation wasn't carrying its weight, so
  // we collapsed to one entry here.
  forceTurret: {
    id: 'forceTurret',
    range: LAND_CELL_SIZE * 3 * 0.9,
    turretTurnAccel: 200,
    turretDrag: 0.15,
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
    // sphere; radius.body remains available to shared barrel/mount
    // helpers even though the normal turret head is hidden.
    radius: { body: 12 },
    aimStyle: 'none',
    forceField: {
      angle: Math.PI * 2,
      transitionTime: 500,
      barrier: { ...FORCE_FIELD_BARRIER },
    },
    audio: { fireSound: AUDIO.event.fire.forceTurret },
  },
  // Construction turret — visual-only construction hardware mounted
  // through the normal turret hardpoint path. It has no projectileId:
  // build spray particles are renderer-owned cosmetics, not backend
  // sim shots. constructionEmitter owns pylon/shower geometry plus
  // cosmetic particle travel speed and radius.
  constructionTurret: {
    id: 'constructionTurret',
    range: 0,
    cooldown: 0,
    launchForce: 0,
    turretTurnAccel: 200,
    turretDrag: 0.15,
    barrel: { type: 'simpleSingleBarrel', barrelLength: 0 },
    rangeMultiplierOverrides: fireEnvelope({
      engageRangeMin: null,
      trackingRange: null,
    }),
    eventsSmooth: false,
    color: COLOR_WHITE,
    spread: { angle: 0 },
    radius: { body: CONSTRUCTION_TURRET_HEAD_RADIUS },
    aimStyle: 'none',
    isManualFire: true,
    constructionEmitter: CONSTRUCTION_EMITTER_VISUALS,
  },
  // Tower beam turret — same range and audio family as megaBeamTurret,
  // but with a larger head and longer barrel so the static tower's
  // weapon is readable above its body. Fires towerBeamShot (10x dps)
  // without changing the Widow's own megaBeamTurret balance.
  towerBeamTurret: {
    id: 'towerBeamTurret',
    projectileId: 'towerBeamShot',
    range: 350,
    turretTurnAccel: 200,
    turretDrag: 0.15,
    barrel: {
      type: 'simpleSingleBarrel',
      barrelLength: 0.8,
      barrelThickness: 8,
    },
    rangeMultiplierOverrides: fireEnvelope({
      engageRangeMin: null,
      trackingRange: null,
    }),
    eventsSmooth: false,
    color: COLOR_WHITE,
    radius: { body: 18 },
    aimStyle: 'direct',
    audio: {
      fireSound: AUDIO.event.fire.megaBeamTurret,
    },
  },
  // Tower cannon turret — static defensive variant of cannonTurret.
  // It keeps the same heavyShot damage profile as unit cannons, but
  // uses a larger head, longer visible barrel, and faster reload so
  // the tower can stand apart without changing mobile cannon balance.
  towerCannonTurret: {
    id: 'towerCannonTurret',
    projectileId: 'heavyShot',
    range: 1500,
    cooldown: 1500,
    launchForce: 22_000,
    turretTurnAccel: 180,
    turretDrag: 0.15,
    barrel: {
      type: 'simpleSingleBarrel',
      barrelLength: 3,
      barrelThickness: 9,
    },
    rangeMultiplierOverrides: fireEnvelope({
      engageRangeMin: RANGE_FIRE_MIN,
      trackingRange: null,
    }),
    eventsSmooth: false,
    color: COLOR_WHITE,
    spread: { angle: 0 },
    radius: { body: 16 },
    audio: { fireSound: AUDIO.event.fire.cannonTurret },
    aimStyle: 'lowArc',
  },
} satisfies Record<TurretId, TurretBlueprint>;

export function getTurretBlueprint(id: string): TurretBlueprint {
  if (!isTurretId(id)) throw new Error(`Unknown weapon blueprint: ${id}`);
  const turretBlueprint = TURRET_BLUEPRINTS[id];
  return turretBlueprint;
}

for (const [id, blueprint] of Object.entries(TURRET_BLUEPRINTS)) {
  if (blueprint.id !== id) {
    throw new Error(
      `Turret blueprint key/id mismatch: ${id} contains ${blueprint.id}`,
    );
  }
}
