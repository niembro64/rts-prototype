import type { LegLayoutEntry, LocomotionBlueprint } from './types';
import { createLocomotionPhysics } from '../locomotion';

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

export const UNIT_LOCOMOTION_BLUEPRINTS = {
  jackal: {
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
  lynx: {
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
  daddy: {
    type: 'legs',
    physics: createLocomotionPhysics('legs', 200),
    config: {
      upperThickness: 2.5,
      lowerThickness: 2,
      hipRadius: 1.5,
      kneeRadius: 0.8,
      lerpDuration: 200,
      leftSide: LEG_LAYOUTS.daddy,
    },
  },
  badger: {
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
  mongoose: {
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
  tick: {
    type: 'legs',
    physics: createLocomotionPhysics('legs', 120, {
      springStiffness: 10_000,
      compression: 15,
      powerRandomMultiplier: 0.95,
      horizontalRandomMultiplier: 0.35,
      mode: 'always',
      // Roll a 2% chance per server tick (60 TPS) to actually release
      // the spring while the rest of the conditions hold. Mean spacing
      // between hops is ~50 ticks (~0.83 s) so the tick fidgets in
      // place instead of pogo-sticking every landing.
      releaseChancePerTick: 0.02,
    }),
    config: {
      upperThickness: 2,
      lowerThickness: 1.5,
      hipRadius: 1,
      kneeRadius: 1.5,
      lerpDuration: 100,
      leftSide: LEG_LAYOUTS.tick,
    },
  },
  mammoth: {
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
  formik: {
    type: 'legs',
    physics: createLocomotionPhysics('legs', 60),
    config: {
      upperThickness: 9,
      lowerThickness: 8,
      hipRadius: 5.5,
      kneeRadius: 7.5,
      lerpDuration: 320,
      leftSide: LEG_LAYOUTS.formik,
    },
  },
  widow: {
    type: 'legs',
    physics: createLocomotionPhysics('legs', 70),
    config: {
      upperThickness: 7,
      lowerThickness: 6,
      hipRadius: 4,
      kneeRadius: 6,
      lerpDuration: 300,
      leftSide: LEG_LAYOUTS.widow,
    },
  },
  hippo: {
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
  tarantula: {
    type: 'legs',
    physics: createLocomotionPhysics('legs', 200),
    config: {
      upperThickness: 6.5,
      lowerThickness: 6,
      hipRadius: 3.5,
      kneeRadius: 6,
      lerpDuration: 200,
      leftSide: LEG_LAYOUTS.tarantula,
    },
  },
  loris: {
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
  commander: {
    type: 'legs',
    physics: createLocomotionPhysics('legs', 50),
    config: {
      upperThickness: 8,
      lowerThickness: 7,
      hipRadius: 5,
      kneeRadius: 7,
      lerpDuration: 200,
      leftSide: LEG_LAYOUTS.commander,
    },
  },
} satisfies Record<string, LocomotionBlueprint>;
