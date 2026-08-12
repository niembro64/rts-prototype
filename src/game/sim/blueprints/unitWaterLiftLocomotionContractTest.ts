import { getUnitBlueprint, getUnitLocomotion } from './index';
import {
  UNIT_LOCOMOTION_SURFACE_FOLLOWING_RESPONSE_FIELDS,
  getUnitLocomotionPreset,
} from '../unitLocomotionPresetConfig';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[water lift locomotion contract] ${message}`);
}

export function runUnitWaterLiftLocomotionContractTest(): void {
  for (const presetId of ['amphibian', 'submarine']) {
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
      !seaTurtle.navigation.waypoint.allowInAir,
    'Sea Turtle keeps a high-grip ground actuator and never propels itself through air',
  );
  // The flipper rig swims by standing off the seabed, not by riding the water
  // surface: ae2895b8 ("turtle good") authored a ground-referenced standoff
  // lift in water on purpose. What must stay absent is a WATER-referenced lift
  // -- that is the surface-riding channel the flippers profile does not use --
  // and any airborne lift at all.
  assertContract(
    seaTurtle.physics.water.lift.surfaceFollowingInverseForceFromGround > 0 &&
      seaTurtle.physics.water.lift.surfaceFollowingProportionalForceFromWater === 0 &&
      seaTurtle.physics.air.lift.surfaceFollowingInverseForceFromWater === 0,
    'Sea Turtle follows the seabed with a ground-referenced standoff lift and takes no water-referenced or airborne lift',
  );
  assertContract(
    getUnitBlueprint('unitSeaTurtle').radius.collision <
      getUnitBlueprint('unitSeaTurtle').radius.other * 1.5,
    'Sea Turtle collision envelope stays close to its physical body envelope',
  );

  const orca = getUnitLocomotion('unitOrca');
  // Both submarine hulls carry a tiny water-referenced trim (0.01) alongside a
  // lakebed force three orders of magnitude larger. The rule is that the
  // lakebed controller is what flies the hull -- a submarine that starts
  // RIDING the surface would show a water term in the same league as the
  // ground one -- not that the trim is exactly zero.
  assertContract(
    orca.physics.air.lift.surfaceFollowingInverseForceFromWater === 0 &&
      orca.physics.water.lift.surfaceFollowingInverseForceFromGround > 0 &&
      orca.physics.water.lift.surfaceFollowingProportionalForceFromWater * 1000 <
        orca.physics.water.lift.surfaceFollowingInverseForceFromGround &&
      orca.physics.water.resistance.linearDampingRate >= 3,
    'Orca retains its inverse lakebed controller and enough water drag to settle at waypoints',
  );
}
