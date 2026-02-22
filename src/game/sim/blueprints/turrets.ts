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

// Generate beam turret blueprints for all harmonic series indices
// Index 0 = most powerful (lowest pitch, thickest barrel), index 13 = weakest (highest pitch, thinnest)
function generateBeamTurrets(): Record<string, TurretBlueprint> {
  const result: Record<string, TurretBlueprint> = {};
  const maxI = harmonicSeries.length - 1;
  for (let i = 0; i < harmonicSeries.length; i++) {
    const p = (maxI - i) / maxI; // 1.0 at i=0, 0.0 at i=13
    const range = Math.round(100 + 200 * p);
    result[`beamTurret${i}`] = {
      id: `beamTurret${i}`,
      projectileId: `beamShot${i}`,
      range,
      turretTurnAccel: 100,
      turretDrag: 0.4,
      turretShape: { type: 'simpleSingleBarrel', barrelLength: 0.6 },
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
    range: 100,
    cooldown: 400,
    launchForce: 60,
    turretTurnAccel: 200,
    turretDrag: 0.5,
    turretShape: { type: 'simpleSingleBarrel', barrelLength: 1.2 },
    rangeMultiplierOverrides: {
      tracking: { acquire: null, release: null },
      engage: { acquire: null, release: null },
    },
    color: 0xffffff,
    spread: { angle: Math.PI / 12 },
    audio: { fireSound: AUDIO.event.fire.lightTurret },
  },
  pulseTurret: {
    id: 'pulseTurret',
    projectileId: 'mediumShot',
    range: 160,
    cooldown: 1800,
    launchForce: 1500,
    turretTurnAccel: 40,
    turretDrag: 0.15,
    turretShape: {
      type: 'simpleMultiBarrel',
      barrelCount: 2,
      barrelLength: 1.7,
      orbitRadius: 0.35,
      depthScale: 0.1,
      spin: { idle: 2.0, max: 30, accel: 80, decel: 30 },
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
  shotgunTurret: {
    id: 'shotgunTurret',
    projectileId: 'mediumShot',
    range: 150,
    cooldown: 2000,
    launchForce: 1000,
    homingTurnRate: 2,
    turretTurnAccel: 5,
    turretDrag: 0.15,
    turretShape: {
      type: 'coneMultiBarrel',
      barrelCount: 5,
      barrelLength: 0.6,
      baseOrbit: 0.094,
      depthScale: 0.12,
      spin: { idle: 0.7, max: 2, accel: 80, decel: 30 },
    },
    rangeMultiplierOverrides: {
      tracking: { acquire: null, release: null },
      engage: { acquire: null, release: null },
    },
    color: 0xffffff,
    spread: { angle: Math.PI / 1.4, pelletCount: 5 },
    audio: { fireSound: AUDIO.event.fire.shotgunTurret },
  },
  hippoGatlingTurret: {
    id: 'hippoGatlingTurret',
    projectileId: 'heavyShot',
    range: 250,
    cooldown: 200,
    launchForce: 8000,
    turretTurnAccel: 100,
    turretDrag: 0.4,
    turretShape: {
      type: 'simpleMultiBarrel',
      barrelCount: 5,
      barrelLength: 1.5,
      orbitRadius: 0.4,
      depthScale: 0.1,
      spin: { idle: 3, max: 40, accel: 100, decel: 30 },
    },
    rangeMultiplierOverrides: {
      tracking: { acquire: null, release: null },
      engage: { acquire: null, release: null },
    },
    color: 0xffffff,
    spread: { angle: Math.PI / 10 },
    burst: { count: 3, delay: 50 },
    audio: { fireSound: AUDIO.event.fire.hippoGatlingTurret },
  },
  cannonTurret: {
    id: 'cannonTurret',
    projectileId: 'heavyShot',
    range: 360,
    cooldown: 3000,
    launchForce: 80000,
    turretTurnAccel: 200,
    turretDrag: 0.5,
    turretShape: { type: 'simpleSingleBarrel', barrelLength: 1.4 },
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
    range: 400,
    cooldown: 6000,
    launchForce: 400,
    turretTurnAccel: 40,
    turretDrag: 0.4,
    turretShape: { type: 'simpleSingleBarrel', barrelLength: 0.75 },
    rangeMultiplierOverrides: {
      tracking: { acquire: null, release: null },
      engage: { acquire: null, release: null },
    },
    color: 0xffffff,
    spread: { angle: Math.PI / 24 },
    audio: { fireSound: AUDIO.event.fire.mortarTurret },
  },
  laserTurret: {
    id: 'laserTurret',
    projectileId: 'laserShot',
    range: 100,
    cooldown: 1500,
    // cooldown: 3000,
    turretTurnAccel: 100,
    turretDrag: 0.6,
    turretShape: { type: 'simpleSingleBarrel', barrelLength: 1.0 },
    launchForce: 1000,
    rangeMultiplierOverrides: {
      tracking: { acquire: null, release: null },
      engage: { acquire: null, release: null },
    },
    color: 0xffffff,
    spread: { angle: 0 },
    audio: { fireSound: AUDIO.event.fire.laserTurret },
  },
  ...generateBeamTurrets(),
  forceTurretLarge: {
    id: 'forceTurretLarge',
    range: SPATIAL_GRID_CELL_SIZE * 3 * 0.9,
    turretTurnAccel: 30,
    turretDrag: 0.5,
    turretShape: { type: 'complexSingleEmitter', grate: FORCE_FIELD_TURRET.forceField },
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
    turretShape: {
      type: 'complexSingleEmitter',
      grate: FORCE_FIELD_TURRET.megaForceField,
    },
    rangeMultiplierOverrides: FORCE_TURRET_RANGE_MULTIPLIERS,
    color: 0xffffff,
    forceField: {
      angle: Math.PI * 2,
      transitionTime: 500,
      push: { ...FORCE_PUSH },
      pull: { ...FORCE_PULL },
    },
    audio: { fireSound: AUDIO.event.fire.forceTurretMedium },
  },
  disruptorTurret: {
    id: 'disruptorTurret',
    projectileId: 'disruptorShot',
    range: 150,
    cooldown: 0,
    launchForce: 7000,
    turretTurnAccel: 40,
    turretDrag: 0.15,
    turretShape: { type: 'simpleSingleBarrel', barrelLength: 0.7 },
    rangeMultiplierOverrides: {
      tracking: { acquire: null, release: null },
      engage: { acquire: null, release: null },
    },
    color: 0xff8800,
    audio: { fireSound: AUDIO.event.fire.disruptorTurret },
  },
  dgunTurret: {
    id: 'dgunTurret',
    projectileId: 'disruptorShot',
    range: 150,
    cooldown: 0,
    launchForce: 7000,
    turretTurnAccel: 40,
    turretDrag: 0.15,
    turretShape: { type: 'simpleSingleBarrel', barrelLength: 0.7 },
    rangeMultiplierOverrides: {
      tracking: { acquire: null, release: null },
      engage: { acquire: null, release: null },
    },
    isManualFire: true,
    color: 0xff8800,
    audio: { fireSound: AUDIO.event.fire.dgunTurret },
  },
};

export function getTurretBlueprint(id: string): TurretBlueprint {
  const bp = TURRET_BLUEPRINTS[id];
  if (!bp) throw new Error(`Unknown weapon blueprint: ${id}`);
  return bp;
}
