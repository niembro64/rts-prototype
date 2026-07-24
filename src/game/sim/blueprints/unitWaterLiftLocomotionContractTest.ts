import { getUnitBlueprint, getUnitLocomotion } from './index';
import {
  UNIT_LOCOMOTION_SURFACE_FOLLOWING_RESPONSE_FIELDS,
  getUnitLocomotionPreset,
} from '../unitLocomotionPresetConfig';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[water lift locomotion contract] ${message}`);
}

export function runUnitWaterLiftLocomotionContractTest(): void {
  for (const presetId of ['flippers', 'submarine']) {
    const preset = getUnitLocomotionPreset(presetId);
    assertContract(
      preset.actuator.ground.staticFrictionCoefficient >= 0,
      `${presetId}.ground declares static friction`,
    );
    for (const medium of ['air', 'water'] as const) {
      const fluid = preset.actuator[medium];
      assertContract(
        fluid.linearDampingRate >= 0 &&
          fluid.angularDampingRate >= 0,
        `${presetId}.${medium} owns linear and angular damping`,
      );
      for (const field of UNIT_LOCOMOTION_SURFACE_FOLLOWING_RESPONSE_FIELDS) {
        assertContract(
          Object.prototype.hasOwnProperty.call(fluid.surfaceLiftResponse, field),
          `${presetId}.${medium}.surfaceLiftResponse owns ${field}`,
        );
      }
      assertContract(
        fluid.surfaceLiftResponse.randomizationAmount === 0 &&
          fluid.surfaceLiftResponse.ema === 0,
        `${presetId}.${medium} surface following has no randomization or EMA`,
      );
    }
  }

  const seaTurtle = getUnitLocomotion('unitSeaTurtle');
  assertContract(
    seaTurtle.physics.ground.maxPropulsiveForce >= seaTurtle.physics.water.maxPropulsiveForce * 2 &&
      seaTurtle.physics.ground.staticFrictionCoefficient >= 2 &&
      seaTurtle.physics.air.maxPropulsiveForce === 0 &&
      !seaTurtle.navigation.waypoint.allowInAir &&
      seaTurtle.physics.water.lift.surfaceFollowingInverseForceFromGround === 0 &&
      seaTurtle.physics.water.lift.surfaceFollowingProportionalForceFromWater === 0 &&
      seaTurtle.physics.air.lift.surfaceFollowingInverseForceFromWater === 0,
    'Sea Turtle keeps a high-grip ground actuator through the water-to-air transition without using a surface lift',
  );
  assertContract(
    getUnitBlueprint('unitSeaTurtle').radius.collision <
      getUnitBlueprint('unitSeaTurtle').radius.other * 1.5,
    'Sea Turtle collision envelope stays close to its physical body envelope',
  );

  const orca = getUnitLocomotion('unitOrca');
  assertContract(
    orca.physics.air.lift.surfaceFollowingInverseForceFromWater === 0 &&
      orca.physics.water.lift.surfaceFollowingInverseForceFromGround > 0 &&
      orca.physics.water.lift.surfaceFollowingProportionalForceFromWater === 0 &&
      orca.physics.water.resistance.linearDampingRate >= 3,
    'Orca retains its inverse lakebed controller and enough water drag to settle at waypoints',
  );
}
