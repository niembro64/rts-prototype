import type { Entity } from './types';
import { setQuatFromYaw } from '../math/Quaternion';

export function setUnitFacingYaw(entity: Entity, yaw: number): void {
  entity.transform.rotation = Number.isFinite(yaw) ? yaw : 0;

  const unit = entity.unit;
  if (!unit) return;

  const orientation = unit.orientation;
  if (!orientation) return;

  setQuatFromYaw(orientation, entity.transform.rotation);

  const omega = unit.angularVelocity3;
  if (omega) {
    omega.x = 0;
    omega.y = 0;
    omega.z = 0;
  }
}
