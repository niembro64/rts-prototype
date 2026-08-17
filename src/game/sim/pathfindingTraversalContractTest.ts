import {
  applyLiquidHazardPathPolicy,
  type PathTerrainFilter,
} from './pathfindingTraversal';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[path traversal contract] ${message}`);
}

export function runPathfindingTraversalContractTest(): void {
  const amphibious: PathTerrainFilter = {
    navigation: {
      waypoint: { allowOnGround: true, allowInWater: true, allowInAir: false },
      move: { allowOnGround: true, allowInWater: true, allowInAir: false },
    },
    minGroundNormalZ: 0.5,
    waterSurfaceSupported: false,
    supportPointOffsetZ: 10,
    cost: {
      flatDriveAccel: 1,
      safeDriveAccel: 0.85,
      flatWaterContactAccel: 2,
      safeWaterDriveAccel: 1,
      staticFrictionCoefficient: 1,
    },
  };
  assertContract(
    applyLiquidHazardPathPolicy(amphibious, 'water') === amphibious,
    'ordinary water preserves the exact physical mobility profile',
  );
  const lava = applyLiquidHazardPathPolicy(amphibious, 'lava');
  assertContract(lava !== null, 'lava policy preserves a non-null profile');
  assertContract(
    lava.navigation.waypoint.allowInWater === false &&
      lava.navigation.move.allowInWater === false,
    'lava is forbidden for both intentional waypoints and physical recovery routes',
  );
  assertContract(
    amphibious.navigation.waypoint.allowInWater && amphibious.navigation.move.allowInWater,
    'hazard policy never mutates the immutable physical profile',
  );
}
