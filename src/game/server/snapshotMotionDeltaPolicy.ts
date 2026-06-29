import {
  ENTITY_CHANGED_BUILDING,
  ENTITY_CHANGED_HP,
  ENTITY_CHANGED_NORMAL,
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_ROT,
  ENTITY_CHANGED_VEL,
} from '../../types/network';
import type { Entity } from '../sim/types';

export const ENTITY_MOTION_DELTA_FIELDS =
  ENTITY_CHANGED_POS |
  ENTITY_CHANGED_ROT |
  ENTITY_CHANGED_VEL |
  ENTITY_CHANGED_NORMAL;

export const ENTITY_BASIC_TRANSFORM_DELTA_FIELDS =
  ENTITY_CHANGED_POS |
  ENTITY_CHANGED_ROT;

export const ENTITY_UNIT_SLAB_DELTA_FIELDS =
  ENTITY_MOTION_DELTA_FIELDS |
  ENTITY_CHANGED_HP |
  ENTITY_CHANGED_BUILDING;

const ENTITY_MOTION_SPEED_EPSILON_SQ = 0.01 * 0.01;
const ENTITY_MOTION_ANGULAR_EPSILON_SQ = 0.0001 * 0.0001;

export function isEntityMotionDeltaCandidate(entity: Entity): boolean {
  const unit = entity.unit;
  if (unit === null || unit.hp <= 0 || unit.locomotion.type !== 'flying') return false;
  const vx = unit.velocityX ?? 0;
  const vy = unit.velocityY ?? 0;
  const vz = unit.velocityZ ?? 0;
  if (vx * vx + vy * vy + vz * vz > ENTITY_MOTION_SPEED_EPSILON_SQ) return true;
  const av = unit.angularVelocity3;
  if (av === null) return false;
  return av.x * av.x + av.y * av.y + av.z * av.z > ENTITY_MOTION_ANGULAR_EPSILON_SQ;
}

export function dirtyFieldsAreMotionOnly(changedFields: number): boolean {
  return changedFields !== 0 &&
    (changedFields & ENTITY_MOTION_DELTA_FIELDS) !== 0 &&
    (changedFields & ~ENTITY_MOTION_DELTA_FIELDS) === 0;
}

export function shouldDeferToSparseEntityMotionDelta(
  entity: Entity,
  changedFields: number,
): boolean {
  return dirtyFieldsAreMotionOnly(changedFields) && isEntityMotionDeltaCandidate(entity);
}
