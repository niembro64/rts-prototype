import { UNIT_MASS_MULTIPLIER } from '../../config';
import type { Unit } from './types';
import type {
  UnitSuspensionConfig,
  UnitSuspensionState,
} from '@/types/locomotionTypes';

const SUSPENSION_REST_EPSILON = 0.01;
const SUSPENSION_REST_VELOCITY_EPSILON = 0.05;

function cloneSuspensionConfig(config: UnitSuspensionConfig): UnitSuspensionConfig {
  return {
    stiffness: config.stiffness,
    dampingRatio: config.dampingRatio,
    massScale: config.massScale,
    maxOffset: config.maxOffset
      ? {
          x: config.maxOffset.x,
          y: config.maxOffset.y,
          z: config.maxOffset.z,
        }
      : undefined,
  };
}

export function createUnitSuspension(
  config: UnitSuspensionConfig | null | undefined,
): UnitSuspensionState | undefined {
  if (!config) return undefined;
  return {
    config: cloneSuspensionConfig(config),
    offsetX: 0,
    offsetY: 0,
    offsetZ: 0,
    velocityX: 0,
    velocityY: 0,
    velocityZ: 0,
    legContact: true,
    anchorVelocityX: 0,
    anchorVelocityY: 0,
    anchorVelocityZ: 0,
    anchorVelocityInitialized: false,
  };
}

function clampAxis(value: number, velocity: number, maxAbs: number | undefined): { value: number; velocity: number } {
  if (maxAbs === undefined || maxAbs <= 0) return { value, velocity };
  if (value > maxAbs) return { value: maxAbs, velocity: Math.min(velocity, 0) };
  if (value < -maxAbs) return { value: -maxAbs, velocity: Math.max(velocity, 0) };
  return { value, velocity };
}

export function isUnitSuspensionNearRest(s: UnitSuspensionState): boolean {
  return (
    Math.abs(s.offsetX) <= SUSPENSION_REST_EPSILON &&
    Math.abs(s.offsetY) <= SUSPENSION_REST_EPSILON &&
    Math.abs(s.offsetZ) <= SUSPENSION_REST_EPSILON &&
    Math.abs(s.velocityX) <= SUSPENSION_REST_VELOCITY_EPSILON &&
    Math.abs(s.velocityY) <= SUSPENSION_REST_VELOCITY_EPSILON &&
    Math.abs(s.velocityZ) <= SUSPENSION_REST_VELOCITY_EPSILON
  );
}

export function advanceUnitSuspension(
  unit: Unit,
  rotation: number,
  dtMs: number,
  options: {
    legContact?: boolean;
  } = {},
): boolean {
  const s = unit.suspension;
  if (!s || dtMs <= 0) return false;

  const beforeOffsetX = s.offsetX;
  const beforeOffsetY = s.offsetY;
  const beforeOffsetZ = s.offsetZ;
  const beforeVelocityX = s.velocityX;
  const beforeVelocityY = s.velocityY;
  const beforeVelocityZ = s.velocityZ;
  const beforeLegContact = s.legContact;

  const dtSec = dtMs / 1000;
  const mass = Math.max(
    1e-6,
    unit.mass * UNIT_MASS_MULTIPLIER * (s.config.massScale ?? 1),
  );
  const stiffness = Math.max(0, s.config.stiffness);
  const damping = Math.max(0, s.config.dampingRatio) * 2 * Math.sqrt(stiffness * mass);

  if (options.legContact !== undefined) {
    s.legContact = options.legContact;
  }

  const anchorVx = unit.velocityX ?? 0;
  const anchorVy = unit.velocityY ?? 0;
  const anchorVz = unit.velocityZ ?? 0;
  let inertialForceX = 0;
  let inertialForceY = 0;
  let inertialForceZ = 0;
  if (s.anchorVelocityInitialized && dtSec > 0) {
    const ax = (anchorVx - s.anchorVelocityX) / dtSec;
    const ay = (anchorVy - s.anchorVelocityY) / dtSec;
    const az = (anchorVz - s.anchorVelocityZ) / dtSec;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    inertialForceX = -mass * (cos * ax + sin * ay);
    inertialForceY = -mass * (-sin * ax + cos * ay);
    inertialForceZ = -mass * az;
  }
  if (!s.legContact) {
    inertialForceX = 0;
    inertialForceY = 0;
    inertialForceZ = 0;
  }
  s.anchorVelocityX = anchorVx;
  s.anchorVelocityY = anchorVy;
  s.anchorVelocityZ = anchorVz;
  s.anchorVelocityInitialized = true;

  const forceX = -stiffness * s.offsetX - damping * s.velocityX + inertialForceX;
  const forceY = -stiffness * s.offsetY - damping * s.velocityY + inertialForceY;
  const forceZ = -stiffness * s.offsetZ - damping * s.velocityZ + inertialForceZ;

  s.velocityX += (forceX / mass) * dtSec;
  s.velocityY += (forceY / mass) * dtSec;
  s.velocityZ += (forceZ / mass) * dtSec;
  s.offsetX += s.velocityX * dtSec;
  s.offsetY += s.velocityY * dtSec;
  s.offsetZ += s.velocityZ * dtSec;

  const max = s.config.maxOffset;
  const clampedX = clampAxis(s.offsetX, s.velocityX, max?.x);
  s.offsetX = clampedX.value;
  s.velocityX = clampedX.velocity;
  const clampedY = clampAxis(s.offsetY, s.velocityY, max?.y);
  s.offsetY = clampedY.value;
  s.velocityY = clampedY.velocity;

  if (max?.z !== undefined) {
    const clampedZ = clampAxis(s.offsetZ, s.velocityZ, max.z);
    s.offsetZ = clampedZ.value;
    s.velocityZ = clampedZ.velocity;
  }

  if (s.legContact && isUnitSuspensionNearRest(s)) {
    s.offsetX = 0;
    s.offsetY = 0;
    s.offsetZ = 0;
    s.velocityX = 0;
    s.velocityY = 0;
    s.velocityZ = 0;
  }

  return (
    Math.abs(s.offsetX - beforeOffsetX) > SUSPENSION_REST_EPSILON ||
    Math.abs(s.offsetY - beforeOffsetY) > SUSPENSION_REST_EPSILON ||
    Math.abs(s.offsetZ - beforeOffsetZ) > SUSPENSION_REST_EPSILON ||
    Math.abs(s.velocityX - beforeVelocityX) > SUSPENSION_REST_VELOCITY_EPSILON ||
    Math.abs(s.velocityY - beforeVelocityY) > SUSPENSION_REST_VELOCITY_EPSILON ||
    Math.abs(s.velocityZ - beforeVelocityZ) > SUSPENSION_REST_VELOCITY_EPSILON ||
    s.legContact !== beforeLegContact
  );
}
