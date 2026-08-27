import { getAllUnitBlueprints } from './units';
import { getUnitLocomotion } from './index';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[water locomotion separation contract] ${message}`);
}

/** Focused contract for water hazard, waypoint intent, and physical movement.
 * It deliberately does not depend on presentation rigs or probe layouts. */
export function runWaterLocomotionSeparationContractTest(): void {
  for (const blueprint of getAllUnitBlueprints()) {
    const locomotion = getUnitLocomotion(blueprint.unitBlueprintId);
    const expectedDamage = locomotion.navigation.waypoint.allowInWater
      ? 0
      : blueprint.hp / 2;

    assertContract(
      locomotion.environmentalHazards.waterDamagePerSecond === expectedDamage,
      `${blueprint.unitBlueprintId} authors ${expectedDamage} water damage per second`,
    );
    // The land mirror: a hull whose waypoints are water-only (no ground, no
    // air) burns on dry ground at the same universal rate; everything that
    // may legitimately stand on ground or hover over it authors zero.
    const waterOnly = !locomotion.navigation.waypoint.allowOnGround &&
      !locomotion.navigation.waypoint.allowInAir;
    const expectedLandDamage = waterOnly ? blueprint.hp / 2 : 0;
    assertContract(
      locomotion.environmentalHazards.landDamagePerSecond === expectedLandDamage,
      `${blueprint.unitBlueprintId} authors ${expectedLandDamage} land damage per second`,
    );
    assertContract(
      locomotion.physics.water.maxPropulsiveForce > 0 &&
        locomotion.navigation.move.allowInWater,
      `${blueprint.unitBlueprintId} has positive water propulsion and move-valid water`,
    );
    assertContract(
      locomotion.navigation.move.allowOnGround ===
        (locomotion.physics.ground.maxPropulsiveForce > 0) &&
        locomotion.navigation.move.allowInAir ===
          (locomotion.physics.air.maxPropulsiveForce > 0) &&
        locomotion.navigation.move.allowInWater ===
          (locomotion.physics.water.maxPropulsiveForce > 0),
      `${blueprint.unitBlueprintId} derives move validity only from physical propulsion`,
    );
  }
}
