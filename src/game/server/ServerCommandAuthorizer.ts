import type { WorldState } from '../sim/WorldState';
import type {
  AttackAreaCommand,
  AttackCommand,
  AttackGroundCommand,
  CaptureCommand,
  ClearQueuedOrdersCommand,
  Command,
  GuardCommand,
  LoadTransportCommand,
  ManualLaunchCommand,
  MoveCommand,
  PingCommand,
  RemoveLastQueuedOrderCommand,
  ResurrectAreaCommand,
  ResurrectCommand,
  ScanCommand,
  SkipCurrentOrderCommand,
  SelfDestructCommand,
  SetBuildingActiveCommand,
  SetFireEnabledCommand,
  SetFactoryGuardCommand,
  SetRepeatQueueCommand,
  SetTrajectoryModeCommand,
  SetUnitMoveStateCommand,
  SetTowerTargetCommand,
  StartBuildCommand,
  StopCommand,
  UpgradeMetalExtractorAreaCommand,
  UpgradeMetalExtractorCommand,
  UnloadTransportCommand,
  WaitCommand,
} from '../sim/commands';
import type { EntityId, PlayerId } from '../sim/types';
import {
  canApplyServerControlCommand,
  canBypassGameplayOwnership,
  commandAuthorityPlayerId,
  type CommandAuthority,
} from './commandAuthority';
import { entityCanBuild } from '../sim/builderBuildRoster';
import {
  canBuilderUpgradeMetalExtractor,
  isUpgradeableMetalExtractorTarget,
} from '../sim/metalExtractorUpgrade';
import { isResurrectableWreck } from '../sim/wrecks';
import { canLoadTransport, isTransportUnit } from '../sim/transports';

type UnitListCommand =
  | AttackCommand
  | AttackGroundCommand
  | AttackAreaCommand
  | GuardCommand
  | StopCommand
  | WaitCommand
  | ClearQueuedOrdersCommand
  | RemoveLastQueuedOrderCommand
  | SkipCurrentOrderCommand
  | SetRepeatQueueCommand
  | SetUnitMoveStateCommand;

type AnyEntityListCommand =
  | ManualLaunchCommand
  | SetFireEnabledCommand
  | SetTrajectoryModeCommand
  | SetBuildingActiveCommand
  | SelfDestructCommand;

const _authorizeSeenEntityIds = new Set<EntityId>();

export function canApplyGameServerControlCommand(
  authority: CommandAuthority,
  hostPlayerId: PlayerId,
): boolean {
  return canApplyServerControlCommand(authority, hostPlayerId);
}

export function authorizeGameServerGameplayCommand(
  world: WorldState,
  command: Command,
  authority: CommandAuthority,
): Command | null {
  if (canBypassGameplayOwnership(authority)) return command;
  const playerId = commandAuthorityPlayerId(authority);
  if (playerId === undefined) return null;

  switch (command.type) {
    case 'select':
    case 'clearSelection':
      // Selection is client-local. Never let a network command mutate
      // authoritative world selection state for other players.
      return null;

    case 'ping':
      return authorizePingCommand(command, playerId);

    case 'scan':
      return authorizeScanCommand(command, playerId);

    case 'move':
      return authorizeMoveCommand(world, command, playerId);

    case 'stop':
    case 'clearQueuedOrders':
    case 'removeLastQueuedOrder':
    case 'skipCurrentOrder':
    case 'setRepeatQueue':
    case 'setUnitMoveState':
      return authorizeUnitListCommand(world, command, playerId);

    case 'wait':
      return authorizeUnitListCommand(world, command, playerId);

    case 'setFireEnabled':
    case 'setTrajectoryMode':
    case 'manualLaunch':
      // Combat state controls apply to any owned entity with combat
      // (units + towers). Towers carry the same host-fire contract
      // per budget_design_philosophy.html "Selection Menus Are Uniform Per
      // Entity Type".
      return authorizeAnyEntityListCommand(world, command, playerId);

    case 'setBuildingActive':
    case 'selfDestruct':
      return authorizeAnyEntityListCommand(world, command, playerId);

    case 'setTowerTarget':
      return authorizeSetTowerTargetCommand(world, command, playerId);

    case 'attack':
    case 'attackGround':
    case 'attackArea':
      return authorizeUnitListCommand(world, command, playerId);

    case 'guard':
      if (!isOwnedEntity(world, command.targetId, playerId)) return null;
      return authorizeUnitListCommand(world, command, playerId);

    case 'startBuild':
      return authorizeStartBuildCommand(world, command, playerId);

    case 'upgradeMetalExtractor':
      return authorizeUpgradeMetalExtractorCommand(world, command, playerId);

    case 'upgradeMetalExtractorArea':
      return authorizeUpgradeMetalExtractorAreaCommand(world, command, playerId);

    case 'queueUnit':
    case 'stopFactoryProduction':
    case 'setRallyPoint':
      return isOwnedFactory(world, command.factoryId, playerId) ? command : null;

    case 'setFactoryGuard':
      return authorizeSetFactoryGuardCommand(world, command, playerId);

    case 'fireDGun':
      return isOwnedEntity(world, command.commanderId, playerId) ? command : null;

    case 'repair':
      if (!isOwnedEntity(world, command.commanderId, playerId)) return null;
      return isOwnedEntity(world, command.targetId, playerId) ? command : null;

    case 'repairArea':
      return isOwnedEntity(world, command.commanderId, playerId) ? command : null;

    case 'reclaim':
      return isOwnedEntity(world, command.commanderId, playerId) ? command : null;

    case 'reclaimArea':
      return isOwnedEntity(world, command.commanderId, playerId) ? command : null;

    case 'capture':
      return authorizeCaptureCommand(world, command, playerId);

    case 'resurrect':
      return authorizeResurrectCommand(world, command, playerId);

    case 'resurrectArea':
      return authorizeResurrectAreaCommand(world, command, playerId);

    case 'loadTransport':
      return authorizeLoadTransportCommand(world, command, playerId);

    case 'unloadTransport':
      return authorizeUnloadTransportCommand(world, command, playerId);

    default:
      return null;
  }
}

function authorizeLoadTransportCommand(
  world: WorldState,
  command: LoadTransportCommand,
  playerId: PlayerId,
): LoadTransportCommand | null {
  const transport = world.getEntity(command.transportId);
  if (!isTransportUnit(transport) || transport.ownership?.playerId !== playerId) return null;
  const target = world.getEntity(command.targetId);
  return canLoadTransport(transport, target) ? command : null;
}

function authorizeUnloadTransportCommand(
  world: WorldState,
  command: UnloadTransportCommand,
  playerId: PlayerId,
): UnloadTransportCommand | null {
  const transportIds: EntityId[] = [];
  const seen = _authorizeSeenEntityIds;
  seen.clear();
  for (let i = 0; i < command.transportIds.length; i++) {
    const id = command.transportIds[i];
    if (seen.has(id)) continue;
    seen.add(id);
    const transport = world.getEntity(id);
    if (!isTransportUnit(transport) || transport.ownership?.playerId !== playerId) continue;
    transportIds.push(id);
  }
  seen.clear();
  return transportIds.length > 0 ? { ...command, transportIds } : null;
}

function authorizeCaptureCommand(
  world: WorldState,
  command: CaptureCommand,
  playerId: PlayerId,
): CaptureCommand | null {
  if (!isOwnedEntity(world, command.commanderId, playerId)) return null;
  const target = world.getEntity(command.targetId);
  if (target === undefined || target.ownership === null || target.ownership.playerId === playerId) return null;
  return command;
}

function authorizeResurrectCommand(
  world: WorldState,
  command: ResurrectCommand,
  playerId: PlayerId,
): ResurrectCommand | null {
  if (!isOwnedEntity(world, command.commanderId, playerId)) return null;
  return isResurrectableWreck(world.getEntity(command.targetId)) ? command : null;
}

function authorizeResurrectAreaCommand(
  world: WorldState,
  command: ResurrectAreaCommand,
  playerId: PlayerId,
): ResurrectAreaCommand | null {
  return isOwnedEntity(world, command.commanderId, playerId) ? command : null;
}

function authorizeStartBuildCommand(
  world: WorldState,
  command: StartBuildCommand,
  playerId: PlayerId,
): StartBuildCommand | null {
  const builder = world.getEntity(command.builderId);
  if (builder === undefined || builder.ownership?.playerId !== playerId) return null;
  return entityCanBuild(builder, command.buildingBlueprintId) ? command : null;
}

function authorizeUpgradeMetalExtractorCommand(
  world: WorldState,
  command: UpgradeMetalExtractorCommand,
  playerId: PlayerId,
): UpgradeMetalExtractorCommand | null {
  const builder = world.getEntity(command.builderId);
  if (builder === undefined || builder.ownership?.playerId !== playerId) return null;
  if (!canBuilderUpgradeMetalExtractor(builder)) return null;
  const target = world.getEntity(command.targetId);
  return isUpgradeableMetalExtractorTarget(target, playerId) ? command : null;
}

function authorizeUpgradeMetalExtractorAreaCommand(
  world: WorldState,
  command: UpgradeMetalExtractorAreaCommand,
  playerId: PlayerId,
): UpgradeMetalExtractorAreaCommand | null {
  const builderIds: EntityId[] = [];
  const seen = _authorizeSeenEntityIds;
  seen.clear();
  for (let i = 0; i < command.builderIds.length; i++) {
    const builderId = command.builderIds[i];
    if (seen.has(builderId)) continue;
    seen.add(builderId);
    const builder = world.getEntity(builderId);
    if (builder === undefined || builder.ownership?.playerId !== playerId) continue;
    if (!canBuilderUpgradeMetalExtractor(builder)) continue;
    builderIds.push(builderId);
  }
  seen.clear();
  return builderIds.length > 0 ? { ...command, builderIds } : null;
}

function authorizePingCommand(command: PingCommand, playerId: PlayerId): PingCommand | null {
  if (!Number.isFinite(command.targetX) || !Number.isFinite(command.targetY)) return null;
  if (command.targetZ !== undefined && !Number.isFinite(command.targetZ)) return null;
  return { ...command, playerId };
}

function authorizeScanCommand(command: ScanCommand, playerId: PlayerId): ScanCommand | null {
  if (!Number.isFinite(command.targetX) || !Number.isFinite(command.targetY)) return null;
  return { ...command, playerId };
}

function authorizeMoveCommand(
  world: WorldState,
  command: MoveCommand,
  playerId: PlayerId,
): MoveCommand | null {
  const sourceIds = command.entityIds;
  if (sourceIds.length === 0) return null;

  const hasPerUnitTargets =
    command.individualTargets !== undefined &&
    command.individualTargets.length === sourceIds.length;

  const entityIds: EntityId[] = [];

  if (hasPerUnitTargets) {
    const individualTargets: MoveCommand['individualTargets'] = [];
    for (let i = 0; i < sourceIds.length; i++) {
      const id = sourceIds[i];
      if (!isOwnedUnit(world, id, playerId)) continue;
      entityIds.push(id);
      individualTargets.push(command.individualTargets![i]);
    }
    if (entityIds.length === 0) return null;
    return { ...command, entityIds, individualTargets };
  }

  for (let i = 0; i < sourceIds.length; i++) {
    const id = sourceIds[i];
    if (isOwnedUnit(world, id, playerId)) entityIds.push(id);
  }
  if (entityIds.length === 0) return null;
  return entityIds.length === sourceIds.length ? command : { ...command, entityIds };
}

function authorizeUnitListCommand(
  world: WorldState,
  command: UnitListCommand,
  playerId: PlayerId,
): UnitListCommand | null {
  const sourceIds = command.entityIds;
  if (sourceIds.length === 0) return null;

  const entityIds: EntityId[] = [];
  for (let i = 0; i < sourceIds.length; i++) {
    const id = sourceIds[i];
    if (isOwnedUnit(world, id, playerId)) entityIds.push(id);
  }
  if (entityIds.length === 0) return null;
  return entityIds.length === sourceIds.length ? command : { ...command, entityIds };
}

/** Authorize a target-lock command: every entityId must be an owned combat
 *  entity with at least one turret. The lock-on `targetId` itself may name
 *  any entity in the world that has an ID (friendly or enemy); the
 *  receiving turret's exclusion policy decides whether to honor it
 *  (see budget_design_philosophy.html "Lock-on selection: anything with an
 *  ID is a candidate"). */
function authorizeSetTowerTargetCommand(
  world: WorldState,
  command: SetTowerTargetCommand,
  playerId: PlayerId,
): SetTowerTargetCommand | null {
  const sourceIds = command.entityIds;
  if (sourceIds.length === 0) return null;
  const entityIds: EntityId[] = [];
  for (let i = 0; i < sourceIds.length; i++) {
    const id = sourceIds[i];
    const entity = world.getEntity(id);
    if (
      entity !== undefined
      && entity.combat !== null
      && entity.combat.turrets.length > 0
      && entity.ownership !== null
      && entity.ownership.playerId === playerId
    ) {
      entityIds.push(id);
    }
  }
  if (entityIds.length === 0) return null;
  return entityIds.length === sourceIds.length ? command : { ...command, entityIds };
}

/** Authorize a command whose entityIds may reference any owned entity
 *  (unit, tower, or building). Used by setFireEnabled (units +
 *  towers), setBuildingActive (buildings), and selfDestruct (any). */
function authorizeAnyEntityListCommand(
  world: WorldState,
  command: AnyEntityListCommand,
  playerId: PlayerId,
): AnyEntityListCommand | null {
  const sourceIds = command.entityIds;
  if (sourceIds.length === 0) return null;

  const entityIds: EntityId[] = [];
  for (let i = 0; i < sourceIds.length; i++) {
    const id = sourceIds[i];
    if (isOwnedEntity(world, id, playerId)) entityIds.push(id);
  }
  if (entityIds.length === 0) return null;
  return entityIds.length === sourceIds.length ? command : { ...command, entityIds };
}

function authorizeSetFactoryGuardCommand(
  world: WorldState,
  command: SetFactoryGuardCommand,
  playerId: PlayerId,
): SetFactoryGuardCommand | null {
  if (!isOwnedFactory(world, command.factoryId, playerId)) return null;
  if (command.targetId === null) return command;
  return isOwnedEntity(world, command.targetId, playerId) ? command : null;
}

function isOwnedEntity(world: WorldState, entityId: EntityId, playerId: PlayerId): boolean {
  const entity = world.getEntity(entityId);
  if (entity === undefined || entity.ownership === null) return false;
  return entity.ownership.playerId === playerId;
}

function isOwnedUnit(world: WorldState, entityId: EntityId, playerId: PlayerId): boolean {
  const entity = world.getEntity(entityId);
  if (entity === undefined) return false;
  return (
    entity.type === 'unit' &&
    entity.unit !== null &&
    entity.ownership !== null &&
    entity.ownership.playerId === playerId
  );
}

function isOwnedFactory(world: WorldState, entityId: EntityId, playerId: PlayerId): boolean {
  const entity = world.getEntity(entityId);
  return entity !== undefined &&
    entity.factory !== null &&
    entity.ownership !== null &&
    entity.ownership.playerId === playerId;
}
