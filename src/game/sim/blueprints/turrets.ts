/**
 * Weapon Blueprints
 *
 * Static data for all weapon types.
 * Merges WEAPON_STATS + turret visuals + audio from config.ts and audioConfig.ts.
 */

import { SPATIAL_GRID_CELL_SIZE, FORCE_FIELD_TURRET } from '../../../config';
import { AUDIO, harmonicSeries } from '../../../audioConfig';
import type { TurretBlueprint } from './types';

// Generate beam turret blueprints for all harmonic series indices
// Index 0 = most powerful (lowest pitch, thickest barrel), index 13 = weakest (highest pitch, thinnest)
function generateBeamTurrets(): Record<string, TurretBlueprint> {
  const result: Record<string, TurretBlueprint> = {};
  const maxI = harmonicSeries.length - 1;
  for (let i = 0; i < harmonicSeries.length; i++) {
    const p = (maxI - i) / maxI; // 1.0 at i=0, 0.0 at i=13
    const barrelThickness = Math.round((1.5 + 6.5 * p) * 2) / 2;
    const range = Math.round(100 + 200 * p);
    result[`beamTurret${i}`] = {
      id: `beamTurret${i}`,
      projectileId: `beamShot${i}`,
      range,
      turretTurnAccel: 100,
      turretDrag: 0.4,
      turretShape: { type: 'beamEmitter', barrelLength: 0.6, barrelThickness },
      rangeMultiplierOverrides: {
        see: null,
        fire: null,
        release: null,
        lock: null,
        fightstop: null,
      },
      color: 0xffffff,
      fireSound: AUDIO.event.fire[`beamTurret${i}`],
      laserSound: AUDIO.event.laser[`beamTurret${i}`],
    };
  }
  return result;
}

export const TURRET_BLUEPRINTS: Record<string, TurretBlueprint> = {
  gatlingTurret: {
    id: 'gatlingTurret',
    projectileId: 'lightShot',
    range: 100,
    cooldown: 400,
    spreadAngle: Math.PI / 12,
    turretTurnAccel: 200,
    turretDrag: 0.5,
    turretShape: { type: 'single', barrelLength: 1.2, barrelThickness: 2 },
    rangeMultiplierOverrides: {
      see: null,
      fire: null,
      release: null,
      lock: null,
      fightstop: null,
    },
    color: 0xffffff,
    fireSound: AUDIO.event.fire.gatlingTurret,
  },
  pulseTurret: {
    id: 'pulseTurret',
    projectileId: 'mediumShot',
    range: 160,
    cooldown: 1800,
    burstCount: 2,
    burstDelay: 80,
    spreadAngle: Math.PI / 32,
    turretTurnAccel: 40,
    turretDrag: 0.15,
    turretShape: {
      type: 'multibarrel',
      barrelCount: 2,
      barrelLength: 1.7,
      barrelThickness: 4,
      orbitRadius: 0.35,
      depthScale: 0.1,
      spin: { idle: 2.0, max: 30, accel: 80, decel: 30 },
    },
    rangeMultiplierOverrides: {
      see: null,
      fire: null,
      release: null,
      lock: null,
      fightstop: null,
    },
    color: 0xffffff,
    fireSound: AUDIO.event.fire.pulseTurret,
  },
  shotgunTurret: {
    id: 'shotgunTurret',
    projectileId: 'mediumShot',
    range: 160,
    cooldown: 2000,
    pelletCount: 5,
    spreadAngle: Math.PI / 1.4,
    homingTurnRate: 3,
    turretTurnAccel: 5,
    turretDrag: 0.15,
    turretShape: {
      type: 'coneSpread',
      barrelCount: 5,
      barrelLength: 0.6,
      barrelThickness: 2,
      baseOrbit: 0.094,
      depthScale: 0.12,
      spin: { idle: 0.7, max: 2, accel: 80, decel: 30 },
    },
    rangeMultiplierOverrides: {
      see: 1,
      fire: 0.9,
      release: 1,
      lock: 0.9,
      fightstop: 0.8,
    },
    color: 0xffffff,
    fireSound: AUDIO.event.fire.shotgunTurret,
  },
  hippoGatlingTurret: {
    id: 'hippoGatlingTurret',
    projectileId: 'heavyShot',
    range: 250,
    cooldown: 200,
    burstCount: 3,
    burstDelay: 50,
    spreadAngle: Math.PI / 10,
    turretTurnAccel: 100,
    turretDrag: 0.4,
    turretShape: {
      type: 'multibarrel',
      barrelCount: 3,
      barrelLength: 1.5,
      barrelThickness: 5,
      orbitRadius: 0.4,
      depthScale: 0.1,
      spin: { idle: 3, max: 40, accel: 100, decel: 30 },
    },
    rangeMultiplierOverrides: {
      see: null,
      fire: null,
      release: null,
      lock: null,
      fightstop: null,
    },
    color: 0xffffff,
    fireSound: AUDIO.event.fire.hippoGatlingTurret,
  },
  cannonTurret: {
    id: 'cannonTurret',
    projectileId: 'heavyShot',
    range: 360,
    cooldown: 3000,
    spreadAngle: Math.PI / 24,
    turretTurnAccel: 200,
    turretDrag: 0.5,
    turretShape: { type: 'single', barrelLength: 1.4, barrelThickness: 7 },
    rangeMultiplierOverrides: {
      see: null,
      fire: null,
      release: null,
      lock: null,
      fightstop: null,
    },
    color: 0xffffff,
    fireSound: AUDIO.event.fire.cannonTurret,
  },
  mortarTurret: {
    id: 'mortarTurret',
    projectileId: 'mortarShot',
    range: 400,
    cooldown: 6000,
    spreadAngle: Math.PI / 24,
    turretTurnAccel: 40,
    turretDrag: 0.4,
    turretShape: { type: 'single', barrelLength: 0.75, barrelThickness: 6 },
    rangeMultiplierOverrides: {
      see: null,
      fire: null,
      release: null,
      lock: null,
      fightstop: null,
    },
    color: 0xffffff,
    fireSound: AUDIO.event.fire.mortarTurret,
  },
  laserTurret: {
    id: 'laserTurret',
    projectileId: 'laserShot',
    range: 100,
    cooldown: 1500,
    // cooldown: 3000,
    spreadAngle: 0,
    turretTurnAccel: 100,
    turretDrag: 0.6,
    turretShape: { type: 'single', barrelLength: 1.0, barrelThickness: 2 },
    rangeMultiplierOverrides: {
      see: null,
      fire: 0.9,
      release: null,
      lock: null,
      fightstop: 0.7,
    },
    color: 0xffffff,
    fireSound: AUDIO.event.fire.laserTurret,
  },
  ...generateBeamTurrets(),
  forceTurret: {
    id: 'forceTurret',
    range: SPATIAL_GRID_CELL_SIZE * 1.9,
    turretTurnAccel: 30,
    turretDrag: 0.5,
    isForceField: true,
    forceFieldAngle: Math.PI * 2,
    forceFieldTransitionTime: 500,
    turretShape: { type: 'forceField', grate: FORCE_FIELD_TURRET.forceField },
    push: {
      innerRatio: 0.0,
      outerRatio: 0.8,
      color: 0x3366ff,
      alpha: 0.05,
      particleAlpha: 0.2,
      power: 300,
      damage: 0,
    },
    pull: {
      innerRatio: 0.8,
      outerRatio: 0.82,
      color: 0x3366ff,
      alpha: 0.2,
      particleAlpha: 0.2,
      power: null,
      damage: 0,
    },
    rangeMultiplierOverrides: {
      see: null,
      fire: null,
      release: null,
      lock: null,
      fightstop: 1.5,
    },
    color: 0xffffff,
    fireSound: AUDIO.event.fire.forceTurret,
  },
  megaForceTurret: {
    id: 'megaForceTurret',
    range: SPATIAL_GRID_CELL_SIZE * 1.3,
    turretTurnAccel: 30,
    turretDrag: 0.5,
    isForceField: true,
    forceFieldAngle: Math.PI * 2,
    forceFieldTransitionTime: 500,
    turretShape: {
      type: 'forceField',
      grate: FORCE_FIELD_TURRET.megaForceField,
    },
    push: {
      innerRatio: 0.0,
      outerRatio: 0.5,
      color: 0x3366ff,
      alpha: 0.05,
      particleAlpha: 0.2,
      power: 300,
      damage: 0,
    },
    pull: {
      innerRatio: 0.5,
      outerRatio: 0.52,
      color: 0x3366ff,
      alpha: 0.2,
      particleAlpha: 0.2,
      power: null,
      damage: 0,
    },
    rangeMultiplierOverrides: {
      see: null,
      fire: null,
      release: null,
      lock: null,
      fightstop: 1.5,
    },
    color: 0xffffff,
    fireSound: AUDIO.event.fire.megaForceTurret,
  },
  disruptorTurret: {
    id: 'disruptorTurret',
    projectileId: 'disruptorShot',
    range: 150,
    cooldown: 0,
    turretTurnAccel: 40,
    turretDrag: 0.15,
    turretShape: { type: 'beamEmitter', barrelLength: 0.7, barrelThickness: 4 },
    rangeMultiplierOverrides: {
      see: null,
      fire: null,
      release: null,
      lock: null,
      fightstop: null,
    },
    color: 0xff8800,
    fireSound: AUDIO.event.fire.disruptorTurret,
  },
  dgunTurret: {
    id: 'dgunTurret',
    projectileId: 'disruptorShot',
    range: 150,
    cooldown: 0,
    turretTurnAccel: 40,
    turretDrag: 0.15,
    turretShape: { type: 'beamEmitter', barrelLength: 0.7, barrelThickness: 4 },
    rangeMultiplierOverrides: {
      see: null,
      fire: null,
      release: null,
      lock: null,
      fightstop: null,
    },
    isManualFire: true,
    color: 0xff8800,
    fireSound: AUDIO.event.fire.dgunTurret,
  },
};

export function getTurretBlueprint(id: string): TurretBlueprint {
  const bp = TURRET_BLUEPRINTS[id];
  if (!bp) throw new Error(`Unknown weapon blueprint: ${id}`);
  return bp;
}
