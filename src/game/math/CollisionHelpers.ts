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
