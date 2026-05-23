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

import { magnitude3 } from './MathHelpers';
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
  if (sim !== undefined) {
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
  return computeHomingThrustTs(
    velX, velY, velZ,
    targetX, targetY, targetZ,
    currentX, currentY, currentZ,
    homingTurnRate, maxThrustAccel, gravity, dtSec,
  );
}

function computeHomingThrustTs(
  velX: number, velY: number, velZ: number,
  targetX: number, targetY: number, targetZ: number,
  currentX: number, currentY: number, currentZ: number,
  homingTurnRate: number,
  maxThrustAccel: number,
  gravity: number,
  dtSec: number,
): HomingThrustResult {
  _htOut.thrustX = 0;
  _htOut.thrustY = 0;
  _htOut.thrustZ = 0;

  // Spent / failed guidance: no thrust this tick. The caller still
  // integrates whatever projectile gravity applies to this shot.
  if (maxThrustAccel <= 0 || dtSec <= 0) return _htOut;

  const dx = targetX - currentX;
  const dy = targetY - currentY;
  const dz = targetZ - currentZ;
  const dMag = magnitude3(dx, dy, dz);
  const speed = magnitude3(velX, velY, velZ);

  // Lateral steering direction: unit vector perpendicular to v in the
  // plane of v and d, pointing toward d (Gram-Schmidt). Magnitude is
  // ω · |v| (centripetal acceleration for a turn at ω rad/s), bounded
  // by θ / dt so we don't overshoot the angle this tick.
  let perpX = 0;
  let perpY = 0;
  let perpZ = 0;
  let theta = 0;

  if (dMag > 1e-6) {
    const invDMag = 1 / dMag;
    const dxN = dx * invDMag;
    const dyN = dy * invDMag;
    const dzN = dz * invDMag;

    if (speed > 1e-6) {
      const invSpeed = 1 / speed;
      const vxN = velX * invSpeed;
      const vyN = velY * invSpeed;
      const vzN = velZ * invSpeed;
      let cosA = vxN * dxN + vyN * dyN + vzN * dzN;
      if (cosA > 1) cosA = 1;
      else if (cosA < -1) cosA = -1;
      theta = Math.acos(cosA);

      // perp = d̂ − (d̂·v̂)·v̂, normalized
      let pX = dxN - cosA * vxN;
      let pY = dyN - cosA * vyN;
      let pZ = dzN - cosA * vzN;
      const pMag = magnitude3(pX, pY, pZ);
      if (pMag > 1e-6) {
        perpX = pX / pMag;
        perpY = pY / pMag;
        perpZ = pZ / pMag;
      } else if (cosA < 0) {
        // v̂ and d̂ are (nearly) anti-parallel — the Gram-Schmidt
        // residual collapses. Pick a stable horizontal perpendicular
        // (rotate v in the world xy-plane) so the rocket starts
        // pivoting instead of sitting on the anti-parallel axis.
        const xyMag = Math.hypot(vxN, vyN);
        if (xyMag > 0.05) {
          perpX = -vyN / xyMag;
          perpY = vxN / xyMag;
          perpZ = 0;
        } else {
          // Velocity is essentially vertical — fall back to world +x.
          perpX = 1;
          perpY = 0;
          perpZ = 0;
        }
        theta = Math.PI;
      }
      // (cosA ≈ +1: already aligned, theta ≈ 0, no lateral thrust needed.)
    }
    // Zero-velocity edge case: leave perp = 0 and let any caller-
    // provided gravity compensation define the thrust direction.
  }

  // Bounded effective turn rate: ω, capped at θ/dt so we exactly close
  // small angles without overshooting them next tick.
  const omegaEff = Math.min(homingTurnRate, theta / dtSec);
  const aLateralMag = omegaEff * speed;

  // Desired thrust: lateral steering plus optional vertical gravity
  // compensation. The clamp below decides how much of that the
  // projectile's engine can actually deliver.
  let aX = perpX * aLateralMag;
  let aY = perpY * aLateralMag;
  let aZ = perpZ * aLateralMag + gravity;

  const aMag = magnitude3(aX, aY, aZ);
  if (aMag > maxThrustAccel) {
    const scale = maxThrustAccel / aMag;
    aX *= scale;
    aY *= scale;
    aZ *= scale;
  }

  _htOut.thrustX = aX;
  _htOut.thrustY = aY;
  _htOut.thrustZ = aZ;
  return _htOut;
}
