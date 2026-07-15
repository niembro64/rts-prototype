import type { ProjectileShot } from './types';
import { dragCoefficientFromVelocityFrictionPer60HzFrame } from './motionFriction';
import { deterministicMath } from './deterministicMath';

const MIN_PROPULSION_SPEED = 1e-6;
// Soft-start delayed guidance so vertical-launch rockets do not jump from
// pure boost to full lateral steering in the first few fixed steps. The
// smootherstep curve keeps acceleration curvature continuous at handoff.
const HOMING_ENGAGEMENT_RAMP_MS = 700;
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

export function getProjectileHomingThrustAcceleration(
  shot: { homingThrust?: number | null; mass: number },
): number {
  const force = shot.homingThrust ?? 0;
  if (!Number.isFinite(force) || force <= 0) return 0;
  const mass = shot.mass;
  if (!Number.isFinite(mass) || mass <= MIN_PROPULSION_SPEED) return 0;
  return force / mass;
}

export function getProjectileRocketCounterGravityCarryAcceleration(
  shot: { type: ProjectileShot['type']; homingThrust?: number | null; mass: number },
  homingEngagementScale: number,
  projectileGravity: number,
): number {
  if (shot.type !== 'rocket') return 0;
  if (!Number.isFinite(projectileGravity) || projectileGravity <= 0) return 0;
  const maxThrustAccel = getProjectileHomingThrustAcceleration(shot);
  if (maxThrustAccel <= 0) return 0;
  const steeringScale = Number.isFinite(homingEngagementScale)
    ? Math.min(1, Math.max(0, homingEngagementScale))
    : 0;
  return Math.max(0, projectileGravity - maxThrustAccel * steeringScale);
}

export function getProjectileMediumHoldCounterGravityAcceleration(
  shot: {
    physicsMedium: ProjectileShot['physicsMedium'];
    type: ProjectileShot['type'];
    homingThrust?: number | null;
    mass: number;
  },
  mediumPhysicsActive: boolean,
  guidedTargetAlreadyCarriesGravity: boolean,
  projectileGravity: number,
): number {
  if (
    !mediumPhysicsActive ||
    guidedTargetAlreadyCarriesGravity ||
    shot.physicsMedium !== 'water-only' ||
    shot.type !== 'rocket' ||
    !Number.isFinite(projectileGravity) ||
    projectileGravity <= 0
  ) {
    return 0;
  }
  return Math.min(
    projectileGravity,
    getProjectileHomingThrustAcceleration(shot),
  );
}

export function getProjectileHomingEngagementScale(
  shot: { homingDelayMs?: number | null },
  timeAliveBeforeStepMs: number,
  dtMs: number,
): number {
  const delayMs = shot.homingDelayMs ?? 0;
  if (!Number.isFinite(delayMs) || delayMs <= 0) return 1;
  if (!Number.isFinite(timeAliveBeforeStepMs)) return 0;
  const stepMs = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
  const elapsedMs = timeAliveBeforeStepMs + stepMs * 0.5 - delayMs;
  if (elapsedMs <= 0) return 0;
  if (elapsedMs >= HOMING_ENGAGEMENT_RAMP_MS) return 1;
  const t = elapsedMs / HOMING_ENGAGEMENT_RAMP_MS;
  return t * t * t * (t * (t * 6 - 15) + 10);
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
  const speed = deterministicMath.hypot(velocityX, velocityY, velocityZ);
  if (!Number.isFinite(speed) || speed <= MIN_PROPULSION_SPEED) return false;
  const scale = accel / speed;
  out.x += velocityX * scale;
  out.y += velocityY * scale;
  out.z += velocityZ * scale;
  return true;
}
