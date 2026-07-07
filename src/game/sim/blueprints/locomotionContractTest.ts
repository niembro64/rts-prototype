import type { LocomotionBlueprint } from './types';
import { createUnitLocomotion, cloneUnitLocomotion } from '../locomotion';
import { getUnitBlueprint, getUnitLocomotion } from './index';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[locomotion contract] ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  assertContract(
    Object.is(actual, expected),
    `${message}; expected ${String(expected)}, got ${String(actual)}`,
  );
}

function assertOwnsMediumTerm(
  medium: Record<string, unknown>,
  key: string,
  expected: number,
  messagePrefix: string,
): void {
  assertContract(
    Object.prototype.hasOwnProperty.call(medium, key),
    `${messagePrefix} must own ${key}`,
  );
  assertEqual(medium[key], expected, `${messagePrefix} ${key}`);
}

function cloneLocomotionBlueprint(locomotion: LocomotionBlueprint): LocomotionBlueprint {
  return JSON.parse(JSON.stringify(locomotion)) as LocomotionBlueprint;
}

function expectLocomotionError(
  blueprint: LocomotionBlueprint,
  expectedMessagePart: string,
): void {
  try {
    createUnitLocomotion(blueprint);
  } catch (err) {
    assertContract(
      err instanceof Error && err.message.includes(expectedMessagePart),
      `expected validation error containing "${expectedMessagePart}", got ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  throw new Error(`[locomotion contract] expected validation error containing "${expectedMessagePart}"`);
}

export function runLocomotionContractTest(): void {
  const hippoBlueprint = getUnitBlueprint('unitHippo');
  assertEqual(hippoBlueprint.supportSurface.kind, 'none', 'Hippo support surface');
  assertEqual(
    hippoBlueprint.locomotion.pathfindingBlueprintId,
    'amphibiousAnywhere',
    'Hippo authored pathfinding profile',
  );

  const hippoLocomotion = getUnitLocomotion('unitHippo');
  assertEqual(hippoLocomotion.pathfinding.pathfindingBlueprintId, 'amphibiousAnywhere', 'Hippo runtime pathfinding id');
  assertEqual(hippoLocomotion.pathfinding.terrainMode, 'anywhere', 'Hippo runtime terrain mode');
  assertEqual(hippoLocomotion.pathfinding.ignoreTerrainBlocking, true, 'Hippo ignores terrain blocking');
  assertEqual(hippoLocomotion.pathfinding.maxSlopeDeg, null, 'Hippo max slope');
  assertEqual(hippoLocomotion.pathfinding.minSurfaceNormalZ, 0, 'Hippo min surface normal');
  assertOwnsMediumTerm(hippoLocomotion.physics.water, 'force', 1200, 'runtime Hippo water');
  assertOwnsMediumTerm(hippoLocomotion.physics.water, 'traction', 0.5, 'runtime Hippo water');
  assertOwnsMediumTerm(hippoLocomotion.physics.water, 'friction', 1.5, 'runtime Hippo water');
  assertOwnsMediumTerm(hippoLocomotion.physics.water, 'heightUpwardForce', 12, 'runtime Hippo water');
  assertOwnsMediumTerm(
    hippoLocomotion.physics.water,
    'gravityCounterUpwardForceRatio',
    0.25,
    'runtime Hippo water',
  );
  assertEqual(hippoLocomotion.maintainFullThrustAtWaypoints, false, 'Hippo waypoint thrust mode');

  const clonedHippoLocomotion = cloneUnitLocomotion(hippoLocomotion);
  assertOwnsMediumTerm(clonedHippoLocomotion.physics.water, 'force', 1200, 'cloned Hippo water');
  assertOwnsMediumTerm(clonedHippoLocomotion.physics.water, 'traction', 0.5, 'cloned Hippo water');
  assertOwnsMediumTerm(clonedHippoLocomotion.physics.water, 'friction', 1.5, 'cloned Hippo water');
  assertOwnsMediumTerm(clonedHippoLocomotion.physics.water, 'heightUpwardForce', 12, 'cloned Hippo water');
  assertOwnsMediumTerm(
    clonedHippoLocomotion.physics.water,
    'gravityCounterUpwardForceRatio',
    0.25,
    'cloned Hippo water',
  );
  assertEqual(
    clonedHippoLocomotion.maintainFullThrustAtWaypoints,
    false,
    'cloned Hippo waypoint thrust mode',
  );

  const eagleLocomotion = getUnitLocomotion('unitEagle');
  assertEqual(eagleLocomotion.type, 'flying', 'Eagle locomotion type');
  assertEqual(eagleLocomotion.maintainFullThrustAtWaypoints, true, 'Eagle waypoint thrust mode');
  assertEqual(eagleLocomotion.airLiftGroundProbeAheadDistance, 5, 'Eagle air lift probe distance');
  assertEqual(
    eagleLocomotion.airLiftGroundProbeAheadRadiusMultiplier,
    1,
    'Eagle air lift probe radius multiplier',
  );
  assertEqual(
    cloneUnitLocomotion(eagleLocomotion).maintainFullThrustAtWaypoints,
    true,
    'cloned Eagle waypoint thrust mode',
  );
  assertEqual(
    cloneUnitLocomotion(eagleLocomotion).airLiftGroundProbeAheadDistance,
    5,
    'cloned Eagle air lift probe distance',
  );

  const nonAmphibiousLocomotion = getUnitLocomotion('unitJackal');
  for (const key of [
    'force',
    'traction',
    'friction',
    'heightUpwardForce',
    'gravityCounterUpwardForceRatio',
  ] as const) {
    assertOwnsMediumTerm(nonAmphibiousLocomotion.physics.water, key, 0, 'non-amphibious water');
    assertOwnsMediumTerm(
      cloneUnitLocomotion(nonAmphibiousLocomotion).physics.water,
      key,
      0,
      'cloned non-amphibious water',
    );
  }

  const seaTurtleLocomotion = getUnitLocomotion('unitSeaTurtle');
  const seaTurtleWaterDrive =
    seaTurtleLocomotion.physics.water.force * seaTurtleLocomotion.physics.water.traction;
  const seaTurtleGroundDrive =
    seaTurtleLocomotion.physics.ground.force * seaTurtleLocomotion.physics.ground.traction;
  assertContract(
    seaTurtleWaterDrive >= seaTurtleGroundDrive * 50,
    'Sea Turtle must be much stronger in water than on ground',
  );
  assertEqual(seaTurtleLocomotion.physics.water.force, 2700, 'Sea Turtle runtime water force');
  assertEqual(seaTurtleLocomotion.physics.ground.force, 140, 'Sea Turtle runtime ground force');
  assertEqual(
    seaTurtleLocomotion.airLiftGroundProbeAheadDistance,
    0,
    'Sea Turtle air lift probe distance',
  );

  const zeroWaterForce = cloneLocomotionBlueprint(hippoBlueprint.locomotion);
  zeroWaterForce.physics.water.force = 0;
  const zeroWaterRuntime = createUnitLocomotion(zeroWaterForce);
  assertOwnsMediumTerm(zeroWaterRuntime.physics.water, 'force', 0, 'zero-water Hippo water');

  const negativeWaterForce = cloneLocomotionBlueprint(hippoBlueprint.locomotion);
  negativeWaterForce.physics.water.force = -1;
  expectLocomotionError(negativeWaterForce, 'water.force');

  const invalidSwimCounter = cloneLocomotionBlueprint(hippoBlueprint.locomotion);
  invalidSwimCounter.physics.water.gravityCounterUpwardForceRatio = 1;
  expectLocomotionError(invalidSwimCounter, 'water.gravityCounterUpwardForceRatio');
}
