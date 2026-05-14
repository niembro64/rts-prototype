import {
  dampVelocityTangentToGroundMutable,
  getUnitGroundSpringAcceleration,
  isUnitGroundPenetrationInContact,
  limitPassiveGroundReboundVelocityMutable,
  UNIT_GROUND_CONTACT_EPSILON,
  type GroundNormal,
} from './unitGroundPhysics';
import { getSimWasm } from '../sim-wasm/init';

export type MutableUnitMotion3 = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
};

export type UnitGroundHeightSampler = (x: number, y: number) => number;
export type UnitGroundNormalSampler = (x: number, y: number) => GroundNormal;

// Reusable Float64Array scratch passed to the WASM kernel. Both
// the server tick and the client prediction stepper call into
// this module sequentially (never re-entrantly within one
// JS turn), so a single module-scope scratch buffer is safe and
// avoids a per-call typed-array allocation.
const _motionBuf = new Float64Array(6);

/**
 * Shared unit-body integrator used by the authoritative server and
 * client visual prediction. It owns only the common physics math:
 * terrain spring, air damping, ground tangent damping, passive rebound
 * limiting, and Euler position integration.
 *
 * Runs in the Rust/WASM `step_unit_motion` kernel when the WASM
 * module has finished loading (every tick after the boot
 * `initSimWasm()` resolves). Falls back to the TypeScript
 * implementation below during the first few frames of boot, and
 * during dev when a developer swaps the WASM kernel back to TS
 * via getSimWasm()-returns-undefined for debugging.
 *
 * Numerical contract: WASM and TS branches are kept bit-identical
 * (same f64 math, same operation order, same constants from
 * unitGroundPhysics.ts + config.ts) so swapping mid-session
 * doesn't change motion.
 */
export function advanceUnitMotionPhysicsMutable(
  motion: MutableUnitMotion3,
  dtSec: number,
  groundOffset: number,
  ax: number,
  ay: number,
  az: number,
  airDamp: number,
  groundDamp: number,
  launchAx: number,
  launchAy: number,
  launchAz: number,
  getGroundZ: UnitGroundHeightSampler,
  getGroundNormal: UnitGroundNormalSampler,
): void {
  // Pre-sample ground state JS-side so the WASM kernel never
  // re-enters JS during a step (boundary cost discipline — see
  // issues.txt Phase 2 notes). The normal is expensive (gradient
  // sample with water exclusion); gate it on the penetration
  // contact check so airborne bodies don't pay for it.
  const groundZ = getGroundZ(motion.x, motion.y);
  const penetration = groundZ - (motion.z - groundOffset);
  const inContact = penetration >= -UNIT_GROUND_CONTACT_EPSILON;
  let normalX = 0;
  let normalY = 0;
  let normalZ = 1;
  if (inContact) {
    const n = getGroundNormal(motion.x, motion.y);
    normalX = n.nx;
    normalY = n.ny;
    normalZ = n.nz;
  }

  const sim = getSimWasm();
  if (sim !== undefined) {
    _motionBuf[0] = motion.x;
    _motionBuf[1] = motion.y;
    _motionBuf[2] = motion.z;
    _motionBuf[3] = motion.vx;
    _motionBuf[4] = motion.vy;
    _motionBuf[5] = motion.vz;
    sim.stepUnitMotion(
      _motionBuf,
      dtSec,
      groundOffset,
      ax, ay, az,
      airDamp, groundDamp,
      launchAx, launchAy, launchAz,
      groundZ,
      normalX, normalY, normalZ,
    );
    motion.x = _motionBuf[0];
    motion.y = _motionBuf[1];
    motion.z = _motionBuf[2];
    motion.vx = _motionBuf[3];
    motion.vy = _motionBuf[4];
    motion.vz = _motionBuf[5];
    return;
  }

  // TS fallback — used during boot (before initSimWasm resolves)
  // and dev. Kept structurally identical to the Rust kernel so
  // motion is bit-identical across the two branches.
  let groundNormal: GroundNormal | undefined;
  if (isUnitGroundPenetrationInContact(penetration)) {
    groundNormal = { nx: normalX, ny: normalY, nz: normalZ };
    const normalVelocity =
      motion.vx * groundNormal.nx +
      motion.vy * groundNormal.ny +
      motion.vz * groundNormal.nz;
    const springAccel = getUnitGroundSpringAcceleration(
      penetration,
      normalVelocity,
    );
    ax += groundNormal.nx * springAccel;
    ay += groundNormal.ny * springAccel;
    az += groundNormal.nz * springAccel;
  }

  motion.vx += ax * dtSec;
  motion.vy += ay * dtSec;
  motion.vz += az * dtSec;
  motion.vx *= airDamp;
  motion.vy *= airDamp;
  motion.vz *= airDamp;

  if (groundNormal) {
    dampVelocityTangentToGroundMutable(motion, groundNormal, groundDamp);
    const launchNormalAccel =
      launchAx * groundNormal.nx +
      launchAy * groundNormal.ny +
      launchAz * groundNormal.nz;
    limitPassiveGroundReboundVelocityMutable(
      motion,
      groundNormal,
      launchNormalAccel,
      dtSec,
    );
  }

  motion.x += motion.vx * dtSec;
  motion.y += motion.vy * dtSec;
  motion.z += motion.vz * dtSec;
}
