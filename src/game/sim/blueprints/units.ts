/**
 * Unit Blueprints
 *
 * Single source of truth for all unit types, including commander.
 * Consolidates: UNIT_STATS, COMMANDER_STATS, UNIT_DEFINITIONS, UNIT_BUILD_CONFIGS,
 * CHASSIS_MOUNTS, LEG_CONFIG, TREAD_CONFIG, WHEEL_CONFIG, UNIT_SHORT_NAMES, death sounds.
 */

import { AUDIO } from '../../../audioConfig';
import type { UnitBlueprint, MountPoint } from './types';

// Compute widow's hexagonal mount points
function computeWidowMounts(): MountPoint[] {
  const hexR = 0.65;
  const hexFwd = 0.5;
  const hexRotOff = Math.PI / 3;
  const mounts: MountPoint[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (i * Math.PI) / 3 + hexRotOff;
    mounts.push({
      x: Math.cos(angle) * hexR + hexFwd,
      y: Math.sin(angle) * hexR,
    });
  }
  mounts.push({ x: hexFwd, y: 0 }); // Force field at hex center
  return mounts;
}

export const UNIT_BLUEPRINTS: Record<string, UnitBlueprint> = {
  jackal: {
    id: 'jackal',
    name: 'Jackal',
    shortName: 'JKL',
    hp: 40,
    moveSpeed: 300,
    collisionRadius: 8,
    collisionRadiusMultiplier: 1.0,
    mass: 10,
    baseCost: 65,
    weapons: [{ weaponId: 'gatlingTurret', offsetX: 0, offsetY: 0 }],
    chassisMounts: [{ x: 0, y: 0 }],
    locomotion: {
      type: 'wheels',
      config: {
        wheelDistX: 0.6,
        wheelDistY: 0.7,
        treadLength: 0.5,
        treadWidth: 0.15,
        wheelRadius: 0.28,
        rotationSpeed: 1.0,
      },
    },
    renderer: 'scout',
    deathSound: AUDIO.event.death.jackal,
  },
  lynx: {
    id: 'lynx',
    name: 'Lynx',
    shortName: 'LNX',
    hp: 65,
    moveSpeed: 170,
    collisionRadius: 10,
    collisionRadiusMultiplier: 1.0,
    mass: 15,
    baseCost: 100,
    weapons: [{ weaponId: 'pulseTurret', offsetX: 0, offsetY: 0 }],
    chassisMounts: [{ x: 0, y: 0 }],
    locomotion: {
      type: 'treads',
      config: {
        treadOffset: 0.8,
        treadLength: 1.6,
        treadWidth: 0.45,
        wheelRadius: 0.12,
        rotationSpeed: 1.0,
      },
    },
    renderer: 'burst',
    deathSound: AUDIO.event.death.lynx,
  },
  daddy: {
    id: 'daddy',
    name: 'Daddy',
    shortName: 'DDY',
    hp: 60,
    moveSpeed: 200,
    collisionRadius: 13,
    collisionRadiusMultiplier: 1.0,
    mass: 25,
    baseCost: 500,
    weapons: [{ weaponId: 'forceTurret', offsetX: 0, offsetY: 0 }],
    chassisMounts: [{ x: 0, y: 0 }],
    locomotion: {
      type: 'legs',
      style: 'daddy',
      config: { thickness: 2, footSize: 0.14, lerpDuration: 300 },
    },
    renderer: 'forceField',
    deathSound: AUDIO.event.death.daddy,
  },
  badger: {
    id: 'badger',
    name: 'Badger',
    shortName: 'BDG',
    hp: 200,
    moveSpeed: 200,
    collisionRadius: 16,
    collisionRadiusMultiplier: 1.0,
    mass: 300,
    baseCost: 500,
    weapons: [{ weaponId: 'shotgunTurret', offsetX: 0, offsetY: 0 }],
    chassisMounts: [{ x: 0, y: 0 }],
    locomotion: {
      type: 'treads',
      config: {
        treadOffset: 0.85,
        treadLength: 1.7,
        treadWidth: 0.55,
        wheelRadius: 0.12,
        rotationSpeed: 1.0,
      },
    },
    renderer: 'brawl',
    deathSound: AUDIO.event.death.badger,
  },
  mongoose: {
    id: 'mongoose',
    name: 'Mongoose',
    shortName: 'MGS',
    hp: 100,
    moveSpeed: 220,
    collisionRadius: 14,
    collisionRadiusMultiplier: 1.0,
    mass: 35,
    baseCost: 85,
    weapons: [{ weaponId: 'mortarTurret', offsetX: 0, offsetY: 0 }],
    chassisMounts: [{ x: 0, y: 0 }],
    locomotion: {
      type: 'wheels',
      config: {
        wheelDistX: 0.65,
        wheelDistY: 0.7,
        treadLength: 0.5,
        treadWidth: 0.3,
        wheelRadius: 0.22,
        rotationSpeed: 1.0,
      },
    },
    renderer: 'mortar',
    deathSound: AUDIO.event.death.mongoose,
  },
  tick: {
    id: 'tick',
    name: 'Tick',
    shortName: 'TCK',
    hp: 45,
    moveSpeed: 120,
    collisionRadius: 11,
    collisionRadiusMultiplier: 1.0,
    mass: 9,
    baseCost: 35,
    weapons: [{ weaponId: 'laserTurret', offsetX: 0, offsetY: 0 }],
    chassisMounts: [{ x: -0.45, y: 0 }],
    locomotion: {
      type: 'legs',
      style: 'tick',
      config: { thickness: 1.5, footSize: 0.08, lerpDuration: 160 },
    },
    renderer: 'snipe',
    deathSound: AUDIO.event.death.tick,
  },
  mammoth: {
    id: 'mammoth',
    name: 'Mammoth',
    shortName: 'MMT',
    hp: 550,
    moveSpeed: 60,
    collisionRadius: 24,
    collisionRadiusMultiplier: 1.0,
    mass: 1000,
    baseCost: 2500,
    weapons: [{ weaponId: 'cannonTurret', offsetX: 0, offsetY: 0 }],
    chassisMounts: [{ x: 0, y: 0 }],
    locomotion: {
      type: 'treads',
      config: {
        treadOffset: 0.9,
        treadLength: 2.0,
        treadWidth: 0.6,
        wheelRadius: 0.175,
        rotationSpeed: 1.0,
      },
    },
    renderer: 'tank',
    deathSound: AUDIO.event.death.mammoth,
  },
  widow: {
    id: 'widow',
    name: 'Widow',
    shortName: 'WDW',
    hp: 700,
    moveSpeed: 70,
    collisionRadius: 35,
    collisionRadiusMultiplier: 1.0,
    mass: 200,
    baseCost: 5000,
    weapons: [
      { weaponId: 'beamTurret6', offsetX: 0, offsetY: 0 }, // front-left
      { weaponId: 'beamTurret5', offsetX: 0, offsetY: 0 }, // back-left
      { weaponId: 'beamTurret4', offsetX: 0, offsetY: 0 }, // back
      { weaponId: 'beamTurret5', offsetX: 0, offsetY: 0 }, // back-right
      { weaponId: 'beamTurret6', offsetX: 0, offsetY: 0 }, // front-right
      { weaponId: 'beamTurret7', offsetX: 0, offsetY: 0 }, // front
      { weaponId: 'megaForceTurret', offsetX: 0, offsetY: 0 }, // center
    ],
    chassisMounts: computeWidowMounts(),
    locomotion: {
      type: 'legs',
      style: 'widow',
      config: { thickness: 6, footSize: 0.1, lerpDuration: 600 },
    },
    renderer: 'arachnid',
    weaponSeeRange: 400,
    deathSound: AUDIO.event.death.widow,
  },
  tarantula: {
    id: 'tarantula',
    name: 'Tarantula',
    shortName: 'TRN',
    hp: 50,
    moveSpeed: 200,
    collisionRadius: 11,
    collisionRadiusMultiplier: 1.0,
    mass: 18,
    baseCost: 460,
    weapons: [{ weaponId: 'beamTurret8', offsetX: 0, offsetY: 0 }],
    chassisMounts: [{ x: 0, y: 0 }],
    locomotion: {
      type: 'legs',
      style: 'tarantula',
      config: { thickness: 6, footSize: 0.12, lerpDuration: 200 },
    },
    renderer: 'beam',
    deathSound: AUDIO.event.death.tarantula,
  },
  commander: {
    id: 'commander',
    name: 'Commander',
    shortName: 'CMD',
    hp: 500,
    moveSpeed: 200,
    collisionRadius: 20,
    collisionRadiusMultiplier: 1.0,
    mass: 60,
    baseCost: 0,
    weapons: [
      { weaponId: 'beamTurret3', offsetX: 0, offsetY: 0 },
      { weaponId: 'dgunTurret', offsetX: 0, offsetY: 0 },
    ],
    chassisMounts: [
      { x: 0.3, y: 0 },
      { x: 0, y: 0 },
    ],
    locomotion: {
      type: 'legs',
      style: 'commander',
      config: { thickness: 6, footSize: 0.15, lerpDuration: 400 },
    },
    renderer: 'commander',
    builder: { buildRange: 150 },
    dgun: { weaponId: 'dgunTurret', energyCost: 200 },
    deathSound: AUDIO.event.death.commander,
  },
};

// Ordered list for build bar (excludes commander — not buildable)
export const BUILDABLE_UNIT_IDS = [
  'jackal',
  'lynx',
  'badger',
  'mongoose',
  'mammoth',
  'tick',
  'tarantula',
  'daddy',
  'widow',
];

export function getUnitBlueprint(id: string): UnitBlueprint {
  const bp = UNIT_BLUEPRINTS[id];
  if (!bp) throw new Error(`Unknown unit blueprint: ${id}`);
  return bp;
}

export function getAllUnitBlueprints(): UnitBlueprint[] {
  return Object.values(UNIT_BLUEPRINTS);
}
