import type { ProjectileShot } from './types';
import type { ShotLocomotionMediumPhysics } from '@/types/shotTypes';
import { dragCoefficientFromVelocityFrictionPer60HzFrame } from './motionFriction';

const MIN_PROPULSION_SPEED = 1e-6;
let cachedAirFrictionPer60HzFrame = Number.NaN;
let cachedMass = Number.NaN;
let cachedAirDragCoefficient = 0;

export function getProjectileAirFrictionPer60HzFrame(shot: ProjectileShot): number {
  const friction = shot.shotLocomotion.media.air.velocityFrictionPer60HzFrame;
  return Number.isFinite(friction) && friction > 0 ? friction : 0;
}

export function getProjectileMediumFrictionPer60HzFrame(
  medium: ShotLocomotionMediumPhysics,
): number {
  const friction = medium.velocityFrictionPer60HzFrame;
  return Number.isFinite(friction) && friction > 0 ? friction : 0;
}

export function getProjectileMediumDragCoefficient(
  shot: ProjectileShot,
  medium: ShotLocomotionMediumPhysics,
): number {
  const friction = getProjectileMediumFrictionPer60HzFrame(medium);
  const mass = shot.mass;
  if (friction === cachedAirFrictionPer60HzFrame && mass === cachedMass) {
    return cachedAirDragCoefficient;
  }
  cachedAirFrictionPer60HzFrame = friction;
  cachedMass = mass;
  cachedAirDragCoefficient = dragCoefficientFromVelocityFrictionPer60HzFrame(friction, mass);
  return cachedAirDragCoefficient;
}

export function getProjectilePropulsionAcceleration(
  shot: ProjectileShot,
  medium: ShotLocomotionMediumPhysics,
): number {
  const force = medium.propulsionForce;
  if (!Number.isFinite(force) || force <= 0) return 0;
  const mass = shot.mass;
  if (!Number.isFinite(mass) || mass <= MIN_PROPULSION_SPEED) return 0;
  return force / mass;
}

export function getProjectileHomingThrustAcceleration(
  shot: { mass: number },
  medium: ShotLocomotionMediumPhysics,
): number {
  const force = medium.guidanceThrust;
  if (!Number.isFinite(force) || force <= 0) return 0;
  const mass = shot.mass;
  if (!Number.isFinite(mass) || mass <= MIN_PROPULSION_SPEED) return 0;
  return force / mass;
}

export function getProjectileRocketCounterGravityCarryAcceleration(
  shot: ProjectileShot,
  medium: ShotLocomotionMediumPhysics,
  homingEngagementScale: number,
  projectileGravity: number,
): number {
  if (shot.shotLocomotion.motionModel !== 'thrustGuided') return 0;
  if (!Number.isFinite(projectileGravity) || projectileGravity <= 0) return 0;
  const maxThrustAccel = getProjectileHomingThrustAcceleration(shot, medium);
  if (maxThrustAccel <= 0) return 0;
  const steeringScale = Number.isFinite(homingEngagementScale)
    ? Math.min(1, Math.max(0, homingEngagementScale))
    : 0;
  return Math.max(0, projectileGravity - maxThrustAccel * steeringScale);
}

export function getProjectileMediumHoldCounterGravityAcceleration(
  shot: ProjectileShot,
  medium: ShotLocomotionMediumPhysics,
  isWaterMedium: boolean,
  mediumPhysicsActive: boolean,
  guidedTargetAlreadyCarriesGravity: boolean,
  projectileGravity: number,
): number {
  if (
    !mediumPhysicsActive ||
    guidedTargetAlreadyCarriesGravity ||
    !isWaterMedium ||
    !shot.shotLocomotion.media.water.operational ||
    shot.shotLocomotion.motionModel !== 'thrustGuided' ||
    !Number.isFinite(projectileGravity) ||
    projectileGravity <= 0
  ) {
    return 0;
  }
  return Math.min(
    projectileGravity,
    getProjectileHomingThrustAcceleration(shot, medium),
  );
}

export function getProjectileHomingEngagementScale(
  shot: ProjectileShot,
  timeAliveBeforeStepMs: number,
  dtMs: number,
): number {
  const delayMs = shot.shotLocomotion.guidanceDelayMs;
  if (!Number.isFinite(delayMs) || delayMs <= 0) return 1;
  if (!Number.isFinite(timeAliveBeforeStepMs)) return 0;
  const stepMs = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
  const elapsedMs = timeAliveBeforeStepMs + stepMs * 0.5 - delayMs;
  if (elapsedMs <= 0) return 0;
  const rampMs = shot.shotLocomotion.guidanceRampMs;
  if (!Number.isFinite(rampMs) || rampMs <= 0 || elapsedMs >= rampMs) return 1;
  // Smootherstep keeps acceleration curvature continuous as blueprint-authored
  // delayed guidance hands off to full turning authority.
  const t = elapsedMs / rampMs;
  return t * t * t * (t * (t * 6 - 15) + 10);
}
