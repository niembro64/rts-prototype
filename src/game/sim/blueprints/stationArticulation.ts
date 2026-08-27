import type { TurretPresentation, TurretStationArticulation } from '../../../types/blueprints';
import type { WorkEmitterSpec } from '../../../types/constructionTypes';
import { assertFiniteNumber } from '../../../configValidation';
import { isStandardTetrahedronParticleRadius } from '@/tetrahedronParticleProfile';

function assertFinite(label: string, value: number): void {
  assertFiniteNumber(value, `Invalid ${label}`);
}

/** Validate the presented barrel cluster at the JSON loader boundary.
 *
 * A `simpleMultiBarrel`/`coneMultiBarrel` cluster is a ROTARY mechanism: two
 * or more tubes share one fixed firing station, and the cluster turns so a
 * different tube reaches that station for each shot. That rotation is what
 * makes the shared-socket geometry read as a gatling instead of a bundle of
 * dead pipes, so it is a contract rather than an option — every multi-barrel
 * mount spins, idles at a visible creep, and spins up when engaged. A cluster
 * that cannot rotate is an authoring error, not a style choice: author a
 * `singleCylinderBarrel` when a mount should hold still. */
export function validateTurretBarrelPresentation(
  label: string,
  presentation: TurretPresentation | null | undefined,
): void {
  const barrel = presentation?.barrel;
  if (
    barrel === null ||
    barrel === undefined ||
    (barrel.type !== 'simpleMultiBarrel' && barrel.type !== 'coneMultiBarrel')
  ) {
    return;
  }
  if (!Number.isInteger(barrel.barrelCount) || barrel.barrelCount < 2) {
    throw new Error(
      `Invalid ${label}.barrel.barrelCount: a ${barrel.type} cluster needs 2 or more barrels`,
    );
  }
  if (presentation?.headOnly) {
    throw new Error(
      `Invalid ${label}.barrel: a headOnly mount suppresses barrel animation, ` +
      'so it cannot present a rotating multi-barrel cluster',
    );
  }
  const spin = barrel.spin;
  assertFinite(`${label}.barrel.spin.idle`, spin.idle);
  assertFinite(`${label}.barrel.spin.max`, spin.max);
  assertFinite(`${label}.barrel.spin.accel`, spin.accel);
  assertFinite(`${label}.barrel.spin.decel`, spin.decel);
  if (spin.idle <= 0 || spin.accel <= 0 || spin.decel <= 0 || spin.max < spin.idle) {
    throw new Error(
      `Invalid ${label}.barrel.spin: every multi-barrel cluster rotates — ` +
      'idle, accel and decel must be positive radians-per-second envelopes and ' +
      'max must be at least idle',
    );
  }
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
  const requestsHost = articulation.hostAssist !== 'none';
  const hasClaimGroup = articulation.claimGroup !== null;
  if (requestsHost !== hasClaimGroup) {
    throw new Error(
      `Invalid ${label}: hostAssist and a claimGroup must be authored together`,
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
  if (emitter.particleTravelSpeed <= 0) {
    throw new Error(`Invalid ${label}: particle speed must be positive`);
  }
  if (!isStandardTetrahedronParticleRadius(emitter.particleRadius)) {
    throw new Error(
      `Invalid ${label}.particleRadius: expected a standardized small, medium, or large radius`,
    );
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
