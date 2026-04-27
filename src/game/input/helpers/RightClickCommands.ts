// Shared command builders for the right-click / right-drag path
// both renderers expose. Neither side enqueues commands directly
// from here — they return a command object (or null) and let the
// caller dispatch it. 2D goes through its local CommandQueue; 3D
// goes through gameConnection.sendCommand. Decoupling the builders
// from the dispatch channel keeps this shared.
//
// Callers keep their own extras (2D has commander-repair pre-check,
// factory-waypoint fallback, build-mode cancel). This file only
// owns the two pieces that were copy-pasted verbatim: attack-if-
// enemy-under-cursor, and the path→move-command transform.

import type { Entity, EntityId, WaypointType, PlayerId } from '../../sim/types';
import type {
  AttackCommand,
  MoveCommand,
  WaypointTarget,
} from '../../sim/commands';
import { findAttackTargetAt } from './AttackTargetHelper';
import type { AttackEntitySource } from './AttackTargetHelper';
import { getPathLength, assignUnitsToTargets } from './PathDistribution';
import type { LinePathAccumulator } from './LinePathAccumulator';

/** Treat paths shorter than this as single-point group moves. The
 *  user probably meant "click here" rather than a micro-drag, so
 *  spreading units across a 5-world-unit line feels wrong. */
const LINE_PATH_MIN_LENGTH = 20;

/** Build an attack command if an enemy (unit or building) is under
 *  the given world point, else return null. The caller decides how
 *  to dispatch it (local queue vs server send). Attack targets the
 *  entity by id, so click altitude isn't needed here — the resolved
 *  target's transform.z is what command execution reads. */
export function buildAttackCommandAt(
  source: AttackEntitySource,
  worldX: number,
  worldY: number,
  selectedUnits: readonly Entity[],
  playerId: PlayerId,
  tick: number,
  queue: boolean,
): AttackCommand | null {
  if (selectedUnits.length === 0) return null;
  const target = findAttackTargetAt(source, worldX, worldY, playerId);
  if (!target) return null;
  return {
    type: 'attack',
    tick,
    entityIds: selectedUnits.map((u) => u.id),
    targetId: target.id,
    queue,
  };
}

/** Turn a finished line path into a MoveCommand. Short paths
 *  (< LINE_PATH_MIN_LENGTH) degrade to a group-move to the final
 *  point so "barely dragged = click" feels right. Long paths run
 *  the unit-to-target assignment and emit individualTargets. */
export function buildLinePathMoveCommand(
  accumulator: LinePathAccumulator,
  selectedUnits: readonly Entity[],
  mode: WaypointType,
  tick: number,
  queue: boolean,
): MoveCommand | null {
  const points = accumulator.points;
  if (selectedUnits.length === 0 || points.length === 0) return null;

  const finalPoint = points[points.length - 1];
  const pathLength = getPathLength(points);

  if (pathLength < LINE_PATH_MIN_LENGTH) {
    return {
      type: 'move',
      tick,
      entityIds: selectedUnits.map((u) => u.id),
      targetX: finalPoint.x,
      targetY: finalPoint.y,
      targetZ: finalPoint.z,
      waypointType: mode,
      queue,
    };
  }

  // Ensure targets reflect the current unit count before assigning.
  accumulator.recomputeTargets(selectedUnits.length);
  const assignments = assignUnitsToTargets(selectedUnits, accumulator.targets);

  const entityIds: EntityId[] = [];
  const individualTargets: WaypointTarget[] = [];
  for (const unit of selectedUnits) {
    const target = assignments.get(unit.id);
    if (target) {
      entityIds.push(unit.id);
      individualTargets.push({ x: target.x, y: target.y, z: target.z });
    }
  }

  return {
    type: 'move',
    tick,
    entityIds,
    individualTargets,
    waypointType: mode,
    queue,
  };
}
