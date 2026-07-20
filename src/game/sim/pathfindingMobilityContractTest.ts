import { getUnitLocomotion } from './blueprints';
import { getAllUnitBlueprints } from './blueprints/units';
import { computeLocomotionClimbProfile } from './pathfindingMobility';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[pathfinding mobility contract] ${message}`);
}

function assertUnitInterval(value: number, label: string): void {
  assertContract(Number.isFinite(value) && value >= 0 && value <= 1, `${label} must be in [0, 1]`);
}

/** Verify that slope mobility is physics-derived while route domains remain
 * explicitly authored, immutable, and cached after authoritative WASM boots. */
export function runPathfindingMobilityContractTest(): void {
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

    if (first.allowInAir || !first.allowOnGround) {
      assertContract(first.minStandstillNormalZ === null, `${label} bypasses dry-ground standstill gating`);
      assertContract(first.minClimbNormalZ === null, `${label} bypasses dry-ground climb gating`);
      continue;
    }

    assertContract(first.maxSlopeDeg !== null, `${label} must derive a standstill slope`);
    assertContract(first.minStandstillNormalZ !== null, `${label} must derive a standstill normal`);
    assertContract(first.minClimbNormalZ !== null, `${label} must derive a climb normal`);
    assertContract(first.flatDriveAccel !== null && first.flatDriveAccel >= 0, `${label} must derive drive acceleration`);
    assertUnitInterval(first.minStandstillNormalZ, `${label} standstill normal`);
    assertUnitInterval(first.minClimbNormalZ, `${label} climb normal`);
    assertContract(
      first.minClimbNormalZ + 1e-12 >= first.minStandstillNormalZ,
      `${label} uphill climb envelope cannot be looser than standstill`,
    );
    for (const [limitName, limit] of [
      ['drive', first.driveLimitedSlopeDeg],
      ['traction', first.tractionLimitedSlopeDeg],
      ['stability', first.stabilityLimitedSlopeDeg],
    ] as const) {
      assertContract(
        limit !== null && first.maxSlopeDeg <= limit + 1e-9,
        `${label} standstill slope must respect its ${limitName} limit`,
      );
    }
  }

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
      seaTurtleClimb.maxSlopeDeg >= 30,
    'Sea Turtle remains amphibious and can climb a steep beach from the water',
  );
  assertContract(
    seaTurtleLocomotion.physics.ground.tangentialDampingRate >
      seaTurtleLocomotion.physics.water.resistance.linearDampingRate,
    'Sea Turtle has stronger dry-land damping than underwater drag, keeping its land pace slow',
  );
}
