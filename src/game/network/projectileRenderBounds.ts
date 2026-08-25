import type { BeamPoint } from '../sim/types';

type ProjectilePlanarBoundsViews = Readonly<{
  minX: Float32Array;
  maxX: Float32Array;
  minY: Float32Array;
  maxY: Float32Array;
}>;

/** Scan a projectile path once and write its planar bounds without allocation. */
export function writeProjectilePlanarBounds(
  views: ProjectilePlanarBoundsViews,
  slot: number,
  originX: number,
  originY: number,
  points: readonly BeamPoint[] | null,
): boolean {
  let minX = originX;
  let maxX = originX;
  let minY = originY;
  let maxY = originY;
  const hasPoints = points !== null && points.length > 0;
  if (hasPoints) {
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
    }
  }
  views.minX[slot] = minX;
  views.maxX[slot] = maxX;
  views.minY[slot] = minY;
  views.maxY[slot] = maxY;
  return hasPoints;
}
