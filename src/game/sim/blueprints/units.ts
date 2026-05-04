/**
 * Unit Blueprints
 *
 * Single source of truth for all unit types, including commander.
 * Consolidates: UNIT_STATS, COMMANDER_STATS, UNIT_DEFINITIONS, UNIT_BUILD_CONFIGS,
 * CHASSIS_MOUNTS, LEG_CONFIG, TREAD_CONFIG, WHEEL_CONFIG, UNIT_SHORT_NAMES, death sounds.
 */

import { AUDIO } from '../../../audioConfig';
import type { TurretId } from '../../../types/blueprintIds';
import type {
  LegLayoutEntry,
  UnitBlueprint,
  MountOffset,
  TurretMount,
  UnitBodyShape,
} from './types';
import type { UnitLocomotion } from '../types';
import { createLocomotionPhysics, createUnitLocomotion } from '../locomotion';
// One legitimate cross-domain dependency: the widow's top-mounted
// turret Z-fraction is computed from the turret's own bodyRadius
// (`widowTopMountedTurretZFrac` below). Cross-blueprint *validation*
// (every turretId on every unit resolves) lives in blueprints/index.ts
// instead, so this is the ONLY thing units.ts pulls from turrets.
import { getTurretBlueprint } from './turrets';
import {
  LEG_BODY_LIFT_FRAC,
  getExpectedUnitBodyCenterHeightY,
  getLegBodyCenterHeightY,
  getTreadBodyCenterHeightY,
  getWheelBodyCenterHeightY,
} from '../../math/BodyDimensions';
export { BUILDABLE_UNIT_IDS, type BuildableUnitId } from './unitRoster';
import { BUILDABLE_UNIT_IDS } from './unitRoster';

const WIDOW_BODY_RADIUS = 30;
const WIDOW_ABDOMEN_RADIUS_FRAC = 1.15;
const WIDOW_ABDOMEN_FORWARD_FRAC = -1.1;
const WIDOW_HEAD_RADIUS_FRAC = 0.55;
// Forward prosoma/head sphere location. The visible head belongs here;
// combat turrets that are meant to read as rear/back weapons should not
// reuse this mount.
const WIDOW_HEAD_FORWARD_FRAC = 0.3;
const WIDOW_ABDOMEN_TOP_Z_FRAC =
  LEG_BODY_LIFT_FRAC + WIDOW_ABDOMEN_RADIUS_FRAC * 2;
const WIDOW_HEAD_TOP_Z_FRAC = LEG_BODY_LIFT_FRAC + WIDOW_HEAD_RADIUS_FRAC * 2;

function widowTopMountedTurretZFrac(
  turretId: TurretId,
  bodyTopZFrac: number,
): number {
  const turretRadius = getTurretBlueprint(turretId).bodyRadius;
  if (turretRadius === undefined) {
    throw new Error(
      `Widow top-mounted turret ${turretId} must define bodyRadius`,
    );
  }
  return bodyTopZFrac + turretRadius / WIDOW_BODY_RADIUS;
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
      {
        kind: 'circle',
        offsetForward: WIDOW_ABDOMEN_FORWARD_FRAC,
        radiusFrac: WIDOW_ABDOMEN_RADIUS_FRAC,
        yFrac: WIDOW_ABDOMEN_RADIUS_FRAC,
      },
      {
        kind: 'circle',
        offsetForward: WIDOW_HEAD_FORWARD_FRAC,
        radiusFrac: WIDOW_HEAD_RADIUS_FRAC,
        yFrac: WIDOW_HEAD_RADIUS_FRAC,
      },
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
  // Daddy uses a thin central platform under its force-field emitter.
  // Keeping the chassis low and broad gives the leg hips a sensible
  // attachment surface while leaving the emitter visually dominant.
  forceField: { kind: 'circle', radiusFrac: 0.55, yFrac: 0.12 },
  loris: { kind: 'circle', radiusFrac: 0.55, yFrac: 0.55 },
} satisfies Record<string, UnitBodyShape>;

type LegGaitPreset = {
  snapTriggerAnglePi: number;
  snapTargetAnglePi: number;
  snapDistanceMultiplier: number;
  extensionThreshold: number;
};

const LEG_GAIT_FRONT: LegGaitPreset = {
  snapTriggerAnglePi: 0.46,
  snapTargetAnglePi: -0.31,
  snapDistanceMultiplier: 0.74,
  extensionThreshold: 0.96,
};

const LEG_GAIT_REAR: LegGaitPreset = {
  snapTriggerAnglePi: 0.99,
  snapTargetAnglePi: -0.58,
  snapDistanceMultiplier: 0.5,
  extensionThreshold: 0.99,
};

const FORMIK_GAITS: [LegGaitPreset, LegGaitPreset, LegGaitPreset] = [
  {
    snapTriggerAnglePi: 0.42,
    snapTargetAnglePi: -0.28,
    snapDistanceMultiplier: 0.7,
    extensionThreshold: 0.96,
  },
  {
    snapTriggerAnglePi: 0.72,
    snapTargetAnglePi: -0.45,
    snapDistanceMultiplier: 0.62,
    extensionThreshold: 0.98,
  },
  {
    snapTriggerAnglePi: 1.02,
    snapTargetAnglePi: -0.62,
    snapDistanceMultiplier: 0.54,
    extensionThreshold: 0.99,
  },
];

function legLayoutEntry(
  attachOffsetXFrac: number,
  attachOffsetYFrac: number,
  legLengthFrac: number,
  upperLengthRatio: number,
  lowerLengthToUpperRatio: number,
  gait: LegGaitPreset,
): LegLayoutEntry {
  const upperLegLengthFrac = legLengthFrac * upperLengthRatio;
  return {
    attachOffsetXFrac,
    attachOffsetYFrac,
    upperLegLengthFrac,
    lowerLegLengthFrac: upperLegLengthFrac * lowerLengthToUpperRatio,
    snapTriggerAngle: Math.PI * gait.snapTriggerAnglePi,
    snapTargetAngle: Math.PI * gait.snapTargetAnglePi,
    snapDistanceMultiplier: gait.snapDistanceMultiplier,
    extensionThreshold: gait.extensionThreshold,
  };
}

const LEG_LAYOUTS: Record<string, LegLayoutEntry[]> = {
  daddy: [
    legLayoutEntry(0.3, -0.2, 10, 0.45, 1.2, LEG_GAIT_FRONT),
    legLayoutEntry(-0.3, -0.3, 10, 0.45, 1.2, LEG_GAIT_REAR),
  ],
  formik: [
    legLayoutEntry(0.42, -0.28, 1.75, 0.52, 1.16, FORMIK_GAITS[0]),
    legLayoutEntry(0.02, -0.36, 1.75, 0.52, 1.16, FORMIK_GAITS[1]),
    legLayoutEntry(-0.48, -0.3, 1.75, 0.52, 1.16, FORMIK_GAITS[2]),
  ],
  tick: [
    legLayoutEntry(0.25, -0.15, 1.0, 0.5, 1.1, LEG_GAIT_FRONT),
    legLayoutEntry(-0.25, -0.15, 1.0, 0.5, 1.1, LEG_GAIT_REAR),
  ],
  commander: [
    legLayoutEntry(0.4, -0.5, 2.2, 0.5, 1.2, LEG_GAIT_FRONT),
    legLayoutEntry(-0.4, -0.5, 2.2, 0.5, 1.2, LEG_GAIT_REAR),
  ],
  tarantula: [
    legLayoutEntry(0.3, -0.2, 1.9, 0.55, 1.2, LEG_GAIT_FRONT),
    legLayoutEntry(-0.3, -0.2, 1.9, 0.55, 1.2, LEG_GAIT_REAR),
  ],
  widow: [
    legLayoutEntry(0.4, -0.4, 1.9, 0.55, 1.2, LEG_GAIT_FRONT),
    legLayoutEntry(-0.4, -0.4, 1.9, 0.55, 1.2, LEG_GAIT_REAR),
  ],
};

const TARANTULA_ABDOMEN_FORWARD_FRAC = -0.65;
const FORMIK_BACK_SEGMENT_FORWARD_FRAC = -0.85;
const TICK_BODY_CENTER_HEIGHT = 8;
const TICK_TURRET_Z_FRAC = TICK_BODY_CENTER_HEIGHT / 10;
const DADDY_VISUAL_RADIUS = 13;
const DADDY_PUSH_RADIUS = 15;
const DADDY_BODY_CENTER_HEIGHT = 60;
const DADDY_LASER_TURRET_Z_FRAC =
  DADDY_BODY_CENTER_HEIGHT / DADDY_VISUAL_RADIUS;
// Daddy's main body is authored high above the ground; this force-field
// mount intentionally uses a >1 radius fraction to sit on its underside.
const DADDY_FORCE_FIELD_TURRET_Z_FRAC = 49 / DADDY_VISUAL_RADIUS;
const DADDY_LEG_ATTACH_HEIGHT_FRAC = DADDY_FORCE_FIELD_TURRET_Z_FRAC;
const LORIS_BODY_CENTER_HEIGHT = 24;
const LORIS_MIRROR_TURRET_Z_FRAC = LORIS_BODY_CENTER_HEIGHT / 10;

function turretMount(
  turretId: TurretId,
  mount: MountOffset,
): TurretMount {
  return { turretId, mount };
}

function mountPoint(x: number, y: number, z: number): MountOffset {
  return { x, y, z };
}

// Compute widow's mount points: 4 light turrets on the abdomen edge,
// the megaBeam centered on top of the rear abdomen segment, and the
// force-field emitter on top of the forward head segment. Order
// matches the `turrets` array on the widow blueprint below.
function computeWidowMounts(): MountOffset[] {
  const mounts: MountOffset[] = [];
  const lightZ = widowTopMountedTurretZFrac(
    'lightTurret',
    WIDOW_ABDOMEN_TOP_Z_FRAC,
  );
  const megaBeamZ = widowTopMountedTurretZFrac(
    'megaBeamTurret',
    WIDOW_ABDOMEN_TOP_Z_FRAC,
  );
  const forceFieldZ = widowTopMountedTurretZFrac(
    'forceTurret',
    WIDOW_HEAD_TOP_Z_FRAC,
  );
  for (let i = 0; i < 4; i++) {
    const angle = Math.PI / 4 + (i * Math.PI) / 2;
    mounts.push({
      x:
        Math.cos(angle) * WIDOW_ABDOMEN_RADIUS_FRAC +
        WIDOW_ABDOMEN_FORWARD_FRAC,
      y: Math.sin(angle) * WIDOW_ABDOMEN_RADIUS_FRAC,
      z: lightZ,
    });
  }
  // megaBeam: rear abdomen segment center, sitting above the body top.
  mounts.push({ x: WIDOW_ABDOMEN_FORWARD_FRAC, y: 0, z: megaBeamZ });
  // forceTurret: forward prosoma/head segment center top.
  mounts.push({ x: WIDOW_HEAD_FORWARD_FRAC, y: 0, z: forceFieldZ });
  return mounts;
}

function computeWidowTurrets(): TurretMount[] {
  const mounts = computeWidowMounts();
  return [
    turretMount('lightTurret', mounts[0]), // front-left abdomen edge
    turretMount('lightTurret', mounts[1]), // back-left abdomen edge
    turretMount('lightTurret', mounts[2]), // back-right abdomen edge
    turretMount('lightTurret', mounts[3]), // front-right abdomen edge
    turretMount('megaBeamTurret', mounts[4]), // abdomen center
    turretMount('forceTurret', mounts[5]), // head center
  ];
}

export const UNIT_BLUEPRINTS: Record<string, UnitBlueprint> = {
  jackal: {
    id: 'jackal',
    name: 'Jackal',
    shortName: 'JKL',
    hp: 55,
    unitRadiusCollider: { shot: 6, push: 8 * 1.2 },
    bodyRadius: 8,
    bodyCenterHeight: getWheelBodyCenterHeightY(BODY_SHAPES.scout, 8, 0.28),
    mass: 30,
    cost: { energy: 50, mana: 50, metal: 50 },
    turrets: [turretMount('lightTurret', mountPoint(0, 0, 1.2))],
    bodyShape: BODY_SHAPES.scout,
    locomotion: {
      type: 'wheels',
      physics: createLocomotionPhysics('wheels', 300),
      config: {
        wheelDistX: 0.6,
        wheelDistY: 0.7,
        treadLength: 0.5,
        treadWidth: 0.15,
        wheelRadius: 0.28,
        rotationSpeed: 1.0,
      },
    },
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
    bodyCenterHeight: getTreadBodyCenterHeightY(BODY_SHAPES.burst, 10),
    mass: 40,
    cost: { energy: 90, mana: 90, metal: 90 },
    turrets: [turretMount('pulseTurret', mountPoint(0, 0, 1.3))],
    bodyShape: BODY_SHAPES.burst,
    locomotion: {
      type: 'treads',
      physics: createLocomotionPhysics('treads', 170),
      config: {
        treadOffset: 0.8,
        treadLength: 1.6,
        treadWidth: 0.45,
        wheelRadius: 0.12,
        rotationSpeed: 1.0,
      },
    },
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
    bodyCenterHeight: DADDY_BODY_CENTER_HEIGHT,
    mass: 30,
    cost: { energy: 350, mana: 350, metal: 350 },
    turrets: [
      turretMount('laserTurret', mountPoint(0, 0, DADDY_LASER_TURRET_Z_FRAC)),
      turretMount(
        'forceTurret',
        mountPoint(0, 0, DADDY_FORCE_FIELD_TURRET_Z_FRAC),
      ),
    ],
    bodyShape: BODY_SHAPES.forceField,
    hideChassis: true,
    legAttachHeightFrac: DADDY_LEG_ATTACH_HEIGHT_FRAC,
    locomotion: {
      type: 'legs',
      physics: createLocomotionPhysics('legs', 200),
      config: {
        upperThickness: 2.5,
        lowerThickness: 2,
        hipRadius: 1.5,
        kneeRadius: 0.8,
        footRadius: 1.8,
        lerpDuration: 200,
        leftSide: LEG_LAYOUTS.daddy,
      },
    },
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
    bodyCenterHeight: getTreadBodyCenterHeightY(BODY_SHAPES.brawl, 16),
    mass: 300,
    cost: { energy: 300, mana: 300, metal: 300 },
    turrets: [turretMount('salvoRocketTurret', mountPoint(0, 0, 1.4))],
    bodyShape: BODY_SHAPES.brawl,
    locomotion: {
      type: 'treads',
      physics: createLocomotionPhysics('treads', 200),
      config: {
        treadOffset: 0.85,
        treadLength: 1.7,
        treadWidth: 0.55,
        wheelRadius: 0.12,
        rotationSpeed: 1.0,
      },
    },
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
    bodyCenterHeight: getWheelBodyCenterHeightY(BODY_SHAPES.mortar, 20, 0.22),
    mass: 200,
    cost: { energy: 220, mana: 220, metal: 220 },
    turrets: [turretMount('mortarTurret', mountPoint(0, 0, 1.2))],
    bodyShape: BODY_SHAPES.mortar,
    locomotion: {
      type: 'wheels',
      physics: createLocomotionPhysics('wheels', 220),
      config: {
        wheelDistX: 0.65,
        wheelDistY: 0.7,
        treadLength: 0.5,
        treadWidth: 0.3,
        wheelRadius: 0.22,
        rotationSpeed: 1.0,
      },
    },
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
    bodyCenterHeight: TICK_BODY_CENTER_HEIGHT,
    mass: 20,
    cost: { energy: 35, mana: 35, metal: 35 },
    turrets: [turretMount('laserTurret', mountPoint(0, 0, TICK_TURRET_Z_FRAC))],
    bodyShape: BODY_SHAPES.snipe,
    hideChassis: true,
    locomotion: {
      type: 'legs',
      physics: createLocomotionPhysics('legs', 120),
      config: {
        upperThickness: 2,
        lowerThickness: 1.5,
        hipRadius: 1,
        kneeRadius: 1.5,
        footRadius: 1,
        lerpDuration: 100,
        leftSide: LEG_LAYOUTS.tick,
      },
    },
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
    bodyCenterHeight: getTreadBodyCenterHeightY(BODY_SHAPES.tank, 24),
    mass: 1000,
    cost: { energy: 1200, mana: 1200, metal: 1200 },
    turrets: [turretMount('cannonTurret', mountPoint(0, 0, 1.5))],
    bodyShape: BODY_SHAPES.tank,
    locomotion: {
      type: 'treads',
      physics: createLocomotionPhysics('treads', 60),
      config: {
        treadOffset: 0.9,
        treadLength: 2.0,
        treadWidth: 0.6,
        wheelRadius: 0.175,
        rotationSpeed: 1.0,
      },
    },
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
    bodyCenterHeight: getLegBodyCenterHeightY(BODY_SHAPES.formik, 40),
    mass: 2500,
    cost: { energy: 4000, mana: 4000, metal: 4000 },
    turrets: [
      turretMount(
        'gatlingMortarTurret',
        mountPoint(FORMIK_BACK_SEGMENT_FORWARD_FRAC, 0, 1.7),
      ),
    ],
    // Mount on the top of the rear abdomen/back segment. The forward
    // head sphere remains a body part, not a turret replacement.
    bodyShape: BODY_SHAPES.formik,
    locomotion: {
      type: 'legs',
      physics: createLocomotionPhysics('legs', 60),
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
        leftSide: LEG_LAYOUTS.formik,
      },
    },
    deathSound: AUDIO.event.death.formik,
    fightStopEngagedRatio: 0.9,
  },
  widow: {
    id: 'widow',
    name: 'Widow',
    shortName: 'WDW',
    hp: 2400,
    unitRadiusCollider: { shot: 40, push: 40 * 1.3 },
    bodyRadius: WIDOW_BODY_RADIUS,
    bodyCenterHeight: getLegBodyCenterHeightY(
      BODY_SHAPES.arachnid,
      WIDOW_BODY_RADIUS,
    ),
    mass: 1000,
    cost: { energy: 3000, mana: 3000, metal: 3000 },
    turrets: computeWidowTurrets(),
    bodyShape: BODY_SHAPES.arachnid,
    locomotion: {
      type: 'legs',
      physics: createLocomotionPhysics('legs', 70),
      config: {
        upperThickness: 7,
        lowerThickness: 6,
        hipRadius: 4,
        kneeRadius: 6,
        footRadius: 3.5,
        lerpDuration: 300,
        leftSide: LEG_LAYOUTS.widow,
      },
    },
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
    bodyCenterHeight: getTreadBodyCenterHeightY(BODY_SHAPES.hippo, 30),
    mass: 1500,
    cost: { energy: 2500, mana: 2500, metal: 2500 },
    turrets: [turretMount('hippoGatlingTurret', mountPoint(0.2, 0, 1.8))],
    bodyShape: BODY_SHAPES.hippo,
    locomotion: {
      type: 'treads',
      physics: createLocomotionPhysics('treads', 55),
      config: {
        treadOffset: 1.1,
        treadLength: 2.6,
        treadWidth: 0.55,
        wheelRadius: 0.2,
        rotationSpeed: 1.0,
      },
    },
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
    bodyCenterHeight: getLegBodyCenterHeightY(BODY_SHAPES.beam, 11),
    mass: 30,
    cost: { energy: 300, mana: 300, metal: 300 },
    turrets: [
      turretMount(
        'beamTurret',
        mountPoint(TARANTULA_ABDOMEN_FORWARD_FRAC, 0, 1.8),
      ),
    ],
    // Mount the beam turret on the rear abdomen segment; the forward
    // head body sphere stays in place.
    bodyShape: BODY_SHAPES.beam,
    locomotion: {
      type: 'legs',
      physics: createLocomotionPhysics('legs', 200),
      config: {
        upperThickness: 6.5,
        lowerThickness: 6,
        hipRadius: 3.5,
        kneeRadius: 6,
        footRadius: 1.5,
        lerpDuration: 200,
        leftSide: LEG_LAYOUTS.tarantula,
      },
    },
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
    bodyCenterHeight: LORIS_BODY_CENTER_HEIGHT,
    mass: 90,
    cost: { energy: 190, mana: 190, metal: 190 },
    turrets: [
      turretMount('mirrorTurret', mountPoint(0, 0, LORIS_MIRROR_TURRET_Z_FRAC)),
    ],
    bodyShape: BODY_SHAPES.loris,
    hideChassis: true,
    locomotion: {
      type: 'treads',
      physics: createLocomotionPhysics('treads', 160),
      config: {
        treadOffset: 0.85,
        treadLength: 1.7,
        treadWidth: 0.5,
        wheelRadius: 0.12,
        rotationSpeed: 1.0,
      },
    },
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
    bodyCenterHeight: getLegBodyCenterHeightY(BODY_SHAPES.commander, 20),
    mass: 300,
    cost: { energy: 400, mana: 400, metal: 400 },
    turrets: [
      turretMount('beamTurret', mountPoint(0.36, -0.42, 1)),
      turretMount('dgunTurret', mountPoint(0.36, 0.42, 1)),
    ],
    bodyShape: BODY_SHAPES.commander,
    locomotion: {
      type: 'legs',
      physics: createLocomotionPhysics('legs', 200),
      config: {
        upperThickness: 8,
        lowerThickness: 7,
        hipRadius: 5,
        kneeRadius: 7,
        footRadius: 5,
        lerpDuration: 200,
        leftSide: LEG_LAYOUTS.commander,
      },
    },
    builder: { buildRange: 150, constructionRate: 50 },
    dgun: { turretId: 'dgunTurret', energyCost: 200 },
    deathSound: AUDIO.event.death.commander,
    fightStopEngagedRatio: 0.9,
  },
};

for (const bp of Object.values(UNIT_BLUEPRINTS)) {
  const expectedBodyCenterHeight = getExpectedUnitBodyCenterHeightY(
    bp,
    bp.bodyRadius,
  );
  if (
    !Number.isFinite(bp.bodyCenterHeight) ||
    Math.abs(bp.bodyCenterHeight - expectedBodyCenterHeight) > 1e-6
  ) {
    throw new Error(
      `Invalid bodyCenterHeight for ${bp.id}: expected ${expectedBodyCenterHeight}, got ${bp.bodyCenterHeight}`,
    );
  }

  if (bp.locomotion.type === 'legs') {
    const legs = bp.locomotion.config.leftSide;
    if (!Array.isArray(legs) || legs.length === 0) {
      throw new Error(
        `Invalid leg layout for ${bp.id}: leftSide must define at least one leg`,
      );
    }
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const values = [
        ['attachOffsetXFrac', leg.attachOffsetXFrac],
        ['attachOffsetYFrac', leg.attachOffsetYFrac],
        ['upperLegLengthFrac', leg.upperLegLengthFrac],
        ['lowerLegLengthFrac', leg.lowerLegLengthFrac],
        ['snapTriggerAngle', leg.snapTriggerAngle],
        ['snapTargetAngle', leg.snapTargetAngle],
        ['snapDistanceMultiplier', leg.snapDistanceMultiplier],
        ['extensionThreshold', leg.extensionThreshold],
      ] as const;
      for (const [name, value] of values) {
        if (!Number.isFinite(value)) {
          throw new Error(
            `Invalid leg layout for ${bp.id}[${i}]: ${name} must be finite`,
          );
        }
      }
      if (leg.upperLegLengthFrac <= 0 || leg.lowerLegLengthFrac <= 0) {
        throw new Error(
          `Invalid leg layout for ${bp.id}[${i}]: leg lengths must be positive`,
        );
      }
      if (leg.snapDistanceMultiplier <= 0 || leg.extensionThreshold <= 0) {
        throw new Error(
          `Invalid leg layout for ${bp.id}[${i}]: snapDistanceMultiplier and extensionThreshold must be positive`,
        );
      }
    }
  }

  // Mount-finiteness only — cross-blueprint turret-ID validation runs
  // in blueprints/index.ts where both UNIT_BLUEPRINTS and
  // TURRET_BLUEPRINTS are visible.
  for (let i = 0; i < bp.turrets.length; i++) {
    const turret = bp.turrets[i];
    const mount = turret.mount;
    if (
      !Number.isFinite(mount.x) ||
      !Number.isFinite(mount.y) ||
      !Number.isFinite(mount.z)
    ) {
      throw new Error(
        `Invalid turret mount for ${bp.id}[${i}] ${turret.turretId}: mount x/y/z must be finite`,
      );
    }
  }

  if (bp.dgun) {
    if (!bp.turrets.some((turret) => turret.turretId === bp.dgun!.turretId)) {
      throw new Error(
        `Invalid dgun turret for ${bp.id}: ${bp.dgun.turretId} is not mounted on the unit`,
      );
    }
  }
}

export function getUnitBlueprint(id: string): UnitBlueprint {
  const unitBlueprint = UNIT_BLUEPRINTS[id];
  if (!unitBlueprint) throw new Error(`Unknown unit blueprint: ${id}`);
  return unitBlueprint;
}

export function getUnitLocomotion(id: string): UnitLocomotion {
  return createUnitLocomotion(getUnitBlueprint(id).locomotion);
}

export function getAllUnitBlueprints(): UnitBlueprint[] {
  return Object.values(UNIT_BLUEPRINTS);
}

// Normalized cost: total per-build cost / max total across buildables.
// "Total" is the sum across the three resource axes — gives a single
// scalar for UI rank/scale display while honouring per-resource costs.
let _costNormCache: { max: number } | null = null;

function totalCost(c: { energy: number; mana: number; metal: number }): number {
  return c.energy + c.mana + c.metal;
}

function getCostNorm(): { max: number } {
  if (_costNormCache) return _costNormCache;
  let max = 0;
  for (const id of BUILDABLE_UNIT_IDS) {
    const unitBlueprint = UNIT_BLUEPRINTS[id];
    if (!unitBlueprint) continue;
    const t = totalCost(unitBlueprint.cost);
    if (t > max) max = t;
  }
  _costNormCache = { max };
  return _costNormCache;
}

export function getNormalizedUnitCost(unitBlueprint: {
  cost: { energy: number; mana: number; metal: number };
}): number {
  const { max } = getCostNorm();
  return max > 0 ? totalCost(unitBlueprint.cost) / max : 0;
}
