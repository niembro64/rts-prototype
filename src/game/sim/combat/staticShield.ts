import type { Entity, Turret } from '../types';
import { isWeaponAimedForFire } from './combatUtils';

const STATIC_SHIELD_HOST_SPEED_EPS = 2.0;
const STATIC_SHIELD_HOST_SPEED_EPS_SQ =
  STATIC_SHIELD_HOST_SPEED_EPS * STATIC_SHIELD_HOST_SPEED_EPS;
const STATIC_SHIELD_HOST_THRUST_EPS = 1e-4;
const STATIC_SHIELD_HOST_THRUST_EPS_SQ =
  STATIC_SHIELD_HOST_THRUST_EPS * STATIC_SHIELD_HOST_THRUST_EPS;
const STATIC_SHIELD_TURRET_SPEED_EPS = 0.03;
const SHIELD_DEPLOYED_EPS = 1e-6;

export function isStaticShieldHostSettled(entity: Entity): boolean {
  const unit = entity.unit;
  if (unit === null) return true;
  if (unit.hp <= 0) return false;
  const vx = unit.velocityX ?? 0;
  const vy = unit.velocityY ?? 0;
  const vz = unit.velocityZ ?? 0;
  if (vx * vx + vy * vy + vz * vz > STATIC_SHIELD_HOST_SPEED_EPS_SQ) {
    return false;
  }
  const thrustX = unit.thrustDirX ?? 0;
  const thrustY = unit.thrustDirY ?? 0;
  return thrustX * thrustX + thrustY * thrustY <= STATIC_SHIELD_HOST_THRUST_EPS_SQ;
}

export function isStaticShieldTurretPoseSettled(turret: Turret): boolean {
  return (
    Math.abs(turret.angularVelocity) <= STATIC_SHIELD_TURRET_SPEED_EPS &&
    Math.abs(turret.pitchVelocity) <= STATIC_SHIELD_TURRET_SPEED_EPS
  );
}

export function isStaticShieldDeploymentReady(
  host: Entity,
  turret: Turret,
  requireAimedPose: boolean,
): boolean {
  return (
    isStaticShieldHostSettled(host) &&
    isStaticShieldTurretPoseSettled(turret) &&
    (!requireAimedPose || isWeaponAimedForFire(turret))
  );
}

export function isShieldSurfaceDeployed(turret: Turret): boolean {
  return (turret.shield?.transition ?? 0) > SHIELD_DEPLOYED_EPS;
}
