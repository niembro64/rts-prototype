import { getUnitLocomotion } from './blueprints';
import { getAllUnitBlueprints } from './blueprints/units';
import { computeLocomotionClimbProfile } from './pathfindingMobility';
import { PATHFINDING_FORCE_SAFETY_RATIO } from './pathfindingTuning';
import { getSimWasm } from '../sim-wasm/init';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[pathfinding mobility contract] ${message}`);
}

function assertUnitInterval(value: number, label: string): void {
  assertContract(Number.isFinite(value) && value >= 0 && value <= 1, `${label} must be in [0, 1]`);
}

/** Verify that slope mobility is physics-derived while route domains remain
 * explicitly authored, immutable, and cached after authoritative WASM boots. */
export function runPathfindingMobilityContractTest(): void {
  assertContract(
    PATHFINDING_FORCE_SAFETY_RATIO === 0.85,
    'pathfinding must reserve 15% of authored propulsion and contact grip',
  );
  for (const blueprint of getAllUnitBlueprints()) {
    const locomotion = getUnitLocomotion(blueprint.unitBlueprintId);
    const first = computeLocomotionClimbProfile(locomotion, blueprint.mass);
    const second = computeLocomotionClimbProfile(locomotion, blueprint.mass);
    const label = blueprint.unitBlueprintId;

    assertContract(first === second, `${label} must reuse its cached derived profile`);
    assertContract(Object.isFrozen(first), `${label} cached profile must be immutable`);
    assertContract(first.cacheKey.length > 0, `${label} must expose a non-empty physics cache key`);
    assertContract(first.safeDriveAccel >= 0, `${label} safe drive acceleration must be non-negative`);
    assertContract(first.staticFrictionCoefficient >= 0, `${label} static friction must be non-negative`);

    if (first.allowOnGround) {
      assertContract(first.maxSlopeDeg !== null, `${label} must derive a dry-contact slope`);
      assertContract(first.minGroundNormalZ !== null, `${label} must derive a dry-contact normal`);
      assertContract(first.flatDriveAccel !== null && first.flatDriveAccel >= 0, `${label} must derive drive acceleration`);
      assertUnitInterval(first.minGroundNormalZ, `${label} dry-contact normal`);
      for (const [limitName, limit] of [
        ['drive', first.driveLimitedSlopeDeg],
        ['traction', first.tractionLimitedSlopeDeg],
      ] as const) {
        assertContract(
          limit !== null && first.maxSlopeDeg <= limit + 1e-9,
          `${label} dry-contact slope must respect its ${limitName} limit`,
        );
      }
    } else {
      assertContract(
        first.maxSlopeDeg === null && first.minGroundNormalZ === null,
        `${label} without ground drive must not invent a dry-contact envelope`,
      );
    }

    if (first.allowInWater && !first.allowInAir && first.allowOnGround && !first.waterSurfaceSupported) {
      assertContract(first.maxWaterMoveSlopeDeg !== null, `${label} bed-walking water MOVE must derive a slope`);
      assertContract(first.minWaterMoveNormalZ !== null, `${label} bed-walking water MOVE must derive a normal`);
      assertContract(first.maxWaterWaypointSlopeDeg !== null, `${label} bed-walking water WAYPOINT must derive a hold slope`);
      assertContract(first.minWaterWaypointNormalZ !== null, `${label} bed-walking water WAYPOINT must derive a hold normal`);
      assertUnitInterval(first.minWaterMoveNormalZ, `${label} water-MOVE contact normal`);
      assertUnitInterval(first.minWaterWaypointNormalZ, `${label} water-WAYPOINT contact normal`);
      assertContract(
        first.maxWaterMoveSlopeDeg + 1e-9 >= first.maxWaterWaypointSlopeDeg,
        `${label} commanded wet propulsion cannot reduce its resting support envelope`,
      );
    } else {
      assertContract(
        first.minWaterMoveNormalZ === null && first.minWaterWaypointNormalZ === null,
        `${label} fluid-supported or air-capable water must not inherit a lakebed slope ceiling`,
      );
    }
  }

  const hippoBlueprint = getAllUnitBlueprints().find(
    (blueprint) => blueprint.unitBlueprintId === 'unitHippo',
  );
  if (hippoBlueprint === undefined) {
    throw new Error('[pathfinding mobility contract] Hippo blueprint is missing');
  }
  const hippoLocomotion = getUnitLocomotion(hippoBlueprint.unitBlueprintId);
  const hippoClimb = computeLocomotionClimbProfile(
    hippoLocomotion,
    hippoBlueprint.mass,
  );
  const hippoAuthoredGrip = hippoLocomotion.physics.ground.staticFrictionCoefficient;
  const expectedHippoGripSlope =
    Math.atan(hippoAuthoredGrip * PATHFINDING_FORCE_SAFETY_RATIO) * 180 / Math.PI;
  assertContract(
    hippoClimb.maxSlopeDeg !== null &&
      Math.abs(hippoClimb.maxSlopeDeg - expectedHippoGripSlope) < 1e-9,
    'Hippo maximum slope must reserve uphill authority from its grip-limited angle',
  );
  assertContract(
    hippoClimb.maxSlopeDeg <
      Math.atan(hippoAuthoredGrip) * 180 / Math.PI,
    'Hippo must not advertise the zero-margin angle where grip can only hold position',
  );

  const seaTurtleBlueprint = getAllUnitBlueprints().find(
    (blueprint) => blueprint.unitBlueprintId === 'unitSeaTurtle',
  );
  if (seaTurtleBlueprint === undefined) {
    throw new Error('[pathfinding mobility contract] Sea Turtle blueprint is missing');
  }
  const seaTurtleLocomotion = getUnitLocomotion(seaTurtleBlueprint.unitBlueprintId);
  const seaTurtleClimb = computeLocomotionClimbProfile(
    seaTurtleLocomotion,
    seaTurtleBlueprint.mass,
  );
  assertContract(
    seaTurtleClimb.allowOnGround &&
      seaTurtleClimb.allowInWater &&
      seaTurtleClimb.maxSlopeDeg !== null &&
      seaTurtleClimb.maxSlopeDeg >= 55,
    'Sea Turtle remains amphibious and has enough supported ground force to climb a steep beach from the water',
  );
  assertContract(
    seaTurtleLocomotion.physics.ground.tangentialDampingRate >
      seaTurtleLocomotion.physics.water.resistance.linearDampingRate,
    'Sea Turtle has stronger dry-land damping than underwater drag, keeping its land pace slow',
  );

  const commanderBlueprint = getAllUnitBlueprints().find(
    (blueprint) => blueprint.unitBlueprintId === 'unitCommander',
  );
  if (commanderBlueprint === undefined) {
    throw new Error('[pathfinding mobility contract] Commander blueprint is missing');
  }
  const commander = computeLocomotionClimbProfile(
    getUnitLocomotion(commanderBlueprint.unitBlueprintId),
    commanderBlueprint.mass,
  );
  assertContract(
    commander.maxWaterMoveSlopeDeg !== null && commander.maxWaterMoveSlopeDeg > 70,
    'a sufficiently powerful bed-walking water actuator must exceed the removed 70-degree global ceiling',
  );
  assertContract(
    commander.maxWaterWaypointSlopeDeg !== null &&
      commander.maxWaterMoveSlopeDeg > commander.maxWaterWaypointSlopeDeg,
    'commanded water thrust may traverse a wet slope that cannot be selected as an unpowered resting waypoint',
  );

  const sim = getSimWasm();
  if (sim === undefined) throw new Error('[pathfinding mobility contract] sim-wasm is not initialized');
  const light = new Float64Array(12);
  const heavy = new Float64Array(12);
  const args = [0.5, 0.4, 1, 300, PATHFINDING_FORCE_SAFETY_RATIO] as const;
  assertContract(
    sim.pathfinder.computeLocomotionClimbProfile(
      args[0], args[1], args[2], 1_000, args[3], args[4], true, true, false, false, light,
    ) === 1 &&
    sim.pathfinder.computeLocomotionClimbProfile(
      args[0], args[1], args[2], 10_000, args[3], args[4], true, true, false, false, heavy,
    ) === 1,
    'synthetic mass probes must be accepted',
  );
  assertContract(
    light[0] > heavy[0] && light[6] > heavy[6],
    'the same dry and water actuators must support less slope as physical mass increases',
  );
}
