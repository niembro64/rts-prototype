// Path distribution helpers for line move commands

import type { Entity, EntityId } from '../../sim/types';
import { magnitude } from '../../math';

// Point in world space
export interface WorldPoint {
  x: number;
  y: number;
}

// Calculate total length of a path
export function getPathLength(points: WorldPoint[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    length += magnitude(dx, dy);
  }
  return length;
}

// Get a point at a specific distance along the path
export function getPointAtDistance(points: WorldPoint[], targetDist: number): WorldPoint {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return { x: points[0].x, y: points[0].y };

  let traveled = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    const segmentLength = magnitude(dx, dy);

    if (traveled + segmentLength >= targetDist) {
      // The target point is on this segment
      const remaining = targetDist - traveled;
      const t = segmentLength > 0 ? remaining / segmentLength : 0;
      return {
        x: points[i - 1].x + dx * t,
        y: points[i - 1].y + dy * t,
      };
    }
    traveled += segmentLength;
  }

  // Return the last point if we've gone past the end
  return { x: points[points.length - 1].x, y: points[points.length - 1].y };
}

// Calculate target positions distributed evenly along the path
export function calculateLinePathTargets(
  linePathPoints: WorldPoint[],
  unitCount: number
): WorldPoint[] {
  if (unitCount === 0 || linePathPoints.length === 0) {
    return [];
  }

  const pathLength = getPathLength(linePathPoints);
  const targets: WorldPoint[] = [];

  if (unitCount === 1) {
    // Single unit goes to the end of the path
    const lastPoint = linePathPoints[linePathPoints.length - 1];
    targets.push({ x: lastPoint.x, y: lastPoint.y });
  } else {
    // Distribute units evenly along the path
    for (let i = 0; i < unitCount; i++) {
      const t = i / (unitCount - 1); // 0 to 1
      const dist = t * pathLength;
      targets.push(getPointAtDistance(linePathPoints, dist));
    }
  }

  return targets;
}

// Assign units to target positions using closest distance (greedy algorithm)
export function assignUnitsToTargets(
  units: Entity[],
  targets: WorldPoint[]
): Map<EntityId, WorldPoint> {
  const assignments = new Map<EntityId, WorldPoint>();
  const remainingUnits = [...units];
  const remainingTargets = [...targets];

  while (remainingUnits.length > 0 && remainingTargets.length > 0) {
    let bestUnit: Entity | null = null;
    let bestTarget: WorldPoint | null = null;
    let bestDist = Infinity;

    // Find the closest unit-target pair
    for (const unit of remainingUnits) {
      for (const target of remainingTargets) {
        const dx = unit.transform.x - target.x;
        const dy = unit.transform.y - target.y;
        const dist = magnitude(dx, dy);
        if (dist < bestDist) {
          bestDist = dist;
          bestUnit = unit;
          bestTarget = target;
        }
      }
    }

    if (bestUnit && bestTarget) {
      assignments.set(bestUnit.id, bestTarget);
      remainingUnits.splice(remainingUnits.indexOf(bestUnit), 1);
      remainingTargets.splice(remainingTargets.indexOf(bestTarget), 1);
    }
  }

  return assignments;
}
