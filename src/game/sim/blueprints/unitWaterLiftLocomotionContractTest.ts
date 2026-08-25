import { getUnitBlueprint, getUnitLocomotion } from './index';
import {
  UNIT_LOCOMOTION_SURFACE_FOLLOWING_RESPONSE_FIELDS,
  getUnitLocomotionPreset,
} from '../unitLocomotionPresetConfig';
import {
  airSurfaceLiftMediumIsActive,
  getLocomotionSupportPointZ,
  getSurfaceLiftInverseDistanceToSurfaceWorld,
  getSurfaceLiftWaterDepthWorld,
} from '../surfaceLiftDistanceResponse';
import { WATER_LEVEL } from '../Terrain';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[water lift locomotion contract] ${message}`);
}

export function runUnitWaterLiftLocomotionContractTest(): void {
  const supportZ = getLocomotionSupportPointZ(WATER_LEVEL + 32, 12);
  assertContract(
    supportZ === WATER_LEVEL + 20 &&
      getSurfaceLiftInverseDistanceToSurfaceWorld(supportZ, WATER_LEVEL) === 20 &&
      getSurfaceLiftWaterDepthWorld(getLocomotionSupportPointZ(WATER_LEVEL - 20, 12)) === 32,
    'all surface distances use body center minus support-point offset as the locomotion datum',
  );
  assertContract(
    airSurfaceLiftMediumIsActive(WATER_LEVEL + 1, 0.49, WATER_LEVEL) &&
      !airSurfaceLiftMediumIsActive(WATER_LEVEL, 0.5, WATER_LEVEL) &&
      !airSurfaceLiftMediumIsActive(WATER_LEVEL - 1, 0.51, WATER_LEVEL),
    'air surface lift may recover a partly immersed body only while its origin remains above water',
  );

  for (const presetId of ['amphibian', 'amphibious-crawler', 'submarine']) {
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

  const waterStrider = getUnitLocomotion('unitWaterStrider');
  const waterStriderForwardForces = [
    waterStrider.physics.ground.maxPropulsiveForce,
    waterStrider.physics.air.maxPropulsiveForce,
    waterStrider.physics.water.maxPropulsiveForce,
  ];
  const weakestForwardForce = Math.min(...waterStriderForwardForces);
  const strongestForwardForce = Math.max(...waterStriderForwardForces);
  const weakestWaterLift = Math.min(
    waterStrider.physics.water.lift.surfaceFollowingInverseForceFromGround,
    waterStrider.physics.water.lift.surfaceFollowingProportionalForceFromWater,
  );
  assertContract(
    waterStrider.type === 'crawler' &&
      waterStrider.physics.air.lift.surfaceFollowingInverseForceFromGround === 0 &&
      waterStrider.physics.air.lift.surfaceFollowingInverseForceFromWater === 0 &&
      weakestForwardForce > 0 &&
      strongestForwardForce / weakestForwardForce <= 1.5 &&
      weakestWaterLift >= strongestForwardForce * 3 &&
      waterStrider.navigation.waypoint.allowOnGround &&
      waterStrider.navigation.waypoint.allowInWater &&
      !waterStrider.navigation.waypoint.allowInAir &&
      !waterStrider.motionControl.cruiseWhenUncommanded &&
      !waterStrider.motionControl.maintainFullThrustAtWaypoints,
    'Water Strider has no air lift, high water lift, balanced per-medium propulsion, and no airborne routing',
  );

  const patrolCorvette = getUnitLocomotion('unitPatrolCorvette');
  assertContract(
    patrolCorvette.physics.ground.maxPropulsiveForce === 0 &&
      patrolCorvette.physics.air.lift.surfaceFollowingInverseForceFromGround === 0 &&
      patrolCorvette.physics.air.lift.surfaceFollowingInverseForceFromWater === 0 &&
      patrolCorvette.physics.water.lift.surfaceFollowingProportionalForceFromWater > 0 &&
      patrolCorvette.physics.water.lift.surfaceFollowingInverseForceFromGround === 0 &&
      !patrolCorvette.navigation.waypoint.allowOnGround &&
      patrolCorvette.navigation.waypoint.allowInWater &&
      !patrolCorvette.navigation.waypoint.allowInAir &&
      !patrolCorvette.motionControl.cruiseWhenUncommanded,
    'Patrol Corvette falls freely through air, then rides the surface using only its in-water lift channel',
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
    'Orca retains its inverse lakebed controller and enough water damping to settle at waypoints',
  );

  const cuttlefishBlueprint = getUnitBlueprint('unitStealthScout');
  const cuttlefish = getUnitLocomotion('unitStealthScout');
  assertContract(
    cuttlefishBlueprint.requiresWater && !cuttlefishBlueprint.requiresLand &&
      cuttlefish.physics.ground.maxPropulsiveForce === 0 &&
      cuttlefish.physics.air.maxPropulsiveForce === 0 &&
      cuttlefish.physics.air.lift.surfaceFollowingInverseForceFromGround === 0 &&
      cuttlefish.physics.air.lift.surfaceFollowingInverseForceFromWater === 0 &&
      cuttlefish.physics.water.maxPropulsiveForce > 0 &&
      cuttlefish.physics.water.lift.surfaceFollowingInverseForceFromGround > 0 &&
      cuttlefish.physics.water.lift.surfaceFollowingProportionalForceFromWater > 0 &&
      !cuttlefish.navigation.waypoint.allowOnGround &&
      cuttlefish.navigation.waypoint.allowInWater &&
      !cuttlefish.navigation.waypoint.allowInAir,
    'Cuttlefish must be a submerged water-only stealth scout, not a land-walking turtle variant',
  );
}
