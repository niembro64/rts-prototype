import { trimEntitySnapshotPool } from '../network/stateSerializerEntities';
import { beamIndex } from '../sim/BeamIndex';
import { trimBuildingActiveStateBuffers } from '../sim/buildingActiveState';
import { getBuildingConfig } from '../sim/buildConfigs';
import { resetProjectileBuffers } from '../sim/combat/projectileSystem';
import { resetDamageBuffers } from '../sim/damage/DamageSystem';
import { economyManager } from '../sim/economy';
import { trimEnergyDistributionBuffers } from '../sim/energyDistribution';
import { spatialGrid } from '../sim/SpatialGrid';
import { resetTerrainStateForDeterministicReplay } from '../sim/Terrain';
import { getSimWasm } from '../sim-wasm/init';
import type { GameServerConfig } from '@/types/game';
import type { Command } from '../sim/commands';
import type { BuildingBlueprintId, Entity, PlayerId } from '../sim/types';
import { ServerBootstrap } from '../server/ServerBootstrap';
import { ServerSimulationCore } from '../server/ServerSimulationCore';
import {
  buildCanonicalServerState,
  type CanonicalServerState,
} from './CanonicalStateHash';
import { hashCanonicalValue } from './CanonicalMatchInitialization';
import { LOCKSTEP_FIXED_DT_MS } from './LockstepFrameScheduler';

type ReplayCommandBuilder = (core: ServerSimulationCore, frame: number) => readonly Command[];
type ReplaySetup = (core: ServerSimulationCore) => void;
type ReplayFinalAssertion = (
  core: ServerSimulationCore,
  stats: ReplayRunStats,
) => void;

type DeterministicReplayCase = {
  readonly id: string;
  readonly ticks: number;
  readonly config: GameServerConfig;
  readonly setup?: ReplaySetup;
  readonly buildCommands: ReplayCommandBuilder;
  readonly assertFinal?: ReplayFinalAssertion;
};

export type DeterministicReplayCaseReport = {
  readonly id: string;
  readonly ticks: number;
  readonly checkpointCount: number;
  readonly finalHash: string;
  readonly finalSections: Record<string, string>;
  readonly finalEntities: readonly unknown[];
};

export type DeterministicReplayHarnessReport = {
  readonly schema: 'budget-annihilation.deterministic-replay-harness.v1';
  readonly cases: DeterministicReplayCaseReport[];
};

const BASE_REAL_CONFIG: GameServerConfig = {
  playerIds: [1 as PlayerId, 2 as PlayerId],
  centerMagnitude: 0,
  dividersMagnitude: 0,
  terrainMapShape: 'circle',
  terrainDTerrain: 0,
  metalDepositStep: 0,
  terrainDetail: 1,
  mapWidthLandCells: 9,
  mapLengthLandCells: 9,
  converterTax: 0,
};

const CASES: readonly DeterministicReplayCase[] = [
  {
    id: 'real-idle-2p-120t',
    ticks: 120,
    config: BASE_REAL_CONFIG,
    buildCommands: () => [],
  },
  {
    id: 'real-commander-move-2p-180t',
    ticks: 180,
    config: BASE_REAL_CONFIG,
    buildCommands: (core, frame) => {
      if (frame !== 0) return [];
      const commander = requireCommander(core, 1 as PlayerId);
      return [
        {
          type: 'move',
          tick: core.world.getTick(),
          entityIds: [commander.id],
          targetX: commander.transform.x + 320,
          targetY: commander.transform.y,
          targetZ: commander.transform.z,
          waypointType: 'move',
          queue: false,
        },
      ];
    },
  },
  {
    id: 'real-construction-economy-scan-2p-300t',
    ticks: 300,
    config: BASE_REAL_CONFIG,
    buildCommands: (core, frame) => {
      const commander = requireCommander(core, 1 as PlayerId);
      if (frame === 0) {
        const placement = requireBuildPlacement(core, commander, 'buildingSolar');
        return [
          {
            type: 'startBuild',
            tick: core.world.getTick(),
            builderId: commander.id,
            buildingBlueprintId: 'buildingSolar',
            gridX: placement.gridX,
            gridY: placement.gridY,
            queue: false,
          },
          {
            type: 'scan',
            tick: core.world.getTick(),
            targetX: core.world.mapWidth / 2,
            targetY: core.world.mapHeight / 2,
            playerId: 1 as PlayerId,
          },
        ];
      }
      return [];
    },
    assertFinal: (core, stats) => {
      assertHasEntity(core, (entity) =>
        entity.buildingBlueprintId === 'buildingSolar' &&
        entity.ownership?.playerId === 1 &&
        entity.buildable === null,
      'completed solar construction');
      if (core.world.scanPulses.length <= 0) {
        throw new Error('[deterministic replay] expected a live scan pulse');
      }
      const economy = economyManager.getEconomy(1 as PlayerId);
      if (economy === undefined || economy.stockpile.curr <= 0) {
        throw new Error('[deterministic replay] expected valid player economy state');
      }
      if ((stats.constructionEnergySpendByPlayer.get(1 as PlayerId) ?? 0) <= 0) {
        throw new Error('[deterministic replay] expected construction/economy state to spend energy');
      }
    },
  },
  {
    id: 'real-prebuilt-factory-production-2p-240t',
    ticks: 240,
    config: BASE_REAL_CONFIG,
    setup: (core) => {
      const commander = requireCommander(core, 1 as PlayerId);
      createActiveFactoryNear(core, commander);
    },
    buildCommands: (core, frame) => {
      if (frame !== 0) return [];
      const factory = requireFirstEntity(core, (entity) =>
        entity.factory !== null &&
        entity.ownership?.playerId === 1,
      'player 1 factory');
      return [
        {
          type: 'queueUnit',
          tick: core.world.getTick(),
          factoryId: factory.id,
          unitBlueprintId: 'unitJackal',
          repeat: false,
          count: 1,
        },
      ];
    },
    assertFinal: (core) => {
      assertHasEntity(core, (entity) =>
        entity.unit?.unitBlueprintId === 'unitJackal' &&
        entity.ownership?.playerId === 1 &&
        entity.buildable === null,
      'completed factory-produced unit');
    },
  },
  {
    id: 'real-simultaneous-factory-production-2p-300t',
    ticks: 300,
    config: BASE_REAL_CONFIG,
    setup: (core) => {
      createActiveFactoryNear(core, requireCommander(core, 1 as PlayerId));
      createActiveFactoryNear(core, requireCommander(core, 2 as PlayerId));
    },
    buildCommands: (core, frame) => {
      if (frame !== 0) return [];
      const playerOneFactory = requireFirstEntity(core, (entity) =>
        entity.factory !== null &&
        entity.ownership?.playerId === 1,
      'player 1 simultaneous factory');
      const playerTwoFactory = requireFirstEntity(core, (entity) =>
        entity.factory !== null &&
        entity.ownership?.playerId === 2,
      'player 2 simultaneous factory');
      return [
        {
          type: 'queueUnit',
          tick: core.world.getTick(),
          factoryId: playerOneFactory.id,
          unitBlueprintId: 'unitJackal',
          repeat: false,
          count: 1,
        },
        {
          type: 'queueUnit',
          tick: core.world.getTick(),
          factoryId: playerTwoFactory.id,
          unitBlueprintId: 'unitJackal',
          repeat: false,
          count: 1,
        },
      ];
    },
    assertFinal: (core) => {
      const completedJackals = core.world.getUnits().filter((entity) =>
        entity.unit?.unitBlueprintId === 'unitJackal' &&
        entity.buildable === null,
      );
      if (completedJackals.length < 2) {
        throw new Error('[deterministic replay] expected simultaneous factory unit completions');
      }
    },
  },
  {
    id: 'real-dgun-projectile-2p-1t',
    ticks: 1,
    config: BASE_REAL_CONFIG,
    buildCommands: (core, frame) => {
      if (frame !== 0) return [];
      const commander = requireCommander(core, 1 as PlayerId);
      return [
        {
          type: 'fireDGun',
          tick: core.world.getTick(),
          commanderId: commander.id,
          targetX: commander.transform.x + 400,
          targetY: commander.transform.y,
          targetZ: commander.transform.z,
        },
      ];
    },
    assertFinal: (core) => {
      if (core.world.getProjectiles().length <= 0) {
        throw new Error('[deterministic replay] expected a live d-gun projectile');
      }
    },
  },
  {
    id: 'real-simultaneous-projectile-death-cleanup-2p-90t',
    ticks: 90,
    config: BASE_REAL_CONFIG,
    buildCommands: (core, frame) => {
      if (frame !== 0) return [];
      const playerOneCommander = requireCommander(core, 1 as PlayerId);
      const playerTwoCommander = requireCommander(core, 2 as PlayerId);
      return [
        {
          type: 'fireDGun',
          tick: core.world.getTick(),
          commanderId: playerOneCommander.id,
          targetX: playerTwoCommander.transform.x,
          targetY: playerTwoCommander.transform.y,
          targetZ: playerTwoCommander.transform.z,
        },
        {
          type: 'fireDGun',
          tick: core.world.getTick(),
          commanderId: playerTwoCommander.id,
          targetX: playerOneCommander.transform.x,
          targetY: playerOneCommander.transform.y,
          targetZ: playerOneCommander.transform.z,
        },
        {
          type: 'selfDestruct',
          tick: core.world.getTick(),
          entityIds: [playerOneCommander.id],
        },
        {
          type: 'selfDestruct',
          tick: core.world.getTick(),
          entityIds: [playerTwoCommander.id],
        },
      ];
    },
    assertFinal: (core) => {
      if (core.world.getCommander(1 as PlayerId) !== undefined) {
        throw new Error('[deterministic replay] expected player 1 commander cleanup');
      }
      if (core.world.getCommander(2 as PlayerId) !== undefined) {
        throw new Error('[deterministic replay] expected player 2 commander cleanup');
      }
    },
  },
  {
    id: 'real-self-destruct-death-cleanup-2p-90t',
    ticks: 90,
    config: BASE_REAL_CONFIG,
    buildCommands: (core, frame) => {
      if (frame !== 0) return [];
      const commander = requireCommander(core, 2 as PlayerId);
      return [
        {
          type: 'selfDestruct',
          tick: core.world.getTick(),
          entityIds: [commander.id],
        },
      ];
    },
    assertFinal: (core) => {
      const commander = core.world.getCommander(2 as PlayerId);
      if (commander !== undefined) {
        throw new Error('[deterministic replay] expected self-destructed commander cleanup');
      }
    },
  },
];

export async function runDeterministicReplayHarness(): Promise<DeterministicReplayHarnessReport> {
  assertDeterministicWasmAvailable();
  const reports: DeterministicReplayCaseReport[] = [];
  for (const replayCase of CASES) {
    const first = runReplayCaseOnce(replayCase);
    const second = runReplayCaseOnce(replayCase);
    assertMatchingReplayRuns(replayCase.id, first, second);
    reports.push({
      id: replayCase.id,
      ticks: replayCase.ticks,
      checkpointCount: first.checkpoints.length,
      finalHash: first.finalHash,
      finalSections: first.finalSections,
      finalEntities: [...first.entitiesById.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, entity]) => entity),
    });
  }
  return {
    schema: 'budget-annihilation.deterministic-replay-harness.v1',
    cases: reports,
  };
}

function assertDeterministicWasmAvailable(): void {
  if (getSimWasm() === undefined) {
    throw new Error('[deterministic replay] sim-wasm must be initialized before replay');
  }
}

type ReplayRun = {
  readonly finalHash: string;
  readonly finalSections: Record<string, string>;
  readonly entityHashes: readonly { readonly id: number; readonly hash: string }[];
  readonly entitiesById: ReadonlyMap<number, unknown>;
  readonly checkpoints: readonly string[];
};

type ReplayRunStats = {
  readonly constructionEnergySpendByPlayer: Map<PlayerId, number>;
};

function runReplayCaseOnce(replayCase: DeterministicReplayCase): ReplayRun {
  resetReusableSimulationStateForDeterministicReplay();
  const boot = ServerBootstrap.bootstrap(replayCase.config);
  const core = new ServerSimulationCore(boot);
  const checkpoints: string[] = [];
  const stats = createReplayRunStats();
  try {
    replayCase.setup?.(core);
    for (let frame = 0; frame < replayCase.ticks; frame++) {
      const commands = replayCase.buildCommands(core, frame);
      core.stepFixedTick(LOCKSTEP_FIXED_DT_MS, commands);
      observeReplayTick(core, stats);
      if ((frame + 1) % 30 === 0 || frame === replayCase.ticks - 1) {
        checkpoints.push(core.getCanonicalStateHash().hash);
      }
    }
    replayCase.assertFinal?.(core, stats);
    const finalState = buildCanonicalServerState(core);
    const finalStateHash = core.getCanonicalStateHash();
    return {
      finalHash: finalStateHash.hash,
      finalSections: finalStateHash.sections,
      entityHashes: collectEntityHashes(finalState.entities),
      entitiesById: collectEntitiesById(finalState.entities),
      checkpoints,
    };
  } finally {
    core.clearPendingCommandsAndStepBuffers();
    core.resetSessionState();
    core.detachSimulationCallbacks();
    core.dispose();
    resetReusableSimulationStateForDeterministicReplay();
  }
}

function createReplayRunStats(): ReplayRunStats {
  return {
    constructionEnergySpendByPlayer: new Map(),
  };
}

function observeReplayTick(core: ServerSimulationCore, stats: ReplayRunStats): void {
  const movements = core.world.resourceMovements;
  for (let i = 0; i < movements.length; i++) {
    const movement = movements[i];
    if (movement.reason !== 'construction' || movement.resource !== 'energy') continue;
    const playerId = movement.playerId;
    const previous = stats.constructionEnergySpendByPlayer.get(playerId) ?? 0;
    stats.constructionEnergySpendByPlayer.set(playerId, previous + movement.amount);
  }
}

function assertMatchingReplayRuns(
  caseId: string,
  first: ReplayRun,
  second: ReplayRun,
): void {
  if (first.finalHash !== second.finalHash) {
    throw new Error(
      `[deterministic replay] ${caseId} final hash mismatch: ` +
        `${first.finalHash} !== ${second.finalHash}; ` +
        `sections ${JSON.stringify(first.finalSections)} !== ` +
        `${JSON.stringify(second.finalSections)}; ` +
        `entityDiff=${JSON.stringify(firstEntityHashDiff(first, second))}; ` +
        `fieldDiff=${JSON.stringify(firstEntityFieldDiff(first, second))}`,
    );
  }
  if (first.checkpoints.length !== second.checkpoints.length) {
    throw new Error(`[deterministic replay] ${caseId} checkpoint count mismatch`);
  }
  for (let i = 0; i < first.checkpoints.length; i++) {
    if (first.checkpoints[i] !== second.checkpoints[i]) {
      throw new Error(
        `[deterministic replay] ${caseId} checkpoint ${i} mismatch: ` +
          `${first.checkpoints[i]} !== ${second.checkpoints[i]}`,
      );
    }
  }
}

function collectEntityHashes(
  entities: CanonicalServerState['entities'],
): { id: number; hash: string }[] {
  if (!Array.isArray(entities)) return [];
  return entities.map((entity) => {
    const id = typeof entity === 'object' && entity !== null && !Array.isArray(entity)
      ? entity.id
      : null;
    return {
      id: typeof id === 'number' ? id : -1,
      hash: hashCanonicalValue(entity),
    };
  });
}

function firstEntityHashDiff(
  first: ReplayRun,
  second: ReplayRun,
): { id: number; first: string | null; second: string | null } | null {
  const ids = new Set([
    ...first.entityHashes.map((entry) => entry.id),
    ...second.entityHashes.map((entry) => entry.id),
  ]);
  const firstById = new Map(first.entityHashes.map((entry) => [entry.id, entry.hash]));
  const secondById = new Map(second.entityHashes.map((entry) => [entry.id, entry.hash]));
  for (const id of [...ids].sort((a, b) => a - b)) {
    const firstHash = firstById.get(id) ?? null;
    const secondHash = secondById.get(id) ?? null;
    if (firstHash !== secondHash) {
      return { id, first: firstHash, second: secondHash };
    }
  }
  return null;
}

function collectEntitiesById(
  entities: CanonicalServerState['entities'],
): Map<number, unknown> {
  const result = new Map<number, unknown>();
  if (!Array.isArray(entities)) return result;
  for (const entity of entities) {
    if (typeof entity !== 'object' || entity === null || Array.isArray(entity)) continue;
    const id = entity.id;
    if (typeof id === 'number') result.set(id, entity);
  }
  return result;
}

function firstEntityFieldDiff(
  first: ReplayRun,
  second: ReplayRun,
): { id: number; path: string; first: unknown; second: unknown } | null {
  const hashDiff = firstEntityHashDiff(first, second);
  if (hashDiff === null) return null;
  const firstEntity = first.entitiesById.get(hashDiff.id);
  const secondEntity = second.entitiesById.get(hashDiff.id);
  const diff = firstValueDiff(firstEntity, secondEntity);
  return {
    id: hashDiff.id,
    path: diff.path,
    first: diff.first,
    second: diff.second,
  };
}

function firstValueDiff(
  first: unknown,
  second: unknown,
  path: string[] = [],
): { path: string; first: unknown; second: unknown } {
  if (Object.is(first, second)) {
    return { path: path.join('.') || '<root>', first, second };
  }
  if (
    first === null ||
    second === null ||
    typeof first !== 'object' ||
    typeof second !== 'object'
  ) {
    return { path: path.join('.') || '<root>', first, second };
  }
  if (Array.isArray(first) || Array.isArray(second)) {
    if (!Array.isArray(first) || !Array.isArray(second)) {
      return { path: path.join('.') || '<root>', first, second };
    }
    const length = Math.max(first.length, second.length);
    for (let i = 0; i < length; i++) {
      if (!canonicalValuesMatch(first[i], second[i])) {
        return firstValueDiff(first[i], second[i], [...path, String(i)]);
      }
    }
    return { path: path.join('.') || '<root>', first, second };
  }
  const keys = new Set([...Object.keys(first), ...Object.keys(second)]);
  for (const key of [...keys].sort()) {
    const firstValue = (first as Record<string, unknown>)[key];
    const secondValue = (second as Record<string, unknown>)[key];
    if (!canonicalValuesMatch(firstValue, secondValue)) {
      return firstValueDiff(firstValue, secondValue, [...path, key]);
    }
  }
  return { path: path.join('.') || '<root>', first, second };
}

function canonicalValuesMatch(first: unknown, second: unknown): boolean {
  if (Object.is(first, second)) return true;
  return hashCanonicalValue(first) === hashCanonicalValue(second);
}

function requireCommander(core: ServerSimulationCore, playerId: PlayerId): Entity {
  const commander = core.world.getCommander(playerId);
  if (commander === undefined) {
    throw new Error(`[deterministic replay] missing commander for player ${playerId}`);
  }
  return commander;
}

function requireFirstEntity(
  core: ServerSimulationCore,
  predicate: (entity: Entity) => boolean,
  label: string,
): Entity {
  for (const entity of core.world.getAllEntities()) {
    if (predicate(entity)) return entity;
  }
  throw new Error(`[deterministic replay] missing ${label}`);
}

function assertHasEntity(
  core: ServerSimulationCore,
  predicate: (entity: Entity) => boolean,
  label: string,
): void {
  requireFirstEntity(core, predicate, label);
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
    [150, 90],
    [90, 150],
    [-150, 90],
    [90, -150],
  ];

  for (const [dx, dy] of candidateOffsets) {
    const x = builder.transform.x + dx;
    const y = builder.transform.y + dy;
    if (!construction.canPlaceAt(x, y, buildingBlueprintId)) continue;
    const snapped = grid.snapToGrid(x, y, config.placementGridWidth, config.placementGridHeight);
    const { gx, gy } = grid.worldToGrid(snapped.x, snapped.y);
    return { gridX: gx, gridY: gy };
  }
  throw new Error(`[deterministic replay] no placement found for ${buildingBlueprintId}`);
}

function createActiveFactoryNear(core: ServerSimulationCore, builder: Entity): Entity {
  const placement = requireBuildPlacement(core, builder, 'towerFabricator');
  const construction = core.simulation.getConstructionSystem();
  const factory = construction.startBuilding(
    core.world,
    'towerFabricator',
    placement.gridX,
    placement.gridY,
    builder.ownership?.playerId ?? (1 as PlayerId),
    builder.id,
    0,
    { skipBuilderAuthorization: true },
  );
  if (factory === null || factory.building === null) {
    throw new Error('[deterministic replay] failed to create factory fixture');
  }

  const buildable = factory.buildable;
  if (buildable !== null) {
    buildable.paid = { ...buildable.required };
    buildable.isComplete = true;
    buildable.healthBuildFraction = 1;
    factory.buildable = null;
  }
  factory.building.hp = factory.building.maxHp;
  const baseZ = factory.transform.z - factory.building.depth / 2;
  const body = core.physics.createBuildingBody(
    factory.transform.x,
    factory.transform.y,
    factory.building.width,
    factory.building.height,
    factory.building.depth,
    baseZ,
    factory.building.supportSurface,
    `building_${factory.id}`,
    factory.id,
  );
  factory.body = { physicsBody: body };
  return factory;
}

export function resetReusableSimulationStateForDeterministicReplay(): void {
  spatialGrid.clear();
  beamIndex.clear();
  economyManager.reset();
  resetProjectileBuffers();
  resetDamageBuffers();
  trimBuildingActiveStateBuffers();
  trimEnergyDistributionBuffers();
  trimEntitySnapshotPool();
  resetTerrainStateForDeterministicReplay();
  const sim = getSimWasm();
  if (sim !== undefined) {
    sim.combatTargeting.clear();
    sim.shieldSurfacePool.clear();
    sim.projectilePool.clear();
  }
}
