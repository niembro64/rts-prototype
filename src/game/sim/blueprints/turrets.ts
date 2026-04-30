/**
 * Weapon Blueprints
 *
 * Static data for all weapon types.
 * Merges WEAPON_STATS + turret visuals + audio from config.ts and audioConfig.ts.
 */

import {
  SPATIAL_GRID_CELL_SIZE,
  FORCE_FIELD_TURRET,
  FORCE_TURRET_RANGE_MULTIPLIERS,
  FORCE_PUSH,
} from '../../../config';
import { AUDIO, harmonicSeries } from '../../../audioConfig';
import type { TurretBlueprint } from './types';

const beamTurretBarrelLength: number = 1.0;

// Generate beam turret blueprints for all harmonic series indices
// Index 0 = most powerful (lowest pitch, thickest barrel), index 13 = weakest (highest pitch, thinnest)
function generateBeamTurrets(): Record<string, TurretBlueprint> {
  const result: Record<string, TurretBlueprint> = {};

  for (let i = 0; i < harmonicSeries.length; i++) {
    const commanderShoulderEmitter = i === 3;
    const range = 250;
    result[`beamTurret${i}`] = {
      id: `beamTurret${i}`,
      projectileId: `beamShot${i}`,
      range,
      turretTurnAccel: 100,
      turretDrag: 0.4,
      barrel: {
        type: 'simpleSingleBarrel',
        barrelLength: commanderShoulderEmitter ? 0.82 : beamTurretBarrelLength,
      },
      launchForce: 1000,
      rangeMultiplierOverrides: {
        tracking: { acquire: null, release: null },
        engage: { acquire: null, release: null },
      },
      color: 0xffffff,
      bodyRadius: commanderShoulderEmitter ? 5 : 6,
      audio: {
        fireSound: AUDIO.event.fire[`beamTurret${i}`],
        laserSound: AUDIO.event.laser[`beamTurret${i}`],
      },
    };
  }
  return result;
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
    barrel: { type: 'simpleSingleBarrel', barrelLength: 1.5 },
    rangeMultiplierOverrides: {
      tracking: { acquire: null, release: null },
      engage: { acquire: null, release: null },
    },
    color: 0xffffff,
    spread: { angle: Math.PI / 12 },
    bodyRadius: 4,
    audio: { fireSound: AUDIO.event.fire.lightTurret },
  },
  // Salvo rocket pod — vertical-launch system. The turret is pinned
  // pointing straight up (verticalLauncher=true → turretSystem locks
  // pitch to π/2) so the original cone-cluster of barrels stays
  // visibly aimed at the sky, with the cluster spin still driven by
  // engagement state. Each volley fires 10 rockets straight up into
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
    rangeMultiplierOverrides: {
      tracking: { acquire: null, release: null },
      engage: { acquire: null, release: null },
    },
    color: 0xffffff,
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
    rangeMultiplierOverrides: {
      tracking: { acquire: null, release: null },
      engage: { acquire: null, release: null },
    },
    color: 0xffffff,
    spread: { angle: Math.PI / 24 },
    bodyRadius: 10,
    audio: { fireSound: AUDIO.event.fire.cannonTurret },
  },
  mortarTurret: {
    id: 'mortarTurret',
    projectileId: 'mortarShot',
    range: 600,
    cooldown: 6000,
    launchForce: 30000,
    turretTurnAccel: 90,
    turretDrag: 0.4,
    barrel: { type: 'simpleSingleBarrel', barrelLength: 0.75 },
    rangeMultiplierOverrides: {
      tracking: { acquire: null, release: null },
      engage: { acquire: null, release: null },
    },
    color: 0xffffff,
    spread: { angle: Math.PI / 24 },
    bodyRadius: 9,
    audio: { fireSound: AUDIO.event.fire.mortarTurret },
    // Mortars lob — high-arc solution from the ballistic solver so
    // shells sail up and over whatever's in front of them.
    highArc: true,
    // Aim the carrier round to hit the GROUND 2/3 of the way to the
    // target. The mortarShot detonates on ground impact, its 15
    // lightShot submunitions bounce upward off the impact point in
    // the carrier's flight direction (reflected velocity, damped to
    // 40%), and the random spread + remaining momentum carry them
    // the rest of the way into a fragmentation ring around the
    // target. Designed in tandem with mortarShot.submunitions —
    // tune both knobs together.
    groundAimFraction: 1.00,
  },
  pulseTurret: {
    id: 'pulseTurret',
    projectileId: 'mediumShot',
    range: 160,
    cooldown: 1_400,
    launchForce: 1_500,
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
    rangeMultiplierOverrides: {
      tracking: { acquire: null, release: null },
      engage: { acquire: null, release: null },
    },
    color: 0xffffff,
    spread: { angle: Math.PI / 32 },
    burst: { count: 2, delay: 80 },
    bodyRadius: 7,
    audio: { fireSound: AUDIO.event.fire.pulseTurret },
  },
  // Gatling mortar — multi-barrel rotating cluster that lobs
  // advancedMortarShot rounds. Each round is itself a cluster
  // carrier (4 mortarShot submunitions), so the per-shot effective
  // payload is 4 mortars × 5 medium fragments = 20 hits. Pacing is
  // slower than the hippo gatling because each round is a heavy
  // cluster.
  gatlingMortarTurret: {
    id: 'gatlingMortarTurret',
    projectileId: 'advancedMortarShot',
    range: 1000,
    cooldown: 2000,
    launchForce: 50_000,
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
    rangeMultiplierOverrides: {
      tracking: { acquire: null, release: null },
      engage: { acquire: null, release: null },
    },
    color: 0xffffff,
    spread: { angle: Math.PI / 32 },
    bodyRadius: 14,
    audio: { fireSound: AUDIO.event.fire.gatlingMortarTurret },
    // Uses the low ballistic solution; the submunitions do the area spread.
    highArc: true,
    // Aim short so the cluster carrier lands inside the target
    // group; the bouncing mortar children carry the rest of the
    // fragmentation outward.
    groundAimFraction: 1.00,
  },
  hippoGatlingTurret: {
    id: 'hippoGatlingTurret',
    projectileId: 'mediumShot',
    range: 300,
    cooldown: 100,
    launchForce: 2_200,
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
    rangeMultiplierOverrides: {
      tracking: { acquire: null, release: null },
      engage: { acquire: null, release: null },
    },
    color: 0xffffff,
    spread: { angle: Math.PI / 8 },
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
    barrel: { type: 'simpleSingleBarrel', barrelLength: 1.0, barrelThickness: 8 },
    rangeMultiplierOverrides: {
      tracking: { acquire: null, release: null },
      engage: { acquire: null, release: null },
    },
    isManualFire: true,
    color: 0xff8800,
    bodyRadius: 7,
    audio: { fireSound: AUDIO.event.fire.dgunTurret },
  },
  laserTurret: {
    id: 'laserTurret',
    projectileId: 'laserShot',
    range: 100,
    cooldown: 1500,
    // cooldown: 3000,
    turretTurnAccel: 100,
    turretDrag: 0.6,
    barrel: {
      type: 'simpleSingleBarrel',
      barrelLength: beamTurretBarrelLength,
    },
    launchForce: 1000,
    rangeMultiplierOverrides: {
      tracking: { acquire: null, release: null },
      engage: { acquire: null, release: null },
    },
    color: 0xffffff,
    spread: { angle: Math.PI / 32 },
    bodyRadius: 5,
    audio: { fireSound: AUDIO.event.fire.laserTurret },
  },
  mirrorTurret: {
    id: 'mirrorTurret',
    projectileId: 'beamShot0',
    range: 500,
    turretTurnAccel: 50,
    turretDrag: 1,
    barrel: { type: 'simpleSingleBarrel', barrelLength: 0 },
    launchForce: 0,
    passive: true,
    spread: { angle: Math.PI / 2 },
    rangeMultiplierOverrides: {
      tracking: { acquire: 0.95, release: 1.0 },
      engage: { acquire: 0.45, release: 0.5 },
    },
    color: 0xffffff,
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
  ...generateBeamTurrets(),
  forceTurretLarge: {
    id: 'forceTurretLarge',
    range: SPATIAL_GRID_CELL_SIZE * 3 * 0.9,
    turretTurnAccel: 30,
    turretDrag: 0.5,
    barrel: {
      type: 'complexSingleEmitter',
      grate: FORCE_FIELD_TURRET.forceField,
    },
    rangeMultiplierOverrides: FORCE_TURRET_RANGE_MULTIPLIERS,
    color: 0xffffff,
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
    rangeMultiplierOverrides: FORCE_TURRET_RANGE_MULTIPLIERS,
    color: 0xffffff,
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
  const bp = TURRET_BLUEPRINTS[id];
  if (!bp) throw new Error(`Unknown weapon blueprint: ${id}`);
  return bp;
}
