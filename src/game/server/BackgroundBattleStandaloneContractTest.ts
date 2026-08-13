import type { PlayerId } from '../sim/types';
import { WorldState } from '../sim/WorldState';
import { initSimWasm } from '../sim-wasm/init';
import { getNormalizedUnitCost, getUnitBlueprint } from '../sim/blueprints';
import type { PhysicsEngine3D } from './PhysicsEngine3D';
import {
  BACKGROUND_UNIT_BLUEPRINT_IDS,
  spawnBackgroundUnitsStandalone,
} from './BackgroundBattleStandalone';

function assertContract(condition: boolean, message: string): void {
  if (!condition) throw new Error(`background battle standalone contract: ${message}`);
}

/** The spawn planner only needs the body coordinates, velocity slots, and
 * surface-normal view. Keeping this harness pool-free makes the CAP contract
 * runnable without booting the renderer or WASM physics worker. */
function createPhysicsHarness(): PhysicsEngine3D {
  return {
    // The spawn path checks pool headroom before creating bodies; the
    // harness pool is unbounded, so it always has room.
    hasBodyPoolHeadroom: () => true,
    createUnitBody(
      x: number,
      y: number,
      _radius: number,
      _groundOffset: number,
      _supportSurface: unknown,
      _mass: number,
      _label: string,
      _entityId: number,
      z: number | undefined,
    ) {
      const surfaceNormal = { nx: 0, ny: 0, nz: 1 };
      return {
        x,
        y,
        z: z ?? 0,
        vx: 0,
        vy: 0,
        vz: 0,
        createSurfaceNormalView: () => surfaceNormal,
      };
    },
  } as unknown as PhysicsEngine3D;
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
  weightedWorld.maxTotalUnits = 3;
  const cheaperComesFirst = BACKGROUND_UNIT_BLUEPRINT_IDS.indexOf(cheaperUnitBlueprintId) <
    BACKGROUND_UNIT_BLUEPRINT_IDS.indexOf(expensiveUnitBlueprintId);
  const boundary = cheaperComesFirst ? 2 / 3 : 1 / 3;
  const cheaperIntervalMidpoint = cheaperComesFirst ? boundary / 2 : (boundary + 1) / 2;
  const weightedRandomValues = [
    boundary - 0.001, 0.1, 0.1,
    boundary + 0.001, 0.2, 0.2,
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

  const playerIds = [1, 2, 3, 4, 5, 6] as PlayerId[];
  const world = new WorldState(0x12345678, 6400, 6400);
  world.playerCount = playerIds.length;
  world.maxTotalUnits = 9;

  assertContract(
    world.getUnitCapPerPlayer() === 9,
    'CAP 9 was diluted by the six-player seat count',
  );

  const spawned = spawnBackgroundUnitsStandalone(
    world,
    createPhysicsHarness(),
    true,
    new Set(BACKGROUND_UNIT_BLUEPRINT_IDS),
    playerIds,
  );
  assertContract(
    spawned.length === playerIds.length * 9,
    `CAP 9 spawned ${spawned.length} opening units instead of 54`,
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
  for (const playerId of playerIds) {
    assertContract(
      countByPlayer.get(playerId) === 9,
      `player ${playerId} did not receive exactly nine opening units`,
    );
  }
  assertContract(spawnedBlueprintIds.size > 1, 'opening unit roster was not randomized');
  assertContract(spawnedPositions.size > 1, 'opening unit positions were not randomized');
}
