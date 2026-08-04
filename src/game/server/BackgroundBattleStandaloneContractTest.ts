import type { PlayerId } from '../sim/types';
import { WorldState } from '../sim/WorldState';
import { initSimWasm } from '../sim-wasm/init';
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
