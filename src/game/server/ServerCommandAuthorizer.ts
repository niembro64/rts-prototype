import type { WorldState } from '../sim/WorldState';
import type {
  AttackAreaCommand,
  AttackCommand,
  AttackGroundCommand,
  CaptureCommand,
  ClearQueuedOrdersCommand,
  Command,
  FireDGunCommand,
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
  SetFactoryAirIdleStateCommand,
  SetFireEnabledCommand,
  SetFactoryGuardCommand,
  SetFactoryOutputGuardCommand,
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
import { entityCanBuild } from '../sim/hostCapabilities';
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
  entityHasBarAirPlantLandAtCommand,
  entityHasBarBuilderPriorityCommand,
  entityHasBarCarrierSpawnCommand,
  entityHasBarCaptureCommand,
  entityHasBarFactoryGuardCommand,
  entityHasBarFireControlCommand,
  entityHasBarMoveStateCommand,
  entityHasBarSetTargetCommand,
  entityHasBarStopCommand,
  entityCanIssueResurrectCommand,
  entityCanBarAttackGround,
  entityCanBarAttackTarget,
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

    case 'clearQueuedOrders':
    case 'removeLastQueuedOrder':
    case 'skipCurrentOrder':
    case 'setRepeatQueue':
      return authorizeUnitListCommand(world, command, playerId);

    case 'stop':
      return authorizeStopCommand(world, command, playerId);

    case 'setUnitMoveState':
      return authorizeSetUnitMoveStateCommand(world, command, playerId);

    case 'setBuilderPriority':
      return authorizeSetBuilderPriorityCommand(world, command, playerId);

    case 'setCarrierSpawn':
      return authorizeSetCarrierSpawnCommand(world, command, playerId);

    case 'setCloakState':
      return authorizeSetCloakStateCommand(world, command, playerId);

    case 'wait':
      return authorizeWaitCommand(world, command, playerId);

    case 'setFireEnabled':
      return authorizeSetFireEnabledCommand(world, command, playerId);

    case 'setTrajectoryMode':
    case 'manualLaunch':
      // Combat state controls apply to any owned entity with combat
      // (units + armed buildings), independent of host kind.
      return authorizeAnyEntityListCommand(world, command, playerId);

    case 'setBuildingActive':
    case 'selfDestruct':
      return authorizeAnyEntityListCommand(world, command, playerId);

    // A resign names its SUBJECT, not its author, so ownership is the wrong
    // question: this is the seat conceding. The host's power to resign a seat
    // that has been gone past the timeout is granted one level up, where the
    // host player id is known (see LockstepCommandProtocol) — the same place
    // the other host-only commands are gated.
    case 'resign':
      return command.playerId === playerId ? command : null;

    // Same SUBJECT-is-the-seat shape as resign: a player may only move
    // their own auto-conversion slider points.
    case 'setAutoConversionThresholds':
      return command.playerId === playerId ? command : null;

    case 'setTowerTarget':
      return authorizeSetTowerTargetCommand(world, command, playerId);

    case 'attack':
      return authorizeAttackCommand(world, command, playerId);

    case 'attackGround':
      return authorizeAttackGroundCommand(world, command, playerId);

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
    case 'editFactoryQueue':
      return isOwnedFactory(world, command.factoryId, playerId) ? command : null;

    case 'setFactoryAirIdleState':
      return authorizeSetFactoryAirIdleStateCommand(world, command, playerId);

    case 'changeFactoryUnitQuota':
      return authorizeQueueUnitCommand(world, command, playerId);

    case 'setFactoryGuard':
      return authorizeSetFactoryGuardCommand(world, command, playerId);
    case 'setFactoryOutputGuard':
      return authorizeSetFactoryOutputGuardCommand(world, command, playerId);

    case 'fireDGun':
      return authorizeFireDGunCommand(world, command, playerId);

    case 'repair':
      if (!isOwnedBuilderUnit(world, command.commanderId, playerId)) return null;
      return isAlliedEntity(world, command.targetId, playerId) ? command : null;

    case 'repairArea':
      return isOwnedBuilderUnit(world, command.commanderId, playerId) ? command : null;

    case 'reclaim':
      return isOwnedBuilderUnit(world, command.commanderId, playerId) ? command : null;

    case 'reclaimArea':
      return isOwnedBuilderUnit(world, command.commanderId, playerId) ? command : null;

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
  if ('targetId' in command) {
    const transport = world.getEntity(command.transportId);
    if (!isTransportUnit(transport) || transport.ownership?.playerId !== playerId) return null;
    const target = world.getEntity(command.targetId);
    return canLoadTransport(transport, target) ? command : null;
  }
  if (
    !Number.isFinite(command.targetX) ||
    !Number.isFinite(command.targetY) ||
    !Number.isFinite(command.radius) ||
    command.radius <= 0
  ) {
    return null;
  }
  const transportIds = filterOwnedTransportIds(world, command.transportIds, playerId);
  return transportIds.length > 0 ? { ...command, transportIds } : null;
}

function authorizeUnloadTransportCommand(
  world: WorldState,
  command: UnloadTransportCommand,
  playerId: PlayerId,
): UnloadTransportCommand | null {
  const transportIds = filterOwnedTransportIds(world, command.transportIds, playerId);
  return transportIds.length > 0 ? { ...command, transportIds } : null;
}

function filterOwnedTransportIds(
  world: WorldState,
  transportIds: readonly EntityId[],
  playerId: PlayerId,
): EntityId[] {
  const ownedIds: EntityId[] = [];
  const seen = _authorizeSeenEntityIds;
  seen.clear();
  for (let i = 0; i < transportIds.length; i++) {
    const id = transportIds[i];
    if (seen.has(id)) continue;
    seen.add(id);
    const transport = world.getEntity(id);
    if (!isTransportUnit(transport) || transport.ownership?.playerId !== playerId) continue;
    ownedIds.push(id);
  }
  seen.clear();
  return ownedIds;
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
  if (
    target === undefined ||
    target.ownership === null ||
    world.arePlayersAllied(target.ownership.playerId, playerId)
  ) return null;
  return command;
}

function authorizeResurrectCommand(
  world: WorldState,
  command: ResurrectCommand,
  playerId: PlayerId,
): ResurrectCommand | null {
  const commander = world.getEntity(command.commanderId);
  if (
    commander === undefined ||
    commander.ownership?.playerId !== playerId ||
    !entityCanIssueResurrectCommand(commander)
  ) return null;
  return isResurrectableWreck(world.getEntity(command.targetId)) ? command : null;
}

function authorizeResurrectAreaCommand(
  world: WorldState,
  command: ResurrectAreaCommand,
  playerId: PlayerId,
): ResurrectAreaCommand | null {
  const commander = world.getEntity(command.commanderId);
  return commander !== undefined &&
    commander.ownership?.playerId === playerId &&
    entityCanIssueResurrectCommand(commander)
    ? command
    : null;
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

/** BAR-style order filtering: keep only the ids this player may actually issue
 *  this order to, in their original order.
 *
 *  Returns null when nothing survives, the UNTOUCHED command when every id
 *  survives (so the common case allocates nothing and the queued command keeps
 *  its identity), and a narrowed copy otherwise. Every per-order authorizer
 *  below differs only in its eligibility predicate — sharing this tail is what
 *  keeps "empty means reject" and "full means pass through unchanged"
 *  identical across all of them. */
function authorizeEntityIds<C extends { entityIds: EntityId[] }>(
  command: C,
  isEligible: (id: EntityId) => boolean,
): C | null {
  const sourceIds = command.entityIds;
  if (sourceIds.length === 0) return null;

  const entityIds: EntityId[] = [];
  for (let i = 0; i < sourceIds.length; i++) {
    const id = sourceIds[i];
    if (isEligible(id)) entityIds.push(id);
  }
  if (entityIds.length === 0) return null;
  return entityIds.length === sourceIds.length ? command : { ...command, entityIds };
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

  if (hasPerUnitTargets) {
    const entityIds: EntityId[] = [];
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

  return authorizeEntityIds(command, (id) => isOwnedUnit(world, id, playerId));
}

function authorizeUnitListCommand(
  world: WorldState,
  command: UnitListCommand,
  playerId: PlayerId,
): UnitListCommand | null {
  return authorizeEntityIds(command, (id) => isOwnedUnit(world, id, playerId));
}

function authorizeStopCommand(
  world: WorldState,
  command: StopCommand,
  playerId: PlayerId,
): StopCommand | null {
  return authorizeEntityIds(command, (id) =>
    isOwnedBarStoppableEntity(world, id, playerId));
}

function authorizeWaitCommand(
  world: WorldState,
  command: WaitCommand,
  playerId: PlayerId,
): WaitCommand | null {
  if (command.gather === true) {
    return authorizeUnitListCommand(world, command, playerId) as WaitCommand | null;
  }

  return authorizeEntityIds(command, (id) =>
    isOwnedUnit(world, id, playerId) || isOwnedFactory(world, id, playerId));
}

function authorizeAttackCommand(
  world: WorldState,
  command: AttackCommand,
  playerId: PlayerId,
): AttackCommand | null {
  const target = world.getEntity(command.targetId);
  if (
    target === undefined ||
    target.ownership === null ||
    world.arePlayersAllied(playerId, target.ownership.playerId)
  ) {
    return null;
  }

  return authorizeEntityIds(command, (id) => {
    const entity = world.getEntity(id);
    return entity !== undefined
      && entity.ownership?.playerId === playerId
      && entityHasBarAttackCommand(entity)
      && entityCanBarAttackTarget(entity, target);
  });
}

function authorizeAttackGroundCommand(
  world: WorldState,
  command: AttackGroundCommand,
  playerId: PlayerId,
): AttackGroundCommand | null {
  return authorizeEntityIds(command, (id) => {
    const entity = world.getEntity(id);
    return entity !== undefined
      && entity.ownership?.playerId === playerId
      && entityCanBarAttackGround(entity);
  });
}

function authorizeAttackAreaCommand(
  world: WorldState,
  command: AttackAreaCommand,
  playerId: PlayerId,
): AttackAreaCommand | null {
  return authorizeEntityIds(command, (id) => {
    const entity = world.getEntity(id);
    return entity !== undefined
      && entity.ownership?.playerId === playerId
      && entityHasBarAreaAttackCommand(entity);
  });
}

function authorizeSetUnitMoveStateCommand(
  world: WorldState,
  command: SetUnitMoveStateCommand,
  playerId: PlayerId,
): SetUnitMoveStateCommand | null {
  return authorizeEntityIds(command, (id) => {
    const entity = world.getEntity(id);
    return entity !== undefined
      && entity.ownership?.playerId === playerId
      && entityHasBarMoveStateCommand(entity);
  });
}

function authorizeGuardCommand(
  world: WorldState,
  command: GuardCommand,
  playerId: PlayerId,
): GuardCommand | null {
  if (!isAlliedEntity(world, command.targetId, playerId)) return null;

  return authorizeEntityIds(command, (id) =>
    id !== command.targetId && isOwnedUnit(world, id, playerId));
}

function authorizeSetBuilderPriorityCommand(
  world: WorldState,
  command: SetBuilderPriorityCommand,
  playerId: PlayerId,
): SetBuilderPriorityCommand | null {
  return authorizeEntityIds(command, (id) => {
    const entity = world.getEntity(id);
    return entity !== undefined
      && entity.ownership?.playerId === playerId
      && entityHasBarBuilderPriorityCommand(entity)
      && (entity.builder !== null || entity.factory !== null);
  });
}

function authorizeSetCarrierSpawnCommand(
  world: WorldState,
  command: SetCarrierSpawnCommand,
  playerId: PlayerId,
): SetCarrierSpawnCommand | null {
  return authorizeEntityIds(command, (id) => {
    const entity = world.getEntity(id);
    return entity !== undefined
      && entity.type === 'unit'
      && entity.factory !== null
      && entityHasBarCarrierSpawnCommand(entity)
      && entity.ownership?.playerId === playerId;
  });
}

/** Authorize a target-lock command: every entityId must be an owned combat
 *  entity with a BAR-equivalent targetable weapon, and unit analogues with
 *  BAR target restrictions keep those restrictions for explicit locks. */
function authorizeSetTowerTargetCommand(
  world: WorldState,
  command: SetTowerTargetCommand,
  playerId: PlayerId,
): SetTowerTargetCommand | null {
  const target = command.targetId !== null ? world.getEntity(command.targetId) : null;
  const isClearTarget = command.targetId === null &&
    command.targetX === undefined &&
    command.targetY === undefined;
  return authorizeEntityIds(command, (id) => {
    const entity = world.getEntity(id);
    return entity !== undefined
      && entityHasBarSetTargetCommand(entity)
      && (isClearTarget || entityCanBarAttackTarget(entity, target))
      && entity.ownership !== null
      && entity.ownership.playerId === playerId;
  });
}

function authorizeSetFireEnabledCommand(
  world: WorldState,
  command: SetFireEnabledCommand,
  playerId: PlayerId,
): SetFireEnabledCommand | null {
  return authorizeEntityIds(command, (id) => {
    const entity = world.getEntity(id);
    return entity !== undefined
      && entity.ownership?.playerId === playerId
      && entityHasBarFireControlCommand(entity);
  });
}

function authorizeSetCloakStateCommand(
  world: WorldState,
  command: SetCloakStateCommand,
  playerId: PlayerId,
): SetCloakStateCommand | null {
  return authorizeEntityIds(command, (id) => {
    const entity = world.getEntity(id);
    return entity !== undefined
      && entity.ownership?.playerId === playerId
      && entityHasCloakCommand(entity);
  });
}

/** Authorize a command whose entityIds may reference any owned entity
 *  (unit, tower, or building). Used by setFireEnabled (units +
 *  towers), setBuildingActive (buildings), and selfDestruct (any). */
function authorizeAnyEntityListCommand(
  world: WorldState,
  command: AnyEntityListCommand,
  playerId: PlayerId,
): AnyEntityListCommand | null {
  return authorizeEntityIds(command, (id) => isOwnedEntity(world, id, playerId));
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
  return command.targetId === null || command.targetId === factory.id ? command : null;
}

function authorizeSetFactoryOutputGuardCommand(
  world: WorldState,
  command: SetFactoryOutputGuardCommand,
  playerId: PlayerId,
): SetFactoryOutputGuardCommand | null {
  return isOwnedFactory(world, command.factoryId, playerId) &&
    command.targetId !== command.factoryId &&
    isAlliedEntity(world, command.targetId, playerId)
    ? command
    : null;
}

function authorizeSetFactoryAirIdleStateCommand(
  world: WorldState,
  command: SetFactoryAirIdleStateCommand,
  playerId: PlayerId,
): SetFactoryAirIdleStateCommand | null {
  const factory = world.getEntity(command.factoryId);
  return factory !== undefined &&
    factory.factory !== null &&
    factory.ownership !== null &&
    factory.ownership.playerId === playerId &&
    entityHasBarAirPlantLandAtCommand(factory)
    ? command
    : null;
}

function authorizeFireDGunCommand(
  world: WorldState,
  command: FireDGunCommand,
  playerId: PlayerId,
): FireDGunCommand | null {
  if (!isOwnedEntity(world, command.commanderId, playerId)) return null;
  if (command.targetId !== undefined) {
    const target = world.getEntity(command.targetId);
    if (target === undefined) return null;
    if (target.ownership !== null && world.arePlayersAllied(playerId, target.ownership.playerId)) {
      return {
        type: 'fireDGun',
        tick: command.tick,
        commanderId: command.commanderId,
        targetX: command.targetX,
        targetY: command.targetY,
        targetZ: command.targetZ,
      };
    }
  }
  return command;
}

function isOwnedEntity(world: WorldState, entityId: EntityId, playerId: PlayerId): boolean {
  const entity = world.getEntity(entityId);
  if (entity === undefined || entity.ownership === null) return false;
  return entity.ownership.playerId === playerId;
}

function isAlliedEntity(world: WorldState, entityId: EntityId, playerId: PlayerId): boolean {
  const entity = world.getEntity(entityId);
  if (entity === undefined || entity.ownership === null) return false;
  return world.arePlayersAllied(playerId, entity.ownership.playerId);
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

function isOwnedBuilderUnit(world: WorldState, entityId: EntityId, playerId: PlayerId): boolean {
  const entity = world.getEntity(entityId);
  return entity !== undefined &&
    entity.type === 'unit' &&
    entity.unit !== null &&
    entity.builder !== null &&
    entity.ownership?.playerId === playerId;
}

function isOwnedFactory(world: WorldState, entityId: EntityId, playerId: PlayerId): boolean {
  const entity = world.getEntity(entityId);
  return entity !== undefined &&
    entity.factory !== null &&
    entity.ownership !== null &&
    entity.ownership.playerId === playerId;
}

function isOwnedBarStoppableEntity(world: WorldState, entityId: EntityId, playerId: PlayerId): boolean {
  const entity = world.getEntity(entityId);
  return entity !== undefined &&
    entity.ownership !== null &&
    entity.ownership.playerId === playerId &&
    entityHasBarStopCommand(entity);
}
