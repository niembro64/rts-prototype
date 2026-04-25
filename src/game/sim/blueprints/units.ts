/**
 * Unit Blueprints
 *
 * Single source of truth for all unit types, including commander.
 * Consolidates: UNIT_STATS, COMMANDER_STATS, UNIT_DEFINITIONS, UNIT_BUILD_CONFIGS,
 * CHASSIS_MOUNTS, LEG_CONFIG, TREAD_CONFIG, WHEEL_CONFIG, UNIT_SHORT_NAMES, death sounds.
 */

import { AUDIO } from '../../../audioConfig';
import type { UnitBlueprint, MountPoint } from './types';

// Compute widow's mount points: 6 beam turrets on abdomen edge, force field on prosoma
function computeWidowMounts(): MountPoint[] {
  const abdomenR = 1.15; // matches abdomen radius in renderer
  const abdomenFwd = -1.1; // matches abdomen offset in renderer
  const mounts: MountPoint[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (i * Math.PI) / 3 + Math.PI / 6;
    mounts.push({
      x: Math.cos(angle) * abdomenR + abdomenFwd,
      y: Math.sin(angle) * abdomenR,
    });
  }
  mounts.push({ x: 0.3, y: 0 }); // Force field at prosoma center
  return mounts;
}

export const UNIT_BLUEPRINTS: Record<string, UnitBlueprint> = {
  jackal: {
    id: 'jackal',
    name: 'Jackal',
    shortName: 'JKL',
    hp: 55,
    moveSpeed: 300,
    unitRadiusCollider: { scale: 8, shot: 6, push: 8 * 1.2 },
    mass: 30,
    energyCost: 50,
    manaCost: 10,
    turrets: [{ turretId: 'lightTurret', offsetX: 0, offsetY: 0 }],
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
    fightStopEngagedRatio: 0.9,
  },
  lynx: {
    id: 'lynx',
    name: 'Lynx',
    shortName: 'LNX',
    hp: 60,
    moveSpeed: 170,
    unitRadiusCollider: { scale: 10, shot: 7, push: 10 * 1.3 },
    mass: 40,
    energyCost: 90,
    manaCost: 10,
    turrets: [{ turretId: 'pulseTurret', offsetX: 0, offsetY: 0 }],
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
    fightStopEngagedRatio: 0.9,
  },
  daddy: {
    id: 'daddy',
    name: 'Daddy',
    shortName: 'DDY',
    hp: 200,
    moveSpeed: 200,
    unitRadiusCollider: { scale: 13, shot: 9, push: 13 * 2.5 },
    mass: 30,
    energyCost: 10,
    manaCost: 350,
    turrets: [
      { turretId: 'laserTurret', offsetX: 0, offsetY: 0 },
      { turretId: 'laserTurret', offsetX: 0, offsetY: 0 },
      { turretId: 'forceTurretLarge', offsetX: 0, offsetY: 0 },
    ],
    chassisMounts: [
      { x: 0.5, y: -0.4 }, // front-left laser
      { x: 0.5, y: 0.4 }, // front-right laser
      { x: 0, y: 0 }, // center force field
    ],
    locomotion: {
      type: 'legs',
      style: 'daddy',
      config: {
        upperThickness: 2.5,
        lowerThickness: 2,
        hipRadius: 1.5,
        kneeRadius: 0.8,
        footRadius: 1.8,
        lerpDuration: 300,
      },
    },
    renderer: 'forceField',
    deathSound: AUDIO.event.death.daddy,
    fightStopEngagedRatio: 0.1,
  },
  badger: {
    id: 'badger',
    name: 'Badger',
    shortName: 'BDG',
    hp: 300,
    moveSpeed: 200,
    unitRadiusCollider: { scale: 16, shot: 13, push: 16 * 1.4 },
    mass: 300,
    energyCost: 300,
    manaCost: 10,
    turrets: [{ turretId: 'salvoRocketTurret', offsetX: 0, offsetY: 0 }],
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
    fightStopEngagedRatio: 0.9,
  },
  mongoose: {
    id: 'mongoose',
    name: 'Mongoose',
    shortName: 'MGS',
    hp: 200,
    moveSpeed: 220,
    unitRadiusCollider: { scale: 20, shot: 12, push: 20 * 1.2 },
    mass: 200,
    energyCost: 220,
    manaCost: 10,
    turrets: [{ turretId: 'mortarTurret', offsetX: 0, offsetY: 0 }],
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
    fightStopEngagedRatio: 0.9,
  },
  tick: {
    id: 'tick',
    name: 'Tick',
    shortName: 'TCK',
    hp: 55,
    moveSpeed: 120,
    unitRadiusCollider: { scale: 10, shot: 8, push: 11 * 1.1 },
    mass: 30,
    energyCost: 10,
    manaCost: 35,
    turrets: [{ turretId: 'laserTurret', offsetX: 0, offsetY: 0 }],
    chassisMounts: [{ x: -0.45, y: 0 }],
    locomotion: {
      type: 'legs',
      style: 'tick',
      config: {
        upperThickness: 2,
        lowerThickness: 1.5,
        hipRadius: 1,
        kneeRadius: 1.5,
        footRadius: 1,
        lerpDuration: 100,
      },
    },
    renderer: 'snipe',
    deathSound: AUDIO.event.death.tick,
    fightStopEngagedRatio: 0.9,
  },
  mammoth: {
    id: 'mammoth',
    name: 'Mammoth',
    shortName: 'MMT',
    hp: 900,
    moveSpeed: 60,
    unitRadiusCollider: { scale: 24, shot: 24, push: 24 * 1.5 },
    mass: 1000,
    energyCost: 1200,
    manaCost: 10,
    turrets: [{ turretId: 'cannonTurret', offsetX: 0, offsetY: 0 }],
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
    fightStopEngagedRatio: 0.9,
  },
  widow: {
    id: 'widow',
    name: 'Widow',
    shortName: 'WDW',
    hp: 2400,
    moveSpeed: 70,
    unitRadiusCollider: { scale: 30, shot: 40, push: 40 * 1.3 },
    mass: 200,
    energyCost: 10,
    manaCost: 3000,
    turrets: [
      { turretId: 'beamTurret6', offsetX: 0, offsetY: 0 }, // front-left
      { turretId: 'beamTurret5', offsetX: 0, offsetY: 0 }, // back-left
      { turretId: 'beamTurret4', offsetX: 0, offsetY: 0 }, // back
      { turretId: 'beamTurret5', offsetX: 0, offsetY: 0 }, // back-right
      { turretId: 'beamTurret6', offsetX: 0, offsetY: 0 }, // front-right
      { turretId: 'beamTurret7', offsetX: 0, offsetY: 0 }, // front
      { turretId: 'forceTurretMedium', offsetX: 0, offsetY: 0 }, // center
    ],
    chassisMounts: computeWidowMounts(),
    locomotion: {
      type: 'legs',
      style: 'widow',
      config: {
        upperThickness: 7,
        lowerThickness: 6,
        hipRadius: 4,
        kneeRadius: 6,
        footRadius: 3.5,
        lerpDuration: 600,
      },
    },
    renderer: 'arachnid',
    seeRange: 400,
    deathSound: AUDIO.event.death.widow,
    fightStopEngagedRatio: 0.9,
  },
  hippo: {
    id: 'hippo',
    name: 'Hippo',
    shortName: 'HPO',
    hp: 1500,
    moveSpeed: 55,
    unitRadiusCollider: { scale: 30, shot: 27, push: 45 * 1.2 },
    mass: 1500,
    energyCost: 2500,
    manaCost: 10,
    turrets: [
      { turretId: 'hippoGatlingTurret', offsetX: 0, offsetY: 0 },
      { turretId: 'hippoGatlingTurret', offsetX: 0, offsetY: 0 },
    ],
    chassisMounts: [
      { x: 0.2, y: -0.7 },
      { x: 0.2, y: 0.7 },
    ],
    locomotion: {
      type: 'treads',
      config: {
        treadOffset: 1.1,
        treadLength: 2.6,
        treadWidth: 0.55,
        wheelRadius: 0.2,
        rotationSpeed: 1.0,
      },
    },
    renderer: 'hippo',
    deathSound: AUDIO.event.death.hippo,
    fightStopEngagedRatio: 0.9,
  },
  tarantula: {
    id: 'tarantula',
    name: 'Tarantula',
    shortName: 'TRN',
    hp: 100,
    moveSpeed: 200,
    unitRadiusCollider: { scale: 11, shot: 13, push: 11 * 1.8 },
    mass: 18,
    energyCost: 10,
    manaCost: 300,
    turrets: [{ turretId: 'beamTurret8', offsetX: 0, offsetY: 0 }],
    chassisMounts: [{ x: 0.1, y: 0 }],
    locomotion: {
      type: 'legs',
      style: 'tarantula',
      config: {
        upperThickness: 6.5,
        lowerThickness: 6,
        hipRadius: 3.5,
        kneeRadius: 6,
        footRadius: 1.5,
        lerpDuration: 200,
      },
    },
    renderer: 'beam',
    deathSound: AUDIO.event.death.tarantula,
    fightStopEngagedRatio: 0.9,
  },
  loris: {
    id: 'loris',
    name: 'Loris',
    shortName: 'LRS',
    hp: 200,
    moveSpeed: 160,
    unitRadiusCollider: { scale: 10, shot: 8, push: 34 },
    mass: 20,
    energyCost: 190,
    manaCost: 10,
    turrets: [
      { turretId: 'mirrorTurret', offsetX: 0, offsetY: 0 },
    ],
    chassisMounts: [
      { x: 0, y: 0 },
    ],
    locomotion: {
      type: 'treads',
      config: {
        treadOffset: 0.85,
        treadLength: 1.7,
        treadWidth: 0.5,
        wheelRadius: 0.12,
        rotationSpeed: 1.0,
      },
    },
    renderer: 'loris',
    deathSound: AUDIO.event.death.loris,
    fightStopEngagedRatio: 0.9,
  },
  commander: {
    id: 'commander',
    name: 'Commander',
    shortName: 'CMD',
    hp: 500,
    moveSpeed: 200,
    unitRadiusCollider: { scale: 20, shot: 20, push: 20 },
    mass: 60,
    energyCost: 10,
    manaCost: 400,
    turrets: [
      { turretId: 'beamTurret3', offsetX: 0, offsetY: 0 },
      { turretId: 'dgunTurret', offsetX: 0, offsetY: 0 },
    ],
    chassisMounts: [
      { x: 0.3, y: 0 },
      { x: 0, y: 0 },
    ],
    locomotion: {
      type: 'legs',
      style: 'commander',
      config: {
        upperThickness: 8,
        lowerThickness: 7,
        hipRadius: 5,
        kneeRadius: 7,
        footRadius: 5,
        lerpDuration: 400,
      },
    },
    renderer: 'commander',
    builder: { buildRange: 150, maxEnergyUseRate: 50 },
    dgun: { turretId: 'dgunTurret', energyCost: 200 },
    deathSound: AUDIO.event.death.commander,
    fightStopEngagedRatio: 0.9,
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
  'loris',
  'daddy',
  'widow',
  'hippo',
];

export function getUnitBlueprint(id: string): UnitBlueprint {
  const bp = UNIT_BLUEPRINTS[id];
  if (!bp) throw new Error(`Unknown unit blueprint: ${id}`);
  return bp;
}

export function getAllUnitBlueprints(): UnitBlueprint[] {
  return Object.values(UNIT_BLUEPRINTS);
}

// Normalized composite cost: avg(energy/maxEnergy, mana/maxMana).
// Both resources contribute equally on a 0–1 scale.
let _costNormsCache: { maxEnergy: number; maxMana: number } | null = null;

function getCostNorms(): { maxEnergy: number; maxMana: number } {
  if (_costNormsCache) return _costNormsCache;
  let maxEnergy = 0;
  let maxMana = 0;
  for (const id of BUILDABLE_UNIT_IDS) {
    const bp = UNIT_BLUEPRINTS[id];
    if (!bp) continue;
    if (bp.energyCost > maxEnergy) maxEnergy = bp.energyCost;
    if (bp.manaCost > maxMana) maxMana = bp.manaCost;
  }
  _costNormsCache = { maxEnergy, maxMana };
  return _costNormsCache;
}

export function getNormalizedUnitCost(bp: { energyCost: number; manaCost: number }): number {
  const { maxEnergy, maxMana } = getCostNorms();
  const eNorm = maxEnergy > 0 ? bp.energyCost / maxEnergy : 0;
  const mNorm = maxMana > 0 ? bp.manaCost / maxMana : 0;
  return (eNorm + mNorm) / 2;
}
