// Commander-specific right-click builders shared by 2D and 3D.
// Both renderers previously had their own copy-pastes for "the
// selected commander right-clicked on something repairable".
// Keeping these renderer-agnostic (no dispatch channel, no event
// object) — callers enqueue the returned command themselves.

import type { Entity, EntityId, WaypointType } from '../../sim/types';
import type {
  CaptureCommand,
  BarAreaCommandExpansion,
  GuardCommand,
  LoadTransportCommand,
  ReclaimCommand,
  ReclaimAreaCommand,
  RepairAreaCommand,
  RepairCommand,
  SetFactoryOutputGuardCommand,
  SetFactoryGuardCommand,
  SetRallyPointCommand,
  UnloadTransportCommand,
} from '../../sim/commands';
import type { PlayerId } from '../../sim/types';
import { findRepairTargetAt, isRepairableFriendlyTarget } from './RepairTargetHelper';
import type { RepairEntitySource } from './RepairTargetHelper';
import { isGuardableFriendlyTarget } from './GuardTargetHelper';
import { buildGuardCommandForTarget } from './RightClickCommands';
import { isPlainQueueAppend, unitHasQueuedDuplicateOrder } from './duplicateOrderGuard';
import { isCapturableTarget } from '../../sim/capture';
import { isReclaimableTarget } from '../../sim/reclaim';
import type { AreaCommandTargetFilter } from '../../sim/areaCommandFilters';
import { isBuildInProgress } from '../../sim/buildableHelpers';
import { canLoadTransport, isClientTransportUnit } from '../../sim/transports';
import { getEntityTargetPoint } from '../../sim/buildingAnchors';
import { getBuilderConstructionRate } from '../../sim/hostCapabilities';
import { entityHasBarFactoryGuardCommand } from '../../sim/unitCommandCapabilities';

/** True when `target` is a completed friendly mobile constructor or factory.
 *  BAR "Guard damaged constructors" (cmd_guard_damaged_constructors.lua)
 *  turns the default right-click REPAIR on such a target into GUARD so the
 *  helpers keep assisting instead of stopping at full health. A target
 *  still under construction keeps plain repair (finish the build). */
function isCompletedFriendlyGuardAssistTarget(target: Entity): boolean {
  if (isBuildInProgress(target.buildable)) return false;
  return target.factory !== null ||
    (target.unit !== null && target.builder !== null);
}

const BAR_MULTI_TRANSPORT_TARGET_LOAD_RADIUS = 150;

type CommandCapableBuilder = Entity & {
  ownership: NonNullable<Entity['ownership']>;
  unit: NonNullable<Entity['unit']>;
  builder: NonNullable<Entity['builder']>;
};

function isCommandCapableBuilder(
  entity: Entity | null | undefined,
): entity is CommandCapableBuilder {
  return entity !== null &&
    entity !== undefined &&
    entity.ownership !== null &&
    entity.unit !== null &&
    entity.builder !== null &&
    getBuilderConstructionRate(entity) > 0;
}

/** Build the default right-click assist command for a ground point: a
 *  RepairCommand when the commander (if any) is right-clicking on a
 *  repairable target — an incomplete friendly building or a damaged
 *  friendly unit — or, per BAR's guard-damaged-constructors default, a
 *  GuardCommand for the selection when that target is a completed
 *  friendly constructor or factory. Returns null if no commander is given, no
 *  owner info, or no repair target is under the point. */
export function buildRepairOrGuardCommandAt(
  source: RepairEntitySource,
  worldX: number,
  worldY: number,
  commander: Entity | null,
  selectedUnits: readonly Entity[],
  tick: number,
  queue: boolean,
  queueFront = false,
  queueInsertIndex?: number,
): RepairCommand | GuardCommand | null {
  if (!isCommandCapableBuilder(commander)) return null;
  const playerId = commander.ownership.playerId;
  const target = findRepairTargetAt(source, worldX, worldY, playerId);
  if (!target) return null;
  return buildRepairOrGuardCommandForTarget(
    target,
    commander,
    selectedUnits,
    tick,
    queue,
    queueFront,
    queueInsertIndex,
    source.arePlayersAllied,
  );
}

/** Build BAR's default assist command against an already-resolved 3D body.
 *  Recoil chooses Repair for an unfinished or damaged allied entity, while
 *  BAR's enabled guard-damaged-constructors widget rewrites Repair to Guard
 *  for a completed mobile constructor or factory. */
export function buildRepairOrGuardCommandForTarget(
  target: Entity | null | undefined,
  commander: Entity | null,
  selectedUnits: readonly Entity[],
  tick: number,
  queue: boolean,
  queueFront = false,
  queueInsertIndex?: number,
  arePlayersAllied?: (a: PlayerId, b: PlayerId) => boolean,
): RepairCommand | GuardCommand | null {
  if (!isCommandCapableBuilder(commander)) return null;
  if (!isRepairableFriendlyTarget(
    target,
    commander.ownership.playerId,
    arePlayersAllied,
  )) return null;
  if (isCompletedFriendlyGuardAssistTarget(target)) {
    return buildGuardCommandForTarget(
      target,
      selectedUnits,
      commander.ownership.playerId,
      tick,
      queue,
      queueFront,
      queueInsertIndex,
      arePlayersAllied,
    );
  }
  // BAR NoDuplicateOrders: drop a shift-appended repair the commander
  // already has queued (including the build assist on the same target).
  if (
    isPlainQueueAppend(queue, queueFront, queueInsertIndex) &&
    unitHasQueuedDuplicateOrder(commander, 'repair', target.id)
  ) return null;
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

/** Build a RepairCommand against an already-resolved entity (the
 *  canonical path for a 3D body pick), so a commander can repair/assist
 *  an airborne or precisely-clicked friendly target — not just whatever
 *  sits under a ground point. */
export function buildRepairCommandForTarget(
  target: Entity | null | undefined,
  commander: Entity | null,
  tick: number,
  queue: boolean,
  queueFront = false,
  queueInsertIndex?: number,
  arePlayersAllied?: (a: PlayerId, b: PlayerId) => boolean,
): RepairCommand | null {
  if (!isCommandCapableBuilder(commander)) return null;
  if (!isRepairableFriendlyTarget(target, commander.ownership.playerId, arePlayersAllied)) return null;
  // BAR NoDuplicateOrders: drop a shift-appended repair the builder
  // already has queued (including the build assist on the same target).
  if (
    isPlainQueueAppend(queue, queueFront, queueInsertIndex) &&
    unitHasQueuedDuplicateOrder(commander, 'repair', target.id)
  ) return null;
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

/** Payload shared verbatim by the repair-area and reclaim-area builder
 *  commands — they differ only in the command type tag, so the field list
 *  lives once here. */
function buildBuilderAreaCommandFields(
  commander: Entity | null,
  worldX: number,
  worldY: number,
  radius: number,
  tick: number,
  queue: boolean,
  worldZ?: number,
  queueFront = false,
  queueInsertIndex?: number,
  targetFilter?: AreaCommandTargetFilter,
  expansion?: BarAreaCommandExpansion,
): Omit<RepairAreaCommand, 'type'> | null {
  if (!isCommandCapableBuilder(commander)) return null;
  return {
    tick,
    commanderId: commander.id,
    targetX: worldX,
    targetY: worldY,
    targetZ: worldZ,
    radius,
    queue,
    queueFront,
    queueInsertIndex,
    filterCategory: targetFilter?.filterCategory,
    filterBlueprintId: targetFilter?.filterBlueprintId,
    targetOrderOriginX: expansion?.targetOrderOriginX,
    targetOrderOriginY: expansion?.targetOrderOriginY,
    targetSplitIndex: expansion?.targetSplitIndex,
    targetSplitCount: expansion?.targetSplitCount,
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
  targetFilter?: AreaCommandTargetFilter,
  expansion?: BarAreaCommandExpansion,
): RepairAreaCommand | null {
  const fields = buildBuilderAreaCommandFields(
    commander, worldX, worldY, radius, tick, queue,
    worldZ, queueFront, queueInsertIndex, targetFilter, expansion,
  );
  return fields === null ? null : { type: 'repairArea', ...fields };
}

export function buildReclaimCommandForTarget(
  target: Entity | null | undefined,
  commander: Entity | null,
  tick: number,
  queue: boolean,
  queueFront = false,
  queueInsertIndex?: number,
): ReclaimCommand | null {
  if (commander === null || commander.id === target?.id || !isReclaimableTarget(target)) {
    return null;
  }
  return buildReclaimCommandForTargetId(
    target.id,
    commander,
    tick,
    queue,
    queueFront,
    queueInsertIndex,
  );
}

/** Reclaim by target id. Vegetation props are addressed the same way
 *  BAR addresses features from a unit order — by an id above the entity
 *  range — so the one Reclaim command covers both stores and the client
 *  never needs a second command shape. */
export function buildReclaimCommandForTargetId(
  targetId: EntityId | null,
  commander: Entity | null,
  tick: number,
  queue: boolean,
  queueFront = false,
  queueInsertIndex?: number,
): ReclaimCommand | null {
  if (targetId === null || !isCommandCapableBuilder(commander)) return null;
  if (commander.id === targetId) return null;
  return {
    type: 'reclaim',
    tick,
    commanderId: commander.id,
    targetId,
    queue,
    queueFront,
    queueInsertIndex,
  };
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
  targetFilter?: AreaCommandTargetFilter,
  expansion?: BarAreaCommandExpansion,
): ReclaimAreaCommand | null {
  const fields = buildBuilderAreaCommandFields(
    commander, worldX, worldY, radius, tick, queue,
    worldZ, queueFront, queueInsertIndex, targetFilter, expansion,
  );
  return fields === null ? null : { type: 'reclaimArea', ...fields };
}

export function buildCaptureCommandForTarget(
  target: Entity | null | undefined,
  commander: Entity | null,
  tick: number,
  queue: boolean,
  queueFront = false,
  queueInsertIndex?: number,
  arePlayersAllied?: (a: PlayerId, b: PlayerId) => boolean,
): CaptureCommand | null {
  const playerId = commander?.ownership?.playerId;
  if (commander === null || commander === undefined || playerId === undefined) return null;
  if (
    commander.id === target?.id ||
    !isCapturableTarget(target, playerId, arePlayersAllied)
  ) return null;
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
  transports: readonly Entity[],
  tick: number,
  queue: boolean,
  queueFront = false,
  queueInsertIndex?: number,
): LoadTransportCommand | null {
  if (target === null || target === undefined) return null;
  const selectedTransports = getSelectedClientTransports(transports);
  if (selectedTransports.length === 0) return null;
  let canAnyTransportLoadTarget = false;
  for (let i = 0; i < selectedTransports.length; i++) {
    if (canLoadTransport(selectedTransports[i], target)) {
      canAnyTransportLoadTarget = true;
      break;
    }
  }
  if (!canAnyTransportLoadTarget) return null;

  if (selectedTransports.length > 1) {
    const targetPoint = getEntityTargetPoint(target);
    return buildLoadTransportAreaCommand(
      selectedTransports,
      targetPoint.x,
      targetPoint.y,
      BAR_MULTI_TRANSPORT_TARGET_LOAD_RADIUS,
      tick,
      queue,
      targetPoint.z,
      queueFront,
      queueInsertIndex,
    );
  }

  const transport = selectedTransports[0];
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

export function buildLoadTransportAreaCommand(
  transports: readonly Entity[],
  worldX: number,
  worldY: number,
  radius: number,
  tick: number,
  queue: boolean,
  worldZ?: number,
  queueFront = false,
  queueInsertIndex?: number,
): LoadTransportCommand | null {
  const transportIds: number[] = [];
  for (let i = 0; i < transports.length; i++) {
    const transport = transports[i];
    if (isClientTransportUnit(transport)) transportIds.push(transport.id);
  }
  if (transportIds.length === 0) return null;
  return {
    type: 'loadTransport',
    tick,
    transportIds,
    targetX: worldX,
    targetY: worldY,
    targetZ: worldZ,
    radius,
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
  radius?: number,
): UnloadTransportCommand | null {
  const transportIds: number[] = [];
  for (let i = 0; i < transports.length; i++) {
    const transport = transports[i];
    if (isClientTransportUnit(transport)) transportIds.push(transport.id);
  }
  if (transportIds.length === 0) return null;
  const command: UnloadTransportCommand = {
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
  if (radius !== undefined) command.radius = radius;
  return command;
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
  queue = false,
  queueFront = false,
  queueInsertIndex?: number,
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
      queue,
      queueFront,
      queueInsertIndex,
    });
  }
  return cmds;
}

export function buildFactoryGuardCommands(
  factories: readonly Entity[],
  target: Entity | null | undefined,
  playerId: PlayerId,
  tick: number,
  arePlayersAllied: ((a: PlayerId, b: PlayerId) => boolean) | undefined = undefined,
  queue = false,
  queueFront = false,
  queueInsertIndex?: number,
): SetFactoryOutputGuardCommand[] {
  if (!isGuardableFriendlyTarget(target, playerId, arePlayersAllied)) return [];
  const cmds: SetFactoryOutputGuardCommand[] = [];
  for (const f of factories) {
    if (!f.factory || target.id === f.id) continue;
    cmds.push({
      type: 'setFactoryOutputGuard',
      tick,
      factoryId: f.id,
      targetId: target.id,
      queue,
      queueFront,
      queueInsertIndex,
    });
  }
  return cmds;
}

/** BAR excludes factories from its ignore-self default-command override.
 *  Guarding the selected factory itself enables Factory Guard without
 *  replacing its authored output route. */
export function buildFactorySelfGuardCommands(
  factories: readonly Entity[],
  target: Entity | null | undefined,
  tick: number,
): SetFactoryGuardCommand[] {
  if (target === null || target === undefined) return [];
  const commands: SetFactoryGuardCommand[] = [];
  for (const factory of factories) {
    if (
      factory.id !== target.id ||
      factory.factory === null ||
      !entityHasBarFactoryGuardCommand(factory)
    ) continue;
    commands.push({
      type: 'setFactoryGuard',
      tick,
      factoryId: factory.id,
      targetId: factory.id,
    });
  }
  return commands;
}
