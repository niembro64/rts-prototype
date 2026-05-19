import type {
  AttackAreaCommand,
  AttackCommand,
  AttackGroundCommand,
  CancelQueueItemCommand,
  ClearQueuedOrdersCommand,
  Command,
  FactoryWaypoint,
  FireDGunCommand,
  GuardCommand,
  MoveCommand,
  PingCommand,
  QueueUnitCommand,
  ReclaimCommand,
  RepairAreaCommand,
  RepairCommand,
  RemoveLastQueuedOrderCommand,
  ScanCommand,
  SetFactoryWaypointsCommand,
  SetFireEnabledCommand,
  SetJumpEnabledCommand,
  SetRallyPointCommand,
  StartBuildCommand,
  StopCommand,
  WaitCommand,
  WaypointTarget,
} from '../sim/commands';
import {
  ATTACK_AREA_MAX_RADIUS,
  MAX_FACTORY_WAYPOINTS_PER_COMMAND,
  REPAIR_AREA_MAX_RADIUS,
} from '../sim/commandLimits';
import type { WorldState } from '../sim/WorldState';
import type { BuildingType, EntityId, WaypointType } from '../sim/types';
import { BUILDING_CONFIGS } from '../sim/buildConfigs';
import { isBuildableUnitId } from '../sim/blueprints/unitRoster';
import { SERVER_CONFIG, normalizeSnapshotRate } from '../../serverBarConfig';
import { BATTLE_CONFIG } from '../../battleBarConfig';
import { isForceFieldReflectionMode } from '../../types/shotTypes';

const WAYPOINT_TYPES: readonly WaypointType[] = ['move', 'fight', 'patrol'];

type GroundPoint = { x: number; y: number; z?: number };

export function sanitizeCommand(command: Command, world: WorldState): Command | null {
  if (!command || typeof command.type !== 'string') return null;
  const tick = sanitizeTick(command.tick);
  if (tick === null) return null;

  switch (command.type) {
    case 'select':
    case 'clearSelection':
      return null;

    case 'ping':
      return sanitizePingCommand(command, world, tick);
    case 'scan':
      return sanitizeScanCommand(command, world, tick);
    case 'move':
      return sanitizeMoveCommand(command, world, tick);
    case 'stop':
    case 'clearQueuedOrders':
    case 'removeLastQueuedOrder':
      return sanitizeUnitListCommand(command, tick);
    case 'wait':
      return sanitizeWaitCommand(command, tick);
    case 'setJumpEnabled':
      return sanitizeSetJumpEnabledCommand(command, tick);
    case 'setFireEnabled':
      return sanitizeSetFireEnabledCommand(command, tick);
    case 'attack':
      return sanitizeAttackCommand(command, tick);
    case 'attackGround':
      return sanitizeAttackGroundCommand(command, world, tick);
    case 'attackArea':
      return sanitizeAttackAreaCommand(command, world, tick);
    case 'guard':
      return sanitizeGuardCommand(command, tick);
    case 'startBuild':
      return sanitizeStartBuildCommand(command, tick);
    case 'queueUnit':
      return sanitizeQueueUnitCommand(command, tick);
    case 'cancelQueueItem':
      return sanitizeCancelQueueItemCommand(command, tick);
    case 'setRallyPoint':
      return sanitizeSetRallyPointCommand(command, world, tick);
    case 'setFactoryWaypoints':
      return sanitizeSetFactoryWaypointsCommand(command, world, tick);
    case 'fireDGun':
      return sanitizeFireDgunCommand(command, world, tick);
    case 'repair':
      return sanitizeRepairCommand(command, tick);
    case 'repairArea':
      return sanitizeRepairAreaCommand(command, world, tick);
    case 'reclaim':
      return sanitizeReclaimCommand(command, tick);
    case 'setSnapshotRate':
      return SERVER_CONFIG.snapshot.options.includes(command.rate)
        ? { ...command, tick, rate: normalizeSnapshotRate(command.rate) }
        : null;
    case 'setKeyframeRatio':
      return SERVER_CONFIG.keyframe.options.includes(command.ratio)
        ? { ...command, tick }
        : null;
    case 'setTickRate':
      return SERVER_CONFIG.tickRate.options.includes(command.rate)
        ? { ...command, tick }
        : null;
    case 'setUnitGroundNormalEmaMode':
      return SERVER_CONFIG.unitGroundNormalEma.options.includes(command.mode)
        ? { ...command, tick }
        : null;
    case 'setSendGridInfo':
      return typeof command.enabled === 'boolean' ? { ...command, tick } : null;
    case 'setBackgroundUnitType':
      return typeof command.enabled === 'boolean' && isBuildableUnitId(command.unitType)
        ? { ...command, tick }
        : null;
    case 'setMaxTotalUnits':
      return sanitizeMaxTotalUnitsCommand(command, tick);
    case 'setMirrorsEnabled':
    case 'setForceFieldsEnabled':
    case 'setForceFieldsBlockTargeting':
    case 'setFogOfWarEnabled':
      return typeof command.enabled === 'boolean' ? { ...command, tick } : null;
    case 'setForceFieldReflectionMode':
      return isForceFieldReflectionMode(command.mode) ? { ...command, tick } : null;
  }
}

function sanitizeTick(value: unknown): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value as number));
}

function isEntityId(value: unknown): value is EntityId {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xFFFF_FFFF;
}

function sanitizeEntityIdArray(value: unknown): EntityId[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const ids: EntityId[] = [];
  for (let i = 0; i < value.length; i++) {
    const id = value[i];
    if (!isEntityId(id)) return null;
    ids.push(id);
  }
  return ids.length > 0 ? ids : null;
}

function isBuildingType(value: unknown): value is BuildingType {
  return typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(BUILDING_CONFIGS, value);
}

function sanitizeWaypointType(value: unknown): WaypointType | null {
  return typeof value === 'string' && WAYPOINT_TYPES.includes(value as WaypointType)
    ? value as WaypointType
    : null;
}

function sanitizeGroundPoint(
  world: WorldState,
  x: unknown,
  y: unknown,
  z?: unknown,
): GroundPoint | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (z !== undefined && !Number.isFinite(z)) return null;
  return {
    x: clamp(x as number, 0, world.mapWidth),
    y: clamp(y as number, 0, world.mapHeight),
    z: z === undefined ? undefined : z as number,
  };
}

function sanitizeWaypointTarget(world: WorldState, target: unknown): WaypointTarget | null {
  if (!target || typeof target !== 'object') return null;
  const record = target as Record<string, unknown>;
  const point = sanitizeGroundPoint(world, record.x, record.y, record.z);
  return point === null ? null : point;
}

function sanitizeFactoryWaypoint(world: WorldState, waypoint: unknown): FactoryWaypoint | null {
  if (!waypoint || typeof waypoint !== 'object') return null;
  const record = waypoint as Record<string, unknown>;
  const point = sanitizeGroundPoint(world, record.x, record.y, record.z);
  const type = sanitizeWaypointType(record.type);
  return point === null || type === null ? null : { ...point, type };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function sanitizePingCommand(command: PingCommand, world: WorldState, tick: number): PingCommand | null {
  const point = sanitizeGroundPoint(world, command.targetX, command.targetY, command.targetZ);
  return point === null
    ? null
    : { type: 'ping', tick, targetX: point.x, targetY: point.y, targetZ: point.z };
}

function sanitizeScanCommand(command: ScanCommand, world: WorldState, tick: number): ScanCommand | null {
  const point = sanitizeGroundPoint(world, command.targetX, command.targetY);
  return point === null
    ? null
    : { type: 'scan', tick, targetX: point.x, targetY: point.y };
}

function sanitizeMoveCommand(command: MoveCommand, world: WorldState, tick: number): MoveCommand | null {
  const entityIds = sanitizeEntityIdArray(command.entityIds);
  const waypointType = sanitizeWaypointType(command.waypointType);
  if (entityIds === null || waypointType === null || typeof command.queue !== 'boolean') return null;

  if (command.individualTargets !== undefined) {
    if (!Array.isArray(command.individualTargets) || command.individualTargets.length !== command.entityIds.length) {
      return null;
    }
    const individualTargets: WaypointTarget[] = [];
    for (let i = 0; i < command.individualTargets.length; i++) {
      const target = sanitizeWaypointTarget(world, command.individualTargets[i]);
      if (target === null) return null;
      individualTargets.push(target);
    }
    return { type: 'move', tick, entityIds, individualTargets, waypointType, queue: command.queue };
  }

  const point = sanitizeGroundPoint(world, command.targetX, command.targetY, command.targetZ);
  return point === null
    ? null
    : {
        type: 'move',
        tick,
        entityIds,
        targetX: point.x,
        targetY: point.y,
        targetZ: point.z,
        waypointType,
        queue: command.queue,
      };
}

function sanitizeUnitListCommand(
  command: StopCommand | ClearQueuedOrdersCommand | RemoveLastQueuedOrderCommand,
  tick: number,
): StopCommand | ClearQueuedOrdersCommand | RemoveLastQueuedOrderCommand | null {
  const entityIds = sanitizeEntityIdArray(command.entityIds);
  return entityIds === null ? null : { ...command, tick, entityIds };
}

function sanitizeWaitCommand(command: WaitCommand, tick: number): WaitCommand | null {
  const entityIds = sanitizeEntityIdArray(command.entityIds);
  return entityIds === null || typeof command.queue !== 'boolean'
    ? null
    : { ...command, tick, entityIds, queue: command.queue };
}

function sanitizeSetJumpEnabledCommand(command: SetJumpEnabledCommand, tick: number): SetJumpEnabledCommand | null {
  const entityIds = sanitizeEntityIdArray(command.entityIds);
  return entityIds === null || typeof command.enabled !== 'boolean'
    ? null
    : { ...command, tick, entityIds, enabled: command.enabled };
}

function sanitizeSetFireEnabledCommand(command: SetFireEnabledCommand, tick: number): SetFireEnabledCommand | null {
  const entityIds = sanitizeEntityIdArray(command.entityIds);
  return entityIds === null || typeof command.enabled !== 'boolean'
    ? null
    : { ...command, tick, entityIds, enabled: command.enabled };
}

function sanitizeAttackCommand(command: AttackCommand, tick: number): AttackCommand | null {
  const entityIds = sanitizeEntityIdArray(command.entityIds);
  return entityIds === null || !isEntityId(command.targetId) || typeof command.queue !== 'boolean'
    ? null
    : { ...command, tick, entityIds, targetId: command.targetId, queue: command.queue };
}

function sanitizeAttackGroundCommand(
  command: AttackGroundCommand,
  world: WorldState,
  tick: number,
): AttackGroundCommand | null {
  const entityIds = sanitizeEntityIdArray(command.entityIds);
  const point = sanitizeGroundPoint(world, command.targetX, command.targetY, command.targetZ);
  return entityIds === null || point === null || typeof command.queue !== 'boolean'
    ? null
    : {
        type: 'attackGround',
        tick,
        entityIds,
        targetX: point.x,
        targetY: point.y,
        targetZ: point.z,
        queue: command.queue,
      };
}

function sanitizeAttackAreaCommand(
  command: AttackAreaCommand,
  world: WorldState,
  tick: number,
): AttackAreaCommand | null {
  const entityIds = sanitizeEntityIdArray(command.entityIds);
  const point = sanitizeGroundPoint(world, command.targetX, command.targetY, command.targetZ);
  if (entityIds === null || point === null || typeof command.queue !== 'boolean') return null;
  const radius = Number.isFinite(command.radius)
    ? clamp(command.radius, 1, ATTACK_AREA_MAX_RADIUS)
    : ATTACK_AREA_MAX_RADIUS;
  return {
    type: 'attackArea',
    tick,
    entityIds,
    targetX: point.x,
    targetY: point.y,
    targetZ: point.z,
    radius,
    queue: command.queue,
  };
}

function sanitizeGuardCommand(command: GuardCommand, tick: number): GuardCommand | null {
  const entityIds = sanitizeEntityIdArray(command.entityIds);
  return entityIds === null || !isEntityId(command.targetId) || typeof command.queue !== 'boolean'
    ? null
    : { ...command, tick, entityIds, targetId: command.targetId, queue: command.queue };
}

function sanitizeStartBuildCommand(command: StartBuildCommand, tick: number): StartBuildCommand | null {
  if (
    !isEntityId(command.builderId) ||
    !isBuildingType(command.buildingType) ||
    !Number.isFinite(command.gridX) ||
    !Number.isFinite(command.gridY) ||
    typeof command.queue !== 'boolean'
  ) {
    return null;
  }
  return {
    type: 'startBuild',
    tick,
    builderId: command.builderId,
    buildingType: command.buildingType,
    gridX: Math.floor(command.gridX),
    gridY: Math.floor(command.gridY),
    queue: command.queue,
  };
}

function sanitizeQueueUnitCommand(command: QueueUnitCommand, tick: number): QueueUnitCommand | null {
  return isEntityId(command.factoryId) && isBuildableUnitId(command.unitId)
    ? { ...command, tick, factoryId: command.factoryId, unitId: command.unitId }
    : null;
}

function sanitizeCancelQueueItemCommand(command: CancelQueueItemCommand, tick: number): CancelQueueItemCommand | null {
  return isEntityId(command.factoryId) && Number.isInteger(command.index) && command.index >= 0
    ? { ...command, tick, factoryId: command.factoryId, index: command.index }
    : null;
}

function sanitizeSetRallyPointCommand(
  command: SetRallyPointCommand,
  world: WorldState,
  tick: number,
): SetRallyPointCommand | null {
  const point = sanitizeGroundPoint(world, command.rallyX, command.rallyY);
  return !isEntityId(command.factoryId) || point === null
    ? null
    : { type: 'setRallyPoint', tick, factoryId: command.factoryId, rallyX: point.x, rallyY: point.y };
}

function sanitizeSetFactoryWaypointsCommand(
  command: SetFactoryWaypointsCommand,
  world: WorldState,
  tick: number,
): SetFactoryWaypointsCommand | null {
  if (!isEntityId(command.factoryId) || !Array.isArray(command.waypoints) || typeof command.queue !== 'boolean') {
    return null;
  }
  const count = Math.min(command.waypoints.length, MAX_FACTORY_WAYPOINTS_PER_COMMAND);
  const waypoints: FactoryWaypoint[] = [];
  for (let i = 0; i < count; i++) {
    const waypoint = sanitizeFactoryWaypoint(world, command.waypoints[i]);
    if (waypoint === null) return null;
    waypoints.push(waypoint);
  }
  return { type: 'setFactoryWaypoints', tick, factoryId: command.factoryId, waypoints, queue: command.queue };
}

function sanitizeFireDgunCommand(
  command: FireDGunCommand,
  world: WorldState,
  tick: number,
): FireDGunCommand | null {
  const point = sanitizeGroundPoint(world, command.targetX, command.targetY, command.targetZ);
  return !isEntityId(command.commanderId) || point === null
    ? null
    : {
        type: 'fireDGun',
        tick,
        commanderId: command.commanderId,
        targetX: point.x,
        targetY: point.y,
        targetZ: point.z,
      };
}

function sanitizeRepairCommand(command: RepairCommand, tick: number): RepairCommand | null {
  return isEntityId(command.commanderId) &&
    isEntityId(command.targetId) &&
    typeof command.queue === 'boolean'
    ? { ...command, tick, commanderId: command.commanderId, targetId: command.targetId, queue: command.queue }
    : null;
}

function sanitizeRepairAreaCommand(
  command: RepairAreaCommand,
  world: WorldState,
  tick: number,
): RepairAreaCommand | null {
  const point = sanitizeGroundPoint(world, command.targetX, command.targetY, command.targetZ);
  if (!isEntityId(command.commanderId) || point === null || typeof command.queue !== 'boolean') return null;
  const radius = Number.isFinite(command.radius)
    ? clamp(command.radius, 1, REPAIR_AREA_MAX_RADIUS)
    : REPAIR_AREA_MAX_RADIUS;
  return {
    type: 'repairArea',
    tick,
    commanderId: command.commanderId,
    targetX: point.x,
    targetY: point.y,
    targetZ: point.z,
    radius,
    queue: command.queue,
  };
}

function sanitizeReclaimCommand(command: ReclaimCommand, tick: number): ReclaimCommand | null {
  return isEntityId(command.commanderId) &&
    isEntityId(command.targetId) &&
    typeof command.queue === 'boolean'
    ? { ...command, tick, commanderId: command.commanderId, targetId: command.targetId, queue: command.queue }
    : null;
}

function sanitizeMaxTotalUnitsCommand(command: Command, tick: number): Command | null {
  if (command.type !== 'setMaxTotalUnits' || !Number.isFinite(command.maxTotalUnits)) return null;
  const options = BATTLE_CONFIG.cap.options;
  const min = options[0];
  const max = options[options.length - 1];
  return {
    type: 'setMaxTotalUnits',
    tick,
    maxTotalUnits: Math.floor(clamp(command.maxTotalUnits, min, max)),
  };
}
