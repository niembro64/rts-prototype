import type { PlayerId } from '../sim/types';
import { WorldState } from '../sim/WorldState';
import { buildTeamRosterFromSeatCounts } from '../sim/teamRoster';
import { initSimWasm } from '../sim-wasm/init';
import { getNormalizedUnitCost, getUnitBlueprint } from '../sim/blueprints';
import { createPhysicsHarness } from './poolFreePhysicsHarness';
import {
  BACKGROUND_UNIT_BLUEPRINT_IDS,
  spawnBackgroundUnitsStandalone,
} from './BackgroundBattleStandalone';

function assertContract(condition: boolean, message: string): void {
  if (!condition) throw new Error(`background battle standalone contract: ${message}`);
}

export async function runBackgroundBattleStandaloneContractTest(): Promise<void> {
  await initSimWasm();

  // These two authored prices are exactly 2:1, so inverse-cost weighting gives
  // the cheaper unit exactly two thirds of their combined selection interval.
  const cheaperUnitBlueprintId = 'unitConstructionDrone';
  const expensiveUnitBlueprintId = 'unitDaddy';
  const cheaperCost = getNormalizedUnitCost(getUnitBlueprint(cheaperUnitBlueprintId));
  const expensiveCost = getNormalizedUnitCost(getUnitBlueprint(expensiveUnitBlueprintId));
  assertContract(
    Math.abs(expensiveCost - cheaperCost * 2) < Number.EPSILON,
    'inverse-cost opening-wave fixture no longer has a 2:1 price ratio',
  );

  const weightedWorld = new WorldState(0x2468ace0, 6400, 6400);
  const weightedPlayerIds = [1] as PlayerId[];
  weightedWorld.playerCount = weightedPlayerIds.length;
  weightedWorld.entityCountCap = 3;
  const cheaperComesFirst = BACKGROUND_UNIT_BLUEPRINT_IDS.indexOf(cheaperUnitBlueprintId) <
    BACKGROUND_UNIT_BLUEPRINT_IDS.indexOf(expensiveUnitBlueprintId);
  const boundary = cheaperComesFirst ? 2 / 3 : 1 / 3;
  const cheaperIntervalMidpoint = cheaperComesFirst ? boundary / 2 : (boundary + 1) / 2;
  const weightedRandomValues = [
    0.1, 0.1,
    0.2, 0.2,
    cheaperIntervalMidpoint, 0.3, 0.3,
  ];
  weightedWorld.nextRandom = () => {
    const value = weightedRandomValues.shift();
    if (value === undefined) {
      throw new Error('background battle standalone contract: weighted spawn consumed extra RNG');
    }
    return value;
  };
  const weightedSpawn = spawnBackgroundUnitsStandalone(
    weightedWorld,
    createPhysicsHarness(),
    true,
    new Set([cheaperUnitBlueprintId, expensiveUnitBlueprintId]),
    weightedPlayerIds,
  );
  const weightedBlueprintIds = weightedSpawn.map((entity) => entity.unit?.unitBlueprintId);
  const cheaperSpawnCount = weightedBlueprintIds.filter(
    (unitBlueprintId) => unitBlueprintId === cheaperUnitBlueprintId,
  ).length;
  const expensiveSpawnCount = weightedBlueprintIds.filter(
    (unitBlueprintId) => unitBlueprintId === expensiveUnitBlueprintId,
  ).length;
  assertContract(
    cheaperSpawnCount === 2 && expensiveSpawnCount === 1,
    `2:1 inverse-cost opening interval selected ${weightedBlueprintIds.join(',')}`,
  );

  // Actual-unit visibility regression: when capacity can hold the enabled
  // roster, the opening wave must instantiate every blueprint at least once.
  // A factory queue alone is not sufficient evidence that a new unit appears
  // in Demo.
  const coverageWorld = new WorldState(0x2468ace1, 6400, 6400);
  coverageWorld.playerCount = 1;
  coverageWorld.entityCountCap = BACKGROUND_UNIT_BLUEPRINT_IDS.length;
  const coverageSpawn = spawnBackgroundUnitsStandalone(
    coverageWorld,
    createPhysicsHarness(),
    true,
    new Set(BACKGROUND_UNIT_BLUEPRINT_IDS),
    [1] as PlayerId[],
  );
  const coverageIds = new Set(
    coverageSpawn.map((entity) => entity.unit?.unitBlueprintId),
  );
  const missingCoverage = BACKGROUND_UNIT_BLUEPRINT_IDS.filter(
    (unitBlueprintId) => !coverageIds.has(unitBlueprintId),
  );
  assertContract(
    coverageSpawn.length === BACKGROUND_UNIT_BLUEPRINT_IDS.length &&
      missingCoverage.length === 0,
    `opening Demo wave must instantiate every enabled unit; missing ${missingCoverage.join(', ')}`,
  );

  // ── Entity count cap: a MATCH TOTAL, split across SEATED sides ──
  // 6 seats on 3 sides, plus a declared-but-empty 4th side. The empty side
  // gets a terrain slice but must not eat a quarter of the cap, so 60
  // divides by 3, not 4: 20 per side, shared by that side's 2 seats.
  const playerIds = [1, 2, 3, 4, 5, 6] as PlayerId[];
  const world = new WorldState(0x12345678, 6400, 6400);
  world.playerCount = playerIds.length;
  world.setTeamRoster(buildTeamRosterFromSeatCounts(playerIds, [2, 2, 0, 2]));
  world.entityCountCap = 60;

  assertContract(
    world.getTeamEntityCountCap() === 20,
    `cap 60 over 3 seated sides must give 20 per side, got ${world.getTeamEntityCountCap()}`,
  );
  assertContract(
    world.getTeamEntityCount(1 as PlayerId) === 0,
    'an empty world must report zero entities on every side',
  );

  const spawned = spawnBackgroundUnitsStandalone(
    world,
    createPhysicsHarness(),
    true,
    new Set(BACKGROUND_UNIT_BLUEPRINT_IDS),
    playerIds,
  );
  assertContract(
    spawned.length === 60,
    `cap 60 spawned ${spawned.length} opening units instead of 60`,
  );

  const countByPlayer = new Map<PlayerId, number>();
  const spawnedBlueprintIds = new Set<string>();
  const spawnedPositions = new Set<string>();
  for (const entity of spawned) {
    const playerId = entity.ownership?.playerId;
    const unitBlueprintId = entity.unit?.unitBlueprintId;
    if (playerId === undefined) {
      throw new Error('background battle standalone contract: opening unit had no player owner');
    }
    if (unitBlueprintId === undefined) {
      throw new Error('background battle standalone contract: opening entity was not a unit');
    }
    countByPlayer.set(playerId, (countByPlayer.get(playerId) ?? 0) + 1);
    spawnedBlueprintIds.add(unitBlueprintId);
    spawnedPositions.add(`${entity.transform.x},${entity.transform.y}`);
  }
  // A side's pool is split across its own seats, so 20 over 2 seats is 10
  // each — the seat count must not change how much a SIDE fields.
  for (const playerId of playerIds) {
    assertContract(
      countByPlayer.get(playerId) === 10,
      `player ${playerId} received ${countByPlayer.get(playerId)} opening units instead of 10`,
    );
  }
  for (const seat of [1, 3, 5] as PlayerId[]) {
    assertContract(
      world.getTeamEntityCount(seat) === 20,
      `side of seat ${seat} must hold its full 20-entity share`,
    );
    assertContract(
      world.getRemainingTeamEntityCapacity(seat) === 0 &&
        !world.canPlayerBuildEntity(seat),
      `side of seat ${seat} must be full at its team cap`,
    );
  }

  // A lone seat opposite a crowded side fields the SAME army: sides split
  // the cap, seats never do.
  const unevenWorld = new WorldState(0x13572468, 6400, 6400);
  unevenWorld.playerCount = 4;
  unevenWorld.setTeamRoster(
    buildTeamRosterFromSeatCounts([1, 2, 3, 4] as PlayerId[], [1, 3]),
  );
  unevenWorld.entityCountCap = 100;
  assertContract(
    unevenWorld.getTeamEntityCountCap() === 50,
    'a 1v3 must split the cap in half, not four ways',
  );

  assertContract(spawnedBlueprintIds.size > 1, 'opening unit roster was not randomized');
  assertContract(spawnedPositions.size > 1, 'opening unit positions were not randomized');
}
