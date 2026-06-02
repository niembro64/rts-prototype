export type RayConfigRangeCylinder = {
  centerX: number;
  centerY: number;
  centerZ: number;
  radius: number;
};

const LINE_SHOT_RANGE_EPS = 1e-9;

/** Distance along a 3D line-shot ray until it exits the turret's vertical
 *  range cylinder. The cylinder matches the targeting gate: horizontal
 *  radius R, top cap at mount.z + R, and no lower cap. */
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

  if (uz > LINE_SHOT_RANGE_EPS) {
    const topZ = cylinder.centerZ + cylinder.radius;
    const topDistance = (topZ - startZ) / uz;
    if (topDistance >= 0 && Number.isFinite(topDistance)) best = Math.min(best, topDistance);
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
