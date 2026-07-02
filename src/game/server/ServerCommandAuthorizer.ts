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
  QueueUnitCommand,
  RemoveLastQueuedOrderCommand,
  ResurrectAreaCommand,
  ResurrectCommand,
  ScanCommand,
  SkipCurrentOrderCommand,
  SelfDestructCommand,
  SetBuildingActiveCommand,
  SetBuilderPriorityCommand,
  SetCarrierSpawnCommand,
  SetCloakStateCommand,
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
import { factoryCanProduceUnit } from '../sim/factoryProductionRoster';
import {
  canBuilderUpgradeMetalExtractor,
  isUpgradeableMetalExtractorTarget,
} from '../sim/metalExtractorUpgrade';
import { isResurrectableWreck } from '../sim/wrecks';
import { canLoadTransport, isTransportUnit } from '../sim/transports';
import {
  entityHasBarAttackCommand,
  entityHasBarAreaAttackCommand,
  entityHasBarBuilderPriorityCommand,
  entityHasBarCarrierSpawnCommand,
  entityHasBarCaptureCommand,
  entityHasBarFactoryGuardCommand,
  entityHasBarMoveStateCommand,
  entityHasBarSetTargetCommand,
  entityHasCloakCommand,
} from '../sim/unitCommandCapabilities';

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
      return authorizeUnitListCommand(world, command, playerId);

    case 'setUnitMoveState':
      return authorizeSetUnitMoveStateCommand(world, command, playerId);

    case 'setBuilderPriority':
      return authorizeSetBuilderPriorityCommand(world, command, playerId);

    case 'setCarrierSpawn':
      return authorizeSetCarrierSpawnCommand(world, command, playerId);

    case 'setCloakState':
      return authorizeSetCloakStateCommand(world, command, playerId);

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
      return authorizeAttackCommand(world, command, playerId);

    case 'attackGround':
      return authorizeUnitListCommand(world, command, playerId);

    case 'attackArea':
      return authorizeAttackAreaCommand(world, command, playerId);

    case 'guard':
      return authorizeGuardCommand(world, command, playerId);

    case 'startBuild':
      return authorizeStartBuildCommand(world, command, playerId);

    case 'upgradeMetalExtractor':
      return authorizeUpgradeMetalExtractorCommand(world, command, playerId);

    case 'upgradeMetalExtractorArea':
      return authorizeUpgradeMetalExtractorAreaCommand(world, command, playerId);

    case 'queueUnit':
      return authorizeQueueUnitCommand(world, command, playerId);
    case 'removeFactoryUnitProduction':
      return authorizeQueueUnitCommand(world, command, playerId);

    case 'stopFactoryProduction':
    case 'setFactoryRepeatProduction':
    case 'setRallyPoint':
      return isOwnedFactory(world, command.factoryId, playerId) ? command : null;

    case 'changeFactoryUnitQuota':
      return authorizeQueueUnitCommand(world, command, playerId);

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
  const commander = world.getEntity(command.commanderId);
  if (
    commander === undefined ||
    commander.ownership?.playerId !== playerId ||
    !entityHasBarCaptureCommand(commander)
  ) return null;
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

function authorizeQueueUnitCommand<T extends Pick<QueueUnitCommand, 'factoryId' | 'unitBlueprintId'>>(
  world: WorldState,
  command: T,
  playerId: PlayerId,
): T | null {
  const factory = world.getEntity(command.factoryId);
  if (
    factory === undefined ||
    factory.factory === null ||
    factory.ownership?.playerId !== playerId
  ) {
    return null;
  }
  return factoryCanProduceUnit(factory, command.unitBlueprintId) ? command : null;
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

function authorizeAttackCommand(
  world: WorldState,
  command: AttackCommand,
  playerId: PlayerId,
): AttackCommand | null {
  const sourceIds = command.entityIds;
  if (sourceIds.length === 0) return null;

  const entityIds: EntityId[] = [];
  for (let i = 0; i < sourceIds.length; i++) {
    const id = sourceIds[i];
    const entity = world.getEntity(id);
    if (entity === undefined || entity.ownership?.playerId !== playerId) continue;
    if (!entityHasBarAttackCommand(entity)) continue;
    entityIds.push(id);
  }
  if (entityIds.length === 0) return null;
  return entityIds.length === sourceIds.length ? command : { ...command, entityIds };
}

function authorizeAttackAreaCommand(
  world: WorldState,
  command: AttackAreaCommand,
  playerId: PlayerId,
): AttackAreaCommand | null {
  const sourceIds = command.entityIds;
  if (sourceIds.length === 0) return null;

  const entityIds: EntityId[] = [];
  for (let i = 0; i < sourceIds.length; i++) {
    const id = sourceIds[i];
    const entity = world.getEntity(id);
    if (entity === undefined || entity.ownership?.playerId !== playerId) continue;
    if (!entityHasBarAreaAttackCommand(entity)) continue;
    entityIds.push(id);
  }
  if (entityIds.length === 0) return null;
  return entityIds.length === sourceIds.length ? command : { ...command, entityIds };
}

function authorizeSetUnitMoveStateCommand(
  world: WorldState,
  command: SetUnitMoveStateCommand,
  playerId: PlayerId,
): SetUnitMoveStateCommand | null {
  const sourceIds = command.entityIds;
  if (sourceIds.length === 0) return null;

  const entityIds: EntityId[] = [];
  for (let i = 0; i < sourceIds.length; i++) {
    const id = sourceIds[i];
    const entity = world.getEntity(id);
    if (entity === undefined || entity.ownership?.playerId !== playerId) continue;
    if (!entityHasBarMoveStateCommand(entity)) continue;
    entityIds.push(id);
  }
  if (entityIds.length === 0) return null;
  return entityIds.length === sourceIds.length ? command : { ...command, entityIds };
}

function authorizeGuardCommand(
  world: WorldState,
  command: GuardCommand,
  playerId: PlayerId,
): GuardCommand | null {
  if (!isOwnedEntity(world, command.targetId, playerId)) return null;

  const sourceIds = command.entityIds;
  if (sourceIds.length === 0) return null;

  const entityIds: EntityId[] = [];
  for (let i = 0; i < sourceIds.length; i++) {
    const id = sourceIds[i];
    if (id === command.targetId) continue;
    if (isOwnedUnit(world, id, playerId)) entityIds.push(id);
  }
  if (entityIds.length === 0) return null;
  return entityIds.length === sourceIds.length ? command : { ...command, entityIds };
}

function authorizeSetBuilderPriorityCommand(
  world: WorldState,
  command: SetBuilderPriorityCommand,
  playerId: PlayerId,
): SetBuilderPriorityCommand | null {
  const sourceIds = command.entityIds;
  if (sourceIds.length === 0) return null;

  const entityIds: EntityId[] = [];
  for (let i = 0; i < sourceIds.length; i++) {
    const id = sourceIds[i];
    const entity = world.getEntity(id);
    if (
      entity !== undefined &&
      entity.ownership?.playerId === playerId &&
      entityHasBarBuilderPriorityCommand(entity) &&
      (entity.builder !== null || entity.factory !== null)
    ) {
      entityIds.push(id);
    }
  }
  if (entityIds.length === 0) return null;
  return entityIds.length === sourceIds.length ? command : { ...command, entityIds };
}

function authorizeSetCarrierSpawnCommand(
  world: WorldState,
  command: SetCarrierSpawnCommand,
  playerId: PlayerId,
): SetCarrierSpawnCommand | null {
  const sourceIds = command.entityIds;
  if (sourceIds.length === 0) return null;

  const entityIds: EntityId[] = [];
  for (let i = 0; i < sourceIds.length; i++) {
    const id = sourceIds[i];
    const entity = world.getEntity(id);
    if (
      entity !== undefined &&
      entity.type === 'unit' &&
      entity.factory !== null &&
      entityHasBarCarrierSpawnCommand(entity) &&
      entity.ownership?.playerId === playerId
    ) {
      entityIds.push(id);
    }
  }
  if (entityIds.length === 0) return null;
  return entityIds.length === sourceIds.length ? command : { ...command, entityIds };
}

/** Authorize a target-lock command: every entityId must be an owned combat
 *  entity with a BAR-equivalent targetable weapon. The lock-on `targetId`
 *  itself may name any entity in the world that has an ID (friendly or enemy);
 *  the receiving turret's exclusion policy decides whether to honor it
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
      && entityHasBarSetTargetCommand(entity)
      && entity.ownership !== null
      && entity.ownership.playerId === playerId
    ) {
      entityIds.push(id);
    }
  }
  if (entityIds.length === 0) return null;
  return entityIds.length === sourceIds.length ? command : { ...command, entityIds };
}

function authorizeSetCloakStateCommand(
  world: WorldState,
  command: SetCloakStateCommand,
  playerId: PlayerId,
): SetCloakStateCommand | null {
  const sourceIds = command.entityIds;
  if (sourceIds.length === 0) return null;
  const entityIds: EntityId[] = [];
  for (let i = 0; i < sourceIds.length; i++) {
    const id = sourceIds[i];
    const entity = world.getEntity(id);
    if (
      entity !== undefined &&
      entity.ownership?.playerId === playerId &&
      entityHasCloakCommand(entity)
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
  const factory = world.getEntity(command.factoryId);
  if (
    factory === undefined ||
    factory.factory === null ||
    factory.ownership === null ||
    factory.ownership.playerId !== playerId ||
    !entityHasBarFactoryGuardCommand(factory)
  ) {
    return null;
  }
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
