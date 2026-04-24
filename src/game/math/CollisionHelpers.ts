// Collision geometry helpers - shared by DamageSystem, forceFieldWeapon, ClientViewState

import { normalizeAngle } from './MathHelpers';

// Line-circle intersection - returns parametric T value (0-1) of first intersection, or null
export function lineCircleIntersectionT(
  x1: number, y1: number,
  x2: number, y2: number,
  cx: number, cy: number,
  r: number
): number | null {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const fx = x1 - cx;
  const fy = y1 - cy;

  const a = dx * dx + dy * dy;
  if (a === 0) return null; // Zero-length line

  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;

  let discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;

  discriminant = Math.sqrt(discriminant);

  const t1 = (-b - discriminant) / (2 * a);
  const t2 = (-b + discriminant) / (2 * a);

  // Return smallest t in valid range [0, 1]
  if (t1 >= 0 && t1 <= 1) return t1;
  if (t2 >= 0 && t2 <= 1) return t2;
  return null;
}

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
  if (a === 0) return null;

  const b = 2 * (fx * dx + fy * dy + fz * dz);
  const c = fx * fx + fy * fy + fz * fz - r * r;

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

/** 3D ray vs upright rectangle intersection, parametric T in [0, 1] of
 *  the first hit, or null.
 *
 *  The rectangle is "upright" — its plane contains world +Y (up), its
 *  normal is horizontal. Used by the beam tracer for mirror panels,
 *  which are vertical slabs attached to unit turrets: normal comes from
 *  the panel's yaw, the edge direction is perpendicular to the normal
 *  in the horizontal plane, and the vertical extent runs from `baseZ`
 *  to `topZ` in world-z.
 *
 *  Algebra:
 *    - Plane:  n · (P − C) = 0  where n = (nx, ny, 0), C = (cx, cy, *)
 *    - Ray:    P(t) = S + t·(E − S)
 *    - Solve:  t = (nx·(cx−sx) + ny·(cy−sy)) / (nx·dx + ny·dy)
 *    - Reject if t ∉ [0, 1], if |edge-projection| > halfWidth, or if
 *      the hit's z lies outside [baseZ, topZ].
 *
 *  Because the plane's normal is horizontal, the plane-intersection
 *  test ignores the beam's vertical component entirely — altitude only
 *  matters for the final in-rectangle bounds check. */
export function rayVerticalRectIntersectionT(
  sx: number, sy: number, sz: number,
  ex: number, ey: number, ez: number,
  cx: number, cy: number,
  normalX: number, normalY: number,
  halfWidth: number,
  baseZ: number, topZ: number,
): number | null {
  const dx = ex - sx;
  const dy = ey - sy;
  const denom = dx * normalX + dy * normalY;
  // Beam parallel to the panel's plane (or grazing it) — no valid hit.
  if (Math.abs(denom) < 1e-9) return null;

  const t = ((cx - sx) * normalX + (cy - sy) * normalY) / denom;
  if (t < 0 || t > 1) return null;

  const hx = sx + t * dx;
  const hy = sy + t * dy;
  const hz = sz + t * (ez - sz);

  // Horizontal edge direction = normal rotated 90° CCW.
  const edgeX = -normalY;
  const edgeY = normalX;
  const along = (hx - cx) * edgeX + (hy - cy) * edgeY;
  if (along < -halfWidth || along > halfWidth) return null;
  if (hz < baseZ || hz > topZ) return null;
  return t;
}

// Line-line intersection - returns T value for first line, or null
export function lineLineIntersectionT(
  x1: number, y1: number, x2: number, y2: number,
  x3: number, y3: number, x4: number, y4: number
): number | null {
  const denom = (y4 - y3) * (x2 - x1) - (x4 - x3) * (y2 - y1);
  if (Math.abs(denom) < 0.0001) return null; // Lines are parallel

  const ua = ((x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3)) / denom;
  const ub = ((x2 - x1) * (y1 - y3) - (y2 - y1) * (x1 - x3)) / denom;

  if (ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1) {
    return ua;
  }
  return null;
}

// Line-rectangle intersection - returns parametric T value (0-1) of first intersection, or null
export function lineRectIntersectionT(
  x1: number, y1: number,
  x2: number, y2: number,
  rectX: number, rectY: number,
  rectWidth: number, rectHeight: number
): number | null {
  const left = rectX;
  const right = rectX + rectWidth;
  const top = rectY;
  const bottom = rectY + rectHeight;

  // If start point is inside rectangle, intersection is at t=0
  if (x1 >= left && x1 <= right && y1 >= top && y1 <= bottom) {
    return 0;
  }

  // Check intersection with each edge, track smallest t (inline to avoid array allocation)
  let minT: number | null = null;

  // Top edge
  let t = lineLineIntersectionT(x1, y1, x2, y2, left, top, right, top);
  if (t !== null && (minT === null || t < minT)) minT = t;
  // Bottom edge
  t = lineLineIntersectionT(x1, y1, x2, y2, left, bottom, right, bottom);
  if (t !== null && (minT === null || t < minT)) minT = t;
  // Left edge
  t = lineLineIntersectionT(x1, y1, x2, y2, left, top, left, bottom);
  if (t !== null && (minT === null || t < minT)) minT = t;
  // Right edge
  t = lineLineIntersectionT(x1, y1, x2, y2, right, top, right, bottom);
  if (t !== null && (minT === null || t < minT)) minT = t;

  return minT;
}

// Check if a point is within a pie slice (annular ring between minRadius and maxRadius)
// Takes pre-computed dx, dy, dist to avoid redundant sqrt when caller already has them.
// When isFullCircle is true, skips the expensive atan2 angle checks (360 fields).
export function isPointInSlice(
  dx: number, dy: number, dist: number,
  sliceDirection: number,
  sliceHalfAngle: number,
  maxRadius: number,
  targetRadius: number,
  minRadius: number = 0,
  isFullCircle: boolean = false
): boolean {
  // Check outer distance (accounting for target radius)
  if (dist > maxRadius + targetRadius) return false;

  // Check inner distance (target must be outside inner radius)
  if (minRadius > 0 && dist + targetRadius < minRadius) return false;

  // Full-circle force fields skip the angle check entirely (avoids 2x atan2)
  if (isFullCircle) return true;

  // Check angle (accounting for target angular size)
  const angleToPoint = Math.atan2(dy, dx);
  const angleDiff = normalizeAngle(angleToPoint - sliceDirection);
  const angularSize = dist > 0 ? Math.atan2(targetRadius, dist) : Math.PI;

  return Math.abs(angleDiff) <= sliceHalfAngle + angularSize;
}
