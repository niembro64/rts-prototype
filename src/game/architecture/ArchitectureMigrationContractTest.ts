import type { GameServerConfig } from '@/types/game';
import type { Command } from '../sim/commands';
import type { BuildingBlueprintId, Entity, PlayerId } from '../sim/types';
import { getBuildingConfig } from '../sim/buildConfigs';
import { ServerBootstrap } from '../server/ServerBootstrap';
import { ServerSimulationCore } from '../server/ServerSimulationCore';
import {
  disposeCheckpointCore,
  exportCanonicalCheckpoint,
  type CanonicalCheckpoint,
  type CanonicalCheckpointCommandFrame,
} from './CanonicalCheckpoint';
import { migrateArchitectureCheckpoint } from './ArchitectureMigration';
import { LOCKSTEP_FIXED_DT_MS } from './LockstepFrameScheduler';
import { resetReusableSimulationStateForDeterministicReplay } from './DeterministicReplayHarness';

function assertContract(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[architecture migration contract] ${message}`);
  }
}

export function runArchitectureMigrationContractTest(): void {
  const config: GameServerConfig = {
    playerIds: [1 as PlayerId, 2 as PlayerId],
    centerMagnitude: 0,
    dividersMagnitude: 0,
    terrainMapShape: 'circle',
    terrainDTerrain: 0,
    metalDepositStep: 0,
    terrainDetail: 1,
    mapWidthLandCells: 9,
    mapLengthLandCells: 9,
    converterTax: 0.25,
  };

  resetReusableSimulationStateForDeterministicReplay();
  const baseline = new ServerSimulationCore(ServerBootstrap.bootstrap(config));
  let checkpoint: CanonicalCheckpoint;
  let baselineFrame24Hash: string;
  try {
    const commandFrames = createActiveMigrationCommandFrames(baseline);
    stepCoreToFrame(baseline, 12, commandFrames);
    assertContract(baseline.world.getProjectiles().length > 0, 'migration fixture must have projectile state');
    assertContract(baseline.world.scanPulses.length > 0, 'migration fixture must have scan/economy-adjacent state');
    assertContract(
      baseline.world.getBuildings().some((entity) => entity.buildable !== null),
      'migration fixture must have construction in progress',
    );
    checkpoint = exportCanonicalCheckpoint({
      core: baseline,
      config,
      commandFrames,
      initializationHash: 'architecture-migration-contract-init',
    });
    stepCoreToFrame(baseline, 24, []);
    baselineFrame24Hash = baseline.getCanonicalStateHash().hash;
  } finally {
    disposeCheckpointCore(baseline);
  }

  let paused = false;
  let committed = false;
  let rollbackReason: string | null = null;
  const rollbackReasons: string[] = [];
  const migration = migrateArchitectureCheckpoint({
    direction: 'authoritative-server-to-deterministic-lockstep',
    checkpoint,
    agreedNextFrame: checkpoint.frame,
    onPauseSource: () => {
      paused = true;
    },
    onCommit: () => {
      committed = true;
    },
    onRollback: (reason) => {
      rollbackReason = reason;
      rollbackReasons.push(reason);
    },
  });
  assertContract(migration.ok, 'valid checkpoint migration must succeed');
  assertContract(paused && committed && rollbackReason === null, 'successful migration must pause and commit without rollback');
  try {
    stepCoreToFrame(migration.imported.core, 24, []);
    assertContract(
      migration.imported.core.getCanonicalStateHash().hash === baselineFrame24Hash,
      'migrated runtime must continue with unchanged canonical gameplay state',
    );
  } finally {
    disposeCheckpointCore(migration.imported.core);
  }

  const failed = migrateArchitectureCheckpoint({
    direction: 'deterministic-lockstep-to-authoritative-server',
    checkpoint: {
      ...checkpoint,
      content: {
        ...checkpoint.content,
        configHash: 'corrupt',
      },
    },
    agreedNextFrame: checkpoint.frame,
    onPauseSource: () => undefined,
    onCommit: () => {
      throw new Error('corrupt migration must not commit');
    },
    onRollback: (reason) => {
      rollbackReason = reason;
      rollbackReasons.push(reason);
    },
  });
  assertContract(!failed.ok, 'corrupt checkpoint migration must fail');
  assertContract(
    rollbackReasons.some((reason) => reason.includes('config hash mismatch')),
    'failed migration must report rollback reason',
  );
}

function createActiveMigrationCommandFrames(
  core: ServerSimulationCore,
): CanonicalCheckpointCommandFrame[] {
  const playerOneCommander = requireCommander(core, 1 as PlayerId);
  const playerTwoCommander = requireCommander(core, 2 as PlayerId);
  const placement = requireBuildPlacement(core, playerOneCommander, 'buildingSolar');
  const commands: Command[] = [
    {
      type: 'startBuild',
      tick: 0,
      builderId: playerOneCommander.id,
      buildingBlueprintId: 'buildingSolar',
      gridX: placement.gridX,
      gridY: placement.gridY,
      queue: false,
    },
    {
      type: 'scan',
      tick: 0,
      targetX: core.world.mapWidth / 2,
      targetY: core.world.mapHeight / 2,
      playerId: 1 as PlayerId,
    },
    {
      type: 'fireDGun',
      tick: 0,
      commanderId: playerOneCommander.id,
      targetX: playerTwoCommander.transform.x,
      targetY: playerTwoCommander.transform.y,
      targetZ: playerTwoCommander.transform.z,
    },
  ];
  return [{ frame: 0, frameSequence: 0, commands }];
}

function requireCommander(core: ServerSimulationCore, playerId: PlayerId): Entity {
  const commander = core.world.getCommander(playerId);
  if (commander === undefined) {
    throw new Error(`[architecture migration contract] missing commander ${playerId}`);
  }
  return commander;
}

function requireBuildPlacement(
  core: ServerSimulationCore,
  builder: Entity,
  buildingBlueprintId: BuildingBlueprintId,
): { gridX: number; gridY: number } {
  const construction = core.simulation.getConstructionSystem();
  const config = getBuildingConfig(buildingBlueprintId);
  const grid = construction.getGrid();
  const candidateOffsets: readonly [number, number][] = [
    [90, 0],
    [0, 90],
    [-90, 0],
    [0, -90],
    [130, 0],
    [0, 130],
    [-130, 0],
    [0, -130],
  ];

  for (const [dx, dy] of candidateOffsets) {
    const x = builder.transform.x + dx;
    const y = builder.transform.y + dy;
    if (!construction.canPlaceAt(x, y, buildingBlueprintId)) continue;
    const snapped = grid.snapToGrid(x, y, config.placementGridWidth, config.placementGridHeight);
    const { gx, gy } = grid.worldToGrid(snapped.x, snapped.y);
    return { gridX: gx, gridY: gy };
  }
  throw new Error('[architecture migration contract] no build placement found');
}

function stepCoreToFrame(
  core: ServerSimulationCore,
  targetFrame: number,
  commandFrames: readonly CanonicalCheckpointCommandFrame[],
): void {
  const commandsByFrame = new Map<number, readonly Command[]>();
  for (const frame of commandFrames) commandsByFrame.set(frame.frame, frame.commands);
  while (core.world.getTick() < targetFrame) {
    const frame = core.world.getTick();
    core.stepFixedTick(LOCKSTEP_FIXED_DT_MS, commandsByFrame.get(frame) ?? []);
  }
}
