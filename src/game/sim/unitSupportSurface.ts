import type { Entity, EntityId, UnitSupportSurface } from './types';
import {
  SUPPORT_SURFACE_CONTACT_EPSILON,
  SUPPORT_SURFACE_FOOTPRINT_EPSILON,
} from './supportSurface';

export type UnitSupportQueryOptions = {
  bodyZ?: number;
  groundOffset?: number;
  ignoreEntityId?: EntityId | null;
};

export function cloneUnitSupportSurface(
  surface: UnitSupportSurface | undefined,
): UnitSupportSurface {
  if (surface === undefined || surface.kind === 'none') {
    return { kind: 'none' };
  }
  return {
    kind: 'discTop',
    topZ: surface.topZ,
    radius: surface.radius,
  };
}

export function sampleUnitSupportTopZ(
  entity: Entity,
  x: number,
  y: number,
  terrainGroundZ: number,
  options: UnitSupportQueryOptions = {},
): number | null {
  if (options.ignoreEntityId !== undefined && options.ignoreEntityId === entity.id) {
    return null;
  }

  const unit = entity.unit;
  if (unit === null || unit.hp <= 0) return null;
  const support = unit.supportSurface;
  if (support.kind !== 'discTop') return null;

  const topZ = entity.transform.z - unit.bodyCenterHeight + support.topZ;
  if (topZ < terrainGroundZ - SUPPORT_SURFACE_CONTACT_EPSILON) return null;

  const dx = x - entity.transform.x;
  const dy = y - entity.transform.y;
  const radius = support.radius + SUPPORT_SURFACE_FOOTPRINT_EPSILON;
  if (dx * dx + dy * dy > radius * radius) return null;

  const bodyZ = options.bodyZ;
  const hasBodyZ = bodyZ !== undefined && Number.isFinite(bodyZ);
  if (hasBodyZ) {
    if (bodyZ < topZ - SUPPORT_SURFACE_CONTACT_EPSILON) return null;
  }

  return topZ;
}
