import {
  ENTITY_CHANGED_BUILDING,
  ENTITY_CHANGED_HP,
  ENTITY_CHANGED_NORMAL,
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_ROT,
  ENTITY_CHANGED_VEL,
} from '../../types/network';
import { ENTITY_STATE_KIND_UNIT } from '../sim-wasm/init';
import type { EntityStateViews } from '../sim/EntitySlotRegistry';
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
  if (unit === null || unit.hp <= 0) return false;
  const vx = unit.velocityX ?? 0;
  const vy = unit.velocityY ?? 0;
  const vz = unit.velocityZ ?? 0;
  if (vx * vx + vy * vy + vz * vz > ENTITY_MOTION_SPEED_EPSILON_SQ) return true;
  const av = unit.angularVelocity3;
  if (av === null) return false;
  return av.x * av.x + av.y * av.y + av.z * av.z > ENTITY_MOTION_ANGULAR_EPSILON_SQ;
}

export function isEntityMotionDeltaCandidateSlot(
  views: EntityStateViews | null,
  slot: number,
  entityId?: number,
): boolean {
  if (views === null || slot < 0 || slot >= views.capacity) return false;
  if (entityId !== undefined && views.entityId[slot] !== entityId) return false;
  if (views.kind[slot] !== ENTITY_STATE_KIND_UNIT || views.hp[slot] <= 0) return false;
  const vx = views.velX[slot];
  const vy = views.velY[slot];
  const vz = views.velZ[slot];
  if (vx * vx + vy * vy + vz * vz > ENTITY_MOTION_SPEED_EPSILON_SQ) return true;
  const avx = views.angularVelocityX[slot];
  const avy = views.angularVelocityY[slot];
  const avz = views.angularVelocityZ[slot];
  return avx * avx + avy * avy + avz * avz > ENTITY_MOTION_ANGULAR_EPSILON_SQ;
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
