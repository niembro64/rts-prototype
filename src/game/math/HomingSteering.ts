// Homing thrust — compute the bounded steering acceleration vector a
// guided projectile applies this tick. Replaces the earlier velocity-
// rotation primitive: instead of pretending the missile rotates its
// velocity at constant speed, we treat the engine as a real force-
// producer.
//
// The thrust vector pushes velocity toward the predicted intercept at
// the projectile's authored angular rate (centripetal accel `ω · |v|`
// perpendicular to v, in the v→d plane). Callers pass the projectile's
// effective gravity. Guided projectiles that should hold altitude pass
// the world gravity so their engine spends thrust budget on
// counter-gravity.
//
// The whole vector is then clamped to the projectile's available
// thrust acceleration (`homingThrust / mass`). The caller integrates
// the returned thrust together with its own projectile gravity.

import { getSimWasm } from '../sim-wasm/init';

export type HomingThrustResult = {
  thrustX: number;
  thrustY: number;
  thrustZ: number;
};

// Reusable output to avoid per-call allocations in a hot path.
const _htOut: HomingThrustResult = { thrustX: 0, thrustY: 0, thrustZ: 0 };
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
