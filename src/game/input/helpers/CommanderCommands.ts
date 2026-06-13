// Commander-specific right-click builders shared by 2D and 3D.
// Both renderers previously had their own copy-pastes for "the
// selected commander right-clicked on something repairable".
// Keeping these renderer-agnostic (no dispatch channel, no event
// object) — callers enqueue the returned command themselves.

import type { Entity, WaypointType } from '../../sim/types';
import type {
  CaptureCommand,
  LoadTransportCommand,
  ReclaimCommand,
  ReclaimAreaCommand,
  RepairAreaCommand,
  RepairCommand,
  ResurrectAreaCommand,
  ResurrectCommand,
  SetFactoryGuardCommand,
  SetRallyPointCommand,
  UnloadTransportCommand,
} from '../../sim/commands';
import type { PlayerId } from '../../sim/types';
import { findRepairTargetAt } from './RepairTargetHelper';
import type { RepairEntitySource } from './RepairTargetHelper';
import { findReclaimTargetAt } from './ReclaimTargetHelper';
import type { ReclaimEntitySource } from './ReclaimTargetHelper';
import { isGuardableFriendlyTarget } from './GuardTargetHelper';
import { isCapturableTarget } from '../../sim/capture';
import { isReclaimableTarget } from '../../sim/reclaim';
import { canLoadTransport, isClientTransportUnit } from '../../sim/transports';

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

export function buildCaptureCommandForTarget(
  target: Entity | null | undefined,
  commander: Entity | null,
  tick: number,
  queue: boolean,
  queueFront = false,
  queueInsertIndex?: number,
): CaptureCommand | null {
  const playerId = commander?.ownership?.playerId;
  if (commander === null || commander === undefined || playerId === undefined) return null;
  if (commander.id === target?.id || !isCapturableTarget(target, playerId)) return null;
  return {
    type: 'capture',
    tick,
    commanderId: commander.id,
    targetId: target.id,
    queue,
    queueFront,
    queueInsertIndex,
  };
}

export function isClientResurrectableWreck(target: Entity | null | undefined): target is Entity {
  if (target === null || target === undefined || target.building === null) return false;
  return target.wreck !== null && target.building.hp > 0;
}

export function buildResurrectCommandForTarget(
  target: Entity | null | undefined,
  commander: Entity | null,
  tick: number,
  queue: boolean,
  queueFront = false,
  queueInsertIndex?: number,
): ResurrectCommand | null {
  const playerId = commander?.ownership?.playerId;
  if (commander === null || commander === undefined || playerId === undefined || commander.builder === null) return null;
  if (commander.id === target?.id || !isClientResurrectableWreck(target)) return null;
  return {
    type: 'resurrect',
    tick,
    commanderId: commander.id,
    targetId: target.id,
    queue,
    queueFront,
    queueInsertIndex,
  };
}

export function buildResurrectAreaCommand(
  commander: Entity | null,
  worldX: number,
  worldY: number,
  radius: number,
  tick: number,
  queue: boolean,
  worldZ?: number,
  queueFront = false,
  queueInsertIndex?: number,
): ResurrectAreaCommand | null {
  if (!commander?.ownership || commander.builder === null) return null;
  return {
    type: 'resurrectArea',
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

export function getSelectedClientTransports(selectedUnits: readonly Entity[]): Entity[] {
  const transports: Entity[] = [];
  for (let i = 0; i < selectedUnits.length; i++) {
    const unit = selectedUnits[i];
    if (isClientTransportUnit(unit)) transports.push(unit);
  }
  return transports;
}

export function buildLoadTransportCommandForTarget(
  target: Entity | null | undefined,
  transport: Entity | null,
  tick: number,
  queue: boolean,
  queueFront = false,
  queueInsertIndex?: number,
): LoadTransportCommand | null {
  if (!canLoadTransport(transport, target)) return null;
  if (transport === null || target === null || target === undefined) return null;
  return {
    type: 'loadTransport',
    tick,
    transportId: transport.id,
    targetId: target.id,
    queue,
    queueFront,
    queueInsertIndex,
  };
}

export function buildUnloadTransportCommand(
  transports: readonly Entity[],
  worldX: number,
  worldY: number,
  tick: number,
  queue: boolean,
  worldZ?: number,
  queueFront = false,
  queueInsertIndex?: number,
): UnloadTransportCommand | null {
  const transportIds: number[] = [];
  for (let i = 0; i < transports.length; i++) {
    const transport = transports[i];
    if (isClientTransportUnit(transport)) transportIds.push(transport.id);
  }
  if (transportIds.length === 0) return null;
  return {
    type: 'unloadTransport',
    tick,
    transportIds,
    targetX: worldX,
    targetY: worldY,
    targetZ: worldZ,
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
