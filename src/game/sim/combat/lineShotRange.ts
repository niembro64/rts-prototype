import type { TurretRangeVolume } from '../../../types/blueprints';

export type RayConfigRangeCylinder = {
  centerX: number;
  centerY: number;
  centerZ: number;
  radius: number;
  rangeVolume: TurretRangeVolume;
};

const LINE_SHOT_RANGE_EPS = 1e-9;

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
  const dirLen = Math.hypot(dirX, dirY, dirZ);
  if (dirLen <= LINE_SHOT_RANGE_EPS) return null;
  if (
    !Number.isFinite(cylinder.centerX) ||
    !Number.isFinite(cylinder.centerY) ||
    !Number.isFinite(cylinder.centerZ) ||
    !Number.isFinite(cylinder.radius) ||
    cylinder.radius < 0
  ) {
    return null;
  }

  const ux = dirX / dirLen;
  const uy = dirY / dirLen;
  const uz = dirZ / dirLen;
  let best = Number.POSITIVE_INFINITY;

  const ox = startX - cylinder.centerX;
  const oy = startY - cylinder.centerY;
  const oz = startZ - cylinder.centerZ;

  if (cylinder.rangeVolume === 'turret-range-sphere') {
    const sphereB = 2 * (ox * ux + oy * uy + oz * uz);
    const sphereC = ox * ox + oy * oy + oz * oz - cylinder.radius * cylinder.radius;
    const disc = sphereB * sphereB - 4 * sphereC;
    if (disc < 0) return null;
    const sqrtDisc = Math.sqrt(disc);
    const t0 = (-sphereB - sqrtDisc) * 0.5;
    const t1 = (-sphereB + sqrtDisc) * 0.5;
    const t = sphereC <= LINE_SHOT_RANGE_EPS
      ? Math.max(t0, t1)
      : Math.min(t0 >= 0 ? t0 : Number.POSITIVE_INFINITY, t1 >= 0 ? t1 : Number.POSITIVE_INFINITY);
    return t >= 0 && Number.isFinite(t) ? t : null;
  }

  const horizontalA = ux * ux + uy * uy;
  const horizontalC = ox * ox + oy * oy - cylinder.radius * cylinder.radius;
  if (horizontalA > LINE_SHOT_RANGE_EPS) {
    const horizontalB = 2 * (ox * ux + oy * uy);
    const disc = horizontalB * horizontalB - 4 * horizontalA * horizontalC;
    if (disc >= 0) {
      const sqrtDisc = Math.sqrt(disc);
      const invDenom = 1 / (2 * horizontalA);
      const t0 = (-horizontalB - sqrtDisc) * invDenom;
      const t1 = (-horizontalB + sqrtDisc) * invDenom;
      const t = horizontalC <= LINE_SHOT_RANGE_EPS
        ? Math.max(t0, t1)
        : Math.min(t0 >= 0 ? t0 : Number.POSITIVE_INFINITY, t1 >= 0 ? t1 : Number.POSITIVE_INFINITY);
      if (t >= 0 && Number.isFinite(t)) best = Math.min(best, t);
    }
  }

  if (
    cylinder.rangeVolume !== 'turret-range-top-and-bottom-unbounded' &&
    uz > LINE_SHOT_RANGE_EPS
  ) {
    const topZ = cylinder.centerZ + cylinder.radius;
    const topDistance = (topZ - startZ) / uz;
    if (topDistance >= 0 && Number.isFinite(topDistance)) best = Math.min(best, topDistance);
  }
  if (cylinder.rangeVolume === 'turret-range-cylinder-normal' && uz < -LINE_SHOT_RANGE_EPS) {
    const bottomZ = cylinder.centerZ - cylinder.radius;
    const bottomDistance = (bottomZ - startZ) / uz;
    if (bottomDistance >= 0 && Number.isFinite(bottomDistance)) {
      best = Math.min(best, bottomDistance);
    }
  }

  return Number.isFinite(best) ? best : null;
}

export function resolveRayConfigRangeCylinderEndpoint(
  startX: number,
  startY: number,
  startZ: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  cylinder: RayConfigRangeCylinder,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const dirLen = Math.hypot(dirX, dirY, dirZ);
  if (dirLen <= LINE_SHOT_RANGE_EPS) {
    out.x = startX;
    out.y = startY;
    out.z = startZ;
    return out;
  }
  const distance = distanceToRayConfigRangeCylinder(
    startX, startY, startZ, dirX, dirY, dirZ, cylinder,
  );
  if (distance === null) {
    out.x = startX;
    out.y = startY;
    out.z = startZ;
    return out;
  }
  const invDirLen = 1 / dirLen;
  out.x = startX + dirX * invDirLen * distance;
  out.y = startY + dirY * invDirLen * distance;
  out.z = startZ + dirZ * invDirLen * distance;
  return out;
}
