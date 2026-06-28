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

function assertOwnsWaterTerm(
  locomotion: Record<string, unknown>,
  key: string,
  expected: number,
): void {
  assertContract(
    Object.prototype.hasOwnProperty.call(locomotion, key),
    `runtime Hippo locomotion must preserve authored ${key}`,
  );
  assertEqual(locomotion[key], expected, `runtime Hippo ${key}`);
}

function assertOmitsWaterTerm(locomotion: Record<string, unknown>, key: string): void {
  assertContract(
    !Object.prototype.hasOwnProperty.call(locomotion, key),
    `non-amphibious locomotion must omit unauthored ${key}`,
  );
}

function cloneLocomotionBlueprint(locomotion: LocomotionBlueprint): LocomotionBlueprint {
  return {
    ...locomotion,
    physics: { ...locomotion.physics },
    pathfinding: { ...locomotion.pathfinding },
    config: { ...locomotion.config },
  } as LocomotionBlueprint;
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
  assertOwnsWaterTerm(hippoLocomotion, 'waterForce', 1200);
  assertOwnsWaterTerm(hippoLocomotion, 'waterTraction', 0.5);
  assertOwnsWaterTerm(hippoLocomotion, 'waterFriction', 1.5);
  assertOwnsWaterTerm(hippoLocomotion, 'swimHeightUpwardForce', 12);
  assertOwnsWaterTerm(hippoLocomotion, 'swimGravityCounterUpwardForceRatio', 0.25);

  const clonedHippoLocomotion = cloneUnitLocomotion(hippoLocomotion);
  assertOwnsWaterTerm(clonedHippoLocomotion, 'waterForce', 1200);
  assertOwnsWaterTerm(clonedHippoLocomotion, 'waterTraction', 0.5);
  assertOwnsWaterTerm(clonedHippoLocomotion, 'waterFriction', 1.5);
  assertOwnsWaterTerm(clonedHippoLocomotion, 'swimHeightUpwardForce', 12);
  assertOwnsWaterTerm(clonedHippoLocomotion, 'swimGravityCounterUpwardForceRatio', 0.25);

  const nonAmphibiousLocomotion = getUnitLocomotion('unitJackal');
  for (const key of [
    'waterForce',
    'waterTraction',
    'waterFriction',
    'swimHeightUpwardForce',
    'swimGravityCounterUpwardForceRatio',
  ]) {
    assertOmitsWaterTerm(nonAmphibiousLocomotion, key);
    assertOmitsWaterTerm(cloneUnitLocomotion(nonAmphibiousLocomotion), key);
  }

  const zeroWaterForce = cloneLocomotionBlueprint(hippoBlueprint.locomotion);
  zeroWaterForce.physics.waterForce = 0;
  const zeroWaterRuntime = createUnitLocomotion(zeroWaterForce);
  assertOwnsWaterTerm(zeroWaterRuntime, 'waterForce', 0);

  const negativeWaterForce = cloneLocomotionBlueprint(hippoBlueprint.locomotion);
  negativeWaterForce.physics.waterForce = -1;
  expectLocomotionError(negativeWaterForce, 'waterForce');

  const invalidSwimCounter = cloneLocomotionBlueprint(hippoBlueprint.locomotion);
  invalidSwimCounter.physics.swimGravityCounterUpwardForceRatio = 1;
  expectLocomotionError(invalidSwimCounter, 'swimGravityCounterUpwardForceRatio');
}
