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
      preset.actuator.ground.maxPropulsiveForce >= 0 &&
        preset.actuator.ground.staticFrictionCoefficient >= 0,
      `${presetId} declares direct ground force and static friction`,
    );
    for (const medium of ['air', 'water'] as const) {
      const fluid = preset.actuator[medium];
      assertContract(
        fluid.maxPropulsiveForce >= 0 && fluid.resistanceProfileId.length > 0,
        `${presetId}.${medium} declares direct propulsion and one resistance profile`,
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
    seaTurtle.physics.water.lift.buoyancyRatio === 1 &&
      seaTurtle.physics.water.lift.surfaceFollowingForceFromGround > 0 &&
      seaTurtle.physics.air.lift.surfaceFollowingForceFromWater > 0,
    'Sea Turtle holds the waterline with explicit buoyancy and surface-following forces',
  );
  assertContract(
    getUnitBlueprint('unitSeaTurtle').radius.collision <
      getUnitBlueprint('unitSeaTurtle').radius.other * 1.5,
    'Sea Turtle collision envelope stays close to its physical body envelope',
  );

  const orca = getUnitLocomotion('unitOrca');
  assertContract(
    orca.physics.air.lift.surfaceFollowingForceFromWater === 0 &&
      orca.physics.water.lift.buoyancyRatio > 0 &&
      orca.physics.water.lift.buoyancyRatio < 1,
    'Orca retains submerged buoyancy without inheriting the surface-swimmer controller',
  );
}
