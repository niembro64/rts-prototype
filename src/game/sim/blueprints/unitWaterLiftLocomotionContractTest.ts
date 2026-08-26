import { GRAVITY, UNIT_MASS_MULTIPLIER } from '../../../config';
import { getAllUnitBlueprints, getUnitBlueprint, getUnitLocomotion } from './index';
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

/** Fluid propulsion and damping are both occupancy-weighted, so their
 *  full-medium ratio is the exact steady speed for an otherwise free body. */
function fullFluidTerminalSpeed(
  unitBlueprintId: string,
  medium: 'air' | 'water',
): number {
  const blueprint = getUnitBlueprint(unitBlueprintId);
  const physics = getUnitLocomotion(unitBlueprintId).physics[medium];
  const physicsMass = blueprint.mass * UNIT_MASS_MULTIPLIER;
  if (physics.maxPropulsiveForce <= 0) return 0;
  if (physics.resistance.linearDampingRate <= 0 || physicsMass <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return physics.maxPropulsiveForce * 1_000_000 /
    (physicsMass * physics.resistance.linearDampingRate);
}

function flatGroundTerminalSpeed(unitBlueprintId: string): number {
  const blueprint = getUnitBlueprint(unitBlueprintId);
  const ground = getUnitLocomotion(unitBlueprintId).physics.ground;
  const physicsMass = blueprint.mass * UNIT_MASS_MULTIPLIER;
  const weightForce = physicsMass * GRAVITY / 1_000_000;
  const driveForce = Math.min(
    ground.maxPropulsiveForce,
    weightForce * ground.staticFrictionCoefficient,
  );
  if (driveForce <= 0) return 0;
  if (ground.tangentialDampingRate <= 0 || physicsMass <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return driveForce * 1_000_000 /
    (physicsMass * ground.tangentialDampingRate);
}

export function runUnitWaterLiftLocomotionContractTest(): void {
  // A stop-and-hold unit crossing an entire ordinary combat envelope in one
  // second is a tuning error, not a niche. Audit every blueprint rather than
  // naming only whichever small-mass hull made the mistake visible first.
  const maxStopAndHoldTerminalSpeed = 600;
  for (const blueprint of getAllUnitBlueprints()) {
    const locomotion = getUnitLocomotion(blueprint.unitBlueprintId);
    if (locomotion.motionControl.cruiseWhenUncommanded) continue;
    for (const medium of ['air', 'water'] as const) {
      const speed = fullFluidTerminalSpeed(blueprint.unitBlueprintId, medium);
      assertContract(
        Number.isFinite(speed) && speed <= maxStopAndHoldTerminalSpeed,
        `${blueprint.unitBlueprintId}.${medium} full-medium terminal speed is bounded; got ${speed}`,
      );
    }
  }

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

  for (const presetId of ['amphibian', 'amphibious-crawler', 'submarine', 'surface-ship']) {
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
  const waterStriderTerminalSpeeds = [
    flatGroundTerminalSpeed('unitWaterStrider'),
    fullFluidTerminalSpeed('unitWaterStrider', 'air'),
    fullFluidTerminalSpeed('unitWaterStrider', 'water'),
  ];
  const weakestTerminalSpeed = Math.min(...waterStriderTerminalSpeeds);
  const strongestTerminalSpeed = Math.max(...waterStriderTerminalSpeeds);
  assertContract(
    waterStrider.type === 'crawler' &&
      waterStrider.physics.air.lift.surfaceFollowingInverseForceFromGround === 0 &&
      waterStrider.physics.air.lift.surfaceFollowingInverseForceFromWater === 0 &&
      weakestTerminalSpeed > 0 &&
      strongestTerminalSpeed / weakestTerminalSpeed <= 1.35 &&
      waterStrider.physics.water.lift.surfaceFollowingInverseForceFromGround > 0 &&
      waterStrider.physics.water.lift.surfaceFollowingProportionalForceFromWater > 0 &&
      waterStrider.navigation.waypoint.allowOnGround &&
      waterStrider.navigation.waypoint.allowInWater &&
      !waterStrider.navigation.waypoint.allowInAir &&
      !waterStrider.motionControl.cruiseWhenUncommanded &&
      !waterStrider.motionControl.maintainFullThrustAtWaypoints,
    'Water Strider has no air lift, damped dual-channel water support, balanced per-medium speed, and no airborne routing',
  );

  const patrolCorvette = getUnitLocomotion('unitPatrolCorvette');
  const patrolCorvetteWaterSpeed = fullFluidTerminalSpeed('unitPatrolCorvette', 'water');
  assertContract(
    patrolCorvette.physicsPresetId === 'surface-ship' &&
    patrolCorvette.physics.ground.maxPropulsiveForce === 0 &&
      patrolCorvette.physics.air.lift.surfaceFollowingInverseForceFromGround === 0 &&
      patrolCorvette.physics.air.lift.surfaceFollowingInverseForceFromWater === 0 &&
      patrolCorvette.physics.water.lift.surfaceFollowingProportionalForceFromWater > 0 &&
      patrolCorvette.physics.water.lift.surfaceFollowingInverseForceFromGround === 0 &&
      patrolCorvette.physics.water.resistance.linearDampingRate >= 20 &&
      patrolCorvetteWaterSpeed >= 100 && patrolCorvetteWaterSpeed <= 250 &&
      !patrolCorvette.navigation.waypoint.allowOnGround &&
      patrolCorvette.navigation.waypoint.allowInWater &&
      !patrolCorvette.navigation.waypoint.allowInAir &&
      !patrolCorvette.motionControl.cruiseWhenUncommanded,
    'Patrol Corvette falls freely through air, then settles into bounded surface-ship propulsion and in-water lift',
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
