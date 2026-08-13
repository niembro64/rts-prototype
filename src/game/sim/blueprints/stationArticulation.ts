import type { TurretStationArticulation } from '../../../types/blueprints';
import type { WorkEmitterSpec } from '../../../types/constructionTypes';

function assertFinite(label: string, value: number): void {
  if (!Number.isFinite(value)) throw new Error(`Invalid ${label}: expected a finite number`);
}

/** Validate the physical station envelope at the JSON loader boundary. */
export function validateStationArticulation(
  label: string,
  articulation: TurretStationArticulation | undefined,
): void {
  if (articulation === undefined) return;
  assertFinite(`${label}.yaw.minAngle`, articulation.yaw.minAngle);
  assertFinite(`${label}.yaw.maxAngle`, articulation.yaw.maxAngle);
  assertFinite(`${label}.pitch.minAngle`, articulation.pitch.minAngle);
  assertFinite(`${label}.pitch.maxAngle`, articulation.pitch.maxAngle);
  assertFinite(`${label}.restYaw`, articulation.restYaw);
  assertFinite(`${label}.restPitch`, articulation.restPitch);
  assertFinite(`${label}.restoreDelayMs`, articulation.restoreDelayMs);
  if (articulation.yaw.minAngle > articulation.yaw.maxAngle) {
    throw new Error(`Invalid ${label}.yaw: minAngle exceeds maxAngle`);
  }
  if (articulation.pitch.minAngle > articulation.pitch.maxAngle) {
    throw new Error(`Invalid ${label}.pitch: minAngle exceeds maxAngle`);
  }
  if (
    !articulation.yaw.continuous &&
    (articulation.restYaw < articulation.yaw.minAngle ||
      articulation.restYaw > articulation.yaw.maxAngle)
  ) {
    throw new Error(`Invalid ${label}.restYaw: outside limited yaw traverse`);
  }
  if (
    articulation.restPitch < articulation.pitch.minAngle ||
    articulation.restPitch > articulation.pitch.maxAngle
  ) {
    throw new Error(`Invalid ${label}.restPitch: outside pitch traverse`);
  }
  if (articulation.restoreDelayMs < 0) {
    throw new Error(`Invalid ${label}.restoreDelayMs: expected non-negative milliseconds`);
  }
  if (!Number.isInteger(articulation.claimPriority)) {
    throw new Error(`Invalid ${label}.claimPriority: expected an integer`);
  }
  const requestsHostYaw = articulation.hostAssist === 'requestYaw';
  const hasClaimGroup = articulation.claimGroup !== null;
  if (requestsHostYaw !== hasClaimGroup) {
    throw new Error(
      `Invalid ${label}: hostAssist requestYaw and a claimGroup must be authored together`,
    );
  }
}

/** Validate QueryWork using the same explicit actuator/envelope contract as
 * weapon stations. The caller separately enforces which attachment pieces a
 * particular host kind supports. */
export function validateWorkEmitter(
  label: string,
  emitter: WorkEmitterSpec,
): void {
  if (emitter.points.length === 0) {
    throw new Error(`Invalid ${label}.points: expected at least one QueryWork socket`);
  }
  for (const point of emitter.points) {
    assertFinite(`${label}.points[].x`, point.x);
    assertFinite(`${label}.points[].y`, point.y);
    assertFinite(`${label}.points[].z`, point.z);
  }
  assertFinite(`${label}.particleTravelSpeed`, emitter.particleTravelSpeed);
  assertFinite(`${label}.particleRadius`, emitter.particleRadius);
  assertFinite(`${label}.alignmentToleranceRadians`, emitter.alignmentToleranceRadians);
  if (emitter.particleTravelSpeed <= 0 || emitter.particleRadius <= 0) {
    throw new Error(`Invalid ${label}: particle speed and radius must be positive`);
  }
  if (emitter.alignmentToleranceRadians <= 0) {
    throw new Error(`Invalid ${label}.alignmentToleranceRadians: expected a positive value`);
  }
  const moving = emitter.attachment.kind !== 'host';
  if (moving !== (emitter.angularActuator !== null && emitter.articulation !== null)) {
    throw new Error(
      `Invalid ${label}: moving attachments require an actuator and articulation; fixed host sockets require null`,
    );
  }
  if (emitter.requiresAlignmentForWork && !moving) {
    throw new Error(`Invalid ${label}: an alignment gate requires a moving attachment`);
  }
  if (emitter.angularActuator !== null) {
    for (const [axis, actuator] of [
      ['yaw', emitter.angularActuator.yaw],
      ['pitch', emitter.angularActuator.pitch],
    ] as const) {
      assertFinite(`${label}.angularActuator.${axis}.maxSpeed`, actuator.maxSpeed);
      assertFinite(`${label}.angularActuator.${axis}.maxAcceleration`, actuator.maxAcceleration);
      if (actuator.maxSpeed <= 0 || actuator.maxAcceleration <= 0) {
        throw new Error(`Invalid ${label}.angularActuator.${axis}: limits must be positive`);
      }
    }
  }
  if (emitter.articulation !== null) {
    validateStationArticulation(`${label}.articulation`, emitter.articulation);
  }
  if (emitter.attachment.kind === 'botArm') {
    const socket = emitter.attachment.socketOffset;
    assertFinite(`${label}.attachment.socketOffset.x`, socket.x);
    assertFinite(`${label}.attachment.socketOffset.y`, socket.y);
    assertFinite(`${label}.attachment.socketOffset.z`, socket.z);
  }
}
