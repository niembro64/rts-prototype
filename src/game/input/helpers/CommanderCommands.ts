// Commander-specific right-click builders shared by 2D and 3D.
// Both renderers previously had their own copy-pastes for "the
// selected commander right-clicked on something repairable".
// Keeping these renderer-agnostic (no dispatch channel, no event
// object) — callers enqueue the returned command themselves.

import type { Entity, WaypointType } from '../../sim/types';
import type {
  ReclaimCommand,
  ReclaimAreaCommand,
  RepairAreaCommand,
  RepairCommand,
  SetFactoryGuardCommand,
  SetRallyPointCommand,
} from '../../sim/commands';
import type { PlayerId } from '../../sim/types';
import { findRepairTargetAt } from './RepairTargetHelper';
import type { RepairEntitySource } from './RepairTargetHelper';
import { findReclaimTargetAt } from './ReclaimTargetHelper';
import type { ReclaimEntitySource } from './ReclaimTargetHelper';
import { isGuardableFriendlyTarget } from './GuardTargetHelper';
import { isReclaimableTarget } from '../../sim/reclaim';

/** Build a RepairCommand if the commander (if any) is right-clicking
 *  on a repairable target — an incomplete friendly building or a
 *  damaged friendly unit. Returns null if no commander is given, no
 *  owner info, or no repair target is under the point. */
export function buildRepairCommandAt(
  source: RepairEntitySource,
  worldX: number,
  worldY: number,
  commander: Entity | null,
  tick: number,
  queue: boolean,
  queueFront = false,
  queueInsertIndex?: number,
): RepairCommand | null {
  if (!commander?.ownership) return null;
  const target = findRepairTargetAt(
    source, worldX, worldY, commander.ownership.playerId,
  );
  if (!target) return null;
  return {
    type: 'repair',
    tick,
    commanderId: commander.id,
    targetId: target.id,
    queue,
    queueFront,
    queueInsertIndex,
  };
}

export function buildRepairAreaCommand(
  commander: Entity | null,
  worldX: number,
  worldY: number,
  radius: number,
  tick: number,
  queue: boolean,
  worldZ?: number,
  queueFront = false,
  queueInsertIndex?: number,
): RepairAreaCommand | null {
  if (!commander?.ownership) return null;
  return {
    type: 'repairArea',
    tick,
    commanderId: commander.id,
    targetX: worldX,
    targetY: worldY,
    targetZ: worldZ,
    radius,
    queue,
    queueFront,
    queueInsertIndex,
  };
}

export function buildReclaimCommandForTarget(
  target: Entity | null | undefined,
  commander: Entity | null,
  tick: number,
  queue: boolean,
  queueFront = false,
  queueInsertIndex?: number,
): ReclaimCommand | null {
  if (!commander?.ownership) return null;
  if (commander.id === target?.id || !isReclaimableTarget(target)) return null;
  return {
    type: 'reclaim',
    tick,
    commanderId: commander.id,
    targetId: target.id,
    queue,
    queueFront,
    queueInsertIndex,
  };
}

export function buildReclaimCommandAt(
  source: ReclaimEntitySource,
  worldX: number,
  worldY: number,
  commander: Entity | null,
  tick: number,
  queue: boolean,
  queueFront = false,
  queueInsertIndex?: number,
): ReclaimCommand | null {
  const target = findReclaimTargetAt(source, worldX, worldY);
  return buildReclaimCommandForTarget(target, commander, tick, queue, queueFront, queueInsertIndex);
}

export function buildReclaimAreaCommand(
  commander: Entity | null,
  worldX: number,
  worldY: number,
  radius: number,
  tick: number,
  queue: boolean,
  worldZ?: number,
  queueFront = false,
  queueInsertIndex?: number,
): ReclaimAreaCommand | null {
  if (!commander?.ownership) return null;
  return {
    type: 'reclaimArea',
    tick,
    commanderId: commander.id,
    targetX: worldX,
    targetY: worldY,
    targetZ: worldZ,
    radius,
    queue,
    queueFront,
    queueInsertIndex,
  };
}

/** Build one SetRallyPointCommand per selected factory at the
 *  given world point. Used when the user right-clicks with no units
 *  selected but one or more factories — each factory stores the same
 *  static rally point. `worldZ` is the click altitude from
 *  CursorGround.pickSim; carried through so factory-spawned units
 *  use the player's clicked 3D ground point as the waypoint goal
 *  instead of a re-sampled terrain altitude. Callers filter
 *  factories beforehand (only truthy .factory + owned by active
 *  player). */
export function buildFactoryRallyCommands(
  factories: readonly Entity[],
  worldX: number,
  worldY: number,
  mode: WaypointType,
  tick: number,
  worldZ?: number,
): SetRallyPointCommand[] {
  const cmds: SetRallyPointCommand[] = [];
  for (const f of factories) {
    if (!f.factory) continue;
    cmds.push({
      type: 'setRallyPoint',
      tick,
      factoryId: f.id,
      rallyX: worldX,
      rallyY: worldY,
      rallyZ: worldZ,
      waypointType: mode,
    });
  }
  return cmds;
}

export function buildFactoryGuardCommands(
  factories: readonly Entity[],
  target: Entity | null | undefined,
  playerId: PlayerId,
  tick: number,
): SetFactoryGuardCommand[] {
  if (!isGuardableFriendlyTarget(target, playerId)) return [];
  const cmds: SetFactoryGuardCommand[] = [];
  for (const f of factories) {
    if (!f.factory) continue;
    cmds.push({
      type: 'setFactoryGuard',
      tick,
      factoryId: f.id,
      targetId: target.id,
    });
  }
  return cmds;
}
