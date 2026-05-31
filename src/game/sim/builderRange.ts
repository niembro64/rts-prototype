import { getSimWasm } from '../sim-wasm/init';
import type { Entity } from './types';

const BUILD_TARGET_KIND_POINT = 0;
const BUILD_TARGET_KIND_BUILDING = 1;
const BUILD_TARGET_KIND_UNIT = 2;

export function getBuildRange(entity: Entity): number {
  return entity.builder !== null ? entity.builder.buildRange : 0;
}

export function getBuildTargetHorizontalDistance(builder: Entity, target: Entity): number {
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('getBuildTargetHorizontalDistance: sim-wasm is not initialized');
  }

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
