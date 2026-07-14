// Homing guidance primitives.
//
// Rockets use bounded thrust acceleration: the engine pushes velocity
// toward the predicted intercept and spends thrust budget on any
// caller-provided gravity compensation.
//
// Missiles use constant-speed velocity rotation: guidance turns the
// velocity vector toward the predicted intercept without changing its
// magnitude.
//
// Both paths dispatch into the authoritative Rust/WASM projectile module.

import { getSimWasm } from '../sim-wasm/init';

type HomingThrustResult = {
  thrustX: number;
  thrustY: number;
  thrustZ: number;
};

type ConstantSpeedHomingVelocityResult = {
  velocityX: number;
  velocityY: number;
  velocityZ: number;
};

// Reusable output to avoid per-call allocations in a hot path.
const _htOut: HomingThrustResult = { thrustX: 0, thrustY: 0, thrustZ: 0 };
const _constantSpeedOut: ConstantSpeedHomingVelocityResult = {
  velocityX: 0,
  velocityY: 0,
  velocityZ: 0,
};
// Module-scope scratch for the WASM dispatch — written by Rust into
// (thrustX, thrustY, thrustZ) at indices 0..3.
const _htWasmScratch = new Float64Array(3);

/**
 * Compute the thrust acceleration vector a guided projectile applies
 * this tick. The result combines lateral steering toward the target
 * with the caller-provided gravity compensation term, bounded by the
 * projectile's max thrust acceleration. Pass `gravity = 0` only for
 * callers that genuinely have no gravity to counter.
 */
export function computeHomingThrust(
  velX: number, velY: number, velZ: number,
  targetX: number, targetY: number, targetZ: number,
  currentX: number, currentY: number, currentZ: number,
  homingTurnRate: number,
  maxThrustAccel: number,
  gravity: number,
  dtSec: number,
): HomingThrustResult {
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('Homing thrust requires initialized sim-wasm');
  }
  sim.computeHomingThrust(
    _htWasmScratch,
    velX, velY, velZ,
    targetX, targetY, targetZ,
    currentX, currentY, currentZ,
    homingTurnRate, maxThrustAccel, gravity, dtSec,
  );
  _htOut.thrustX = _htWasmScratch[0];
  _htOut.thrustY = _htWasmScratch[1];
  _htOut.thrustZ = _htWasmScratch[2];
  return _htOut;
}

/**
 * Rotate a missile velocity toward the target without changing its
 * speed. This is the missile-class guidance primitive, separate from
 * rocket thrust.
 */
export function computeConstantSpeedHomingVelocity(
  velX: number, velY: number, velZ: number,
  targetX: number, targetY: number, targetZ: number,
  currentX: number, currentY: number, currentZ: number,
  homingTurnRate: number,
  dtSec: number,
): ConstantSpeedHomingVelocityResult {
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('Constant-speed homing requires initialized sim-wasm');
  }
  sim.computeConstantSpeedHomingVelocity(
    _htWasmScratch,
    velX, velY, velZ,
    targetX, targetY, targetZ,
    currentX, currentY, currentZ,
    homingTurnRate, dtSec,
  );
  _constantSpeedOut.velocityX = _htWasmScratch[0];
  _constantSpeedOut.velocityY = _htWasmScratch[1];
  _constantSpeedOut.velocityZ = _htWasmScratch[2];
  return _constantSpeedOut;
}
