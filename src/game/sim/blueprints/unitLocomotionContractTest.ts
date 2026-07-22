import type { UnitLocomotionBlueprint } from './types';
import {
  cloneUnitLocomotion,
  createUnitLocomotion,
  getUnitLocomotionTraversalCapabilities,
} from '../unitLocomotion';
import {
  UNIT_LOCOMOTION_SURFACE_FOLLOWING_RESPONSE_FIELDS,
  getUnitLocomotionPreset,
} from '../unitLocomotionPresetConfig';
import { getUnitBlueprint, getUnitLocomotion } from './index';
import { getAllUnitBlueprints } from './units';
import { UNIT_BLUEPRINT_IDS } from '@/types/blueprintIds';
import rawLocomotionConfig from '../unitLocomotionConfig.json';
import {
  forEachSurfaceProbePoint,
  getSurfaceProbeSpacing,
} from '../surfaceProbeSets';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[locomotion contract] ${message}`);
}

function cloneBlueprint(value: UnitLocomotionBlueprint): UnitLocomotionBlueprint {
  return JSON.parse(JSON.stringify(value)) as UnitLocomotionBlueprint;
}

function expectLocomotionError(blueprint: UnitLocomotionBlueprint, message: string): void {
  try {
    createUnitLocomotion(blueprint);
  } catch {
    return;
  }
  throw new Error(`[locomotion contract] expected invalid locomotion: ${message}`);
}

type ExpectedLocomotionDomain = Readonly<{
  type: UnitLocomotionBlueprint['type'];
  allowOnGround: boolean;
  allowInAir: boolean;
  allowInWater: boolean;
  waterFatal: boolean;
}>;

/**
 * This is an explicit roster policy rather than a visual-type inference.
 * The same leg rig may be a land-only bot or the Commander's seabed-walking
 * chassis; navigation and survival stay deliberate data decisions.
 */
const EXPECTED_ROSTER_LOCOMOTION: Readonly<Record<string, ExpectedLocomotionDomain>> = {
  unitJackal: { type: 'wheels', allowOnGround: true, allowInAir: false, allowInWater: false, waterFatal: true },
  unitLynx: { type: 'treads', allowOnGround: true, allowInAir: false, allowInWater: false, waterFatal: true },
  unitDaddy: { type: 'legs', allowOnGround: true, allowInAir: false, allowInWater: false, waterFatal: true },
  unitBadger: { type: 'treads', allowOnGround: true, allowInAir: false, allowInWater: false, waterFatal: true },
  unitMongoose: { type: 'wheels', allowOnGround: true, allowInAir: false, allowInWater: false, waterFatal: true },
  unitTick: { type: 'legs', allowOnGround: true, allowInAir: false, allowInWater: false, waterFatal: true },
  unitMammoth: { type: 'treads', allowOnGround: true, allowInAir: false, allowInWater: false, waterFatal: true },
  unitFormik: { type: 'legs', allowOnGround: true, allowInAir: false, allowInWater: false, waterFatal: true },
  unitWidow: { type: 'legs', allowOnGround: true, allowInAir: false, allowInWater: false, waterFatal: true },
  unitHippo: { type: 'amphibious-treads', allowOnGround: true, allowInAir: false, allowInWater: true, waterFatal: false },
  unitSeaTurtle: { type: 'flippers', allowOnGround: true, allowInAir: false, allowInWater: true, waterFatal: false },
  unitOrca: { type: 'submarine', allowOnGround: false, allowInAir: false, allowInWater: true, waterFatal: false },
  unitTarantula: { type: 'legs', allowOnGround: true, allowInAir: false, allowInWater: false, waterFatal: true },
  unitLoris: { type: 'treads', allowOnGround: true, allowInAir: false, allowInWater: false, waterFatal: true },
  unitBee: { type: 'hover', allowOnGround: false, allowInAir: true, allowInWater: true, waterFatal: false },
  unitDragonfly: { type: 'hover', allowOnGround: false, allowInAir: true, allowInWater: true, waterFatal: false },
  unitConstructionDrone: { type: 'hover', allowOnGround: false, allowInAir: true, allowInWater: true, waterFatal: false },
  unitEagle: { type: 'flying', allowOnGround: false, allowInAir: true, allowInWater: false, waterFatal: true },
  unitDuck: { type: 'dive', allowOnGround: false, allowInAir: true, allowInWater: true, waterFatal: false },
  unitAlbatros: { type: 'flying', allowOnGround: false, allowInAir: true, allowInWater: false, waterFatal: true },
  unitQueenBee: { type: 'hover', allowOnGround: false, allowInAir: true, allowInWater: true, waterFatal: false },
  unitQueenTick: { type: 'flying', allowOnGround: false, allowInAir: true, allowInWater: false, waterFatal: true },
  unitTransport: { type: 'hover', allowOnGround: false, allowInAir: true, allowInWater: true, waterFatal: false },
  unitCommander: { type: 'legs', allowOnGround: true, allowInAir: false, allowInWater: true, waterFatal: false },
};

export function runUnitLocomotionContractTest(): void {
  const probeSpacing = getSurfaceProbeSpacing().world;
  const fewSamples: Array<{ x: number; y: number }> = [];
  const manySamples: Array<{ x: number; y: number }> = [];
  forEachSurfaceProbePoint('few', 0, 0, 1, 0, (x, y) => {
    fewSamples.push({ x, y });
  });
  forEachSurfaceProbePoint('many', 0, 0, 1, 0, (x, y) => {
    manySamples.push({ x, y });
  });
  assertContract(
    fewSamples[1]?.x === probeSpacing &&
      manySamples[1]?.x === probeSpacing &&
      manySamples[2]?.x === 2 * probeSpacing &&
      manySamples[3]?.x === 3 * probeSpacing &&
      manySamples[4]?.x === 4 * probeSpacing &&
      manySamples[5]?.y === probeSpacing &&
      manySamples[6]?.y === -probeSpacing &&
      manySamples[7]?.x === -probeSpacing,
    'all multi-point surface-probe layouts use the one shared spacing lattice',
  );

  for (const [presetId, rawPreset] of Object.entries(rawLocomotionConfig.presets)) {
    const preset = getUnitLocomotionPreset(presetId);
    const ground = preset.actuator.ground;
    assertContract(
      ground.maxPropulsiveForce >= 0 &&
        ground.staticFrictionCoefficient >= 0 &&
        ground.tangentialDampingRate >= 0,
      `${presetId}.ground owns propulsion and contact physics`,
    );
    assertContract(
      rawPreset.actuator.ground.maxPropulsiveForce === ground.maxPropulsiveForce,
      `${presetId}.ground preserves its authored propulsion force`,
    );
    for (const medium of ['air', 'water'] as const) {
      const runtime = preset.actuator[medium];
      assertContract(
        runtime.maxPropulsiveForce >= 0 &&
          runtime.linearDampingRate >= 0 &&
          runtime.angularDampingRate >= 0,
        `${presetId}.${medium} owns propulsion plus linear and angular damping`,
      );
      assertContract(
        rawPreset.actuator[medium].maxPropulsiveForce === runtime.maxPropulsiveForce,
        `${presetId}.${medium} preserves its authored propulsion force`,
      );
      for (const field of UNIT_LOCOMOTION_SURFACE_FOLLOWING_RESPONSE_FIELDS) {
        assertContract(
          Object.prototype.hasOwnProperty.call(runtime.surfaceLiftResponse, field),
          `${presetId}.${medium}.surfaceLiftResponse explicitly owns ${field}`,
        );
      }
      assertContract(
        runtime.surfaceLiftResponse.randomizationAmount === 0 &&
          runtime.surfaceLiftResponse.ema === 0,
        `${presetId}.${medium} surface following is deterministic and unfiltered`,
      );
    }
  }

  for (const blueprint of getAllUnitBlueprints()) {
    const runtime = getUnitLocomotion(blueprint.unitBlueprintId);
    const clone = cloneUnitLocomotion(runtime);
    assertContract(
      clone.physics.ground.maxPropulsiveForce === runtime.physics.ground.maxPropulsiveForce &&
        clone.physics.air.maxPropulsiveForce === runtime.physics.air.maxPropulsiveForce &&
        clone.physics.water.maxPropulsiveForce === runtime.physics.water.maxPropulsiveForce &&
        clone.navigation.waypoint.allowOnGround === runtime.navigation.waypoint.allowOnGround &&
        clone.navigation.move.allowInWater === runtime.navigation.move.allowInWater,
      `${blueprint.unitBlueprintId} locomotion cloning preserves per-medium propulsion and navigation`,
    );
    assertContract(
      runtime.physics.air.lift.surfaceFollowingInverseForceFromGround ===
        blueprint.unitLocomotion.physics.air.lift.surfaceFollowingInverseForceFromGround &&
        runtime.physics.air.lift.surfaceFollowingInverseForceFromWater ===
          blueprint.unitLocomotion.physics.air.lift.surfaceFollowingInverseForceFromWater &&
        runtime.physics.water.lift.surfaceFollowingInverseForceFromGround ===
          blueprint.unitLocomotion.physics.water.lift.surfaceFollowingInverseForceFromGround &&
        runtime.physics.water.lift.surfaceFollowingProportionalForceFromWater ===
          blueprint.unitLocomotion.physics.water.lift.surfaceFollowingProportionalForceFromWater,
      `${blueprint.unitBlueprintId} owns explicit inverse and proportional surface-following forces`,
    );
    assertContract(
      getUnitLocomotionTraversalCapabilities(runtime).waypoint.allowInAir ===
        runtime.navigation.waypoint.allowInAir,
      `${blueprint.unitBlueprintId} route permissions come from navigation, not visual type`,
    );
    assertContract(
      runtime.physics.air.maxPropulsiveForce ===
        getUnitLocomotionPreset(runtime.physicsPresetId).actuator.air.maxPropulsiveForce &&
        runtime.physics.water.maxPropulsiveForce ===
          getUnitLocomotionPreset(runtime.physicsPresetId).actuator.water.maxPropulsiveForce,
      `${blueprint.unitBlueprintId} retains authored air and water drive independently of route permission`,
    );
  }

  assertContract(
    Object.keys(EXPECTED_ROSTER_LOCOMOTION).length === UNIT_BLUEPRINT_IDS.length,
    'every unit has an explicit locomotion-domain policy',
  );
  for (const unitBlueprintId of UNIT_BLUEPRINT_IDS) {
    const expected = EXPECTED_ROSTER_LOCOMOTION[unitBlueprintId];
    const runtime = getUnitLocomotion(unitBlueprintId);
    assertContract(expected !== undefined, `${unitBlueprintId} has a locomotion-domain policy`);
    assertContract(
      runtime.type === expected.type &&
        runtime.navigation.waypoint.allowOnGround === expected.allowOnGround &&
        runtime.navigation.waypoint.allowInAir === expected.allowInAir &&
        runtime.navigation.waypoint.allowInWater === expected.allowInWater &&
        (runtime.environmentalHazards.waterDamagePerSecond > 0) === expected.waterFatal,
      `${unitBlueprintId} matches its intended ground, air, and water locomotion`,
    );
    assertContract(
      runtime.navigation.move.allowInWater && runtime.physics.water.maxPropulsiveForce > 0,
      `${unitBlueprintId} has positive emergency water propulsion and move-valid water cells`,
    );
    const blueprint = getUnitBlueprint(unitBlueprintId);
    assertContract(
      runtime.environmentalHazards.waterDamagePerSecond ===
        (expected.waterFatal ? blueprint.hp / 2 : 0),
      `${unitBlueprintId} authors universal numeric water damage; intended water units use zero`,
    );
  }

  const commander = getUnitLocomotion('unitCommander');
  assertContract(
    commander.physicsPresetId === 'amphibiousLegs' &&
      commander.navigation.waypoint.allowOnGround &&
      commander.navigation.waypoint.allowInWater &&
      !commander.navigation.waypoint.allowInAir &&
      commander.environmentalHazards.waterDamagePerSecond === 0 &&
      commander.physics.water.lift.surfaceFollowingProportionalForceFromWater === 0,
    'Commander uses its leg rig to walk the seabed without a water-surface controller',
  );

  const eagle = getUnitLocomotion('unitEagle');
  assertContract(
    eagle.navigation.waypoint.allowInAir && eagle.physics.air.maxPropulsiveForce > 0,
    'Eagle has explicit air navigation and air propulsion',
  );
  const orca = getUnitLocomotion('unitOrca');
  assertContract(
      !orca.navigation.waypoint.allowOnGround &&
      orca.navigation.waypoint.allowInWater &&
      orca.physics.ground.maxPropulsiveForce === 0 &&
      orca.physics.water.maxPropulsiveForce > 0 &&
      !orca.motionControl.maintainFullThrustAtWaypoints &&
      !orca.motionControl.cruiseWhenUncommanded,
    'Orca is water-navigable and brakes to stop at a waypoint',
  );

  const incompleteAirLift = cloneBlueprint(getUnitBlueprint('unitEagle').unitLocomotion);
  delete (incompleteAirLift.physics.air.lift as {
    surfaceFollowingInverseForceFromWater?: number;
  }).surfaceFollowingInverseForceFromWater;
  expectLocomotionError(incompleteAirLift, 'air lift requires both inverse surface sources');

  const invalidWaterLift = cloneBlueprint(getUnitBlueprint('unitOrca').unitLocomotion);
  const waterLift = invalidWaterLift.physics.water.lift as {
    surfaceFollowingProportionalForceFromWater?: number;
  };
  delete waterLift.surfaceFollowingProportionalForceFromWater;
  expectLocomotionError(invalidWaterLift, 'water lift requires its proportional water-surface force');
}
