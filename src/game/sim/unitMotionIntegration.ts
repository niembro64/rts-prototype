import {
  dampVelocityTangentToGroundMutable,
  getUnitGroundSpringAcceleration,
  isUnitGroundPenetrationInContact,
  limitPassiveGroundReboundVelocityMutable,
  type GroundNormal,
} from './unitGroundPhysics';

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

/**
 * Shared unit-body integrator used by the authoritative server and
 * client visual prediction. It owns only the common physics math:
 * terrain spring, air damping, ground tangent damping, passive rebound
 * limiting, and Euler position integration.
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
  const groundZ = getGroundZ(motion.x, motion.y);
  const penetration = groundZ - (motion.z - groundOffset);
  let groundNormal: GroundNormal | undefined;

  if (isUnitGroundPenetrationInContact(penetration)) {
    groundNormal = getGroundNormal(motion.x, motion.y);
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
