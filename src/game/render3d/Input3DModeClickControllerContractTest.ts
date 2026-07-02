import {
  NO_ENTITY_ID,
  createEmptyEntityComponentSlots,
  createTransform,
  type BuildingBlueprintId,
  type Entity,
} from '@/types/sim';
import type { Command } from '../sim/commands';
import { CommanderModeController } from '../input/helpers';
import { Input3DModeClickController } from './Input3DModeClickController';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[input mode-click contract] ${message}`);
  }
}

type BuildDragFixture = {
  kind: 'buildLine';
  button: 0;
  start: { x: number; y: number; z: number };
  current: { x: number; y: number; z: number };
  startClientX: number;
  startClientY: number;
  queue: boolean;
  queueFront: boolean;
  queueInsertIndex?: number;
};

type BuildCommitHarness = {
  commitBuildShapePlacements(
    drag: BuildDragFixture,
    buildingBlueprintId: BuildingBlueprintId,
    planner: () => ReadonlyArray<{ gridX: number; gridY: number }>,
  ): void;
};

function makeCommanderBuilder(): Entity {
  return {
    ...createEmptyEntityComponentSlots(),
    id: 101,
    type: 'unit',
    transform: createTransform(0, 0, 0, 0),
    ownership: { playerId: 1 },
    builder: { buildRange: 1000, lowPriority: false, currentBuildTarget: NO_ENTITY_ID },
    unit: { unitBlueprintId: 'unitCommander' } as Entity['unit'],
  };
}

function makeUnit(id: number, playerId: number): Entity {
  return {
    ...createEmptyEntityComponentSlots(),
    id,
    type: 'unit',
    transform: createTransform(0, 0, 0, 0),
    ownership: { playerId },
    unit: { unitBlueprintId: 'unitJackal' } as Entity['unit'],
  };
}

function makeBuildDrag(queue: boolean): BuildDragFixture {
  return {
    kind: 'buildLine',
    button: 0,
    start: { x: 0, y: 0, z: 0 },
    current: { x: 96, y: 0, z: 0 },
    startClientX: 0,
    startClientY: 0,
    queue,
    queueFront: false,
  };
}

function mouseEvent(init: Partial<MouseEvent> = {}): MouseEvent {
  return {
    button: init.button ?? 0,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
    metaKey: init.metaKey ?? false,
    preventDefault: () => {},
  } as MouseEvent;
}

function makeController(
  mode: CommanderModeController,
  builder: Entity,
  commands: Command[],
  buildCommandQueuedStates: boolean[],
): Input3DModeClickController {
  const entitySource = {
    getUnits: () => [builder],
    getBuildings: () => [],
    getEntity: (id: number) => id === builder.id ? builder : undefined,
    getSelectedUnits: () => [builder],
  };

  return new Input3DModeClickController({
    getEntitySource: () => entitySource,
    commandQueue: { enqueue: (command) => commands.push(command) },
    picker: {} as never,
    mode,
    selectedCommands: {} as never,
    getTick: () => 123,
    getActivePlayerId: () => 1,
    getQueueInsertIndex: () => null,
    getSelectedCommander: () => null,
    getSelectedBuilder: () => builder,
    onBuildCommandIssued: (queued) => buildCommandQueuedStates.push(queued),
    applyCursor: () => {},
    isRepairAreaMode: () => false,
    isAttackMode: () => false,
    isAttackAreaMode: () => false,
    isAttackGroundMode: () => false,
    isManualLaunchMode: () => false,
    isGuardMode: () => false,
    isReclaimMode: () => false,
    isCaptureMode: () => false,
    isResurrectMode: () => false,
    isResurrectAreaMode: () => false,
    isLoadTransportMode: () => false,
    isUnloadTransportMode: () => false,
    isMexUpgradeMode: () => false,
    isPingMode: () => false,
    isTowerTargetMode: () => false,
    isTowerTargetNoGroundMode: () => false,
    exitRepairAreaMode: () => {},
    exitAttackMode: () => {},
    exitAttackAreaMode: () => {},
    exitAttackGroundMode: () => {},
    exitManualLaunchMode: () => {},
    exitGuardMode: () => {},
    exitReclaimMode: () => {},
    exitCaptureMode: () => {},
    exitResurrectMode: () => {},
    exitResurrectAreaMode: () => {},
    exitLoadTransportMode: () => {},
    exitUnloadTransportMode: () => {},
    exitMexUpgradeMode: () => {},
    exitPingMode: () => {},
    exitTowerTargetMode: () => {},
    exitTowerTargetNoGroundMode: () => {},
  });
}

export function runInput3DModeClickControllerContractTest(): void {
  const mode = new CommanderModeController();
  const builder = makeCommanderBuilder();
  const commands: Command[] = [];
  const buildCommandQueuedStates: boolean[] = [];
  const controller = makeController(mode, builder, commands, buildCommandQueuedStates) as unknown as BuildCommitHarness;
  const planner = () => [{ gridX: 0, gridY: 0 }];

  mode.enterBuildMode('buildingSolar');
  controller.commitBuildShapePlacements(makeBuildDrag(false), 'buildingSolar', planner);
  assertContract(commands.length === 1, 'unqueued build commit must enqueue one startBuild command');
  assertContract(
    buildCommandQueuedStates.length === 1 && buildCommandQueuedStates[0] === false,
    'unqueued build commit must report a non-queued build command',
  );
  assertContract(!mode.isInBuildMode, 'unqueued build commit must exit active build mode');

  mode.enterBuildMode('buildingSolar');
  controller.commitBuildShapePlacements(makeBuildDrag(true), 'buildingSolar', planner);
  assertContract(commands.length === 2, 'queued build commit must enqueue one additional startBuild command');
  assertContract(
    buildCommandQueuedStates.length === 2 && buildCommandQueuedStates[1] === true,
    'queued build commit must report a queued build command',
  );
  assertContract(mode.isInBuildMode, 'queued build commit must keep active build mode');

  const attacker = makeUnit(201, 1);
  const ally = makeUnit(202, 1);
  const attackCommands: Command[] = [];
  let exitAttackModeCount = 0;
  const attackController = new Input3DModeClickController({
    getEntitySource: () => ({
      getUnits: () => [attacker, ally],
      getBuildings: () => [],
      getEntity: (id: number) => id === attacker.id ? attacker : id === ally.id ? ally : undefined,
      getSelectedUnits: () => [attacker],
    }),
    commandQueue: { enqueue: (command) => attackCommands.push(command) },
    picker: {
      raycastEntity: () => ally.id,
      raycastGround: () => ({ x: 72, y: 96, z: 4 }),
    } as never,
    mode: new CommanderModeController(),
    selectedCommands: {} as never,
    getTick: () => 321,
    getActivePlayerId: () => 1,
    getQueueInsertIndex: () => null,
    getSelectedCommander: () => null,
    getSelectedBuilder: () => null,
    onBuildCommandIssued: () => {},
    applyCursor: () => {},
    isRepairAreaMode: () => false,
    isAttackMode: () => true,
    isAttackAreaMode: () => false,
    isAttackGroundMode: () => false,
    isManualLaunchMode: () => false,
    isGuardMode: () => false,
    isReclaimMode: () => false,
    isCaptureMode: () => false,
    isResurrectMode: () => false,
    isResurrectAreaMode: () => false,
    isLoadTransportMode: () => false,
    isUnloadTransportMode: () => false,
    isMexUpgradeMode: () => false,
    isPingMode: () => false,
    isTowerTargetMode: () => false,
    isTowerTargetNoGroundMode: () => false,
    exitRepairAreaMode: () => {},
    exitAttackMode: () => { exitAttackModeCount++; },
    exitAttackAreaMode: () => {},
    exitAttackGroundMode: () => {},
    exitManualLaunchMode: () => {},
    exitGuardMode: () => {},
    exitReclaimMode: () => {},
    exitCaptureMode: () => {},
    exitResurrectMode: () => {},
    exitResurrectAreaMode: () => {},
    exitLoadTransportMode: () => {},
    exitUnloadTransportMode: () => {},
    exitMexUpgradeMode: () => {},
    exitPingMode: () => {},
    exitTowerTargetMode: () => {},
    exitTowerTargetNoGroundMode: () => {},
  });
  attackController.handleMouseDown(mouseEvent({ button: 0, clientX: 12, clientY: 34 }));
  assertContract(attackCommands.length === 1, 'active attack click on allied mesh must enqueue one command');
  const allyAttackCommand = attackCommands[0];
  assertContract(
    allyAttackCommand.type === 'attackGround' &&
      allyAttackCommand.targetX === 72 &&
      allyAttackCommand.targetY === 96 &&
      allyAttackCommand.targetZ === 4 &&
      allyAttackCommand.queue === false,
    'BAR attack-no-ally behavior should redirect allied attack clicks to an attack-ground order',
  );
  assertContract(exitAttackModeCount === 1, 'unqueued allied attack-ground redirect must exit attack mode');
}
