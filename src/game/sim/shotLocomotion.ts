import type {
  ShotLocomotion,
  ShotLocomotionMediumPhysics,
  ShotLocomotionMotionModel,
  ShotLocomotionTerminalOutcome,
  ShotLocomotionTransitionOutcome,
} from '@/types/shotTypes';
import rawShotLocomotionConfig from './shotLocomotionConfig.json';

const MOTION_MODELS: readonly ShotLocomotionMotionModel[] = [
  'ballistic',
  'thrustGuided',
  'constantSpeedGuided',
  'terrainFollowing',
];
const TERMINAL_OUTCOMES: readonly ShotLocomotionTerminalOutcome[] = ['detonate', 'despawn'];
const TRANSITION_OUTCOMES: readonly ShotLocomotionTransitionOutcome[] = [
  'continue',
  'continueBallistic',
  'detonate',
  'despawn',
];

type ShotLocomotionConfig = {
  presets: Record<string, Omit<ShotLocomotion, 'presetId'>>;
};

function assertObject(label: string, value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid shotLocomotionConfig.json: expected ${label} object`);
  }
}

function assertExactKeys(
  label: string,
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const expectedSet = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) {
      throw new Error(`Invalid shotLocomotionConfig.json: unexpected ${label}.${key}`);
    }
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`Invalid shotLocomotionConfig.json: missing ${label}.${key}`);
    }
  }
}

function assertBoolean(label: string, value: unknown): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid shot locomotion ${label}: expected boolean`);
  }
}

function assertNonNegativeFinite(label: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid shot locomotion ${label}: expected finite >= 0, got ${String(value)}`);
  }
}

function assertMedium(
  presetId: string,
  mediumName: 'air' | 'water',
  value: unknown,
): asserts value is ShotLocomotionMediumPhysics {
  const label = `presets.${presetId}.media.${mediumName}`;
  assertObject(label, value);
  assertExactKeys(label, value, [
    'operational',
    'propulsionForce',
    'guidanceThrust',
    'turnRate',
    'velocityFrictionPer60HzFrame',
  ]);
  assertBoolean(`${label}.operational`, value.operational);
  assertNonNegativeFinite(`${label}.propulsionForce`, value.propulsionForce);
  assertNonNegativeFinite(`${label}.guidanceThrust`, value.guidanceThrust);
  assertNonNegativeFinite(`${label}.turnRate`, value.turnRate);
  assertNonNegativeFinite(
    `${label}.velocityFrictionPer60HzFrame`,
    value.velocityFrictionPer60HzFrame,
  );
  if ((value.velocityFrictionPer60HzFrame as number) >= 1) {
    throw new Error(
      `Invalid shot locomotion ${label}.velocityFrictionPer60HzFrame: expected < 1`,
    );
  }
  if (
    value.operational === false &&
    (value.propulsionForce !== 0 || value.guidanceThrust !== 0 || value.turnRate !== 0 ||
      value.velocityFrictionPer60HzFrame !== 0)
  ) {
    throw new Error(
      `Invalid shot locomotion ${label}: non-operational media must author zero motion authority`,
    );
  }
}

function validatePreset(presetId: string, value: unknown): ShotLocomotion {
  const label = `presets.${presetId}`;
  assertObject(label, value);
  assertExactKeys(label, value, [
    'motionModel',
    'maxLifespanMs',
    'gravityForceMultiplier',
    'guidanceDelayMs',
    'media',
    'transitions',
    'terminal',
  ]);
  if (!MOTION_MODELS.includes(value.motionModel as ShotLocomotionMotionModel)) {
    throw new Error(`Invalid shot locomotion ${label}.motionModel: ${String(value.motionModel)}`);
  }
  if (value.maxLifespanMs !== null) {
    assertNonNegativeFinite(`${label}.maxLifespanMs`, value.maxLifespanMs);
    if (value.maxLifespanMs === 0) {
      throw new Error(`Invalid shot locomotion ${label}.maxLifespanMs: expected positive or null`);
    }
  }
  assertNonNegativeFinite(`${label}.gravityForceMultiplier`, value.gravityForceMultiplier);
  assertNonNegativeFinite(`${label}.guidanceDelayMs`, value.guidanceDelayMs);

  assertObject(`${label}.media`, value.media);
  assertExactKeys(`${label}.media`, value.media, ['air', 'water', 'ground']);
  assertMedium(presetId, 'air', value.media.air);
  assertMedium(presetId, 'water', value.media.water);
  assertObject(`${label}.media.ground`, value.media.ground);
  assertExactKeys(`${label}.media.ground`, value.media.ground, ['mode']);
  if (value.media.ground.mode !== 'impact' && value.media.ground.mode !== 'terrainFollowing') {
    throw new Error(`Invalid shot locomotion ${label}.media.ground.mode`);
  }

  assertObject(`${label}.transitions`, value.transitions);
  assertExactKeys(`${label}.transitions`, value.transitions, ['enterWater', 'exitWater']);
  for (const transition of ['enterWater', 'exitWater'] as const) {
    if (!TRANSITION_OUTCOMES.includes(value.transitions[transition] as ShotLocomotionTransitionOutcome)) {
      throw new Error(`Invalid shot locomotion ${label}.transitions.${transition}`);
    }
  }

  assertObject(`${label}.terminal`, value.terminal);
  assertExactKeys(`${label}.terminal`, value.terminal, [
    'entityImpact',
    'groundContact',
    'expiry',
    'destroyed',
    'reflectorImpact',
  ]);
  for (const event of [
    'entityImpact',
    'groundContact',
    'expiry',
    'destroyed',
    'reflectorImpact',
  ] as const) {
    if (!TERMINAL_OUTCOMES.includes(value.terminal[event] as ShotLocomotionTerminalOutcome)) {
      throw new Error(`Invalid shot locomotion ${label}.terminal.${event}`);
    }
  }

  const motionModel = value.motionModel as ShotLocomotionMotionModel;
  const media = value.media as unknown as ShotLocomotion['media'];
  const operationalMedia = [media.air, media.water].filter((medium) => medium.operational);
  if (operationalMedia.length === 0 && value.media.ground.mode !== 'terrainFollowing') {
    throw new Error(`Invalid shot locomotion ${label}: no operational movement domain`);
  }
  if (motionModel === 'ballistic') {
    for (const medium of operationalMedia) {
      if (medium.propulsionForce !== 0 || medium.guidanceThrust !== 0 || medium.turnRate !== 0) {
        throw new Error(`Invalid shot locomotion ${label}: ballistic presets cannot author engines`);
      }
    }
  }
  if (motionModel === 'thrustGuided') {
    for (const medium of operationalMedia) {
      if (medium.guidanceThrust <= 0 || medium.turnRate <= 0) {
        throw new Error(
          `Invalid shot locomotion ${label}: thrustGuided operational media need guidance thrust and turn rate`,
        );
      }
    }
  }
  if (motionModel === 'constantSpeedGuided') {
    if (value.gravityForceMultiplier !== 0) {
      throw new Error(`Invalid shot locomotion ${label}: constant-speed guidance requires zero gravity`);
    }
    for (const medium of operationalMedia) {
      if (
        medium.turnRate <= 0 || medium.propulsionForce !== 0 ||
        medium.guidanceThrust !== 0 || medium.velocityFrictionPer60HzFrame !== 0
      ) {
        throw new Error(
          `Invalid shot locomotion ${label}: constant-speed guidance needs turn rate without thrust or drag`,
        );
      }
    }
  }

  const authored = value as unknown as Omit<ShotLocomotion, 'presetId'>;
  return cloneShotLocomotion({ ...authored, presetId });
}

function readShotLocomotionConfig(): Record<string, ShotLocomotion> {
  const config = rawShotLocomotionConfig as unknown as Partial<ShotLocomotionConfig>;
  assertObject('root', config);
  assertExactKeys('root', config, ['presets']);
  assertObject('presets', config.presets);
  const presets: Record<string, ShotLocomotion> = {};
  for (const [presetId, value] of Object.entries(config.presets)) {
    presets[presetId] = validatePreset(presetId, value);
  }
  return presets;
}

export function cloneShotLocomotion(locomotion: ShotLocomotion): ShotLocomotion {
  return {
    ...locomotion,
    media: {
      air: { ...locomotion.media.air },
      water: { ...locomotion.media.water },
      ground: { ...locomotion.media.ground },
    },
    transitions: { ...locomotion.transitions },
    terminal: { ...locomotion.terminal },
  };
}

const SHOT_LOCOMOTION_PRESETS = readShotLocomotionConfig();

export function getShotLocomotionPreset(presetId: string): ShotLocomotion {
  const preset = SHOT_LOCOMOTION_PRESETS[presetId];
  if (preset === undefined) {
    throw new Error(`Invalid shotLocomotionPresetId "${presetId}"`);
  }
  return cloneShotLocomotion(preset);
}

export function getShotLocomotionMediumAtHeight(
  locomotion: ShotLocomotion,
  z: number,
  waterLevel: number,
): ShotLocomotionMediumPhysics {
  return z <= waterLevel ? locomotion.media.water : locomotion.media.air;
}

export function shotLocomotionPhysicsAppliesAtHeight(
  locomotion: ShotLocomotion,
  z: number,
  waterLevel: number,
): boolean {
  return getShotLocomotionMediumAtHeight(locomotion, z, waterLevel).operational;
}

export function shotLocomotionCanOperateInWater(locomotion: ShotLocomotion): boolean {
  return locomotion.media.water.operational;
}

export function shotLocomotionUsesBallisticFeasibility(locomotion: ShotLocomotion): boolean {
  return locomotion.motionModel === 'ballistic';
}

export function getShotLocomotionMaxTurnRate(locomotion: ShotLocomotion): number {
  return Math.max(
    locomotion.media.air.operational ? locomotion.media.air.turnRate : 0,
    locomotion.media.water.operational ? locomotion.media.water.turnRate : 0,
  );
}

export function getShotLocomotionMaxLifespan(locomotion: ShotLocomotion): number {
  return locomotion.maxLifespanMs === null ? Infinity : locomotion.maxLifespanMs;
}

/** Conservative straight-line reach envelope used to cap authored turret
 *  range for powered/guided shots. Ballistic shots use the trajectory solver. */
export function getPoweredShotReachabilityDistance(
  locomotion: ShotLocomotion,
  medium: ShotLocomotionMediumPhysics,
  launchSpeed: number,
  projectileMass: number,
): number {
  if (locomotion.motionModel === 'ballistic') return Infinity;
  if (!medium.operational) return 0;
  const lifespanMs = locomotion.maxLifespanMs;
  if (lifespanMs === null) return Infinity;
  const timeSec = lifespanMs / 1000;
  const initialSpeed = Number.isFinite(launchSpeed) ? Math.max(0, launchSpeed) : 0;
  if (locomotion.motionModel === 'constantSpeedGuided') {
    return initialSpeed * timeSec;
  }
  const propulsionAcceleration =
    Number.isFinite(projectileMass) && projectileMass > 0
      ? medium.propulsionForce / projectileMass
      : 0;
  return initialSpeed * timeSec + 0.5 * propulsionAcceleration * timeSec * timeSec;
}

/** Returns the swept-segment fraction at which a shot crosses the water surface. */
export function getShotWaterSurfaceCrossingFraction(
  previousZ: number,
  currentZ: number,
  waterLevel: number,
): number | null {
  const enteringWater = previousZ > waterLevel && currentZ <= waterLevel;
  const exitingWater = previousZ <= waterLevel && currentZ > waterLevel;
  if (!enteringWater && !exitingWater) return null;
  const dz = currentZ - previousZ;
  if (!Number.isFinite(dz) || Math.abs(dz) <= 1e-12) return 0;
  return Math.max(0, Math.min(1, (waterLevel - previousZ) / dz));
}
