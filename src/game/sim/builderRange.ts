import { requireSimWasm } from '../sim-wasm/init';
import type { Entity } from './types';

const BUILD_TARGET_KIND_POINT = 0;
const BUILD_TARGET_KIND_BUILDING = 1;
const BUILD_TARGET_KIND_UNIT = 2;

function getBuildRange(entity: Entity): number {
  return entity.builder !== null ? entity.builder.buildRange : 0;
}

function getBuildTargetHorizontalDistance(builder: Entity, target: Entity): number {
  const sim = requireSimWasm('getBuildTargetHorizontalDistance');
  const building = target.building;
  const unit = target.unit;
  const targetKind = building !== null
    ? BUILD_TARGET_KIND_BUILDING
    : unit !== null
      ? BUILD_TARGET_KIND_UNIT
      : BUILD_TARGET_KIND_POINT;
  return sim.buildTargetHorizontalDistance(
    builder.transform.x,
    builder.transform.y,
    target.transform.x,
    target.transform.y,
    targetKind,
    building !== null ? building.width : 0,
    building !== null ? building.height : 0,
    unit !== null ? unit.radius.collision : 0,
  );
}

export function isBuildTargetInRange(builder: Entity, target: Entity): boolean {
  const range = getBuildRange(builder);
  if (range <= 0) return false;
  return getBuildTargetHorizontalDistance(builder, target) <= range;
}

/** The builder's surface-to-surface distance to the target, and its build
 *  range, for callers that aim a NAVIGATION goal at a stand-off inside the
 *  range instead of the (building-blocked) target center. Returns null when
 *  the builder has no range. */
export function getBuildApproachMeasure(
  builder: Entity,
  target: Entity,
): { surfaceDistance: number; range: number } | null {
  const range = getBuildRange(builder);
  if (range <= 0) return null;
  return {
    surfaceDistance: getBuildTargetHorizontalDistance(builder, target),
    range,
  };
}

/** Build-range test against a world point with a circular footprint —
 *  the same surface-to-surface measure entity targets get, for work
 *  targets that are not entities (vegetation props). */
export function isBuildRadiusTargetInRange(
  builder: Entity,
  x: number,
  y: number,
  radius: number,
): boolean {
  const range = getBuildRange(builder);
  if (range <= 0) return false;
  const sim = requireSimWasm('isBuildRadiusTargetInRange');
  return sim.buildTargetHorizontalDistance(
    builder.transform.x,
    builder.transform.y,
    x,
    y,
    BUILD_TARGET_KIND_UNIT,
    0,
    0,
    radius,
  ) <= range;
}
