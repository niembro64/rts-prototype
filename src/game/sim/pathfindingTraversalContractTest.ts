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
    applyLiquidHazardPathPolicy(amphibious, 'water', 0) === amphibious,
    'ordinary water preserves the exact physical mobility profile',
  );
  assertContract(
    applyLiquidHazardPathPolicy(amphibious, 'water', 50) === amphibious,
    'a body whose intentional media include water keeps its water MOVE domain even with damage authored',
  );
  const landWithTokenSwim = {
    ...amphibious,
    navigation: {
      waypoint: { allowOnGround: true, allowInWater: false, allowInAir: false },
      move: { allowOnGround: true, allowInWater: true, allowInAir: false },
    },
  };
  const lethal = applyLiquidHazardPathPolicy(landWithTokenSwim, 'water', 50);
  assertContract(
    lethal !== null &&
      lethal.navigation.move.allowInWater === false &&
      lethal.navigation.waypoint.allowOnGround === true,
    'a land body that takes water damage must not plan through deep water it cannot survive',
  );
  assertContract(
    applyLiquidHazardPathPolicy(landWithTokenSwim, 'water', 0) === landWithTokenSwim,
    'without water damage the physical recovery domain is kept',
  );
  const lava = applyLiquidHazardPathPolicy(amphibious, 'lava', 0);
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
