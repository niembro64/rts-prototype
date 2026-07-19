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
      preset.actuator.maxPropulsiveForce >= 0 &&
        preset.actuator.ground.staticFrictionCoefficient >= 0,
      `${presetId} declares one actuator force budget and static friction`,
    );
    for (const medium of ['air', 'water'] as const) {
      const fluid = preset.actuator[medium];
      assertContract(
        fluid.resistanceProfileId.length > 0,
        `${presetId}.${medium} declares one resistance profile`,
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
    seaTurtle.physics.water.lift.surfaceFollowingInverseForceFromGround > 0 &&
      seaTurtle.physics.water.lift.surfaceFollowingProportionalForceFromWater === 0 &&
      seaTurtle.physics.air.lift.surfaceFollowingInverseForceFromWater > 0,
    'Sea Turtle declares independent inverse bottom and proportional water-surface lift channels',
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
      orca.physics.water.lift.surfaceFollowingProportionalForceFromWater === 0,
    'Orca retains its inverse lakebed controller without an air surface swimmer controller',
  );
}
