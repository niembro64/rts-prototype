import type { ProjectileShot } from './types';
import { dampFromFrictionPer60HzFrame } from './motionFriction';

const MIN_PROPULSION_SPEED = 1e-6;

export function getProjectileAirFrictionPer60HzFrame(shot: ProjectileShot): number {
  const friction = shot.airFrictionPer60HzFrame;
  return Number.isFinite(friction) && friction > 0 ? friction : 0;
}

export function getProjectileAirFrictionDamp(
  shot: ProjectileShot,
  dtSec: number,
): number {
  return dampFromFrictionPer60HzFrame(
    getProjectileAirFrictionPer60HzFrame(shot),
    dtSec,
  );
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
