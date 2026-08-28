// Path distribution helpers for line move commands

import type { Entity, EntityId } from '../../sim/types';
import { magnitude } from '../../math';

export type { WorldPoint } from '@/types/input';
import type { WorldPoint } from '@/types/input';

// Calculate total length of a path
export function getPathLength(points: readonly WorldPoint[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    length += magnitude(dx, dy);
  }
  return length;
}

// Get a point at a specific distance along the path. Altitude (`z`) is
// linearly interpolated between segment endpoints when both carry one
// (the right-drag accumulator's points each come from CursorGround.pickSim
// so z is present in normal play); the result preserves z so downstream
// command builders can keep the click-altitude all the way through.
function getPointAtDistance(points: readonly WorldPoint[], targetDist: number): WorldPoint {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return { x: points[0].x, y: points[0].y, z: points[0].z };

  let traveled = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    const segmentLength = magnitude(dx, dy);

    if (traveled + segmentLength >= targetDist) {
      // The target point is on this segment
      const remaining = targetDist - traveled;
      const t = segmentLength > 0 ? remaining / segmentLength : 0;
      const za = points[i - 1].z;
      const zb = points[i].z;
      const z = za !== undefined && zb !== undefined ? za + (zb - za) * t : undefined;
      return {
        x: points[i - 1].x + dx * t,
        y: points[i - 1].y + dy * t,
        z,
      };
    }
    traveled += segmentLength;
  }

  // Return the last point if we've gone past the end
  const last = points[points.length - 1];
  return { x: last.x, y: last.y, z: last.z };
}

// Calculate target positions distributed evenly along the path
export function calculateLinePathTargets(
  linePathPoints: readonly WorldPoint[],
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
    targets.push({ x: lastPoint.x, y: lastPoint.y, z: lastPoint.z });
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

/** BAR's CustomFormations2 uses an exact Hungarian assignment for manageable
 *  selections and changes to an ordered no-cross solver for large armies.
 *  128 keeps the exact O(n^3) solve comfortably below a command-frame budget
 *  in the browser while covering formations much larger than BAR's adaptive
 *  desktop-Lua default. */
const EXACT_LINE_ASSIGNMENT_UNIT_LIMIT = 128;

const ASSIGNMENT_EPSILON = 1e-9;
const NO_CROSS_RELAXATION_PASSES = 8;

type AssignmentUnit = {
  unit: Entity;
  x: number;
  y: number;
};

type AssignmentTarget = {
  point: WorldPoint;
  originalIndex: number;
  x: number;
  y: number;
};

function actionCarriesFinalPosition(type: string): boolean {
  return type !== 'wait' && type !== 'selfDestruct';
}

/** A plain queued formation starts after the existing queue. Matching from
 *  that queue's final authored position mirrors BAR and avoids assigning the
 *  next line as though every unit were still at its current body position. */
function assignmentOrigin(unit: Entity, useQueuedFinalPosition: boolean): { x: number; y: number } {
  const actions = unit.unit?.actions;
  if (useQueuedFinalPosition && actions !== undefined) {
    for (let i = actions.length - 1; i >= 0; i--) {
      const action = actions[i];
      if (
        !action.isPathExpansion &&
        actionCarriesFinalPosition(action.type) &&
        Number.isFinite(action.x) &&
        Number.isFinite(action.y)
      ) {
        return { x: action.x, y: action.y };
      }
    }
  }
  return { x: unit.transform.x, y: unit.transform.y };
}

function buildAssignmentUnits(
  units: readonly Entity[],
  useQueuedFinalPosition: boolean,
): AssignmentUnit[] {
  const out: AssignmentUnit[] = [];
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const origin = assignmentOrigin(unit, useQueuedFinalPosition);
    if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y)) continue;
    out.push({ unit, x: origin.x, y: origin.y });
  }
  // Entity identity is the stable tie-break; selection-array order must not
  // make an otherwise identical formation appear random.
  out.sort((a, b) => a.unit.id - b.unit.id);
  return out;
}

function buildAssignmentTargets(targets: readonly WorldPoint[]): AssignmentTarget[] {
  const out: AssignmentTarget[] = [];
  for (let i = 0; i < targets.length; i++) {
    const point = targets[i];
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    out.push({ point, originalIndex: i, x: point.x, y: point.y });
  }
  return out;
}

function assignmentDistance(unit: AssignmentUnit, target: AssignmentTarget): number {
  return magnitude(target.x - unit.x, target.y - unit.y);
}

/** Successive-shortest-augmenting-path form of the Hungarian algorithm.
 *  Rows are stable entity-id order and columns retain drawn-line order, so
 *  equal-cost choices are deterministic. The objective is total travel
 *  distance, not a sequence of locally nearest pairs. */
function assignMinimumTotalDistance(
  units: readonly AssignmentUnit[],
  targets: readonly AssignmentTarget[],
): Map<EntityId, WorldPoint> {
  const count = units.length;
  const costs = new Float64Array(count * count);
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      costs[row * count + col] = assignmentDistance(units[row], targets[col]);
    }
  }

  const rowPotential = new Float64Array(count + 1);
  const colPotential = new Float64Array(count + 1);
  const matchedRowByCol = new Int32Array(count + 1);
  const previousCol = new Int32Array(count + 1);

  for (let row = 1; row <= count; row++) {
    matchedRowByCol[0] = row;
    const minReducedCost = new Float64Array(count + 1);
    minReducedCost.fill(Number.POSITIVE_INFINITY);
    const usedCol = new Uint8Array(count + 1);
    let col0 = 0;

    do {
      usedCol[col0] = 1;
      const row0 = matchedRowByCol[col0];
      let delta = Number.POSITIVE_INFINITY;
      let col1 = 0;
      for (let col = 1; col <= count; col++) {
        if (usedCol[col] !== 0) continue;
        const reduced = costs[(row0 - 1) * count + (col - 1)]
          - rowPotential[row0]
          - colPotential[col];
        if (reduced < minReducedCost[col] - ASSIGNMENT_EPSILON) {
          minReducedCost[col] = reduced;
          previousCol[col] = col0;
        }
        if (
          minReducedCost[col] < delta - ASSIGNMENT_EPSILON ||
          (Math.abs(minReducedCost[col] - delta) <= ASSIGNMENT_EPSILON && col < col1)
        ) {
          delta = minReducedCost[col];
          col1 = col;
        }
      }
      for (let col = 0; col <= count; col++) {
        if (usedCol[col] !== 0) {
          rowPotential[matchedRowByCol[col]] += delta;
          colPotential[col] -= delta;
        } else {
          minReducedCost[col] -= delta;
        }
      }
      col0 = col1;
    } while (matchedRowByCol[col0] !== 0);

    do {
      const col1 = previousCol[col0];
      matchedRowByCol[col0] = matchedRowByCol[col1];
      col0 = col1;
    } while (col0 !== 0);
  }

  const assignments = new Map<EntityId, WorldPoint>();
  for (let col = 1; col <= count; col++) {
    const row = matchedRowByCol[col] - 1;
    if (row >= 0) assignments.set(units[row].unit.id, targets[col - 1].point);
  }
  return assignments;
}

function considerFarthestAxisPair(
  points: readonly { x: number; y: number }[],
  best: { distanceSq: number; dx: number; dy: number },
): void {
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    for (let j = i + 1; j < points.length; j++) {
      const b = points[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq > best.distanceSq + ASSIGNMENT_EPSILON) {
        best.distanceSq = distanceSq;
        best.dx = dx;
        best.dy = dy;
      }
    }
  }
}

function formationAxis(
  units: readonly AssignmentUnit[],
  targets: readonly AssignmentTarget[],
): { x: number; y: number } {
  const best = { distanceSq: -1, dx: 1, dy: 0 };
  considerFarthestAxisPair(units, best);
  considerFarthestAxisPair(targets, best);
  if (best.distanceSq <= ASSIGNMENT_EPSILON) return { x: 1, y: 0 };
  let dx = best.dx;
  let dy = best.dy;
  if (dx < 0 || (Math.abs(dx) <= ASSIGNMENT_EPSILON && dy < 0)) {
    dx = -dx;
    dy = -dy;
  }
  const length = magnitude(dx, dy);
  return { x: dx / length, y: dy / length };
}

function compareAlongAxis(
  a: { x: number; y: number },
  b: { x: number; y: number },
  axis: { x: number; y: number },
  aTie: number,
  bTie: number,
): number {
  const aAlong = a.x * axis.x + a.y * axis.y;
  const bAlong = b.x * axis.x + b.y * axis.y;
  if (Math.abs(aAlong - bAlong) > ASSIGNMENT_EPSILON) return aAlong - bAlong;
  const aAcross = -a.x * axis.y + a.y * axis.x;
  const bAcross = -b.x * axis.y + b.y * axis.x;
  if (Math.abs(aAcross - bAcross) > ASSIGNMENT_EPSILON) return aAcross - bAcross;
  return aTie - bTie;
}

function cross(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function assignmentSegmentsCross(
  a: AssignmentUnit,
  aTarget: AssignmentTarget,
  b: AssignmentUnit,
  bTarget: AssignmentTarget,
): boolean {
  const ab0 = cross(a.x, a.y, aTarget.x, aTarget.y, b.x, b.y);
  const ab1 = cross(a.x, a.y, aTarget.x, aTarget.y, bTarget.x, bTarget.y);
  const cd0 = cross(b.x, b.y, bTarget.x, bTarget.y, a.x, a.y);
  const cd1 = cross(b.x, b.y, bTarget.x, bTarget.y, aTarget.x, aTarget.y);
  return (
    ((ab0 > ASSIGNMENT_EPSILON && ab1 < -ASSIGNMENT_EPSILON) ||
      (ab0 < -ASSIGNMENT_EPSILON && ab1 > ASSIGNMENT_EPSILON)) &&
    ((cd0 > ASSIGNMENT_EPSILON && cd1 < -ASSIGNMENT_EPSILON) ||
      (cd0 < -ASSIGNMENT_EPSILON && cd1 > ASSIGNMENT_EPSILON))
  );
}

/** BAR-style large-selection fallback: order both sets along their greatest
 *  geometric extent, then exchange any crossing routes. It is bounded O(n^2)
 *  work per fixed pass and produces a stable, readable line when an exact
 *  cubic assignment would be inappropriate for a whole army. */
function assignOrderedNoCross(
  unitsSource: readonly AssignmentUnit[],
  targetsSource: readonly AssignmentTarget[],
): Map<EntityId, WorldPoint> {
  const axis = formationAxis(unitsSource, targetsSource);
  const units = [...unitsSource];
  const targets = [...targetsSource];
  units.sort((a, b) => compareAlongAxis(a, b, axis, a.unit.id, b.unit.id));
  targets.sort((a, b) => compareAlongAxis(a, b, axis, a.originalIndex, b.originalIndex));

  for (let pass = 0; pass < NO_CROSS_RELAXATION_PASSES; pass++) {
    let changed = false;
    for (let i = 0; i < units.length - 1; i++) {
      for (let j = i + 1; j < units.length; j++) {
        if (!assignmentSegmentsCross(units[i], targets[i], units[j], targets[j])) continue;
        const swap = targets[i];
        targets[i] = targets[j];
        targets[j] = swap;
        changed = true;
      }
    }
    if (!changed) break;
  }

  const assignments = new Map<EntityId, WorldPoint>();
  for (let i = 0; i < units.length; i++) assignments.set(units[i].unit.id, targets[i].point);
  return assignments;
}

/** Assign every selected unit to one drawn-line slot. Exact matching minimizes
 *  total travel rather than greedily consuming the nearest pair; very large
 *  selections use the BAR-style ordered/no-cross fallback. */
export function assignUnitsToTargets(
  units: readonly Entity[],
  targets: readonly WorldPoint[],
  useQueuedFinalPosition = false,
): Map<EntityId, WorldPoint> {
  const assignmentUnits = buildAssignmentUnits(units, useQueuedFinalPosition);
  const assignmentTargets = buildAssignmentTargets(targets);
  const count = Math.min(assignmentUnits.length, assignmentTargets.length);
  if (count === 0) return new Map<EntityId, WorldPoint>();
  assignmentUnits.length = count;
  assignmentTargets.length = count;
  if (count <= EXACT_LINE_ASSIGNMENT_UNIT_LIMIT) {
    return assignMinimumTotalDistance(assignmentUnits, assignmentTargets);
  }
  return assignOrderedNoCross(assignmentUnits, assignmentTargets);
}
