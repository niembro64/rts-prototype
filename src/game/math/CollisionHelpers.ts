

/** 3D segment-sphere intersection, parametric T in [0, 1] of the first
 *  entry hit, or null if the segment misses. Same algebra as the 2D
 *  variant above with an added z axis: the segment from (x1,y1,z1) →
 *  (x2,y2,z2) is treated as a ray, and the quadratic
 *  `|P(t) − C|² = r²` picks the nearest valid root.
 *
 *  Used by the damage system for swept projectile-vs-unit and
 *  beam-vs-unit collisions, where every shape is a 3D sphere. A
 *  projectile sweeping above a unit's head genuinely misses. */
export function lineSphereIntersectionT(
  x1: number, y1: number, z1: number,
  x2: number, y2: number, z2: number,
  cx: number, cy: number, cz: number,
  r: number
): number | null {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dz = z2 - z1;
  const fx = x1 - cx;
  const fy = y1 - cy;
  const fz = z1 - cz;

  const a = dx * dx + dy * dy + dz * dz;
  const b = 2 * (fx * dx + fy * dy + fz * dz);
  const c = fx * fx + fy * fy + fz * fz - r * r;
  if (c <= 0) return 0;
  if (a === 0) return null;

  let discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;

  discriminant = Math.sqrt(discriminant);

  const t1 = (-b - discriminant) / (2 * a);
  const t2 = (-b + discriminant) / (2 * a);

  if (t1 >= 0 && t1 <= 1) return t1;
  if (t2 >= 0 && t2 <= 1) return t2;
  return null;
}

/** 3D ray vs axis-aligned box intersection (slab method), parametric T
 *  in [0, 1] of the first entry, or null if the ray misses. Buildings
 *  are world-axis boxes (x/y horizontal footprint, z vertical extent);
 *  this lets the beam tracer skip over high buildings when the beam
 *  arcs above them and stop when it clips the side. */
export function rayBoxIntersectionT(
  sx: number, sy: number, sz: number,
  ex: number, ey: number, ez: number,
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
): number | null {
  const dx = ex - sx;
  const dy = ey - sy;
  const dz = ez - sz;

  let tmin = 0;
  let tmax = 1;

  // X slab
  if (Math.abs(dx) > 1e-9) {
    let t1 = (minX - sx) / dx;
    let t2 = (maxX - sx) / dx;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
  } else if (sx < minX || sx > maxX) {
    return null;
  }
  if (tmin > tmax) return null;

  // Y slab
  if (Math.abs(dy) > 1e-9) {
    let t1 = (minY - sy) / dy;
    let t2 = (maxY - sy) / dy;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
  } else if (sy < minY || sy > maxY) {
    return null;
  }
  if (tmin > tmax) return null;

  // Z slab
  if (Math.abs(dz) > 1e-9) {
    let t1 = (minZ - sz) / dz;
    let t2 = (maxZ - sz) / dz;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
  } else if (sz < minZ || sz > maxZ) {
    return null;
  }
  if (tmin > tmax) return null;

  if (tmax < 0) return null;
  return Math.max(tmin, 0);
}





