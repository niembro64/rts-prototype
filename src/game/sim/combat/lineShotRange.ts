export type LineShotRangeCircle = {
  centerX: number;
  centerY: number;
  radius: number;
};

const LINE_SHOT_RANGE_EPS = 1e-9;

/** Distance along a 3D line-shot ray until its XY projection exits the
 *  turret's 2D range circle. The returned value is a distance along the
 *  full ray direction, not a horizontal distance. */
export function distanceToLineShotRangeCircle(
  startX: number,
  startY: number,
  dirX: number,
  dirY: number,
  circle: LineShotRangeCircle,
): number | null {
  const a = dirX * dirX + dirY * dirY;
  if (a <= LINE_SHOT_RANGE_EPS) return null;

  const ox = startX - circle.centerX;
  const oy = startY - circle.centerY;
  const b = 2 * (ox * dirX + oy * dirY);
  const c = ox * ox + oy * oy - circle.radius * circle.radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;

  const sqrtDisc = Math.sqrt(disc);
  const invDenom = 1 / (2 * a);
  const t0 = (-b - sqrtDisc) * invDenom;
  const t1 = (-b + sqrtDisc) * invDenom;
  const best = Math.max(t0, t1);
  return best >= 0 ? best : null;
}

export function resolveLineShotRangeCircleEndpoint(
  startX: number,
  startY: number,
  startZ: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  circle: LineShotRangeCircle,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const distance = distanceToLineShotRangeCircle(startX, startY, dirX, dirY, circle);
  if (distance === null) {
    out.x = startX;
    out.y = startY;
    out.z = startZ;
    return out;
  }
  out.x = startX + dirX * distance;
  out.y = startY + dirY * distance;
  out.z = startZ + dirZ * distance;
  return out;
}
