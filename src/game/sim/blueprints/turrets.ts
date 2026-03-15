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
  FORCE_PULL,
} from '../../../config';
import { AUDIO, harmonicSeries } from '../../../audioConfig';
import type { TurretBlueprint } from './types';

const beamTurretBarrelLength: number = 1.0;

// Generate beam turret blueprints for all harmonic series indices
// Index 0 = most powerful (lowest pitch, thickest barrel), index 13 = weakest (highest pitch, thinnest)
function generateBeamTurrets(): Record<string, TurretBlueprint> {
  const result: Record<string, TurretBlueprint> = {};

  for (let i = 0; i < harmonicSeries.length; i++) {
    const range = 250;
    result[`beamTurret${i}`] = {
      id: `beamTurret${i}`,
      projectileId: `beamShot${i}`,
      range,
      turretTurnAccel: 100,
      turretDrag: 0.4,
      barrel: { type: 'simpleSingleBarrel', barrelLength: beamTurretBarrelLength },
      launchForce: 1000,
      rangeMultiplierOverrides: {
        tracking: { acquire: null, release: null },
        engage: { acquire: null, release: null },
      },
      color: 0xffffff,
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
    barrel: { type: 'simpleSingleBarrel', barrelLength: 1.0 },
    rangeMultiplierOverrides: {
      tracking: { acquire: null, release: null },
      engage: { acquire: null, release: null },
    },
    color: 0xffffff,
    spread: { angle: Math.PI / 12 },
    audio: { fireSound: AUDIO.event.fire.lightTurret },
  },
  shotgunTurret: {
    id: 'shotgunTurret',
    projectileId: 'mediumShot',
    range: 145,
    cooldown: 1_500,
    launchForce: 1600,
    homingTurnRate: 2,
    turretTurnAccel: 20,
    turretDrag: 0.15,
    barrel: {
      type: 'coneMultiBarrel',
      barrelCount: 5,
      barrelLength: 0.6,
      baseOrbit: 0.094,
      depthScale: 0.12,
      spin: { idle: 2, max: 5, accel: 80, decel: 30 },
    },
    rangeMultiplierOverrides: {
      tracking: { acquire: null, release: null },
      engage: { acquire: null, release: null },
    },
    color: 0xffffff,
    spread: { angle: Math.PI / 1.4, pelletCount: 5 },
    audio: { fireSound: AUDIO.event.fire.shotgunTurret },
  },
  cannonTurret: {
    id: 'cannonTurret',
    projectileId: 'heavyShot',
    range: 410,
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
    audio: { fireSound: AUDIO.event.fire.cannonTurret },
  },
  mortarTurret: {
    id: 'mortarTurret',
    projectileId: 'mortarShot',
    range: 320,
    cooldown: 6000,
    launchForce: 40000,
    turretTurnAccel: 90,
    turretDrag: 0.4,
    barrel: { type: 'simpleSingleBarrel', barrelLength: 0.75 },
    rangeMultiplierOverrides: {
      tracking: { acquire: null, release: null },
      engage: { acquire: null, release: null },
    },
    color: 0xffffff,
    spread: { angle: Math.PI / 24 },
    audio: { fireSound: AUDIO.event.fire.mortarTurret },
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
    audio: { fireSound: AUDIO.event.fire.pulseTurret },
  },
  hippoGatlingTurret: {
    id: 'hippoGatlingTurret',
    projectileId: 'mediumShot',
    range: 300,
    cooldown: 130,
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
    barrel: { type: 'simpleSingleBarrel', barrelLength: 0.7 },
    rangeMultiplierOverrides: {
      tracking: { acquire: null, release: null },
      engage: { acquire: null, release: null },
    },
    isManualFire: true,
    color: 0xff8800,
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
    barrel: { type: 'simpleSingleBarrel', barrelLength: beamTurretBarrelLength },
    launchForce: 1000,
    rangeMultiplierOverrides: {
      tracking: { acquire: null, release: null },
      engage: { acquire: null, release: null },
    },
    color: 0xffffff,
    spread: { angle: Math.PI / 32 },
    audio: { fireSound: AUDIO.event.fire.laserTurret },
  },
  mirrorTurret: {
    id: 'mirrorTurret',
    projectileId: 'beamShot0',
    range: 220,
    turretTurnAccel: 100,
    turretDrag: 0.5,
    barrel: { type: 'simpleSingleBarrel', barrelLength: 0 },
    launchForce: 0,
    passive: true,
    spread: { angle: Math.PI / 2 },
    rangeMultiplierOverrides: {
      tracking: { acquire: 0.95, release: 1.0 },
      engage: { acquire: 0.45, release: 0.5 },
    },
    color: 0xffffff,
    mirrorPanels: [
      { width: 60, height: 4, offsetX: 40, offsetY: 20, angle: -Math.PI / 4 },
      { width: 60, height: 4, offsetX: 40, offsetY: -20, angle: Math.PI / 4 },
    ],
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
    forceField: {
      angle: Math.PI * 2,
      transitionTime: 500,
      push: { ...FORCE_PUSH },
      pull: { ...FORCE_PULL },
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
    forceField: {
      angle: Math.PI * 2,
      transitionTime: 1000,
      push: { ...FORCE_PUSH },
      pull: { ...FORCE_PULL },
    },
    audio: { fireSound: AUDIO.event.fire.forceTurretMedium },
  },
};

export function getTurretBlueprint(id: string): TurretBlueprint {
  const bp = TURRET_BLUEPRINTS[id];
  if (!bp) throw new Error(`Unknown weapon blueprint: ${id}`);
  return bp;
}
