/**
 * Unit Blueprints
 *
 * Single source of truth for all unit types, including commander.
 * Consolidates: UNIT_STATS, COMMANDER_STATS, UNIT_DEFINITIONS, UNIT_BUILD_CONFIGS,
 * CHASSIS_MOUNTS, LEG_CONFIG, TREAD_CONFIG, WHEEL_CONFIG, UNIT_SHORT_NAMES, death sounds.
 */

import { AUDIO } from '../../../audioConfig';
import type { UnitBlueprint, MountPoint, TurretMount, UnitBodyShape, LocomotionPhysics } from './types';
import type { UnitLocomotion } from '../types';

const LOCOMOTION_TRACTION = {
  wheels: 0.45,
  treads: 0.75,
  legs: 1.0,
} as const;

function locomotionPhysics(
  type: keyof typeof LOCOMOTION_TRACTION,
  driveForce: number,
): LocomotionPhysics {
  return {
    driveForce,
    traction: LOCOMOTION_TRACTION[type],
  };
}

const BODY_SHAPES = {
  scout: {
    kind: 'polygon',
    sides: 4,
    radiusFrac: 0.55,
    heightFrac: 0.3,
    rotation: Math.PI / 4,
  },
  brawl: {
    kind: 'polygon',
    sides: 4,
    radiusFrac: 0.8,
    heightFrac: 0.3,
    rotation: 0,
  },
  tank: {
    kind: 'polygon',
    sides: 5,
    radiusFrac: 0.85,
    heightFrac: 0.3,
    rotation: 0,
  },
  burst: {
    kind: 'polygon',
    sides: 3,
    radiusFrac: 0.6,
    heightFrac: 0.3,
    rotation: Math.PI,
  },
  mortar: {
    kind: 'polygon',
    sides: 6,
    radiusFrac: 0.55,
    heightFrac: 0.3,
    rotation: 0,
  },
  hippo: {
    kind: 'rect',
    lengthFrac: 0.7,
    widthFrac: 1.6,
    heightFrac: 0.6,
  },
  beam: {
    kind: 'composite',
    // Tarantula keeps its forward head sphere; its beam turret mounts
    // on top of the rear abdomen segment.
    parts: [
      {
        kind: 'oval',
        offsetForward: -0.65,
        xFrac: 0.9,
        yFrac: (0.9 + 0.65) / 2,
        zFrac: 0.65,
      },
      { kind: 'circle', offsetForward: 0.3, radiusFrac: 0.55, yFrac: 0.55 },
    ],
  },
  arachnid: {
    kind: 'composite',
    // Widow keeps its forward prosoma/head sphere; the mega beam
    // turret mounts on top of the rear abdomen segment.
    parts: [
      { kind: 'circle', offsetForward: -1.1, radiusFrac: 1.15, yFrac: 1.15 },
      { kind: 'circle', offsetForward: 0.3, radiusFrac: 0.55, yFrac: 0.55 },
    ],
  },
  formik: {
    kind: 'composite',
    // Formik keeps a small forward head sphere. Its combat turret
    // lives on the raised rear abdomen/back segment instead of
    // replacing the head silhouette.
    parts: [
      {
        kind: 'oval',
        offsetForward: -0.85,
        xFrac: 0.75,
        yFrac: 0.85,
        zFrac: 0.68,
      },
      {
        kind: 'oval',
        offsetForward: 0.05,
        xFrac: 0.7,
        yFrac: 0.72,
        zFrac: 0.55,
      },
      { kind: 'circle', offsetForward: 0.78, radiusFrac: 0.42, yFrac: 0.42 },
    ],
  },
  snipe: { kind: 'oval', xFrac: 0.5, yFrac: (0.5 + 0.35) / 2, zFrac: 0.35 },
  commander: {
    kind: 'composite',
    parts: [
      {
        kind: 'oval',
        offsetForward: -0.58,
        xFrac: 0.68,
        yFrac: 0.58,
        zFrac: 0.72,
      },
      {
        kind: 'oval',
        offsetForward: 0.04,
        xFrac: 0.78,
        yFrac: 0.62,
        zFrac: 0.76,
      },
      { kind: 'circle', offsetForward: 0.64, radiusFrac: 0.38, yFrac: 0.42 },
    ],
  },
  // Daddy used to have a single dome-sized body sphere here that
  // overlapped the central force-field turret's emitter — the emitter
  // and the body read as two stacked spheres. Drop the body to a thin
  // platform (still wide enough for the leg hips to land sensibly) so
  // the central force-field emitter is the unit's visible head, same
  // intent as removing the head sphere on formik / tarantula.
  forceField: { kind: 'circle', radiusFrac: 0.55, yFrac: 0.12 },
  loris: { kind: 'circle', radiusFrac: 0.55, yFrac: 0.55 },
} satisfies Record<string, UnitBodyShape>;

const WIDOW_ABDOMEN_RADIUS_FRAC = 1.15;
const WIDOW_ABDOMEN_FORWARD_FRAC = -1.1;
const TARANTULA_ABDOMEN_FORWARD_FRAC = -0.65;
const FORMIK_BACK_SEGMENT_FORWARD_FRAC = -0.85;
const TICK_REPLACED_HEAD_CENTER_HEIGHT_FRAC = 0.37;
const DADDY_VISUAL_RADIUS = 13;
const DADDY_PUSH_RADIUS = 15;
const DADDY_REPLACEMENT_HEAD_CENTER_HEIGHT_FRAC = 0.55;
// Daddy's main body is authored high above the ground; this force-field
// mount intentionally uses a >1 radius fraction to sit on its underside.
const DADDY_FORCE_FIELD_CENTER_HEIGHT_FRAC = 49 / DADDY_VISUAL_RADIUS;
const DADDY_REPLACEMENT_HEAD_RADIUS_FRAC = 5 / 13;
const DADDY_LEG_ATTACH_HEIGHT_FRAC =
  DADDY_REPLACEMENT_HEAD_CENTER_HEIGHT_FRAC - DADDY_REPLACEMENT_HEAD_RADIUS_FRAC;

function turretMount(
  turretId: string,
  headCenterHeightFrac?: number,
): TurretMount {
  return headCenterHeightFrac === undefined
    ? { turretId }
    : { turretId, headCenterHeightFrac };
}

// Compute widow's mount points: 4 light turrets on abdomen edge,
// force-field emitter centered on top of the rear abdomen segment.
function computeWidowMounts(): MountPoint[] {
  const mounts: MountPoint[] = [];
  for (let i = 0; i < 4; i++) {
    const angle = Math.PI / 4 + (i * Math.PI) / 2;
    mounts.push({
      x:
        Math.cos(angle) * WIDOW_ABDOMEN_RADIUS_FRAC +
        WIDOW_ABDOMEN_FORWARD_FRAC,
      y: Math.sin(angle) * WIDOW_ABDOMEN_RADIUS_FRAC,
    });
  }
  mounts.push({ x: WIDOW_ABDOMEN_FORWARD_FRAC, y: 0 });
  return mounts;
}

export const UNIT_BLUEPRINTS: Record<string, UnitBlueprint> = {
  jackal: {
    id: 'jackal',
    name: 'Jackal',
    shortName: 'JKL',
    hp: 55,
    unitRadiusCollider: { shot: 6, push: 8 * 1.2 },
    bodyRadius: 8,
    bodyCenterHeight: 8 * 1.2,
    mass: 30,
    resourceCost: 50,
    turrets: [turretMount('lightTurret')],
    chassisMounts: [{ x: 0, y: 0 }],
    bodyShape: BODY_SHAPES.scout,
    locomotion: {
      type: 'wheels',
      physics: locomotionPhysics('wheels', 300),
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
    unitRadiusCollider: { shot: 7, push: 10 * 1.3 },
    bodyRadius: 10,
    bodyCenterHeight: 10 * 1.3,
    mass: 40,
    resourceCost: 90,
    turrets: [turretMount('pulseTurret')],
    chassisMounts: [{ x: 0, y: 0 }],
    bodyShape: BODY_SHAPES.burst,
    locomotion: {
      type: 'treads',
      physics: locomotionPhysics('treads', 170),
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
    unitRadiusCollider: {
      shot: 9,
      push: DADDY_PUSH_RADIUS,
    },
    bodyRadius: DADDY_VISUAL_RADIUS,
    bodyCenterHeight: 60,
    mass: 30,
    resourceCost: 350,
    turrets: [
      turretMount('laserTurret', DADDY_REPLACEMENT_HEAD_CENTER_HEIGHT_FRAC),
      turretMount('forceTurretLarge', DADDY_FORCE_FIELD_CENTER_HEIGHT_FRAC),
    ],
    chassisMounts: [
      { x: 0, y: 0 }, // laser body
      { x: 0, y: 0 }, // center force field
    ],
    bodyShape: BODY_SHAPES.forceField,
    hideChassis: true,
    legAttachHeightFrac: DADDY_LEG_ATTACH_HEIGHT_FRAC,
    locomotion: {
      type: 'legs',
      style: 'daddy',
      physics: locomotionPhysics('legs', 200),
      config: {
        upperThickness: 2.5,
        lowerThickness: 2,
        hipRadius: 1.5,
        kneeRadius: 0.8,
        footRadius: 1.8,
        lerpDuration: 200,
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
    unitRadiusCollider: { shot: 13, push: 16 * 1.4 },
    bodyRadius: 16,
    bodyCenterHeight: 16 * 1.4,
    mass: 300,
    resourceCost: 300,
    turrets: [turretMount('salvoRocketTurret')],
    chassisMounts: [{ x: 0, y: 0 }],
    bodyShape: BODY_SHAPES.brawl,
    locomotion: {
      type: 'treads',
      physics: locomotionPhysics('treads', 200),
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
    unitRadiusCollider: { shot: 12, push: 20 * 1.2 },
    bodyRadius: 20,
    bodyCenterHeight: 20 * 1.2,
    mass: 200,
    resourceCost: 220,
    turrets: [turretMount('mortarTurret')],
    chassisMounts: [{ x: 0, y: 0 }],
    bodyShape: BODY_SHAPES.mortar,
    locomotion: {
      type: 'wheels',
      physics: locomotionPhysics('wheels', 220),
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
    unitRadiusCollider: { shot: 8, push: 11 * 1.1 },
    bodyRadius: 10,
    bodyCenterHeight: 8,
    mass: 30,
    resourceCost: 35,
    turrets: [
      turretMount('laserTurret', TICK_REPLACED_HEAD_CENTER_HEIGHT_FRAC),
    ],
    chassisMounts: [{ x: 0, y: 0 }],
    bodyShape: BODY_SHAPES.snipe,
    hideChassis: true,
    locomotion: {
      type: 'legs',
      style: 'tick',
      physics: locomotionPhysics('legs', 120),
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
    unitRadiusCollider: { shot: 24, push: 24 * 1.5 },
    bodyRadius: 24,
    bodyCenterHeight: 24 * 1.5,
    mass: 1000,
    resourceCost: 1200,
    turrets: [turretMount('cannonTurret')],
    chassisMounts: [{ x: 0, y: 0 }],
    bodyShape: BODY_SHAPES.tank,
    locomotion: {
      type: 'treads',
      physics: locomotionPhysics('treads', 60),
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
  formik: {
    id: 'formik',
    name: 'Formik',
    shortName: 'FMK',
    // Larger than Widow (scale 30 → 40) and tougher to match.
    hp: 3200,
    unitRadiusCollider: { shot: 50, push: 50 * 1.3 },
    bodyRadius: 40,
    bodyCenterHeight: 50 * 1.3,
    mass: 2500,
    resourceCost: 4000,
    turrets: [
      turretMount('gatlingMortarTurret'),
    ],
    // Mount on the top of the rear abdomen/back segment. The forward
    // head sphere remains a body part, not a turret replacement.
    chassisMounts: [{ x: FORMIK_BACK_SEGMENT_FORWARD_FRAC, y: 0 }],
    bodyShape: BODY_SHAPES.formik,
    locomotion: {
      type: 'legs',
      style: 'formik',
      physics: locomotionPhysics('legs', 60),
      config: {
        // Bigger thorax = beefier legs. Bumped over widow's
        // (7/6/4/6/3.5) to keep limb thickness in proportion to
        // the larger chassis.
        upperThickness: 9,
        lowerThickness: 8,
        hipRadius: 5.5,
        kneeRadius: 7.5,
        footRadius: 4.5,
        lerpDuration: 320,
      },
    },
    renderer: 'formik',
    deathSound: AUDIO.event.death.formik,
    fightStopEngagedRatio: 0.9,
  },
  widow: {
    id: 'widow',
    name: 'Widow',
    shortName: 'WDW',
    hp: 2400,
    unitRadiusCollider: { shot: 40, push: 40 * 1.3 },
    bodyRadius: 30,
    bodyCenterHeight: 40 * 1.3,
    mass: 1000,
    resourceCost: 3000,
    turrets: [
      turretMount('lightTurret'), // front-left
      turretMount('lightTurret'), // back-left
      turretMount('lightTurret'), // back-right
      turretMount('lightTurret'), // front-right
      // Force-field emitter sits on top of the rear abdomen segment; the
      // forward prosoma/head body sphere remains visible.
      turretMount('forceTurretMedium'), // abdomen top
    ],
    chassisMounts: computeWidowMounts(),
    bodyShape: BODY_SHAPES.arachnid,
    locomotion: {
      type: 'legs',
      style: 'widow',
      physics: locomotionPhysics('legs', 70),
      config: {
        upperThickness: 7,
        lowerThickness: 6,
        hipRadius: 4,
        kneeRadius: 6,
        footRadius: 3.5,
        lerpDuration: 300,
      },
    },
    renderer: 'arachnid',
    deathSound: AUDIO.event.death.widow,
    fightStopEngagedRatio: 0.9,
  },
  hippo: {
    id: 'hippo',
    name: 'Hippo',
    shortName: 'HPO',
    hp: 1500,
    unitRadiusCollider: { shot: 27, push: 45 * 1.2 },
    bodyRadius: 30,
    bodyCenterHeight: 45 * 1.2,
    mass: 1500,
    resourceCost: 2500,
    turrets: [turretMount('hippoGatlingTurret')],
    chassisMounts: [{ x: 0.2, y: 0 }],
    bodyShape: BODY_SHAPES.hippo,
    locomotion: {
      type: 'treads',
      physics: locomotionPhysics('treads', 55),
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
    unitRadiusCollider: { shot: 13, push: 11 * 1.8 },
    bodyRadius: 11,
    bodyCenterHeight: 11 * 1.8,
    mass: 18,
    resourceCost: 300,
    turrets: [
      turretMount('beamTurret'),
    ],
    // Mount the beam turret on the rear abdomen segment; the forward
    // head body sphere stays in place.
    chassisMounts: [{ x: TARANTULA_ABDOMEN_FORWARD_FRAC, y: 0 }],
    bodyShape: BODY_SHAPES.beam,
    locomotion: {
      type: 'legs',
      style: 'tarantula',
      physics: locomotionPhysics('legs', 200),
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
    unitRadiusCollider: { shot: 8, push: 24 },
    bodyRadius: 10,
    bodyCenterHeight: 24,
    mass: 20,
    resourceCost: 190,
    turrets: [turretMount('mirrorTurret')],
    chassisMounts: [{ x: 0, y: 0 }],
    bodyShape: BODY_SHAPES.loris,
    hideChassis: true,
    locomotion: {
      type: 'treads',
      physics: locomotionPhysics('treads', 160),
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
    unitRadiusCollider: { shot: 20, push: 20 },
    bodyRadius: 20,
    bodyCenterHeight: 20,
    mass: 60,
    resourceCost: 400,
    turrets: [
      turretMount('beamTurret'),
      turretMount('dgunTurret'),
    ],
    chassisMounts: [
      { x: 0.36, y: -0.42 },
      { x: 0.36, y: 0.42 },
    ],
    bodyShape: BODY_SHAPES.commander,
    locomotion: {
      type: 'legs',
      style: 'commander',
      physics: locomotionPhysics('legs', 200),
      config: {
        upperThickness: 8,
        lowerThickness: 7,
        hipRadius: 5,
        kneeRadius: 7,
        footRadius: 5,
        lerpDuration: 200,
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
  'formik',
  'hippo',
];

export function getUnitBlueprint(id: string): UnitBlueprint {
  const unitBlueprint = UNIT_BLUEPRINTS[id];
  if (!unitBlueprint) throw new Error(`Unknown unit blueprint: ${id}`);
  return unitBlueprint;
}

export function getUnitLocomotion(id: string): UnitLocomotion {
  const locomotion = getUnitBlueprint(id).locomotion;
  return {
    type: locomotion.type,
    driveForce: locomotion.physics.driveForce,
    traction: locomotion.physics.traction,
  };
}

export function getAllUnitBlueprints(): UnitBlueprint[] {
  return Object.values(UNIT_BLUEPRINTS);
}

// Normalized cost: resourceCost / max(resourceCost across buildables).
// One resource pool, one normalization — used for UI rank/scale display.
let _costNormCache: { max: number } | null = null;

function getCostNorm(): { max: number } {
  if (_costNormCache) return _costNormCache;
  let max = 0;
  for (const id of BUILDABLE_UNIT_IDS) {
    const unitBlueprint = UNIT_BLUEPRINTS[id];
    if (!unitBlueprint) continue;
    if (unitBlueprint.resourceCost > max) max = unitBlueprint.resourceCost;
  }
  _costNormCache = { max };
  return _costNormCache;
}

export function getNormalizedUnitCost(unitBlueprint: { resourceCost: number }): number {
  const { max } = getCostNorm();
  return max > 0 ? unitBlueprint.resourceCost / max : 0;
}
