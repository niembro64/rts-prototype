import type { Entity, Turret } from '../types';
import { isWeaponAimedForFire } from './combatUtils';

const STATIC_SHIELD_DEPLOY_SPEED_EPS = 2.0;
const STATIC_SHIELD_STOW_SPEED_EPS = 4.0;
const STATIC_SHIELD_DEPLOY_SPEED_EPS_SQ =
  STATIC_SHIELD_DEPLOY_SPEED_EPS * STATIC_SHIELD_DEPLOY_SPEED_EPS;
const STATIC_SHIELD_STOW_SPEED_EPS_SQ =
  STATIC_SHIELD_STOW_SPEED_EPS * STATIC_SHIELD_STOW_SPEED_EPS;
const STATIC_SHIELD_DEPLOY_DELAY_MS = 150;
const STATIC_SHIELD_STOW_DELAY_MS = 150;
const STATIC_SHIELD_TURRET_SPEED_EPS = 0.03;
const SHIELD_DEPLOYED_EPS = 1e-6;

export type StaticShieldPanelEmissionPose = {
  rotation: number;
  pitch: number;
};

function finiteNonNegativeMs(dtMs: number): number {
  return Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0;
}

function getStaticShieldHostSpeedSq(entity: Entity): number {
  const unit = entity.unit;
  if (unit === null) return 0;
  const vx = unit.velocityX;
  const vy = unit.velocityY;
  const vz = unit.velocityZ;
  return vx * vx + vy * vy + vz * vz;
}

function isStaticShieldBodySleeping(entity: Entity): boolean {
  const body = entity.body;
  return body !== null && body.physicsBody.sleeping;
}

function isStaticShieldDeployCandidate(entity: Entity): boolean {
  return (
    isStaticShieldBodySleeping(entity) ||
    getStaticShieldHostSpeedSq(entity) <= STATIC_SHIELD_DEPLOY_SPEED_EPS_SQ
  );
}

function isStaticShieldStowCandidate(entity: Entity): boolean {
  return (
    !isStaticShieldBodySleeping(entity) &&
    getStaticShieldHostSpeedSq(entity) > STATIC_SHIELD_STOW_SPEED_EPS_SQ
  );
}

function stowStaticShieldPanel(entity: Entity): void {
  const unit = entity.unit;
  if (unit === null) return;
  unit.staticShieldPanelActive = false;
}

export function advanceStaticShieldHostReadiness(entity: Entity, dtMs: number): boolean {
  const unit = entity.unit;
  if (unit === null) return true;

  const dt = finiteNonNegativeMs(dtMs);
  if (unit.hp <= 0) {
    unit.staticShieldSettledMs = 0;
    unit.staticShieldUnsettledMs = 0;
    unit.staticShieldHostReady = false;
    stowStaticShieldPanel(entity);
    return false;
  }

  let ready = unit.staticShieldHostReady;
  let settledMs = unit.staticShieldSettledMs;
  let unsettledMs = unit.staticShieldUnsettledMs;
  const deployCandidate = isStaticShieldDeployCandidate(entity);
  const stowCandidate = isStaticShieldStowCandidate(entity);

  if (ready) {
    settledMs = deployCandidate ? STATIC_SHIELD_DEPLOY_DELAY_MS : 0;
    if (stowCandidate) {
      unsettledMs += dt;
      if (unsettledMs >= STATIC_SHIELD_STOW_DELAY_MS) {
        ready = false;
        settledMs = 0;
        unsettledMs = 0;
        stowStaticShieldPanel(entity);
      }
    } else {
      unsettledMs = 0;
    }
  } else if (deployCandidate) {
    settledMs += dt;
    unsettledMs = 0;
    if (isStaticShieldBodySleeping(entity) || settledMs >= STATIC_SHIELD_DEPLOY_DELAY_MS) {
      ready = true;
      settledMs = STATIC_SHIELD_DEPLOY_DELAY_MS;
    }
  } else {
    settledMs = 0;
    unsettledMs = 0;
  }

  unit.staticShieldSettledMs = settledMs;
  unit.staticShieldUnsettledMs = unsettledMs;
  unit.staticShieldHostReady = ready;
  return ready;
}

/** Host-level readiness for static barrier emissions. This intentionally
 *  looks at actual body motion, not one-frame movement intent: the
 *  shield is static as long as the host is static, and intent jitter
 *  should not flicker the deployed surface. The authoritative path calls
 *  advanceStaticShieldHostReadiness once per tick; this read helper also
 *  provides a deterministic instantaneous fallback for tests/bootstrap. */
export function isStaticShieldHostSettled(entity: Entity): boolean {
  const unit = entity.unit;
  if (unit === null) return true;
  if (unit.hp <= 0) return false;
  return unit.staticShieldHostReady;
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

export function isStaticShieldPanelEmissionReady(host: Entity, turret: Turret): boolean {
  const unit = host.unit;
  if (unit !== null && unit.staticShieldPanelActive) {
    return isStaticShieldHostSettled(host);
  }
  return isStaticShieldHostSettled(host) && isStaticShieldTurretPoseSettled(turret);
}

export function updateStaticShieldPanelEmissionState(host: Entity, turret: Turret): boolean {
  const unit = host.unit;
  if (unit === null || unit.hp <= 0 || !isStaticShieldHostSettled(host)) {
    stowStaticShieldPanel(host);
    return false;
  }
  if (unit.staticShieldPanelActive) return true;
  if (!isStaticShieldTurretPoseSettled(turret)) return false;

  unit.staticShieldPanelActive = true;
  unit.staticShieldPanelRotation = turret.rotation;
  unit.staticShieldPanelPitch = turret.pitch;
  return true;
}

export function getStaticShieldPanelEmissionPose(
  host: Entity,
  turret: Turret,
): StaticShieldPanelEmissionPose {
  const unit = host.unit;
  if (unit !== null && unit.staticShieldPanelActive) {
    return { rotation: unit.staticShieldPanelRotation, pitch: unit.staticShieldPanelPitch };
  }
  return { rotation: turret.rotation, pitch: turret.pitch };
}

export function isShieldSurfaceDeployed(turret: Turret): boolean {
  const shield = turret.shield;
  return shield !== null && shield.transition > SHIELD_DEPLOYED_EPS;
}
