import type { BuildingSupportSurface, Entity } from './types';
import { isOddQuarterTurnGridRotation } from './buildGrid';
import {
  SUPPORT_SURFACE_CONTACT_EPSILON,
  SUPPORT_SURFACE_FOOTPRINT_EPSILON,
} from './supportSurface';

export type BuildingSupportQueryOptions = {
  bodyZ?: number;
  groundOffset?: number;
};

export function cloneBuildingSupportSurface(
  surface: BuildingSupportSurface,
  rotation = 0,
): BuildingSupportSurface {
  if (surface.kind === 'none') {
    return { kind: 'none' };
  }
  const swap = isOddQuarterTurnGridRotation(rotation);
  return {
    kind: 'boxTop',
    topZ: surface.topZ,
    width: swap ? surface.height : surface.width,
    height: swap ? surface.width : surface.height,
  };
}

export function createCollisionTopBuildingSupportSurface(
  width: number,
  height: number,
  depth: number,
): BuildingSupportSurface {
  return { kind: 'boxTop', topZ: depth, width, height };
}

export function sampleBuildingSupportTopZ(
  entity: Entity,
  x: number,
  y: number,
  terrainGroundZ: number,
  options: BuildingSupportQueryOptions = {},
): number | null {
  const building = entity.building;
  if (building === null) return null;
  const support = building.supportSurface;
  if (support.kind !== 'boxTop') return null;

  const topZ = entity.transform.z - building.depth / 2 + support.topZ;
  if (topZ < terrainGroundZ - SUPPORT_SURFACE_CONTACT_EPSILON) return null;

  const dx = x - entity.transform.x;
  const dy = y - entity.transform.y;
  if (Math.abs(dx) > support.width / 2 + SUPPORT_SURFACE_FOOTPRINT_EPSILON) {
    return null;
  }
  if (Math.abs(dy) > support.height / 2 + SUPPORT_SURFACE_FOOTPRINT_EPSILON) {
    return null;
  }

  const bodyZ = options.bodyZ;
  const hasBodyZ = bodyZ !== undefined && Number.isFinite(bodyZ);
  if (hasBodyZ) {
    const groundOffset = options.groundOffset !== undefined && Number.isFinite(options.groundOffset)
      ? options.groundOffset
      : 0;
    const groundPointZ = bodyZ - groundOffset;
    if (bodyZ < topZ - SUPPORT_SURFACE_CONTACT_EPSILON) return null;
    if (groundPointZ < topZ - SUPPORT_SURFACE_CONTACT_EPSILON) return null;
  }

  return topZ;
}
