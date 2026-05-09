import type { Unit } from './types';

export const UNIT_MOVEMENT_ACCEL_EPSILON = 0.05;

export function setUnitMovementAcceleration(
  unit: Unit,
  ax: number,
  ay: number,
  az: number,
): boolean {
  const nextX = Number.isFinite(ax) ? ax : 0;
  const nextY = Number.isFinite(ay) ? ay : 0;
  const nextZ = Number.isFinite(az) ? az : 0;
  const prevX = unit.movementAccelX ?? 0;
  const prevY = unit.movementAccelY ?? 0;
  const prevZ = unit.movementAccelZ ?? 0;
  const changed =
    Math.abs(nextX - prevX) > UNIT_MOVEMENT_ACCEL_EPSILON ||
    Math.abs(nextY - prevY) > UNIT_MOVEMENT_ACCEL_EPSILON ||
    Math.abs(nextZ - prevZ) > UNIT_MOVEMENT_ACCEL_EPSILON;

  unit.movementAccelX = nextX;
  unit.movementAccelY = nextY;
  unit.movementAccelZ = nextZ;
  return changed;
}
