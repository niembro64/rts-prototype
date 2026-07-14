import {
  GRAVITY,
  UNIT_LOCOMOTION_FORCE_REFERENCE_MASS,
  UNIT_MASS_MULTIPLIER,
  UNIT_THRUST_MULTIPLIER_GAME,
} from '../../config';
import { getSimWasm } from '../sim-wasm/init';
import type { UnitLocomotion } from './types';
import { LOCOMOTION_FORCE_SCALE } from './locomotion';
import {
  PATHFINDING_FORCE_SAFETY_RATIO,
  PATHFINDING_STABILITY_MAX_SLOPE_DEG,
} from './pathfindingTuning';

type LocomotionClimbProfile = {
  readonly maxSlopeDeg: number | null;
  readonly minSurfaceNormalZ: number | null;
  readonly safeDriveAccel: number;
  readonly driveLimitedSlopeDeg: number | null;
  readonly tractionLimitedSlopeDeg: number | null;
  readonly stabilityLimitedSlopeDeg: number | null;
  readonly allowGround: boolean;
  readonly allowWater: boolean;
  readonly allowAir: boolean;
};

const climbProfileOut = new Float64Array(6);

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

export function computeLocomotionClimbProfile(
  locomotion: UnitLocomotion,
  mass: number,
  thrustMultiplier = UNIT_THRUST_MULTIPLIER_GAME,
): LocomotionClimbProfile {
  const groundPhysics = locomotion.physics.ground;
  const allowGround = locomotion.navigation.allowGround;
  const allowWater = locomotion.navigation.allowWater;
  const allowAir = locomotion.navigation.allowAir;
  if (!Number.isFinite(mass) || mass <= 0) {
    throw new Error(`Invalid pathfinding mobility mass: expected positive finite number, got ${mass}`);
  }
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('Pathfinding mobility requires the authoritative simulation WASM to be initialized');
  }
  const computed = sim.pathfinder.computeLocomotionClimbProfile(
    groundPhysics.force,
    groundPhysics.traction,
    groundPhysics.surfaceGrip,
    mass,
    thrustMultiplier,
    LOCOMOTION_FORCE_SCALE,
    UNIT_LOCOMOTION_FORCE_REFERENCE_MASS,
    UNIT_MASS_MULTIPLIER,
    GRAVITY,
    PATHFINDING_FORCE_SAFETY_RATIO,
    PATHFINDING_STABILITY_MAX_SLOPE_DEG,
    allowGround,
    allowAir,
    climbProfileOut,
  );
  if (computed !== 1) {
    throw new Error(`WASM rejected pathfinding mobility inputs for mass ${mass}`);
  }

  return {
    maxSlopeDeg: finiteOrNull(climbProfileOut[0]),
    minSurfaceNormalZ: finiteOrNull(climbProfileOut[1]),
    safeDriveAccel: climbProfileOut[2],
    driveLimitedSlopeDeg: finiteOrNull(climbProfileOut[3]),
    tractionLimitedSlopeDeg: finiteOrNull(climbProfileOut[4]),
    stabilityLimitedSlopeDeg: finiteOrNull(climbProfileOut[5]),
    allowGround,
    allowWater,
    allowAir,
  };
}

export function minSurfaceNormalZForLocomotion(
  locomotion: UnitLocomotion,
  mass: number,
): number | null {
  return computeLocomotionClimbProfile(locomotion, mass).minSurfaceNormalZ;
}
