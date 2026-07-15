import {
  GRAVITY,
  UNIT_LOCOMOTION_FORCE_REFERENCE_MASS,
  UNIT_MASS_MULTIPLIER,
  UNIT_THRUST_MULTIPLIER_GAME,
} from '../../config';
import { getSimWasm } from '../sim-wasm/init';
import type { UnitLocomotion } from './types';
import { resolveLocomotionRouteCapabilities } from './locomotionNavigation';
import { LOCOMOTION_FORCE_SCALE } from './locomotionPresetConfig';
import {
  PATHFINDING_FORCE_SAFETY_RATIO,
  PATHFINDING_STABILITY_MAX_SLOPE_DEG,
} from './pathfindingTuning';

type LocomotionClimbProfile = {
  readonly maxSlopeDeg: number | null;
  readonly minSurfaceNormalZ: number | null;
  readonly safeDriveAccel: number;
  readonly driveLimitedSlopeDeg: number | null;
  readonly gripLimitedSlopeDeg: number | null;
  readonly stabilityLimitedSlopeDeg: number | null;
  /** Dry-ground tangential acceleration after the authoritative drive-force
   *  and Coulomb-grip clamp. */
  readonly flatDriveAccel: number | null;
  readonly allowOnGround: boolean;
  readonly allowInWater: boolean;
  readonly allowInAir: boolean;
};

const climbProfileOut = new Float64Array(7);

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

export function computeLocomotionClimbProfile(
  locomotion: UnitLocomotion,
  mass: number,
  thrustMultiplier = UNIT_THRUST_MULTIPLIER_GAME,
): LocomotionClimbProfile {
  const groundPhysics = locomotion.physics.ground;
  const { allowOnGround, allowInWater, allowInAir } =
    resolveLocomotionRouteCapabilities(locomotion);
  if (!Number.isFinite(mass) || mass <= 0) {
    throw new Error(`Invalid pathfinding mobility mass: expected positive finite number, got ${mass}`);
  }
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('Pathfinding mobility requires the authoritative simulation WASM to be initialized');
  }
  const computed = sim.pathfinder.computeLocomotionClimbProfile(
    groundPhysics.propulsion.driveForce,
    groundPhysics.propulsion.forceCoupling,
    groundPhysics.contact.surfaceGrip,
    mass,
    thrustMultiplier,
    LOCOMOTION_FORCE_SCALE,
    UNIT_LOCOMOTION_FORCE_REFERENCE_MASS,
    UNIT_MASS_MULTIPLIER,
    GRAVITY,
    PATHFINDING_FORCE_SAFETY_RATIO,
    PATHFINDING_STABILITY_MAX_SLOPE_DEG,
    allowOnGround,
    allowInAir,
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
    gripLimitedSlopeDeg: finiteOrNull(climbProfileOut[4]),
    stabilityLimitedSlopeDeg: finiteOrNull(climbProfileOut[5]),
    flatDriveAccel: finiteOrNull(climbProfileOut[6]),
    allowOnGround,
    allowInWater,
    allowInAir,
  };
}

export function minSurfaceNormalZForLocomotion(
  locomotion: UnitLocomotion,
  mass: number,
): number | null {
  return computeLocomotionClimbProfile(locomotion, mass).minSurfaceNormalZ;
}
