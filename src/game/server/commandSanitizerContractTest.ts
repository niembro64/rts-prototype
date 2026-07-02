import type {
  Command,
  CaptureCommand,
  ChangeFactoryUnitQuotaCommand,
  EditFactoryQueueCommand,
  LoadTransportCommand,
  ManualLaunchCommand,
  MoveCommand,
  QueueUnitCommand,
  RemoveFactoryUnitProductionCommand,
  RepairAreaCommand,
  ResurrectAreaCommand,
  ResurrectCommand,
  SetFactoryGuardCommand,
  SetFactoryRepeatProductionCommand,
  SetFireEnabledCommand,
  SetBuilderPriorityCommand,
  SetCarrierSpawnCommand,
  SetCloakStateCommand,
  SetUnitMoveStateCommand,
  SkipCurrentOrderCommand,
  StartBuildCommand,
  StopFactoryProductionCommand,
  SetForceFieldsVisibleCommand,
  SetShieldReflectionModeCommand,
  SetTowerTargetCommand,
  SetTurretShieldPanelsEnabledCommand,
  SetTurretShieldSpheresEnabledCommand,
  UnloadTransportCommand,
  WaitCommand,
} from '../sim/commands';
import { WorldState } from '../sim/WorldState';
import {
  SHIELD_REFLECTION_MODES,
  type ShieldReflectionMode,
} from '../../types/shotTypes';
import { sanitizeCommand } from './commandSanitizer';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[command sanitizer contract] ${message}`);
  }
}

function sanitizeRequired<T extends Command>(world: WorldState, command: T): T {
  const sanitized = sanitizeCommand(command, world);
  if (sanitized === null) {
    throw new Error(`[command sanitizer contract] ${command.type} should pass sanitizer`);
  }
  assertContract(
    sanitized.type === command.type,
    `${command.type} should not be rewritten to another command type`,
  );
  return sanitized as T;
}

export function runCommandSanitizerContractTest(): void {
  const world = new WorldState(9001, 128, 128);
  while (world.getTick() < 9001) world.incrementTick();

  const skipCurrent = sanitizeRequired<SkipCurrentOrderCommand>(world, {
    type: 'skipCurrentOrder',
    tick: 4,
    entityIds: [1, 2, 2],
  });
  assertContract(
    skipCurrent.tick === 9001 && skipCurrent.entityIds.join(',') === '1,2,2',
    'skipCurrentOrder must sanitize through the unit-list path and normalize tick',
  );

  const stopFactoryProduction = sanitizeRequired<StopFactoryProductionCommand>(world, {
    type: 'stopFactoryProduction',
    tick: 5,
    factoryId: 42,
  });
  assertContract(
    stopFactoryProduction.tick === 9001 && stopFactoryProduction.factoryId === 42,
    'stopFactoryProduction must preserve a valid factory id and normalize tick',
  );

  const setFactoryRepeatProduction = sanitizeRequired<SetFactoryRepeatProductionCommand>(world, {
    type: 'setFactoryRepeatProduction',
    tick: 5,
    factoryId: 42,
    enabled: true,
  });
  assertContract(
    setFactoryRepeatProduction.tick === 9001 &&
      setFactoryRepeatProduction.factoryId === 42 &&
      setFactoryRepeatProduction.enabled === true,
    'setFactoryRepeatProduction must preserve valid repeat state and normalize tick',
  );

  const changeFactoryUnitQuota = sanitizeRequired<ChangeFactoryUnitQuotaCommand>(world, {
    type: 'changeFactoryUnitQuota',
    tick: 5,
    factoryId: 42,
    unitBlueprintId: 'unitLynx',
    delta: 5,
  });
  assertContract(
    changeFactoryUnitQuota.tick === 9001 &&
      changeFactoryUnitQuota.factoryId === 42 &&
      changeFactoryUnitQuota.unitBlueprintId === 'unitLynx' &&
      changeFactoryUnitQuota.delta === 5,
    'changeFactoryUnitQuota must preserve valid factory, unit, and delta fields',
  );

  const removeFactoryUnitProduction = sanitizeRequired<RemoveFactoryUnitProductionCommand>(world, {
    type: 'removeFactoryUnitProduction',
    tick: 5,
    factoryId: 42,
    unitBlueprintId: 'unitLynx',
    count: 5,
  });
  assertContract(
    removeFactoryUnitProduction.tick === 9001 &&
      removeFactoryUnitProduction.factoryId === 42 &&
      removeFactoryUnitProduction.unitBlueprintId === 'unitLynx' &&
      removeFactoryUnitProduction.count === 5,
    'removeFactoryUnitProduction must preserve valid factory, unit, and count fields',
  );

  // BAR gridmenu multipliers: LMB=1, Shift=5, Ctrl=20, Ctrl+Shift=100. The
  // sanitizer bound admits the x100 click; the sim's queue capacity still
  // clamps at execution time.
  const bulkQueueUnit = sanitizeRequired<QueueUnitCommand>(world, {
    type: 'queueUnit',
    tick: 5,
    factoryId: 42,
    unitBlueprintId: 'unitLynx',
    repeat: false,
    count: 100,
  });
  assertContract(
    bulkQueueUnit.count === 100 && bulkQueueUnit.repeat === false,
    'queueUnit must accept the BAR Ctrl+Shift x100 click count',
  );
  assertContract(
    sanitizeCommand({
      type: 'queueUnit',
      tick: 5,
      factoryId: 42,
      unitBlueprintId: 'unitLynx',
      repeat: false,
      count: 101,
    } as Command, world) === null,
    'queueUnit counts above 100 must stay rejected by the sanitizer bound',
  );
  const bulkRemoveProduction = sanitizeRequired<RemoveFactoryUnitProductionCommand>(world, {
    type: 'removeFactoryUnitProduction',
    tick: 5,
    factoryId: 42,
    unitBlueprintId: 'unitLynx',
    count: 100,
  });
  assertContract(
    bulkRemoveProduction.count === 100,
    'removeFactoryUnitProduction must accept the BAR Ctrl+Shift x100 removal count',
  );
  const bulkQuota = sanitizeRequired<ChangeFactoryUnitQuotaCommand>(world, {
    type: 'changeFactoryUnitQuota',
    tick: 5,
    factoryId: 42,
    unitBlueprintId: 'unitLynx',
    delta: -100,
  });
  assertContract(
    bulkQuota.delta === -100,
    'changeFactoryUnitQuota must accept the BAR Ctrl+Shift x100 quota delta',
  );
  // Alt insert-at-front composes queueUnit + editFactoryQueue move; the move
  // length must therefore admit the same x100 run size.
  const frontInsertMove = sanitizeRequired<EditFactoryQueueCommand>(world, {
    type: 'editFactoryQueue',
    tick: 5,
    factoryId: 42,
    operation: 'move',
    index: 12,
    length: 100,
    toIndex: 0,
  });
  assertContract(
    frontInsertMove.operation === 'move' &&
      frontInsertMove.length === 100 &&
      frontInsertMove.toIndex === 0,
    'editFactoryQueue move must accept a 100-long run for Alt insert-at-front',
  );

  const clearFactoryGuard = sanitizeRequired<SetFactoryGuardCommand>(world, {
    type: 'setFactoryGuard',
    tick: 5,
    factoryId: 42,
    targetId: null,
  });
  assertContract(
    clearFactoryGuard.tick === 9001 &&
    clearFactoryGuard.factoryId === 42 &&
    clearFactoryGuard.targetId === null,
    'setFactoryGuard must preserve null target for factory guard clear',
  );

  const setBuilderPriority = sanitizeRequired<SetBuilderPriorityCommand>(world, {
    type: 'setBuilderPriority',
    tick: 5,
    entityIds: [7, 8],
    lowPriority: true,
  });
  assertContract(
    setBuilderPriority.tick === 9001 &&
      setBuilderPriority.entityIds.join(',') === '7,8' &&
      setBuilderPriority.lowPriority === true,
    'setBuilderPriority must preserve valid entity ids and low-priority state',
  );

  const setCarrierSpawn = sanitizeRequired<SetCarrierSpawnCommand>(world, {
    type: 'setCarrierSpawn',
    tick: 5,
    entityIds: [7, 8],
    enabled: false,
  });
  assertContract(
    setCarrierSpawn.tick === 9001 &&
      setCarrierSpawn.entityIds.join(',') === '7,8' &&
      setCarrierSpawn.enabled === false,
    'setCarrierSpawn must preserve valid entity ids and enabled state',
  );

  const queueFrontMove = sanitizeRequired<MoveCommand>(world, {
    type: 'move',
    tick: 6,
    entityIds: [7],
    targetX: 12,
    targetY: 13,
    waypointType: 'move',
    queue: true,
    queueFront: true,
  });
  assertContract(
    queueFrontMove.tick === 9001 && queueFrontMove.queueFront === true,
    'move queueFront must survive sanitizer when queue=true',
  );

  const wireNullQueueMove = sanitizeRequired<MoveCommand>(world, {
    type: 'move',
    tick: 6,
    entityIds: [7],
    targetX: 12,
    targetY: 13,
    waypointType: 'move',
    queue: true,
    queueFront: null as unknown as boolean,
    queueInsertIndex: null as unknown as number,
  });
  assertContract(
    wireNullQueueMove.queue === true &&
      wireNullQueueMove.queueFront === false &&
      wireNullQueueMove.queueInsertIndex === undefined,
    'wire-decoded null queue metadata must normalize as omitted for queued move commands',
  );

  const replaceMove = sanitizeRequired<MoveCommand>(world, {
    type: 'move',
    tick: 7,
    entityIds: [7],
    targetX: 14,
    targetY: 15,
    waypointType: 'fight',
    queue: false,
    queueFront: true,
  });
  assertContract(
    replaceMove.queueFront === false,
    'move queueFront must normalize to false when queue=false',
  );

  const roamMoveState = sanitizeRequired<SetUnitMoveStateCommand>(world, {
    type: 'setUnitMoveState',
    tick: 7,
    entityIds: [7],
    moveState: 'roam',
  });
  assertContract(
    roamMoveState.moveState === 'roam',
    'setUnitMoveState must accept the roam positioning state',
  );

  const returnFireState = sanitizeRequired<SetFireEnabledCommand>(world, {
    type: 'setFireEnabled',
    tick: 7,
    entityIds: [7],
    fireState: 'returnFire',
  });
  assertContract(
    returnFireState.fireState === 'returnFire' && returnFireState.enabled === true,
    'setFireEnabled must accept and normalize the return-fire state',
  );

  const cloakState = sanitizeRequired<SetCloakStateCommand>(world, {
    type: 'setCloakState',
    tick: 7,
    entityIds: [7],
    enabled: true,
  });
  assertContract(
    cloakState.enabled === true,
    'setCloakState must accept enabled=true',
  );

  const gatherWait = sanitizeRequired<WaitCommand>(world, {
    type: 'wait',
    tick: 7,
    entityIds: [7, 8],
    queue: true,
    gather: true,
    waitGroupId: 99,
  });
  assertContract(
    gatherWait.gather === true && gatherWait.waitGroupId === 99,
    'wait command must accept gather wait state and group id',
  );

  const towerGroundTarget = sanitizeRequired<SetTowerTargetCommand>(world, {
    type: 'setTowerTarget',
    tick: 7,
    entityIds: [17],
    targetId: null,
    targetX: 44.5,
    targetY: 12.25,
    targetZ: 999,
  });
  assertContract(
    towerGroundTarget.targetId === null &&
      towerGroundTarget.targetX === 44.5 &&
      towerGroundTarget.targetY === 12.25 &&
      towerGroundTarget.targetZ === world.getGroundZ(44.5, 12.25),
    'setTowerTarget must preserve and normalize ground target points',
  );

  const capture = sanitizeRequired<CaptureCommand>(world, {
    type: 'capture',
    tick: 7,
    commanderId: 7,
    targetId: 8,
    queue: true,
    queueFront: true,
  });
  assertContract(
    capture.tick === 9001 && capture.queueFront === true && capture.targetId === 8,
    'capture command must preserve target and queue-front insertion',
  );

  const resurrect = sanitizeRequired<ResurrectCommand>(world, {
    type: 'resurrect',
    tick: 7,
    commanderId: 7,
    targetId: 9,
    queue: true,
    queueFront: true,
  });
  assertContract(
    resurrect.tick === 9001 && resurrect.queueFront === true && resurrect.targetId === 9,
    'resurrect command must preserve target and queue-front insertion',
  );

  const resurrectArea = sanitizeRequired<ResurrectAreaCommand>(world, {
    type: 'resurrectArea',
    tick: 7,
    commanderId: 7,
    targetX: 24.5,
    targetY: 32.25,
    targetZ: 999,
    radius: 999999,
    queue: true,
    queueInsertIndex: 4,
  });
  assertContract(
      resurrectArea.tick === 9001 &&
      resurrectArea.targetZ === world.getGroundZ(24.5, 32.25) &&
      resurrectArea.radius === 500 &&
      resurrectArea.queueInsertIndex === 4,
    'resurrect-area command must normalize terrain z, radius, and queue insertion',
  );
  assertContract(
    resurrectArea.filterCategory === undefined &&
      resurrectArea.filterBlueprintId === undefined,
    'area commands without filter fields must stay unfiltered',
  );

  // BAR cmd_area_commands_filter fields: known categories/blueprints pass
  // through unchanged; unknown values reject the whole command.
  const filteredRepairArea = sanitizeRequired<RepairAreaCommand>(world, {
    type: 'repairArea',
    tick: 7,
    commanderId: 7,
    targetX: 24.5,
    targetY: 32.25,
    radius: 100,
    queue: false,
    filterCategory: 'unit',
    filterBlueprintId: 'unitJackal',
  });
  assertContract(
    filteredRepairArea.filterCategory === 'unit' &&
      filteredRepairArea.filterBlueprintId === 'unitJackal',
    'repair-area command must preserve valid area target filter fields',
  );

  const invalidFilterCategory = sanitizeCommand({
    type: 'reclaimArea',
    tick: 7,
    commanderId: 7,
    targetX: 24.5,
    targetY: 32.25,
    radius: 100,
    queue: false,
    filterCategory: 'bogus',
  } as unknown as Command, world);
  assertContract(
    invalidFilterCategory === null,
    'reclaim-area command with an unknown filter category must be rejected',
  );

  const invalidFilterBlueprint = sanitizeCommand({
    type: 'resurrectArea',
    tick: 7,
    commanderId: 7,
    targetX: 24.5,
    targetY: 32.25,
    radius: 100,
    queue: false,
    filterBlueprintId: 'unitDoesNotExist',
  } as unknown as Command, world);
  assertContract(
    invalidFilterBlueprint === null,
    'resurrect-area command with an unknown filter blueprint must be rejected',
  );

  const loadTransport = sanitizeRequired<LoadTransportCommand>(world, {
    type: 'loadTransport',
    tick: 7,
    transportId: 12,
    targetId: 13,
    queue: true,
    queueFront: true,
  });
  assertContract(
    loadTransport.tick === 9001 &&
      loadTransport.transportId === 12 &&
      loadTransport.targetId === 13 &&
      loadTransport.queueFront === true,
    'loadTransport command must preserve transport, target, and queue-front insertion',
  );

  const unloadTransport = sanitizeRequired<UnloadTransportCommand>(world, {
    type: 'unloadTransport',
    tick: 7,
    transportIds: [12, 14],
    targetX: 500,
    targetY: -25,
    targetZ: 999,
    queue: true,
    queueInsertIndex: 3,
  });
  assertContract(
    unloadTransport.tick === 9001 &&
      unloadTransport.transportIds.join(',') === '12,14' &&
      unloadTransport.targetX === world.mapWidth &&
      unloadTransport.targetY === 0 &&
      unloadTransport.targetZ === world.getGroundZ(world.mapWidth, 0) &&
      unloadTransport.queueInsertIndex === 3,
    'unloadTransport command must clamp target point and preserve queue insertion',
  );

  const manualLaunch = sanitizeRequired<ManualLaunchCommand>(world, {
    type: 'manualLaunch',
    tick: 7,
    entityIds: [7, 8],
    targetX: 16.5,
    targetY: 20.25,
    targetZ: 999,
  });
  assertContract(
    manualLaunch.tick === 9001 &&
      manualLaunch.entityIds.join(',') === '7,8' &&
      manualLaunch.targetZ === world.getGroundZ(16.5, 20.25),
    'manualLaunch command must preserve selected entities and derive z from authoritative terrain',
  );

  const formationSpeedMove = sanitizeRequired<MoveCommand>(world, {
    type: 'move',
    tick: 8,
    entityIds: [7, 8],
    individualTargets: [{ x: 14, y: 15, z: 999 }, { x: 24, y: 25, z: -999 }],
    formationSpeed: 'slowest',
    waypointType: 'move',
    queue: false,
  });
  assertContract(
    formationSpeedMove.formationSpeed === 'slowest',
    'move formationSpeed=slowest must survive sanitizer',
  );
  assertContract(
    formationSpeedMove.individualTargets?.[0]?.z === world.getGroundZ(14, 15) &&
    formationSpeedMove.individualTargets?.[1]?.z === world.getGroundZ(24, 25),
    'move individualTargets must derive z from authoritative terrain',
  );

  const rotatedBuild = sanitizeRequired<StartBuildCommand>(world, {
    type: 'startBuild',
    tick: 9,
    builderId: 9,
    buildingBlueprintId: 'buildingSolar',
    gridX: 4.8,
    gridY: 5.2,
    rotation: Math.PI * 3,
    queue: true,
  });
  assertContract(
    rotatedBuild.gridX === 4
    && rotatedBuild.gridY === 5
    && Math.abs((rotatedBuild.rotation ?? 0) - Math.PI) < 1e-9,
    'startBuild must floor grid cells and normalize optional build facing',
  );

  const wireNullQueueBuild = sanitizeRequired<StartBuildCommand>(world, {
    type: 'startBuild',
    tick: 12,
    builderId: 9,
    buildingBlueprintId: 'buildingSolar',
    gridX: 12,
    gridY: 13,
    rotation: 0,
    queue: true,
    queueFront: null as unknown as boolean,
    queueInsertIndex: null as unknown as number,
  });
  assertContract(
    wireNullQueueBuild.queue === true &&
      wireNullQueueBuild.queueFront === false &&
      wireNullQueueBuild.queueInsertIndex === undefined,
    'wire-decoded null queue metadata must normalize as omitted for queued startBuild commands',
  );

  const panelsDisabled = sanitizeRequired<SetTurretShieldPanelsEnabledCommand>(world, {
    type: 'setTurretShieldPanelsEnabled',
    tick: 1,
    enabled: false,
  });
  assertContract(
    panelsDisabled.enabled === false,
    'setTurretShieldPanelsEnabled must preserve enabled=false',
  );

  const spheresDisabled = sanitizeRequired<SetTurretShieldSpheresEnabledCommand>(world, {
    type: 'setTurretShieldSpheresEnabled',
    tick: 2,
    enabled: false,
  });
  assertContract(
    spheresDisabled.enabled === false,
    'setTurretShieldSpheresEnabled must preserve enabled=false',
  );

  const forceFieldsHidden = sanitizeRequired<SetForceFieldsVisibleCommand>(world, {
    type: 'setForceFieldsVisible',
    tick: 2,
    enabled: false,
  });
  assertContract(
    forceFieldsHidden.enabled === false,
    'setForceFieldsVisible must preserve enabled=false',
  );

  for (const mode of SHIELD_REFLECTION_MODES) {
    const sanitized = sanitizeRequired<SetShieldReflectionModeCommand>(world, {
      type: 'setShieldReflectionMode',
      tick: 3,
      mode: mode as ShieldReflectionMode,
    });
    assertContract(
      sanitized.mode === mode,
      `setShieldReflectionMode must preserve mode=${mode}`,
    );
  }
}
