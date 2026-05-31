export type RayConfigRangeSphere = {
  centerX: number;
  centerY: number;
  centerZ: number;
  radius: number;
};

const LINE_SHOT_RANGE_EPS = 1e-9;

/** Distance along a 3D line-shot ray until it exits the turret's 3D
 *  range sphere. The returned value is a distance along the full ray
 *  direction. Weapon range is a true 3D envelope — a pitched beam
 *  cannot reach farther than its sphere radius regardless of how much
 *  altitude separates shooter and target. */
export function distanceToRayConfigRangeSphere(
  startX: number,
  startY: number,
  startZ: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  sphere: RayConfigRangeSphere,
): number | null {
  const a = dirX * dirX + dirY * dirY + dirZ * dirZ;
  if (a <= LINE_SHOT_RANGE_EPS) return null;

  const ox = startX - sphere.centerX;
  const oy = startY - sphere.centerY;
  const oz = startZ - sphere.centerZ;
  const b = 2 * (ox * dirX + oy * dirY + oz * dirZ);
  const c = ox * ox + oy * oy + oz * oz - sphere.radius * sphere.radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;

  const sqrtDisc = Math.sqrt(disc);
  const invDenom = 1 / (2 * a);
  const t0 = (-b - sqrtDisc) * invDenom;
  const t1 = (-b + sqrtDisc) * invDenom;
  const best = Math.max(t0, t1);
  return best >= 0 ? best : null;
}

export function resolveRayConfigRangeSphereEndpoint(
  startX: number,
  startY: number,
  startZ: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  sphere: RayConfigRangeSphere,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const distance = distanceToRayConfigRangeSphere(
    startX, startY, startZ, dirX, dirY, dirZ, sphere,
  );
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
