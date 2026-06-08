import type {
  AttackAreaCommand,
  AttackCommand,
  AttackGroundCommand,
  ClearQueuedOrdersCommand,
  Command,
  FireDGunCommand,
  GuardCommand,
  MoveCommand,
  PingCommand,
  QueueUnitCommand,
  ReclaimCommand,
  ReclaimAreaCommand,
  RepairAreaCommand,
  RepairCommand,
  RemoveLastQueuedOrderCommand,
  ScanCommand,
  SkipCurrentOrderCommand,
  StopFactoryProductionCommand,
  SetFireEnabledCommand,
  SetBuildingActiveCommand,
  SetRepeatQueueCommand,
  SetUnitMoveStateCommand,
  SelfDestructCommand,
  SetTowerTargetCommand,
  SetFactoryGuardCommand,
  SetRallyPointCommand,
  StartBuildCommand,
  StopCommand,
  WaitCommand,
  WaypointTarget,
} from '../sim/commands';
import {
  ATTACK_AREA_MAX_RADIUS,
  RECLAIM_AREA_MAX_RADIUS,
  REPAIR_AREA_MAX_RADIUS,
} from '../sim/commandLimits';
import type { WorldState } from '../sim/WorldState';
import type { BuildingBlueprintId, EntityId, WaypointType } from '../sim/types';
import { STRUCTURE_CONFIGS } from '../sim/buildConfigs';
import { isBuildableUnitBlueprintId } from '../sim/blueprints/unitRoster';
import { SERVER_CONFIG, normalizeSnapshotRate } from '../../serverBarConfig';
import { BATTLE_CONFIG } from '../../battleBarConfig';
import { isShieldReflectionMode } from '../../types/shotTypes';
import { normalizeAngle } from '../math';

const WAYPOINT_TYPES: readonly WaypointType[] = ['move', 'fight', 'patrol'];
const UNIT_MOVE_STATES: readonly string[] = ['maneuver', 'holdPosition'];

type GroundPoint = { x: number; y: number; z: number | undefined };

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
    case 'skipCurrentOrder':
      return sanitizeUnitListCommand(command, tick);
    case 'setRepeatQueue':
      return sanitizeSetRepeatQueueCommand(command, tick);
    case 'setUnitMoveState':
      return sanitizeSetUnitMoveStateCommand(command, tick);
    case 'wait':
      return sanitizeWaitCommand(command, tick);
    case 'setFireEnabled':
      return sanitizeSetFireEnabledCommand(command, tick);
    case 'setBuildingActive':
      return sanitizeSetBuildingActiveCommand(command, tick);
    case 'selfDestruct':
      return sanitizeSelfDestructCommand(command, tick);
    case 'setTowerTarget':
      return sanitizeSetTowerTargetCommand(command, tick);
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
    case 'stopFactoryProduction':
      return sanitizeStopFactoryProductionCommand(command, tick);
    case 'setRallyPoint':
      return sanitizeSetRallyPointCommand(command, world, tick);
    case 'setFactoryGuard':
      return sanitizeSetFactoryGuardCommand(command, tick);
    case 'fireDGun':
      return sanitizeFireDgunCommand(command, world, tick);
    case 'repair':
      return sanitizeRepairCommand(command, tick);
    case 'repairArea':
      return sanitizeRepairAreaCommand(command, world, tick);
    case 'reclaim':
      return sanitizeReclaimCommand(command, tick);
    case 'reclaimArea':
      return sanitizeReclaimAreaCommand(command, world, tick);
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
    case 'setPaused':
      return typeof command.paused === 'boolean' ? { ...command, tick } : null;
    case 'setUnitGroundNormalEmaMode':
      return SERVER_CONFIG.unitGroundNormalEma.options.includes(command.mode)
        ? { ...command, tick }
        : null;
    case 'setSendGridInfo':
      return typeof command.enabled === 'boolean' ? { ...command, tick } : null;
    case 'setBackgroundUnitBlueprintEnabled':
      return typeof command.enabled === 'boolean' && isBuildableUnitBlueprintId(command.unitBlueprintId)
        ? { ...command, tick }
        : null;
    case 'setMaxTotalUnits':
      return sanitizeMaxTotalUnitsCommand(command, tick);
    case 'setTurretShieldPanelsEnabled':
    case 'setTurretShieldSpheresEnabled':
      return typeof command.enabled === 'boolean'
        ? { ...command, tick, enabled: command.enabled }
        : null;
    case 'setShieldsObstructSight':
    case 'setFogOfWarEnabled':
      return typeof command.enabled === 'boolean' ? { ...command, tick } : null;
    case 'setShieldReflectionMode':
      return isShieldReflectionMode(command.mode)
        ? { ...command, tick, mode: command.mode }
        : null;
    case 'setConverterTax': {
      const tax = command.tax;
      if (typeof tax !== 'number' || !Number.isFinite(tax)) return null;
      const options = BATTLE_CONFIG.converterTax.options;
      const matched = options.find((opt) => Math.abs(opt - tax) < 1e-6);
      return matched !== undefined ? { ...command, tick, tax: matched } : null;
    }
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

function isStructureBlueprintId(value: unknown): value is BuildingBlueprintId {
  return typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(STRUCTURE_CONFIGS, value);
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
  z: unknown = undefined,
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function sanitizeQueueFront(queue: boolean, queueFront: unknown): boolean | null {
  if (queueFront === undefined) return false;
  if (typeof queueFront !== 'boolean') return null;
  return queue && queueFront;
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
  const queueFront = sanitizeQueueFront(command.queue, command.queueFront);
  if (queueFront === null) return null;

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
    return {
      type: 'move',
      tick,
      entityIds,
      individualTargets,
      waypointType,
      queue: command.queue,
      queueFront,
    };
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
        queueFront,
      };
}

function sanitizeUnitListCommand(
  command: StopCommand | ClearQueuedOrdersCommand | RemoveLastQueuedOrderCommand | SkipCurrentOrderCommand,
  tick: number,
): StopCommand | ClearQueuedOrdersCommand | RemoveLastQueuedOrderCommand | SkipCurrentOrderCommand | null {
  const entityIds = sanitizeEntityIdArray(command.entityIds);
  return entityIds === null ? null : { ...command, tick, entityIds };
}

function sanitizeWaitCommand(command: WaitCommand, tick: number): WaitCommand | null {
  const entityIds = sanitizeEntityIdArray(command.entityIds);
  if (entityIds === null || typeof command.queue !== 'boolean') return null;
  const queueFront = sanitizeQueueFront(command.queue, command.queueFront);
  return queueFront === null
    ? null
    : { ...command, tick, entityIds, queue: command.queue, queueFront };
}

function sanitizeSetFireEnabledCommand(command: SetFireEnabledCommand, tick: number): SetFireEnabledCommand | null {
  const entityIds = sanitizeEntityIdArray(command.entityIds);
  return entityIds === null || typeof command.enabled !== 'boolean'
    ? null
    : { ...command, tick, entityIds, enabled: command.enabled };
}

function sanitizeSetBuildingActiveCommand(
  command: SetBuildingActiveCommand,
  tick: number,
): SetBuildingActiveCommand | null {
  const entityIds = sanitizeEntityIdArray(command.entityIds);
  return entityIds === null || typeof command.open !== 'boolean'
    ? null
    : { ...command, tick, entityIds, open: command.open };
}

function sanitizeSetRepeatQueueCommand(
  command: SetRepeatQueueCommand,
  tick: number,
): SetRepeatQueueCommand | null {
  const entityIds = sanitizeEntityIdArray(command.entityIds);
  return entityIds === null || typeof command.enabled !== 'boolean'
    ? null
    : { type: 'setRepeatQueue', tick, entityIds, enabled: command.enabled };
}

function sanitizeSetUnitMoveStateCommand(
  command: SetUnitMoveStateCommand,
  tick: number,
): SetUnitMoveStateCommand | null {
  const entityIds = sanitizeEntityIdArray(command.entityIds);
  return entityIds === null || !UNIT_MOVE_STATES.includes(command.moveState)
    ? null
    : { type: 'setUnitMoveState', tick, entityIds, moveState: command.moveState };
}

function sanitizeSelfDestructCommand(
  command: SelfDestructCommand,
  tick: number,
): SelfDestructCommand | null {
  const entityIds = sanitizeEntityIdArray(command.entityIds);
  return entityIds === null ? null : { ...command, tick, entityIds };
}

function sanitizeSetTowerTargetCommand(
  command: SetTowerTargetCommand,
  tick: number,
): SetTowerTargetCommand | null {
  const entityIds = sanitizeEntityIdArray(command.entityIds);
  if (entityIds === null) return null;
  // `null` is the canonical "clear lock" sentinel; otherwise the
  // targetId must be a real entity id.
  if (command.targetId !== null && !isEntityId(command.targetId)) return null;
  return { ...command, tick, entityIds, targetId: command.targetId };
}

function sanitizeAttackCommand(command: AttackCommand, tick: number): AttackCommand | null {
  const entityIds = sanitizeEntityIdArray(command.entityIds);
  if (entityIds === null || !isEntityId(command.targetId) || typeof command.queue !== 'boolean') return null;
  const queueFront = sanitizeQueueFront(command.queue, command.queueFront);
  return queueFront === null
    ? null
    : { ...command, tick, entityIds, targetId: command.targetId, queue: command.queue, queueFront };
}

function sanitizeAttackGroundCommand(
  command: AttackGroundCommand,
  world: WorldState,
  tick: number,
): AttackGroundCommand | null {
  const entityIds = sanitizeEntityIdArray(command.entityIds);
  const point = sanitizeGroundPoint(world, command.targetX, command.targetY, command.targetZ);
  if (entityIds === null || point === null || typeof command.queue !== 'boolean') return null;
  const queueFront = sanitizeQueueFront(command.queue, command.queueFront);
  return queueFront === null
    ? null
    : {
        type: 'attackGround',
        tick,
        entityIds,
        targetX: point.x,
        targetY: point.y,
        targetZ: point.z,
        queue: command.queue,
        queueFront,
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
  const queueFront = sanitizeQueueFront(command.queue, command.queueFront);
  if (queueFront === null) return null;
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
    queueFront,
  };
}

function sanitizeGuardCommand(command: GuardCommand, tick: number): GuardCommand | null {
  const entityIds = sanitizeEntityIdArray(command.entityIds);
  if (entityIds === null || !isEntityId(command.targetId) || typeof command.queue !== 'boolean') return null;
  const queueFront = sanitizeQueueFront(command.queue, command.queueFront);
  return queueFront === null
    ? null
    : { ...command, tick, entityIds, targetId: command.targetId, queue: command.queue, queueFront };
}

function sanitizeStartBuildCommand(command: StartBuildCommand, tick: number): StartBuildCommand | null {
  if (
    !isEntityId(command.builderId) ||
    !isStructureBlueprintId(command.buildingBlueprintId) ||
    !Number.isFinite(command.gridX) ||
    !Number.isFinite(command.gridY) ||
    typeof command.queue !== 'boolean'
  ) {
    return null;
  }
  const queueFront = sanitizeQueueFront(command.queue, command.queueFront);
  if (queueFront === null) return null;
  const rotation = command.rotation === undefined
    ? 0
    : Number.isFinite(command.rotation) ? normalizeAngle(command.rotation) : null;
  if (rotation === null) return null;
  return {
    type: 'startBuild',
    tick,
    builderId: command.builderId,
    buildingBlueprintId: command.buildingBlueprintId,
    gridX: Math.floor(command.gridX),
    gridY: Math.floor(command.gridY),
    rotation,
    queue: command.queue,
    queueFront,
  };
}

function sanitizeQueueUnitCommand(command: QueueUnitCommand, tick: number): QueueUnitCommand | null {
  return isEntityId(command.factoryId) && isBuildableUnitBlueprintId(command.unitBlueprintId)
    ? { ...command, tick, factoryId: command.factoryId, unitBlueprintId: command.unitBlueprintId }
    : null;
}

function sanitizeStopFactoryProductionCommand(
  command: StopFactoryProductionCommand,
  tick: number,
): StopFactoryProductionCommand | null {
  return isEntityId(command.factoryId)
    ? { type: 'stopFactoryProduction', tick, factoryId: command.factoryId }
    : null;
}

function sanitizeSetRallyPointCommand(
  command: SetRallyPointCommand,
  world: WorldState,
  tick: number,
): SetRallyPointCommand | null {
  const point = sanitizeGroundPoint(world, command.rallyX, command.rallyY, command.rallyZ);
  const waypointType = sanitizeWaypointType(command.waypointType);
  return !isEntityId(command.factoryId) || point === null || waypointType === null
    ? null
    : {
        type: 'setRallyPoint',
        tick,
        factoryId: command.factoryId,
        rallyX: point.x,
        rallyY: point.y,
        rallyZ: point.z,
        waypointType,
      };
}

function sanitizeSetFactoryGuardCommand(
  command: SetFactoryGuardCommand,
  tick: number,
): SetFactoryGuardCommand | null {
  return !isEntityId(command.factoryId) || !isEntityId(command.targetId)
    ? null
    : {
        type: 'setFactoryGuard',
        tick,
        factoryId: command.factoryId,
        targetId: command.targetId,
      };
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
  if (
    !isEntityId(command.commanderId) ||
    !isEntityId(command.targetId) ||
    typeof command.queue !== 'boolean'
  ) {
    return null;
  }
  const queueFront = sanitizeQueueFront(command.queue, command.queueFront);
  return queueFront === null
    ? null
    : {
        ...command,
        tick,
        commanderId: command.commanderId,
        targetId: command.targetId,
        queue: command.queue,
        queueFront,
      };
}

function sanitizeRepairAreaCommand(
  command: RepairAreaCommand,
  world: WorldState,
  tick: number,
): RepairAreaCommand | null {
  const point = sanitizeGroundPoint(world, command.targetX, command.targetY, command.targetZ);
  if (!isEntityId(command.commanderId) || point === null || typeof command.queue !== 'boolean') return null;
  const queueFront = sanitizeQueueFront(command.queue, command.queueFront);
  if (queueFront === null) return null;
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
    queueFront,
  };
}

function sanitizeReclaimCommand(command: ReclaimCommand, tick: number): ReclaimCommand | null {
  if (
    !isEntityId(command.commanderId) ||
    !isEntityId(command.targetId) ||
    typeof command.queue !== 'boolean'
  ) {
    return null;
  }
  const queueFront = sanitizeQueueFront(command.queue, command.queueFront);
  return queueFront === null
    ? null
    : {
        ...command,
        tick,
        commanderId: command.commanderId,
        targetId: command.targetId,
        queue: command.queue,
        queueFront,
      };
}

function sanitizeReclaimAreaCommand(
  command: ReclaimAreaCommand,
  world: WorldState,
  tick: number,
): ReclaimAreaCommand | null {
  const point = sanitizeGroundPoint(world, command.targetX, command.targetY, command.targetZ);
  if (!isEntityId(command.commanderId) || point === null || typeof command.queue !== 'boolean') return null;
  const queueFront = sanitizeQueueFront(command.queue, command.queueFront);
  if (queueFront === null) return null;
  const radius = Number.isFinite(command.radius)
    ? clamp(command.radius, 1, RECLAIM_AREA_MAX_RADIUS)
    : RECLAIM_AREA_MAX_RADIUS;
  return {
    type: 'reclaimArea',
    tick,
    commanderId: command.commanderId,
    targetX: point.x,
    targetY: point.y,
    targetZ: point.z,
    radius,
    queue: command.queue,
    queueFront,
  };
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
