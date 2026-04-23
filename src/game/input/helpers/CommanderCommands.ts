// Commander-specific right-click builders shared by 2D and 3D.
// Both renderers previously had their own copy-pastes for "the
// selected commander right-clicked on something repairable".
// Keeping these renderer-agnostic (no dispatch channel, no event
// object) — callers enqueue the returned command themselves.

import type { Entity, WaypointType } from '../../sim/types';
import type {
  RepairCommand,
  SetFactoryWaypointsCommand,
} from '../../sim/commands';
import { findRepairTargetAt } from './RepairTargetHelper';
import type { RepairEntitySource } from './RepairTargetHelper';

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
  };
}

/** Build one SetFactoryWaypointsCommand per selected factory at the
 *  given world point. Used when the user right-clicks with no units
 *  selected but one or more factories — each factory inherits the
 *  same single-waypoint list. Callers filter factories beforehand
 *  (only truthy .factory + owned by active player). */
export function buildFactoryWaypointCommands(
  factories: readonly Entity[],
  worldX: number,
  worldY: number,
  mode: WaypointType,
  tick: number,
  queue: boolean,
): SetFactoryWaypointsCommand[] {
  const cmds: SetFactoryWaypointsCommand[] = [];
  for (const f of factories) {
    if (!f.factory) continue;
    cmds.push({
      type: 'setFactoryWaypoints',
      tick,
      factoryId: f.id,
      waypoints: [{ x: worldX, y: worldY, type: mode }],
      queue,
    });
  }
  return cmds;
}
