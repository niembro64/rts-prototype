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
  AttackAreaCommand,
  AttackCommand,
  AttackGroundCommand,
  GuardCommand,
  MoveCommand,
  WaypointTarget,
} from '../../sim/commands';
import { findAttackTargetAt, isAttackableEnemyTarget } from './AttackTargetHelper';
import type { AttackEntitySource } from './AttackTargetHelper';
import { findGuardTargetAt, isGuardableFriendlyTarget } from './GuardTargetHelper';
import type { GuardEntitySource } from './GuardTargetHelper';
import { getPathLength, assignUnitsToTargets } from './PathDistribution';
import type { LinePathAccumulator } from './LinePathAccumulator';

/** Treat paths shorter than this as single-point group moves. The
 *  user probably meant "click here" rather than a micro-drag, so
 *  spreading units across a 5-world-unit line feels wrong. */
const LINE_PATH_MIN_LENGTH = 20;

export function shouldCollapseLinePathToSingleMove(
  points: ReadonlyArray<{ x: number; y: number; z?: number }>,
): boolean {
  return getPathLength(points) < LINE_PATH_MIN_LENGTH;
}

/** Build an attack command against a concrete entity already resolved
 *  by the caller. This is the canonical path for 3D mesh hits; the
 *  ground-point helper below delegates here after resolving by
 *  footprint. */
export function buildAttackCommandForTarget(
  target: Entity | null | undefined,
  selectedUnits: readonly Entity[],
  playerId: PlayerId,
  tick: number,
  queue: boolean,
  queueFront = false,
): AttackCommand | null {
  if (selectedUnits.length === 0) return null;
  if (!isAttackableEnemyTarget(target, playerId)) return null;
  return {
    type: 'attack',
    tick,
    entityIds: selectedUnits.map((u) => u.id),
    targetId: target.id,
    queue,
    queueFront,
  };
}

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
  queueFront = false,
): AttackCommand | null {
  const target = findAttackTargetAt(source, worldX, worldY, playerId);
  return buildAttackCommandForTarget(target, selectedUnits, playerId, tick, queue, queueFront);
}

export function buildAttackAreaCommand(
  selectedUnits: readonly Entity[],
  worldX: number,
  worldY: number,
  radius: number,
  tick: number,
  queue: boolean,
  worldZ?: number,
  queueFront = false,
): AttackAreaCommand | null {
  if (selectedUnits.length === 0) return null;
  return {
    type: 'attackArea',
    tick,
    entityIds: selectedUnits.map((u) => u.id),
    targetX: worldX,
    targetY: worldY,
    targetZ: worldZ,
    radius,
    queue,
    queueFront,
  };
}

export function buildAttackGroundCommand(
  selectedUnits: readonly Entity[],
  worldX: number,
  worldY: number,
  tick: number,
  queue: boolean,
  worldZ?: number,
  queueFront = false,
): AttackGroundCommand | null {
  if (selectedUnits.length === 0) return null;
  return {
    type: 'attackGround',
    tick,
    entityIds: selectedUnits.map((u) => u.id),
    targetX: worldX,
    targetY: worldY,
    targetZ: worldZ,
    queue,
    queueFront,
  };
}

export function buildGuardCommandForTarget(
  target: Entity | null | undefined,
  selectedUnits: readonly Entity[],
  playerId: PlayerId,
  tick: number,
  queue: boolean,
  queueFront = false,
): GuardCommand | null {
  if (!isGuardableFriendlyTarget(target, playerId)) return null;
  const entityIds: EntityId[] = [];
  for (const unit of selectedUnits) {
    if (unit.id !== target.id) entityIds.push(unit.id);
  }
  if (entityIds.length === 0) return null;
  return {
    type: 'guard',
    tick,
    entityIds,
    targetId: target.id,
    queue,
    queueFront,
  };
}

export function buildGuardCommandAt(
  source: GuardEntitySource,
  worldX: number,
  worldY: number,
  selectedUnits: readonly Entity[],
  playerId: PlayerId,
  tick: number,
  queue: boolean,
  queueFront = false,
): GuardCommand | null {
  const target = findGuardTargetAt(source, worldX, worldY, playerId);
  return buildGuardCommandForTarget(target, selectedUnits, playerId, tick, queue, queueFront);
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
  queueFront = false,
  preserveFormation = false,
): MoveCommand | null {
  const points = accumulator.points;
  if (selectedUnits.length === 0 || points.length === 0) return null;

  const finalPoint = points[points.length - 1];

  if (shouldCollapseLinePathToSingleMove(points)) {
    if (preserveFormation) {
      return buildFormationPreservingMoveCommand(
        selectedUnits,
        finalPoint.x,
        finalPoint.y,
        mode,
        tick,
        queue,
        finalPoint.z,
        queueFront,
      );
    }
    return {
      type: 'move',
      tick,
      entityIds: selectedUnits.map((u) => u.id),
      targetX: finalPoint.x,
      targetY: finalPoint.y,
      targetZ: finalPoint.z,
      waypointType: mode,
      queue,
      queueFront,
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
    queueFront,
  };
}

export function buildFormationPreservingMoveCommand(
  selectedUnits: readonly Entity[],
  targetX: number,
  targetY: number,
  mode: WaypointType,
  tick: number,
  queue: boolean,
  targetZ?: number,
  queueFront = false,
): MoveCommand | null {
  if (selectedUnits.length === 0) return null;
  if (selectedUnits.length === 1) {
    return {
      type: 'move',
      tick,
      entityIds: [selectedUnits[0].id],
      targetX,
      targetY,
      targetZ,
      waypointType: mode,
      queue,
      queueFront,
    };
  }

  const targets = buildFormationPreservingMoveTargets(selectedUnits, targetX, targetY, targetZ);

  return {
    type: 'move',
    tick,
    entityIds: targets.entityIds,
    individualTargets: targets.individualTargets,
    formationSpeed: 'slowest',
    waypointType: mode,
    queue,
    queueFront,
  };
}

export function buildFormationPreservingMoveTargets(
  selectedUnits: readonly Entity[],
  targetX: number,
  targetY: number,
  targetZ?: number,
): { entityIds: EntityId[]; individualTargets: WaypointTarget[] } {
  if (selectedUnits.length === 0) {
    return { entityIds: [], individualTargets: [] };
  }

  let cx = 0;
  let cy = 0;
  for (let i = 0; i < selectedUnits.length; i++) {
    cx += selectedUnits[i].transform.x;
    cy += selectedUnits[i].transform.y;
  }
  cx /= selectedUnits.length;
  cy /= selectedUnits.length;

  const entityIds: EntityId[] = [];
  const individualTargets: WaypointTarget[] = [];
  for (let i = 0; i < selectedUnits.length; i++) {
    const unit = selectedUnits[i];
    entityIds.push(unit.id);
    const target: WaypointTarget = {
      x: targetX + (unit.transform.x - cx),
      y: targetY + (unit.transform.y - cy),
    };
    if (targetZ !== undefined) target.z = targetZ;
    individualTargets.push(target);
  }

  return {
    entityIds,
    individualTargets,
  };
}
