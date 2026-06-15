import type { ProjectileShot } from './types';
import { dragCoefficientFromVelocityFrictionPer60HzFrame } from './motionFriction';

const MIN_PROPULSION_SPEED = 1e-6;
let cachedAirFrictionPer60HzFrame = Number.NaN;
let cachedMass = Number.NaN;
let cachedAirDragCoefficient = 0;

export function getProjectileAirFrictionPer60HzFrame(shot: ProjectileShot): number {
  const friction = shot.airFrictionPer60HzFrame;
  return Number.isFinite(friction) && friction > 0 ? friction : 0;
}

export function getProjectileAirDragCoefficient(shot: ProjectileShot): number {
  const friction = getProjectileAirFrictionPer60HzFrame(shot);
  const mass = shot.mass;
  if (friction === cachedAirFrictionPer60HzFrame && mass === cachedMass) {
    return cachedAirDragCoefficient;
  }
  cachedAirFrictionPer60HzFrame = friction;
  cachedMass = mass;
  cachedAirDragCoefficient = dragCoefficientFromVelocityFrictionPer60HzFrame(friction, mass);
  return cachedAirDragCoefficient;
}

export function getProjectilePropulsionAcceleration(shot: ProjectileShot): number {
  const force = shot.propulsionForce ?? 0;
  if (!Number.isFinite(force) || force <= 0) return 0;
  const mass = shot.mass;
  if (!Number.isFinite(mass) || mass <= MIN_PROPULSION_SPEED) return 0;
  return force / mass;
}

export function addProjectileForwardPropulsionAcceleration(
  shot: ProjectileShot,
  velocityX: number,
  velocityY: number,
  velocityZ: number,
  out: { x: number; y: number; z: number },
): boolean {
  const accel = getProjectilePropulsionAcceleration(shot);
  if (accel <= 0) return false;
  const speed = Math.hypot(velocityX, velocityY, velocityZ);
  if (!Number.isFinite(speed) || speed <= MIN_PROPULSION_SPEED) return false;
  const scale = accel / speed;
  out.x += velocityX * scale;
  out.y += velocityY * scale;
  out.z += velocityZ * scale;
  return true;
}
