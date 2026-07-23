import type { ClientCommandSink } from '../ClientCommandSink';
import type { Command } from '../../sim/commands';
import type { BuildingBlueprintId, CombatFireState, CombatTrajectoryMode, Entity, UnitMoveState } from '../../sim/types';
import { buildingBlueprintHasBarOnOffCommand } from '../../sim/buildingActiveState';
import {
  entityEffectiveBarTrajectoryMode,
  entityHasBarTrajectoryCommand,
} from '../../sim/unitCommandCapabilities';
import { InputSelectedCommands } from './InputSelectedCommands';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[input selected commands contract] ${message}`);
  }
}

function commandSink(commands: Command[]): ClientCommandSink {
  return {
    enqueue(command) {
      commands.push(command);
    },
  };
}

function unitEntity(
  id: number,
  repeatQueue: boolean,
  moveState: UnitMoveState,
  unitBlueprintId = 'unitJackal',
  wantCloak = false,
): Entity {
  return {
    id,
    type: 'unit',
    unit: {
      unitBlueprintId,
      repeatQueue,
      moveState,
      wantCloak,
    },
    combat: null,
  } as unknown as Entity;
}

function ballisticCombatEntity(
  id: number,
  fireState: CombatFireState,
  trajectoryMode: CombatTrajectoryMode,
  unitBlueprintId = 'unitMongoose',
): Entity {
  return {
    id,
    type: 'unit',
    unit: {
      unitBlueprintId,
    },
    combat: {
      turrets: [
        {
          config: {
            aimStyle: {
              angleType: 'ballisticArcHigh',
            },
          },
        },
      ],
      fireEnabled: fireState !== 'holdFire',
      fireState,
      trajectoryMode,
    },
  } as unknown as Entity;
}

function ballisticTowerEntity(
  id: number,
  trajectoryMode: CombatTrajectoryMode,
  buildingBlueprintId: BuildingBlueprintId = 'towerCannon',
): Entity {
  return {
    id,
    type: 'building',
    unit: null,
    buildingBlueprintId,
    combat: {
      turrets: [
        {
          config: {
            aimStyle: {
              angleType: 'ballisticArcLow',
            },
          },
        },
      ],
      fireEnabled: true,
      fireState: 'fireAtWill',
      trajectoryMode,
    },
  } as unknown as Entity;
}

function activeBuildingEntity(
  id: number,
  open: boolean,
  buildingBlueprintId: BuildingBlueprintId = 'buildingSolar',
): Entity {
  return {
    id,
    type: 'building',
    buildingBlueprintId,
    building: {
      activeState: {
        open,
        damageDelayMs: 0,
        reopenDelayMs: 0,
      },
    },
  } as unknown as Entity;
}

function builderEntity(id: number, lowPriority: boolean, unitBlueprintId = 'unitCommander'): Entity {
  return {
    id,
    type: 'unit',
    unit: {
      unitBlueprintId,
    },
    builder: {
      lowPriority,
    },
  } as unknown as Entity;
}

function factoryEntity(id: number, lowPriority: boolean): Entity {
  return {
    id,
    type: 'building',
    buildingBlueprintId: 'towerFabricator',
    factory: {
      lowPriority,
      moveState: 'holdPosition',
    },
  } as unknown as Entity;
}

function targetCommandEntity(
  id: number,
  type: 'unit' | 'building' = 'unit',
  shotType: 'plasma' | 'shield' | null = 'plasma',
  passive = false,
): Entity {
  return {
    id,
    type,
    unit: type === 'unit' ? { unitBlueprintId: 'unitJackal' } : null,
    buildingBlueprintId: type === 'building' ? 'towerCannon' : null,
    combat: {
      turrets: [
        {
          config: {
            kind: 'attack',
            passive,
            turretRange: { range: 160 },
            shot: shotType === null ? null : { type: shotType },
          },
        },
      ],
    },
  } as unknown as Entity;
}

function carrierFactoryUnitEntity(id: number, carrierSpawnEnabled: boolean): Entity {
  return {
    id,
    type: 'unit',
    unit: {
      unitBlueprintId: 'unitQueenBee',
    },
    factory: {
      carrierSpawnEnabled,
    },
  } as unknown as Entity;
}

function factoryBuildingEntity(id: number): Entity {
  return {
    id,
    type: 'building',
    factory: {},
  } as unknown as Entity;
}

function lastCommand(commands: readonly Command[]): Command {
  const command = commands[commands.length - 1];
  assertContract(command !== undefined, 'expected a command to be enqueued');
  return command;
}

export function runInputSelectedCommandsContractTest(): void {
  const commands: Command[] = [];
  let selectedUnits: Entity[] = [];
  let selectedBuildings: Entity[] = [];
  const selectedCommands = new InputSelectedCommands(
    {
      getSelectedUnits: () => selectedUnits,
      getSelectedBuildings: () => selectedBuildings,
    },
    commandSink(commands),
    () => 42,
  );

  selectedUnits = [unitEntity(10, false, 'maneuver')];
  selectedCommands.setRepeatQueue(true);
  const repeatCommand = lastCommand(commands);
  assertContract(
    repeatCommand.type === 'setRepeatQueue' &&
      repeatCommand.enabled === true &&
      repeatCommand.entityIds[0] === 10,
    'exact repeat setter must enqueue repeat on',
  );

  selectedUnits = [];
  selectedBuildings = [
    factoryBuildingEntity(15),
    { id: 16, type: 'building', factory: null } as Entity,
  ];
  selectedCommands.wait(false);
  const factoryWaitCommand = lastCommand(commands);
  assertContract(
    factoryWaitCommand.type === 'wait' &&
      factoryWaitCommand.entityIds.length === 1 &&
      factoryWaitCommand.entityIds[0] === 15,
    'normal Wait must enqueue selected factory ids so BAR factory wait can pause production',
  );

  selectedUnits = [unitEntity(17, false, 'maneuver')];
  selectedBuildings = [
    targetCommandEntity(18, 'building'),
    { id: 19, type: 'building', combat: null } as Entity,
    { id: 20, type: 'building', buildingBlueprintId: 'buildingExtractorT2', combat: null } as Entity,
  ];
  selectedCommands.stop();
  const stopCommand = lastCommand(commands);
  assertContract(
    stopCommand.type === 'stop' &&
      stopCommand.entityIds.length === 3 &&
      stopCommand.entityIds[0] === 17 &&
      stopCommand.entityIds[1] === 18 &&
      stopCommand.entityIds[2] === 20,
    'BAR Stop must enqueue selected armed buildings and armamex/T2 mex buildings as well as units while leaving removestop buildings out',
  );

  selectedUnits = [unitEntity(10, false, 'maneuver')];
  selectedBuildings = [];
  selectedCommands.setUnitMoveState('roam');
  const moveCommand = lastCommand(commands);
  assertContract(
    moveCommand.type === 'setUnitMoveState' &&
      moveCommand.moveState === 'roam' &&
      moveCommand.entityIds[0] === 10,
    'exact move-state setter must enqueue the requested state',
  );

  selectedUnits = [];
  selectedBuildings = [factoryEntity(17, true)];
  selectedCommands.setUnitMoveState('maneuver');
  const factoryMoveCommand = lastCommand(commands);
  assertContract(
    factoryMoveCommand.type === 'setUnitMoveState' &&
      factoryMoveCommand.moveState === 'maneuver' &&
      factoryMoveCommand.entityIds.length === 1 &&
      factoryMoveCommand.entityIds[0] === 17,
    'exact move-state setter must enqueue BAR factory ids because factories expose CMD.MOVE_STATE',
  );

  selectedUnits = [unitEntity(11, false, 'maneuver', 'unitJackal')];
  const beforeNonCloakCommandCount = commands.length;
  selectedCommands.setCloakState();
  assertContract(
    commands.length === beforeNonCloakCommandCount,
    'cloak setter must not enqueue for BAR-equivalent units without a cloak command',
  );

  selectedUnits = [
    unitEntity(12, false, 'maneuver', 'unitCommander'),
    unitEntity(13, false, 'maneuver', 'unitJackal'),
  ];
  selectedCommands.setCloakState();
  const cloakCommand = lastCommand(commands);
  assertContract(
    cloakCommand.type === 'setCloakState' &&
      cloakCommand.enabled === true &&
      cloakCommand.entityIds.length === 1 &&
      cloakCommand.entityIds[0] === 12,
    'cloak setter must target only BAR-equivalent cloak-capable selected units',
  );

  selectedUnits = [unitEntity(14, false, 'maneuver', 'unitCommander', true)];
  selectedCommands.setCloakState();
  const uncloakCommand = lastCommand(commands);
  assertContract(
    uncloakCommand.type === 'setCloakState' &&
      uncloakCommand.enabled === false &&
      uncloakCommand.entityIds[0] === 14,
    'cloak setter must toggle off when every cloak-capable selected unit already wants cloak',
  );

  selectedUnits = [ballisticCombatEntity(20, 'fireAtWill', 'auto')];
  selectedCommands.setFireEnabled('holdFire');
  const fireCommand = lastCommand(commands);
  assertContract(
    fireCommand.type === 'setFireEnabled' &&
      fireCommand.fireState === 'holdFire' &&
      fireCommand.enabled === false &&
      fireCommand.entityIds[0] === 20,
    'exact fire-state setter must enqueue hold fire with firing disabled',
  );
  selectedCommands.setFireEnabled('fireAtAll');
  const fireAtAllCommand = lastCommand(commands);
  assertContract(
    fireAtAllCommand.type === 'setFireEnabled' &&
      fireAtAllCommand.fireState === 'fireAtAll' &&
      fireAtAllCommand.enabled === true &&
      fireAtAllCommand.entityIds[0] === 20,
    'exact fire-state setter must enqueue BAR fire-at-all with firing enabled',
  );
  selectedUnits = [ballisticCombatEntity(201, 'defend', 'auto')];
  selectedCommands.setFireEnabled();
  const defendCycleCommand = lastCommand(commands);
  assertContract(
    defendCycleCommand.type === 'setFireEnabled' &&
      defendCycleCommand.fireState === 'holdFire' &&
      defendCycleCommand.enabled === false,
    'BAR Defend state must cycle forward to Hold fire like the order-menu helper',
  );
  selectedUnits = [ballisticCombatEntity(202, 'fireAtAll', 'auto')];
  selectedCommands.setFireEnabled();
  const fireAtAllCycleCommand = lastCommand(commands);
  assertContract(
    fireAtAllCycleCommand.type === 'setFireEnabled' &&
      fireAtAllCycleCommand.fireState === 'holdFire' &&
      fireAtAllCycleCommand.enabled === false,
    'BAR Fire-at-all state must cycle forward to Hold fire like the order-menu helper',
  );

  selectedUnits = [ballisticCombatEntity(20, 'fireAtWill', 'auto')];
  selectedCommands.setTrajectoryMode('high');
  const trajectoryCommand = lastCommand(commands);
  assertContract(
    trajectoryCommand.type === 'setTrajectoryMode' &&
      trajectoryCommand.trajectoryMode === 'high' &&
      trajectoryCommand.entityIds[0] === 20,
    'exact trajectory setter must enqueue the requested trajectory mode',
  );

  selectedUnits = [
    ballisticCombatEntity(21, 'fireAtWill', 'auto', 'unitMongoose'),
    ballisticCombatEntity(22, 'fireAtWill', 'auto', 'unitBadger'),
  ];
  selectedCommands.setTrajectoryMode('low', (entity) => entity.unit?.unitBlueprintId === 'unitMongoose');
  const filteredTrajectoryCommand = lastCommand(commands);
  assertContract(
    filteredTrajectoryCommand.type === 'setTrajectoryMode' &&
      filteredTrajectoryCommand.trajectoryMode === 'low' &&
      filteredTrajectoryCommand.entityIds.length === 1 &&
      filteredTrajectoryCommand.entityIds[0] === 21,
    'trajectory setter must honor the provided BAR-equivalent trajectory filter',
  );

  selectedUnits = [ballisticCombatEntity(23, 'fireAtWill', 'auto', 'unitMongoose')];
  selectedCommands.setTrajectoryMode(
    undefined,
    (entity) => entity.unit?.unitBlueprintId === 'unitMongoose',
    entityEffectiveBarTrajectoryMode,
    ['high', 'low'],
  );
  const barAutoTrajectoryToggle = lastCommand(commands);
  assertContract(
    barAutoTrajectoryToggle.type === 'setTrajectoryMode' &&
      barAutoTrajectoryToggle.trajectoryMode === 'low' &&
      barAutoTrajectoryToggle.entityIds[0] === 23,
    'BAR trajectory toggle must treat the Mongoose authored auto state as high and toggle to low',
  );

  selectedUnits = [ballisticCombatEntity(24, 'fireAtWill', 'low', 'unitMongoose')];
  selectedCommands.setTrajectoryMode(
    undefined,
    (entity) => entity.unit?.unitBlueprintId === 'unitMongoose',
    entityEffectiveBarTrajectoryMode,
    ['high', 'low'],
  );
  const barLowTrajectoryToggle = lastCommand(commands);
  assertContract(
    barLowTrajectoryToggle.type === 'setTrajectoryMode' &&
      barLowTrajectoryToggle.trajectoryMode === 'high' &&
      barLowTrajectoryToggle.entityIds[0] === 24,
    'BAR trajectory toggle must cycle low back to high without exposing auto',
  );

  selectedUnits = [];
  selectedBuildings = [ballisticTowerEntity(25, 'auto')];
  const beforeBarStructureTrajectoryCommandCount = commands.length;
  selectedCommands.setTrajectoryMode(
    undefined,
    entityHasBarTrajectoryCommand,
    entityEffectiveBarTrajectoryMode,
    ['auto', 'low', 'high'],
  );
  assertContract(
    commands.length === beforeBarStructureTrajectoryCommandCount,
    'BAR trajectory filter must not treat towerCannon as armguard while it occupies the ARM T1 defense build slot',
  );

  selectedBuildings = [activeBuildingEntity(30, true)];
  selectedCommands.setBuildingActive(false);
  const activeCommand = lastCommand(commands);
  assertContract(
    activeCommand.type === 'setBuildingActive' &&
      activeCommand.open === false &&
      activeCommand.entityIds[0] === 30,
    'exact building active setter must enqueue the requested open state',
  );

  selectedBuildings = [
    activeBuildingEntity(31, true, 'buildingSolar'),
    activeBuildingEntity(32, false, 'buildingWind'),
  ];
  selectedCommands.setBuildingActive(undefined, (buildingBlueprintId) => buildingBlueprintId === 'buildingSolar');
  const filteredActiveCommand = lastCommand(commands);
  assertContract(
    filteredActiveCommand.type === 'setBuildingActive' &&
      filteredActiveCommand.open === false &&
      filteredActiveCommand.entityIds.length === 1 &&
      filteredActiveCommand.entityIds[0] === 31,
    'building active setter must honor the provided building filter',
  );

  selectedBuildings = [activeBuildingEntity(33, true, 'buildingResourceConverter')];
  selectedCommands.setBuildingActive(undefined, buildingBlueprintHasBarOnOffCommand);
  const converterActiveCommand = lastCommand(commands);
  assertContract(
    converterActiveCommand.type === 'setBuildingActive' &&
      converterActiveCommand.open === false &&
      converterActiveCommand.entityIds.length === 1 &&
      converterActiveCommand.entityIds[0] === 33,
    'BAR building active setter must include the armmakr/buildingResourceConverter analogue',
  );

  selectedUnits = [
    targetCommandEntity(35, 'unit', 'plasma'),
    targetCommandEntity(36, 'unit', 'shield'),
    targetCommandEntity(37, 'unit', 'plasma', true),
  ];
  selectedBuildings = [
    targetCommandEntity(38, 'building', 'plasma'),
    targetCommandEntity(39, 'building', 'shield'),
  ];
  selectedCommands.setTowerTarget(99);
  const targetCommand = lastCommand(commands);
  assertContract(
    targetCommand.type === 'setTowerTarget' &&
      targetCommand.entityIds.join(',') === '35,38',
    'set target must enqueue only BAR-equivalent non-shield active weapon hosts',
  );

  const beforeRejectedTargetCommandCount = commands.length;
  selectedUnits = [targetCommandEntity(45, 'unit', 'shield')];
  selectedBuildings = [];
  selectedCommands.setTowerTarget(99);
  assertContract(
    commands.length === beforeRejectedTargetCommandCount,
    'set target must not enqueue when the selection has only shield/passive hosts',
  );

  selectedUnits = [builderEntity(40, false), carrierFactoryUnitEntity(44, true)];
  selectedBuildings = [factoryEntity(41, true)];
  selectedCommands.setBuilderPriority();
  const priorityLowCommand = lastCommand(commands);
  assertContract(
    priorityLowCommand.type === 'setBuilderPriority' &&
      priorityLowCommand.lowPriority === true &&
      priorityLowCommand.entityIds.join(',') === '40,41',
    'builder priority toggle must set BAR-eligible mixed builder/factory selections to low priority',
  );

  selectedUnits = [builderEntity(42, true)];
  selectedBuildings = [factoryEntity(43, true)];
  selectedCommands.setBuilderPriority();
  const priorityHighCommand = lastCommand(commands);
  assertContract(
    priorityHighCommand.type === 'setBuilderPriority' &&
      priorityHighCommand.lowPriority === false &&
      priorityHighCommand.entityIds.join(',') === '42,43',
    'builder priority toggle must set all-low builder/factory selections back to high priority',
  );

  selectedBuildings = [];
  selectedUnits = [carrierFactoryUnitEntity(50, true), carrierFactoryUnitEntity(51, false)];
  const beforeCarrierSpawnCommandCount = commands.length;
  selectedCommands.setCarrierSpawn();
  assertContract(
    commands.length === beforeCarrierSpawnCommandCount,
    'carrier spawn toggle must ignore prototype mobile factories with no BAR carrier-spawner analogue',
  );

  selectedUnits = [carrierFactoryUnitEntity(52, true), carrierFactoryUnitEntity(53, true)];
  selectedCommands.setCarrierSpawn();
  assertContract(
    commands.length === beforeCarrierSpawnCommandCount,
    'carrier spawn toggle must not enqueue a command for all-enabled prototype mobile factories',
  );
}
