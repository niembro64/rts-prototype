import {
  UNIT_GROUND_FRICTION_PER_60HZ_FRAME,
  UNIT_GROUND_PASSIVE_REBOUND_MAX_SPEED,
  UNIT_GROUND_SPRING_ACCEL_PER_WORLD_UNIT,
  UNIT_GROUND_SPRING_DAMPING_RATIO,
} from '../../config';
import type { Unit } from './types';

export type GroundNormal = { nx: number; ny: number; nz: number };

export const UNIT_GROUND_CONTACT_EPSILON = 1e-3;
const GROUND_SPRING_DAMPING_ACCEL_PER_SPEED =
  Math.max(0, UNIT_GROUND_SPRING_DAMPING_RATIO) *
  2 *
  Math.sqrt(Math.max(0, UNIT_GROUND_SPRING_ACCEL_PER_WORLD_UNIT));

type MutableVelocity3 = { vx: number; vy: number; vz: number };
let cachedGroundDampDtSec = -1;
let cachedGroundDamp = 1;

export function getUnitGroundPointZ(unit: Unit, bodyCenterZ: number): number {
  return bodyCenterZ - unit.bodyCenterHeight;
}

export function getUnitGroundPenetration(
  unit: Unit,
  bodyCenterZ: number,
  groundZ: number,
): number {
  return groundZ - getUnitGroundPointZ(unit, bodyCenterZ);
}

export function isUnitGroundPenetrationInContact(penetration: number): boolean {
  return penetration >= -UNIT_GROUND_CONTACT_EPSILON;
}

export function getUnitGroundSpringCompression(penetration: number): number {
  if (!isUnitGroundPenetrationInContact(penetration)) return 0;
  return Math.max(0, penetration);
}

export function isUnitGroundPointAtOrBelowTerrain(
  unit: Unit,
  bodyCenterZ: number,
  groundZ: number,
): boolean {
  return isUnitGroundPenetrationInContact(
    getUnitGroundPenetration(unit, bodyCenterZ, groundZ),
  );
}

export function getUnitGroundFrictionDamp(dtSec: number): number {
  if (dtSec === cachedGroundDampDtSec) return cachedGroundDamp;
  if (dtSec <= 0) return 1;
  const friction = UNIT_GROUND_FRICTION_PER_60HZ_FRAME;
  if (!Number.isFinite(friction) || friction <= 0) return 1;
  if (friction >= 1) return 0;
  cachedGroundDampDtSec = dtSec;
  cachedGroundDamp = Math.pow(1 - friction, dtSec * 60);
  return cachedGroundDamp;
}

export function getUnitGroundSpringAcceleration(
  penetration: number,
  normalVelocity: number,
): number {
  const compression = getUnitGroundSpringCompression(penetration);
  if (compression <= 0) return 0;
  const springAccel = UNIT_GROUND_SPRING_ACCEL_PER_WORLD_UNIT * compression;
  const dampedAccel =
    springAccel - GROUND_SPRING_DAMPING_ACCEL_PER_SPEED * normalVelocity;
  return Number.isFinite(dampedAccel) ? Math.max(0, dampedAccel) : 0;
}

export function dampVelocityTangentToGroundMutable(
  velocity: MutableVelocity3,
  normal: GroundNormal,
  damp: number,
): void {
  const vNormal =
    velocity.vx * normal.nx + velocity.vy * normal.ny + velocity.vz * normal.nz;
  const tangentX = velocity.vx - vNormal * normal.nx;
  const tangentY = velocity.vy - vNormal * normal.ny;
  const tangentZ = velocity.vz - vNormal * normal.nz;
  velocity.vx = vNormal * normal.nx + tangentX * damp;
  velocity.vy = vNormal * normal.ny + tangentY * damp;
  velocity.vz = vNormal * normal.nz + tangentZ * damp;
}

export function limitPassiveGroundReboundVelocityMutable(
  velocity: MutableVelocity3,
  normal: GroundNormal,
  launchNormalAccel: number,
  dtSec: number,
): void {
  const maxOutwardSpeed = UNIT_GROUND_PASSIVE_REBOUND_MAX_SPEED;
  if (!Number.isFinite(maxOutwardSpeed) || maxOutwardSpeed < 0) return;
  const launchOutwardSpeed =
    Number.isFinite(launchNormalAccel) && Number.isFinite(dtSec) && dtSec > 0
      ? Math.max(0, launchNormalAccel * dtSec)
      : 0;
  const maxAllowedOutwardSpeed = maxOutwardSpeed + launchOutwardSpeed;

  const vNormal =
    velocity.vx * normal.nx + velocity.vy * normal.ny + velocity.vz * normal.nz;
  if (vNormal <= maxAllowedOutwardSpeed) return;

  const remove = vNormal - maxAllowedOutwardSpeed;
  velocity.vx -= remove * normal.nx;
  velocity.vy -= remove * normal.ny;
  velocity.vz -= remove * normal.nz;
}
