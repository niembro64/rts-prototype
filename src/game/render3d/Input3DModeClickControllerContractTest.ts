import {
  NO_ENTITY_ID,
  createEmptyEntityComponentSlots,
  createTransform,
  type BuildingBlueprintId,
  type Entity,
} from '@/types/sim';
import type { Command } from '../sim/commands';
import { BUILD_GRID_CELL_SIZE } from '../sim/buildGrid';
import { CommanderModeController } from '../input/helpers';
import { Input3DBuildPlacementState } from './Input3DBuildPlacementState';
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
  commitAreaDrag(
    drag: {
      kind: 'repairArea' | 'reclaimArea';
      button: 0;
      start: { x: number; y: number; z: number };
      current: { x: number; y: number; z: number };
      startClientX: number;
      startClientY: number;
      queue: boolean;
      queueFront: boolean;
    },
    releaseEvent: MouseEvent,
  ): void;
};

function makeCommanderBuilder(id = 101, unitBlueprintId = 'unitCommander'): Entity {
  return {
    ...createEmptyEntityComponentSlots(),
    id,
    type: 'unit',
    transform: createTransform(0, 0, 0, 0),
    ownership: { playerId: 1 },
    builder: { buildRange: 1000, lowPriority: false, currentBuildTarget: NO_ENTITY_ID },
    unit: { unitBlueprintId, hp: 100, maxHp: 100 } as Entity['unit'],
  };
}

function makeUnit(id: number, playerId: number): Entity {
  return {
    ...createEmptyEntityComponentSlots(),
    id,
    type: 'unit',
    transform: createTransform(0, 0, 0, 0),
    ownership: { playerId },
    unit: { unitBlueprintId: 'unitJackal', hp: 100, maxHp: 100 } as Entity['unit'],
    combat: {
      turrets: [
        {
          config: {
            kind: 'attack',
            passive: false,
            turretRange: { range: 160 },
            shot: { type: 'plasma' },
          },
        },
      ],
    } as unknown as Entity['combat'],
  };
}

function makeTransport(id: number, playerId: number): Entity {
  return {
    ...createEmptyEntityComponentSlots(),
    id,
    type: 'unit',
    transform: createTransform(0, 0, 0, 0),
    ownership: { playerId },
    unit: { unitBlueprintId: 'unitTransport', hp: 100, maxHp: 100 } as Entity['unit'],
    transport: { capacity: 6, loadedUnits: [] },
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
  builders: Entity[],
  commands: Command[],
  buildCommandQueuedStates: boolean[],
  splitModifier: { held: boolean },
): Input3DModeClickController {
  const entitySource = {
    getUnits: () => builders,
    getBuildings: () => [],
    getEntity: (id: number) => builders.find((builder) => builder.id === id),
    getSelectedUnits: () => builders,
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
    getSelectedBuilder: () => builders[0],
    getSelectedResurrectSource: () => builders[0],
    onBuildCommandIssued: (queued) => buildCommandQueuedStates.push(queued),
    applyCursor: () => {},
    isRepairAreaMode: () => false,
    isRestoreAreaMode: () => false,
    isAttackMode: () => false,
    isAttackAreaMode: () => false,
    isAttackGroundMode: () => false,
    isManualLaunchMode: () => false,
    isGuardMode: () => false,
    isReclaimMode: () => false,
    isCaptureMode: () => false,
    isResurrectMode: () => false,
    isResurrectAreaMode: () => false,
    isResurrectModeAreaCapable: () => false,
    isLoadTransportMode: () => false,
    isUnloadTransportMode: () => false,
    isMexUpgradeMode: () => false,
    isPingMode: () => false,
    isTowerTargetMode: () => false,
    isTowerTargetNoGroundMode: () => false,
    exitRepairAreaMode: () => {},
    exitRestoreAreaMode: () => {},
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
    isBuildSplitModifierHeld: () => splitModifier.held,
  });
}

export function runInput3DModeClickControllerContractTest(): void {
  const mode = new CommanderModeController();
  const builder = makeCommanderBuilder();
  const commands: Command[] = [];
  const buildCommandQueuedStates: boolean[] = [];
  const splitModifier = { held: false };
  const controller = makeController(
    mode,
    [builder],
    commands,
    buildCommandQueuedStates,
    splitModifier,
  ) as unknown as BuildCommitHarness;
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

  // BAR multi-builder batch semantics: same-type builders share one
  // queue with guard-assist locally standing in for BAR duplicate
  // nanoframe build orders. Build-split forks the batch, preserving
  // contiguous placement order instead of round-robin interleaving.
  const multiMode = new CommanderModeController();
  const leader = makeCommanderBuilder(301);
  const helper = makeCommanderBuilder(302);
  const multiCommands: Command[] = [];
  const multiSplit = { held: false };
  const multiController = makeController(
    multiMode,
    [leader, helper],
    multiCommands,
    [],
    multiSplit,
  ) as unknown as BuildCommitHarness;
  const multiPlanner = () => [
    { gridX: 0, gridY: 0 },
    { gridX: 4, gridY: 0 },
    { gridX: 8, gridY: 0 },
  ];

  multiMode.enterBuildMode('buildingSolar');
  multiController.commitBuildShapePlacements(makeBuildDrag(true), 'buildingSolar', multiPlanner);
  assertContract(
    multiCommands.length === 4,
    'same-type shared-queue build commit must enqueue every startBuild plus one guard command',
  );
  assertContract(
    multiCommands.slice(0, 3).every(
      (command) => command.type === 'startBuild' && command.builderId === leader.id,
    ),
    'without the split modifier one same-type group leader must own the contiguous placement queue',
  );
  const guardCommand = multiCommands[3];
  assertContract(
    guardCommand.type === 'guard' &&
      guardCommand.targetId === leader.id &&
      guardCommand.entityIds.length === 1 &&
      guardCommand.entityIds[0] === helper.id,
    'without the split modifier the other capable builders must guard-assist the active builder',
  );

  multiCommands.length = 0;
  multiSplit.held = true;
  multiController.commitBuildShapePlacements(makeBuildDrag(true), 'buildingSolar', multiPlanner);
  assertContract(
    multiCommands.length === 5,
    'split-modifier build commit must enqueue split startBuild commands plus assist follow-ups',
  );
  const splitStartBuilds = multiCommands.filter((command) => command.type === 'startBuild');
  const splitBuilderIds = splitStartBuilds.map((command) => command.builderId);
  assertContract(
    splitBuilderIds[0] === leader.id &&
      splitBuilderIds[1] === leader.id &&
      splitBuilderIds[2] === helper.id,
    'split-modifier build commit must partition placements into contiguous builder chunks',
  );
  const splitGuards = multiCommands.filter((command) => command.type === 'guard');
  assertContract(
    splitGuards.length === 2 &&
      splitGuards[0].entityIds[0] === leader.id &&
      splitGuards[0].targetId === helper.id &&
      splitGuards[0].queue === true &&
      splitGuards[1].entityIds[0] === helper.id &&
      splitGuards[1].targetId === leader.id,
    'split-modifier build commit must append peer assist guards after own chunks',
  );

  multiCommands.length = 0;
  const builderAreaDrag = {
    kind: 'repairArea' as const,
    button: 0 as const,
    start: { x: 48, y: 64, z: 3 },
    current: { x: 88, y: 64, z: 3 },
    startClientX: 0,
    startClientY: 0,
    queue: true,
    queueFront: false,
  };
  multiController.commitAreaDrag(builderAreaDrag, mouseEvent({ shiftKey: true }));
  assertContract(
    multiCommands.length === 2 &&
      multiCommands[0].type === 'repairArea' &&
      multiCommands[0].commanderId === leader.id &&
      multiCommands[1].type === 'repairArea' &&
      multiCommands[1].commanderId === helper.id,
    'BAR Repair area must fan out to every selected builder with the active builder first',
  );

  multiCommands.length = 0;
  multiController.commitAreaDrag(
    { ...builderAreaDrag, kind: 'reclaimArea' },
    mouseEvent({ shiftKey: true }),
  );
  assertContract(
    multiCommands.length === 2 &&
      multiCommands[0].type === 'reclaimArea' &&
      multiCommands[0].commanderId === leader.id &&
      multiCommands[1].type === 'reclaimArea' &&
      multiCommands[1].commanderId === helper.id,
    'BAR Reclaim area must fan out to every selected builder with the active builder first',
  );

  const mixedMode = new CommanderModeController();
  const commander = makeCommanderBuilder(501, 'unitCommander');
  const drone = makeCommanderBuilder(502, 'unitConstructionDrone');
  const mixedCommands: Command[] = [];
  const mixedController = makeController(
    mixedMode,
    [commander, drone],
    mixedCommands,
    [],
    { held: false },
  ) as unknown as BuildCommitHarness;
  const fivePlacements = () => [
    { gridX: 0, gridY: 0 },
    { gridX: 4, gridY: 0 },
    { gridX: 8, gridY: 0 },
    { gridX: 12, gridY: 0 },
    { gridX: 16, gridY: 0 },
  ];

  mixedMode.enterBuildMode('buildingSolar');
  mixedController.commitBuildShapePlacements(makeBuildDrag(true), 'buildingSolar', fivePlacements);
  const mixedBuilderIds = mixedCommands
    .filter((command) => command.type === 'startBuild')
    .map((command) => command.builderId);
  assertContract(
    mixedBuilderIds.length === 5 &&
      mixedBuilderIds[0] === commander.id &&
      mixedBuilderIds[1] === commander.id &&
      mixedBuilderIds[2] === commander.id &&
      mixedBuilderIds[3] === drone.id &&
      mixedBuilderIds[4] === drone.id,
    'mixed builder-type build commit must partition ordered placements by build power',
  );

  const placementState = new Input3DBuildPlacementState();
  const buildMapWidth = 512;
  const buildMapHeight = 512;
  const buildCellsX = Math.ceil(buildMapWidth / BUILD_GRID_CELL_SIZE);
  const buildCellsY = Math.ceil(buildMapHeight / BUILD_GRID_CELL_SIZE);
  const flatBuildabilityGrid = {
    mapWidth: buildMapWidth,
    mapHeight: buildMapHeight,
    cellSize: BUILD_GRID_CELL_SIZE,
    cellsX: buildCellsX,
    cellsY: buildCellsY,
    version: 1,
    configKey: 'flat-test',
    flags: new Array(buildCellsX * buildCellsY).fill(1),
    levels: new Array(buildCellsX * buildCellsY).fill(0),
  };
  const emptyBuildEntitySource = {
    getBuildings: () => [],
    getTerrainBuildabilityGrid: () => flatBuildabilityGrid,
  };
  placementState.setMapBounds(buildMapWidth, buildMapHeight, 1, []);
  const reverseGrid = placementState.planBuildGridPlacements(
    'buildingSolar',
    240,
    240,
    60,
    120,
    emptyBuildEntitySource,
  );
  assertContract(
    reverseGrid.length >= 4 &&
      reverseGrid[0].x > reverseGrid[1].x &&
      reverseGrid[1].x > reverseGrid[2].x,
    'reverse grid build drag must emit the first row from the drag start toward the drag end',
  );
  const reverseBorder = placementState.planBuildBorderPlacements(
    'buildingSolar',
    240,
    240,
    60,
    120,
    emptyBuildEntitySource,
  );
  assertContract(
    reverseBorder.length >= 3 &&
      reverseBorder[0].x > reverseBorder[2].x,
    'reverse hollow build drag must start from the drag-start edge instead of the normalized minimum corner',
  );

  const dgunMode = new CommanderModeController();
  dgunMode.enterDGunMode();
  const dgunCommander = makeCommanderBuilder(401);
  const dgunAlly = makeUnit(402, 1);
  const dgunEnemy = makeUnit(403, 2);
  const dgunEntities = [dgunCommander, dgunAlly, dgunEnemy];
  const dgunCommands: Command[] = [];
  let dgunHitId: number | null = dgunEnemy.id;
  const dgunController = new Input3DModeClickController({
    getEntitySource: () => ({
      getUnits: () => dgunEntities,
      getBuildings: () => [],
      getEntity: (id: number) => dgunEntities.find((entity) => entity.id === id),
      getSelectedUnits: () => [dgunCommander],
    }),
    commandQueue: { enqueue: (command) => dgunCommands.push(command) },
    picker: {
      raycastEntity: () => dgunHitId,
      raycastGround: () => ({ x: 320, y: 192, z: 7 }),
    } as never,
    mode: dgunMode,
    selectedCommands: {} as never,
    getTick: () => 123,
    getActivePlayerId: () => 1,
    getQueueInsertIndex: () => null,
    getSelectedCommander: () => dgunCommander,
    getSelectedBuilder: () => null,
    getSelectedResurrectSource: () => null,
    onBuildCommandIssued: () => {},
    applyCursor: () => {},
    isRepairAreaMode: () => false,
    isRestoreAreaMode: () => false,
    isAttackMode: () => false,
    isAttackAreaMode: () => false,
    isAttackGroundMode: () => false,
    isManualLaunchMode: () => false,
    isGuardMode: () => false,
    isReclaimMode: () => false,
    isCaptureMode: () => false,
    isResurrectMode: () => false,
    isResurrectAreaMode: () => false,
    isResurrectModeAreaCapable: () => false,
    isLoadTransportMode: () => false,
    isUnloadTransportMode: () => false,
    isMexUpgradeMode: () => false,
    isPingMode: () => false,
    isTowerTargetMode: () => false,
    isTowerTargetNoGroundMode: () => false,
    exitRepairAreaMode: () => {},
    exitRestoreAreaMode: () => {},
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
    isBuildSplitModifierHeld: () => false,
  });
  dgunController.handleMouseDown(mouseEvent({ button: 0, clientX: 12, clientY: 34 }));
  assertContract(
    dgunCommands.length === 1 &&
      dgunCommands[0].type === 'fireDGun' &&
      dgunCommands[0].targetId === dgunEnemy.id &&
      dgunCommands[0].targetX === 320 &&
      dgunCommands[0].targetY === 192,
    'BAR DGun ICON_UNIT_OR_MAP click must preserve enemy unit target ids while keeping a ground fallback point',
  );
  dgunHitId = dgunAlly.id;
  dgunController.handleMouseDown(mouseEvent({ button: 0, clientX: 12, clientY: 34 }));
  assertContract(
    dgunCommands.length === 2 &&
      dgunCommands[1].type === 'fireDGun' &&
      !('targetId' in dgunCommands[1]),
    'BAR DGun no-ally behavior must fall back to the ground point instead of snapping to allied unit ids',
  );

  const attacker = makeUnit(201, 1);
  const ally = makeUnit(202, 1);
  const attackCommands: Command[] = [];
  let exitAttackModeCount = 0;
  let attackHitId: number | null = ally.id;
  const attackController = new Input3DModeClickController({
    getEntitySource: () => ({
      getUnits: () => [attacker, ally],
      getBuildings: () => [],
      getEntity: (id: number) => id === attacker.id ? attacker : id === ally.id ? ally : undefined,
      getSelectedUnits: () => [attacker],
    }),
    commandQueue: { enqueue: (command) => attackCommands.push(command) },
    picker: {
      raycastEntity: () => attackHitId,
      raycastGround: () => ({ x: 72, y: 96, z: 4 }),
    } as never,
    mode: new CommanderModeController(),
    selectedCommands: {} as never,
    getTick: () => 321,
    getActivePlayerId: () => 1,
    getQueueInsertIndex: () => null,
    getSelectedCommander: () => null,
    getSelectedBuilder: () => null,
    getSelectedResurrectSource: () => null,
    onBuildCommandIssued: () => {},
    applyCursor: () => {},
    isRepairAreaMode: () => false,
    isRestoreAreaMode: () => false,
    isAttackMode: () => true,
    isAttackAreaMode: () => false,
    isAttackGroundMode: () => false,
    isManualLaunchMode: () => false,
    isGuardMode: () => false,
    isReclaimMode: () => false,
    isCaptureMode: () => false,
    isResurrectMode: () => false,
    isResurrectAreaMode: () => false,
    isResurrectModeAreaCapable: () => false,
    isLoadTransportMode: () => false,
    isUnloadTransportMode: () => false,
    isMexUpgradeMode: () => false,
    isPingMode: () => false,
    isTowerTargetMode: () => false,
    isTowerTargetNoGroundMode: () => false,
    exitRepairAreaMode: () => {},
    exitRestoreAreaMode: () => {},
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
    isBuildSplitModifierHeld: () => false,
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
  attackHitId = null;
  attackController.handleMouseDown(mouseEvent({ button: 0, clientX: 12, clientY: 34 }));
  assertContract(
    attackCommands.length === 2 &&
      attackCommands[1].type === 'attackGround' &&
      attackCommands[1].targetX === 72 &&
      attackCommands[1].targetY === 96 &&
      attackCommands[1].targetZ === 4,
    'BAR Attack on empty ground must issue Attack Point rather than degrading to Fight',
  );

  const resurrector = makeCommanderBuilder(303);
  const resurrectCommands: Command[] = [];
  let exitResurrectModeCount = 0;
  const resurrectController = new Input3DModeClickController({
    getEntitySource: () => ({
      getUnits: () => [resurrector],
      getBuildings: () => [],
      getEntity: () => undefined,
      getSelectedUnits: () => [resurrector],
    }),
    commandQueue: { enqueue: (command) => resurrectCommands.push(command) },
    picker: {
      raycastEntity: () => null,
      raycastGround: (clientX: number, clientY: number) => ({ x: clientX, y: clientY, z: 0 }),
    } as never,
    mode: new CommanderModeController(),
    selectedCommands: {} as never,
    getTick: () => 456,
    getActivePlayerId: () => 1,
    getQueueInsertIndex: () => null,
    getSelectedCommander: () => null,
    getSelectedBuilder: () => resurrector,
    getSelectedResurrectSource: () => resurrector,
    onBuildCommandIssued: () => {},
    applyCursor: () => {},
    isRepairAreaMode: () => false,
    isRestoreAreaMode: () => false,
    isAttackMode: () => false,
    isAttackAreaMode: () => false,
    isAttackGroundMode: () => false,
    isManualLaunchMode: () => false,
    isGuardMode: () => false,
    isReclaimMode: () => false,
    isCaptureMode: () => false,
    isResurrectMode: () => true,
    isResurrectAreaMode: () => false,
    isResurrectModeAreaCapable: () => true,
    isLoadTransportMode: () => false,
    isUnloadTransportMode: () => false,
    isMexUpgradeMode: () => false,
    isPingMode: () => false,
    isTowerTargetMode: () => false,
    isTowerTargetNoGroundMode: () => false,
    exitRepairAreaMode: () => {},
    exitRestoreAreaMode: () => {},
    exitAttackMode: () => {},
    exitAttackAreaMode: () => {},
    exitAttackGroundMode: () => {},
    exitManualLaunchMode: () => {},
    exitGuardMode: () => {},
    exitReclaimMode: () => {},
    exitCaptureMode: () => {},
    exitResurrectMode: () => { exitResurrectModeCount++; },
    exitResurrectAreaMode: () => {},
    exitLoadTransportMode: () => {},
    exitUnloadTransportMode: () => {},
    exitMexUpgradeMode: () => {},
    exitPingMode: () => {},
    exitTowerTargetMode: () => {},
    exitTowerTargetNoGroundMode: () => {},
    isBuildSplitModifierHeld: () => false,
  });
  resurrectController.handleMouseDown(mouseEvent({ button: 0, clientX: 0, clientY: 0 }));
  resurrectController.handleMouseUp(mouseEvent({ button: 0, clientX: 24, clientY: 0 }));
  assertContract(resurrectCommands.length === 1, 'area-capable resurrect drag must enqueue one area resurrect command');
  const resurrectDragCommand = resurrectCommands[0];
  assertContract(
    resurrectDragCommand.type === 'resurrectArea' &&
      resurrectDragCommand.commanderId === resurrector.id &&
      resurrectDragCommand.targetX === 0 &&
      resurrectDragCommand.targetY === 0 &&
      resurrectDragCommand.radius === 24,
    'regular Resurrect mode must use the area command path when click-dragged while area-capable',
  );
  assertContract(exitResurrectModeCount === 1, 'unqueued resurrect drag must exit regular resurrect mode');

  const transport = makeTransport(401, 1);
  const loadTransportCommands: Command[] = [];
  let exitLoadTransportModeCount = 0;
  const loadTransportController = new Input3DModeClickController({
    getEntitySource: () => ({
      getUnits: () => [transport],
      getBuildings: () => [],
      getEntity: (id: number) => id === transport.id ? transport : undefined,
      getSelectedUnits: () => [transport],
    }),
    commandQueue: { enqueue: (command) => loadTransportCommands.push(command) },
    picker: {
      raycastEntity: () => null,
      raycastGround: (clientX: number, clientY: number) => ({ x: clientX, y: clientY, z: 2 }),
    } as never,
    mode: new CommanderModeController(),
    selectedCommands: {} as never,
    getTick: () => 789,
    getActivePlayerId: () => 1,
    getQueueInsertIndex: () => null,
    getSelectedCommander: () => null,
    getSelectedBuilder: () => null,
    getSelectedResurrectSource: () => null,
    onBuildCommandIssued: () => {},
    applyCursor: () => {},
    isRepairAreaMode: () => false,
    isRestoreAreaMode: () => false,
    isAttackMode: () => false,
    isAttackAreaMode: () => false,
    isAttackGroundMode: () => false,
    isManualLaunchMode: () => false,
    isGuardMode: () => false,
    isReclaimMode: () => false,
    isCaptureMode: () => false,
    isResurrectMode: () => false,
    isResurrectAreaMode: () => false,
    isResurrectModeAreaCapable: () => false,
    isLoadTransportMode: () => true,
    isUnloadTransportMode: () => false,
    isMexUpgradeMode: () => false,
    isPingMode: () => false,
    isTowerTargetMode: () => false,
    isTowerTargetNoGroundMode: () => false,
    exitRepairAreaMode: () => {},
    exitRestoreAreaMode: () => {},
    exitAttackMode: () => {},
    exitAttackAreaMode: () => {},
    exitAttackGroundMode: () => {},
    exitManualLaunchMode: () => {},
    exitGuardMode: () => {},
    exitReclaimMode: () => {},
    exitCaptureMode: () => {},
    exitResurrectMode: () => {},
    exitResurrectAreaMode: () => {},
    exitLoadTransportMode: () => { exitLoadTransportModeCount++; },
    exitUnloadTransportMode: () => {},
    exitMexUpgradeMode: () => {},
    exitPingMode: () => {},
    exitTowerTargetMode: () => {},
    exitTowerTargetNoGroundMode: () => {},
    isBuildSplitModifierHeld: () => false,
  });
  loadTransportController.handleMouseDown(mouseEvent({ button: 0, clientX: 10, clientY: 10 }));
  loadTransportController.handleMouseUp(mouseEvent({ button: 0, clientX: 40, clientY: 10 }));
  assertContract(loadTransportCommands.length === 1, 'BAR Load units drag must enqueue one area load command');
  const loadDragCommand = loadTransportCommands[0];
  assertContract(
    loadDragCommand.type === 'loadTransport' &&
      !('targetId' in loadDragCommand) &&
      loadDragCommand.transportIds.length === 1 &&
      loadDragCommand.transportIds[0] === transport.id &&
      loadDragCommand.targetX === 10 &&
      loadDragCommand.targetY === 10 &&
      loadDragCommand.targetZ === 2 &&
      loadDragCommand.radius === 30,
    'BAR Load units mode must use the area command path when click-dragged',
  );
  assertContract(exitLoadTransportModeCount === 1, 'unqueued BAR Load units drag must exit load mode');

  const unloadTransportCommands: Command[] = [];
  let exitUnloadTransportModeCount = 0;
  const unloadTransportController = new Input3DModeClickController({
    getEntitySource: () => ({
      getUnits: () => [transport],
      getBuildings: () => [],
      getEntity: (id: number) => id === transport.id ? transport : undefined,
      getSelectedUnits: () => [transport],
    }),
    commandQueue: { enqueue: (command) => unloadTransportCommands.push(command) },
    picker: {
      raycastEntity: () => null,
      raycastGround: (clientX: number, clientY: number) => ({ x: clientX, y: clientY, z: 2 }),
    } as never,
    mode: new CommanderModeController(),
    selectedCommands: {} as never,
    getTick: () => 790,
    getActivePlayerId: () => 1,
    getQueueInsertIndex: () => null,
    getSelectedCommander: () => null,
    getSelectedBuilder: () => null,
    getSelectedResurrectSource: () => null,
    onBuildCommandIssued: () => {},
    applyCursor: () => {},
    isRepairAreaMode: () => false,
    isRestoreAreaMode: () => false,
    isAttackMode: () => false,
    isAttackAreaMode: () => false,
    isAttackGroundMode: () => false,
    isManualLaunchMode: () => false,
    isGuardMode: () => false,
    isReclaimMode: () => false,
    isCaptureMode: () => false,
    isResurrectMode: () => false,
    isResurrectAreaMode: () => false,
    isResurrectModeAreaCapable: () => false,
    isLoadTransportMode: () => false,
    isUnloadTransportMode: () => true,
    isMexUpgradeMode: () => false,
    isPingMode: () => false,
    isTowerTargetMode: () => false,
    isTowerTargetNoGroundMode: () => false,
    exitRepairAreaMode: () => {},
    exitRestoreAreaMode: () => {},
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
    exitUnloadTransportMode: () => { exitUnloadTransportModeCount++; },
    exitMexUpgradeMode: () => {},
    exitPingMode: () => {},
    exitTowerTargetMode: () => {},
    exitTowerTargetNoGroundMode: () => {},
    isBuildSplitModifierHeld: () => false,
  });
  unloadTransportController.handleMouseDown(mouseEvent({ button: 0, clientX: 10, clientY: 10 }));
  unloadTransportController.handleMouseUp(mouseEvent({ button: 0, clientX: 90, clientY: 10 }));
  assertContract(unloadTransportCommands.length === 1, 'BAR Unload units drag must enqueue one area unload command');
  const unloadDragCommand = unloadTransportCommands[0];
  assertContract(
    unloadDragCommand.type === 'unloadTransport' &&
      unloadDragCommand.transportIds.length === 1 &&
      unloadDragCommand.transportIds[0] === transport.id &&
      unloadDragCommand.targetX === 10 &&
      unloadDragCommand.targetY === 10 &&
      unloadDragCommand.targetZ === 2 &&
      unloadDragCommand.radius === 80,
    'BAR Unload units mode must preserve an area radius for drags at least 64 elmos like cmd_area_unload.lua',
  );
  assertContract(exitUnloadTransportModeCount === 1, 'unqueued BAR Unload units drag must exit unload mode');

  const firstTransport = makeTransport(501, 1);
  const secondTransport = makeTransport(502, 1);
  const transportTarget = makeUnit(503, 1);
  transportTarget.transform = createTransform(80, 88, 3, 0);
  const targetLoadCommands: Command[] = [];
  const targetLoadController = new Input3DModeClickController({
    getEntitySource: () => ({
      getUnits: () => [firstTransport, secondTransport, transportTarget],
      getBuildings: () => [],
      getEntity: (id: number) => {
        if (id === firstTransport.id) return firstTransport;
        if (id === secondTransport.id) return secondTransport;
        if (id === transportTarget.id) return transportTarget;
        return undefined;
      },
      getSelectedUnits: () => [firstTransport, secondTransport],
    }),
    commandQueue: { enqueue: (command) => targetLoadCommands.push(command) },
    picker: {
      raycastEntity: () => transportTarget.id,
      raycastGround: () => ({ x: 80, y: 88, z: 3 }),
    } as never,
    mode: new CommanderModeController(),
    selectedCommands: {} as never,
    getTick: () => 790,
    getActivePlayerId: () => 1,
    getQueueInsertIndex: () => null,
    getSelectedCommander: () => null,
    getSelectedBuilder: () => null,
    getSelectedResurrectSource: () => null,
    onBuildCommandIssued: () => {},
    applyCursor: () => {},
    isRepairAreaMode: () => false,
    isRestoreAreaMode: () => false,
    isAttackMode: () => false,
    isAttackAreaMode: () => false,
    isAttackGroundMode: () => false,
    isManualLaunchMode: () => false,
    isGuardMode: () => false,
    isReclaimMode: () => false,
    isCaptureMode: () => false,
    isResurrectMode: () => false,
    isResurrectAreaMode: () => false,
    isResurrectModeAreaCapable: () => false,
    isLoadTransportMode: () => true,
    isUnloadTransportMode: () => false,
    isMexUpgradeMode: () => false,
    isPingMode: () => false,
    isTowerTargetMode: () => false,
    isTowerTargetNoGroundMode: () => false,
    exitRepairAreaMode: () => {},
    exitRestoreAreaMode: () => {},
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
    isBuildSplitModifierHeld: () => false,
  });
  targetLoadController.handleMouseDown(mouseEvent({ button: 0, clientX: 80, clientY: 88 }));
  targetLoadController.handleMouseUp(mouseEvent({ button: 0, clientX: 80, clientY: 88 }));
  assertContract(targetLoadCommands.length === 1, 'multi-transport Load units target click must enqueue one command');
  const targetLoadCommand = targetLoadCommands[0];
  assertContract(
    targetLoadCommand.type === 'loadTransport' &&
      !('targetId' in targetLoadCommand) &&
      targetLoadCommand.transportIds.join(',') === `${firstTransport.id},${secondTransport.id}` &&
      targetLoadCommand.targetX === 80 &&
      targetLoadCommand.targetY === 88 &&
      targetLoadCommand.targetZ === 3 &&
      targetLoadCommand.radius === 150,
    'BAR multi-transport target Load units must convert to a small area command around the target unit',
  );
}
