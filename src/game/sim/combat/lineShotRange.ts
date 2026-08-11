import type { TurretRangeVolume } from '../../../types/blueprints';
import { getSimWasm } from '../../sim-wasm/init';

export type RayConfigRangeCylinder = {
  centerX: number;
  centerY: number;
  centerZ: number;
  radius: number;
  rangeVolume: TurretRangeVolume;
  /** Every ray effect is also confined to this source-centered sphere.
   *  This makes authored vertically-unbounded targeting volumes safe for
   *  collision work while preserving their horizontal/top restrictions. */
  hardRadius: number;
};

const LINE_SHOT_RANGE_VOLUME_CYLINDER_NORMAL = 0;
const LINE_SHOT_RANGE_VOLUME_BOTTOM_UNBOUNDED = 1;
const LINE_SHOT_RANGE_VOLUME_TOP_AND_BOTTOM_UNBOUNDED = 2;
const LINE_SHOT_RANGE_VOLUME_SPHERE = 3;
const LINE_SHOT_RANGE_VOLUME_TOP_WATER_AND_BOTTOM_UNBOUNDED = 4;

function encodeLineShotRangeVolume(rangeVolume: TurretRangeVolume): number {
  switch (rangeVolume) {
    case 'turret-range-cylinder-normal':
      return LINE_SHOT_RANGE_VOLUME_CYLINDER_NORMAL;
    case 'turret-range-bottom-unbounded':
      return LINE_SHOT_RANGE_VOLUME_BOTTOM_UNBOUNDED;
    case 'turret-range-top-water-and-bottom-unbounded':
      return LINE_SHOT_RANGE_VOLUME_TOP_WATER_AND_BOTTOM_UNBOUNDED;
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
  const sim = requireLineShotWasm();
  const volumeDistance = sim.lineShotDistanceToRangeVolume(
    startX, startY, startZ,
    dirX, dirY, dirZ,
    cylinder.centerX,
    cylinder.centerY,
    cylinder.centerZ,
    cylinder.radius,
    encodeLineShotRangeVolume(cylinder.rangeVolume),
  );
  const hardDistance = sim.lineShotDistanceToRangeVolume(
    startX, startY, startZ,
    dirX, dirY, dirZ,
    cylinder.centerX,
    cylinder.centerY,
    cylinder.centerZ,
    cylinder.hardRadius,
    LINE_SHOT_RANGE_VOLUME_SPHERE,
  );
  if (hardDistance < 0) return null;
  return volumeDistance >= 0
    ? Math.min(volumeDistance, hardDistance)
    : hardDistance;
}
