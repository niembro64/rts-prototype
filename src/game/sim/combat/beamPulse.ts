import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
import {
  BEAM_PULSE_COLLISION_SAMPLE_INTERVAL_TICKS,
  BEAM_PULSE_OFF_TIME_MS,
  BEAM_PULSE_OFF_TIME_RANDOMNESS,
  BEAM_PULSE_ON_TIME_MS,
  BEAM_PULSE_ON_TIME_RANDOMNESS,
  BEAM_PULSE_TRACKING_ERROR_BUDGET_RADIANS,
} from '../../../config';
import type { BeamPulsePlan } from '../types';
import {
  getMaximumDurationWithRandomness,
  rollDurationWithRandomness,
} from '../turretCooldown';

export type BeamPulseEvaluation = {
  sourceX: number;
  sourceY: number;
  sourceZ: number;
  targetX: number;
  targetY: number;
  targetZ: number;
  dirX: number;
  dirY: number;
  dirZ: number;
  yaw: number;
  pitch: number;
};

export function createBeamPulsePlan(
  source: { x: number; y: number; z: number },
  sourceVelocity: { x: number; y: number; z: number },
  target: { x: number; y: number; z: number },
  targetVelocity: { x: number; y: number; z: number },
  traceDistance: number,
  durationMs: number = BEAM_PULSE_ON_TIME_MS,
): BeamPulsePlan {
  return {
    durationMs: Math.max(0, durationMs),
    sourceX: source.x,
    sourceY: source.y,
    sourceZ: source.z,
    sourceVelocityX: sourceVelocity.x,
    sourceVelocityY: sourceVelocity.y,
    sourceVelocityZ: sourceVelocity.z,
    targetX: target.x,
    targetY: target.y,
    targetZ: target.z,
    targetVelocityX: targetVelocity.x,
    targetVelocityY: targetVelocity.y,
    targetVelocityZ: targetVelocity.z,
    traceDistance,
    // The entity ID is assigned after this plan is created. Firing schedules
    // it into the deterministic collision ring before publishing the beam.
    collisionSamplePhase: 0,
    nextCollisionSampleTick: -1,
    lastCollisionSampleMs: 0,
  };
}

/** Conservative duration for the no-RNG tracking-feasibility test. If a
 * turret can follow this longest possible pulse, any subsequently rolled
 * duration is safe. */
export function getMaximumBeamPulseOnTimeMs(): number {
  return getMaximumDurationWithRandomness(
    BEAM_PULSE_ON_TIME_MS,
    BEAM_PULSE_ON_TIME_RANDOMNESS,
  );
}

export function rollBeamPulseOnTimeMs(nextRandom: () => number): number {
  return rollDurationWithRandomness(
    BEAM_PULSE_ON_TIME_MS,
    BEAM_PULSE_ON_TIME_RANDOMNESS,
    nextRandom,
  );
}

export function rollBeamPulseOffTimeMs(nextRandom: () => number): number {
  return rollDurationWithRandomness(
    BEAM_PULSE_OFF_TIME_MS,
    BEAM_PULSE_OFF_TIME_RANDOMNESS,
    nextRandom,
  );
}

export function evaluateBeamPulsePlan(
  plan: BeamPulsePlan,
  elapsedMs: number,
  out: BeamPulseEvaluation,
): BeamPulseEvaluation {
  const t = Math.max(0, Math.min(plan.durationMs, elapsedMs)) / 1000;
  const sourceX = plan.sourceX + plan.sourceVelocityX * t;
  const sourceY = plan.sourceY + plan.sourceVelocityY * t;
  const sourceZ = plan.sourceZ + plan.sourceVelocityZ * t;
  const targetX = plan.targetX + plan.targetVelocityX * t;
  const targetY = plan.targetY + plan.targetVelocityY * t;
  const targetZ = plan.targetZ + plan.targetVelocityZ * t;
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const dz = targetZ - sourceZ;
  const length = DMath.hypot(dx, dy, dz);
  const invLength = length > 1e-9 ? 1 / length : 0;
  const dirX = length > 1e-9 ? dx * invLength : 1;
  const dirY = length > 1e-9 ? dy * invLength : 0;
  const dirZ = length > 1e-9 ? dz * invLength : 0;
  const horizontalLength = DMath.hypot(dirX, dirY);

  out.sourceX = sourceX;
  out.sourceY = sourceY;
  out.sourceZ = sourceZ;
  out.targetX = targetX;
  out.targetY = targetY;
  out.targetZ = targetZ;
  out.dirX = dirX;
  out.dirY = dirY;
  out.dirZ = dirZ;
  out.yaw = horizontalLength > 1e-9 ? DMath.atan2(dirY, dirX) : 0;
  out.pitch = DMath.atan2(dirZ, horizontalLength);
  return out;
}

function lineOfSightAngularSpeedAt(plan: BeamPulsePlan, elapsedMs: number): number {
  const t = Math.max(0, Math.min(plan.durationMs, elapsedMs)) / 1000;
  const rx = (plan.targetX - plan.sourceX) +
    (plan.targetVelocityX - plan.sourceVelocityX) * t;
  const ry = (plan.targetY - plan.sourceY) +
    (plan.targetVelocityY - plan.sourceVelocityY) * t;
  const rz = (plan.targetZ - plan.sourceZ) +
    (plan.targetVelocityZ - plan.sourceVelocityZ) * t;
  const vx = plan.targetVelocityX - plan.sourceVelocityX;
  const vy = plan.targetVelocityY - plan.sourceVelocityY;
  const vz = plan.targetVelocityZ - plan.sourceVelocityZ;
  const rangeSq = rx * rx + ry * ry + rz * rz;
  if (rangeSq <= 1e-9) return Infinity;
  const crossX = ry * vz - rz * vy;
  const crossY = rz * vx - rx * vz;
  const crossZ = rx * vy - ry * vx;
  return DMath.sqrt(crossX * crossX + crossY * crossY + crossZ * crossZ) / rangeSq;
}

function closestRelativeApproachMs(plan: BeamPulsePlan): number {
  const rx = plan.targetX - plan.sourceX;
  const ry = plan.targetY - plan.sourceY;
  const rz = plan.targetZ - plan.sourceZ;
  const vx = plan.targetVelocityX - plan.sourceVelocityX;
  const vy = plan.targetVelocityY - plan.sourceVelocityY;
  const vz = plan.targetVelocityZ - plan.sourceVelocityZ;
  const speedSq = vx * vx + vy * vy + vz * vz;
  if (speedSq <= 1e-12) return 0;
  const closestSec = -(rx * vx + ry * vy + rz * vz) / speedSq;
  return Math.max(0, Math.min(plan.durationMs, closestSec * 1000));
}

/**
 * Gate a pulse against the same critically-damped servo used by ordinary
 * turrets. For a ramping target angle, steady tracking error is
 * `(2*sqrt(k)+drag)*omega/k`; solving that for the authored error budget gives
 * the maximum sustainable line-of-sight rate. For constant relative velocity,
 * `|r x v|` is constant and angular rate peaks at closest approach, so checking
 * start/closest/end is the exact maximum-rate test rather than a heuristic
 * per-tick solve.
 */
export function canTurretTrackBeamPulse(
  plan: BeamPulsePlan,
  turnAccel: number,
  drag: number,
): boolean {
  const stiffness = Math.max(0, turnAccel);
  if (stiffness <= 1e-9) return false;
  const damping = 2 * DMath.sqrt(stiffness) + Math.max(0, drag);
  const maxAngularSpeed = BEAM_PULSE_TRACKING_ERROR_BUDGET_RADIANS * stiffness / damping;
  const closestTime = closestRelativeApproachMs(plan);
  return (
    lineOfSightAngularSpeedAt(plan, 0) <= maxAngularSpeed &&
    lineOfSightAngularSpeedAt(plan, closestTime) <= maxAngularSpeed &&
    lineOfSightAngularSpeedAt(plan, plan.durationMs) <= maxAngularSpeed
  );
}

function normalizedCollisionSampleIntervalTicks(): number {
  return Number.isFinite(BEAM_PULSE_COLLISION_SAMPLE_INTERVAL_TICKS)
    ? Math.max(1, Math.round(BEAM_PULSE_COLLISION_SAMPLE_INTERVAL_TICKS))
    : 1;
}

/** Stable pseudo-random phase assignment. It is deliberately a pure hash,
 * not the gameplay RNG stream: adding/removing a beam cannot perturb any
 * combat randomness, and array insertion order cannot move existing beams to
 * a different phase. */
export function beamPulseCollisionPhaseForEntityId(
  entityId: number,
  intervalTicks: number = normalizedCollisionSampleIntervalTicks(),
): number {
  const interval = Number.isFinite(intervalTicks)
    ? Math.max(1, Math.round(intervalTicks))
    : 1;
  let hash = entityId | 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return (hash >>> 0) % interval;
}

export function scheduleBeamPulseCollisionSamples(
  plan: BeamPulsePlan,
  beamEntityId: number,
  spawnTick: number,
): void {
  const interval = normalizedCollisionSampleIntervalTicks();
  const phase = beamPulseCollisionPhaseForEntityId(beamEntityId, interval);
  const firstEligibleTick = Math.max(0, Math.floor(spawnTick)) + 1;
  const firstTickPhase = firstEligibleTick % interval;
  plan.collisionSamplePhase = phase;
  plan.nextCollisionSampleTick = firstEligibleTick +
    ((phase - firstTickPhase + interval) % interval);
}

export function beamPulseNeedsCollisionSample(
  plan: BeamPulsePlan,
  currentTick: number,
  elapsedMs: number,
): boolean {
  const clampedElapsed = Math.min(elapsedMs, plan.durationMs);
  return clampedElapsed >= plan.durationMs || (
    plan.nextCollisionSampleTick >= 0 &&
    currentTick >= plan.nextCollisionSampleTick
  );
}

export function consumeBeamPulseCollisionWindow(
  plan: BeamPulsePlan,
  currentTick: number,
  elapsedMs: number,
): number {
  const clampedElapsed = Math.min(elapsedMs, plan.durationMs);
  const windowMs = Math.max(0, clampedElapsed - plan.lastCollisionSampleMs);
  plan.lastCollisionSampleMs = clampedElapsed;
  const interval = normalizedCollisionSampleIntervalTicks();
  while (
    plan.nextCollisionSampleTick >= 0 &&
    plan.nextCollisionSampleTick <= currentTick
  ) {
    plan.nextCollisionSampleTick += interval;
  }
  return windowMs;
}
