import type { TurretRangeVolume } from '../../../types/blueprints';
import { getSimWasm } from '../../sim-wasm/init';

export type RayConfigRangeCylinder = {
  centerX: number;
  centerY: number;
  centerZ: number;
  radius: number;
  rangeVolume: TurretRangeVolume;
};

const LINE_SHOT_RANGE_VOLUME_CYLINDER_NORMAL = 0;
const LINE_SHOT_RANGE_VOLUME_BOTTOM_UNBOUNDED = 1;
const LINE_SHOT_RANGE_VOLUME_TOP_AND_BOTTOM_UNBOUNDED = 2;
const LINE_SHOT_RANGE_VOLUME_SPHERE = 3;

function encodeLineShotRangeVolume(rangeVolume: TurretRangeVolume): number {
  switch (rangeVolume) {
    case 'turret-range-cylinder-normal':
      return LINE_SHOT_RANGE_VOLUME_CYLINDER_NORMAL;
    case 'turret-range-bottom-unbounded':
      return LINE_SHOT_RANGE_VOLUME_BOTTOM_UNBOUNDED;
    case 'turret-range-top-and-bottom-unbounded':
      return LINE_SHOT_RANGE_VOLUME_TOP_AND_BOTTOM_UNBOUNDED;
    case 'turret-range-sphere':
      return LINE_SHOT_RANGE_VOLUME_SPHERE;
  }
}

function requireLineShotWasm() {
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('Line-shot range clipping requires initialized sim-wasm');
  }
  return sim;
}

/** Distance along a 3D line-shot ray until it exits the turret's range
 *  volume. The cylinder modes match the targeting gate; the sphere mode
 *  clips against a radius-R sphere centered on the mount. */
export function distanceToRayConfigRangeCylinder(
  startX: number,
  startY: number,
  startZ: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  cylinder: RayConfigRangeCylinder,
): number | null {
  const distance = requireLineShotWasm().lineShotDistanceToRangeVolume(
    startX, startY, startZ,
    dirX, dirY, dirZ,
    cylinder.centerX,
    cylinder.centerY,
    cylinder.centerZ,
    cylinder.radius,
    encodeLineShotRangeVolume(cylinder.rangeVolume),
  );
  return distance >= 0 ? distance : null;
}

