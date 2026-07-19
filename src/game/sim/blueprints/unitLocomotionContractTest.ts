import type { UnitLocomotionBlueprint } from './types';
import {
  cloneUnitLocomotion,
  createUnitLocomotion,
  getUnitLocomotionTraversalCapabilities,
} from '../unitLocomotion';
import {
  UNIT_LOCOMOTION_SURFACE_FOLLOWING_RESPONSE_FIELDS,
  getUnitLocomotionFluidResistance,
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
      preset.actuator.maxPropulsiveForce >= 0 &&
        ground.staticFrictionCoefficient >= 0 &&
        ground.tangentialDampingRate >= 0,
      `${presetId} has one finite actuator force budget and ground contact physics`,
    );
    assertContract(
      rawPreset.actuator.maxPropulsiveForce === preset.actuator.maxPropulsiveForce,
      `${presetId} preserves its one authored actuator force budget`,
    );
    for (const medium of ['air', 'water'] as const) {
      const runtime = preset.actuator[medium];
      const resistance = getUnitLocomotionFluidResistance(runtime.resistanceProfileId);
      assertContract(
        resistance.linearDampingRate >= 0 && resistance.angularDampingRate >= 0,
        `${presetId}.${medium} resolves one linear and one angular damping rate`,
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
      clone.actuator.maxPropulsiveForce === runtime.actuator.maxPropulsiveForce &&
        clone.navigation.allowOnGround === runtime.navigation.allowOnGround,
      `${blueprint.unitBlueprintId} locomotion cloning preserves actuator and navigation`,
    );
    assertContract(
      runtime.physics.air.lift.surfaceFollowingForceFromGround ===
        (blueprint.unitLocomotion.physics.air?.lift.surfaceFollowingForceFromGround ?? 0) &&
        runtime.physics.air.lift.surfaceFollowingForceFromWater ===
          (blueprint.unitLocomotion.physics.air?.lift.surfaceFollowingForceFromWater ?? 0) &&
        runtime.physics.water.lift.surfaceFollowingForceFromGround ===
          (blueprint.unitLocomotion.physics.water?.lift.surfaceFollowingForceFromGround ?? 0),
      `${blueprint.unitBlueprintId} owns source-specific surface-following forces`,
    );
    assertContract(
      getUnitLocomotionTraversalCapabilities(runtime).allowInAir === runtime.navigation.allowInAir,
      `${blueprint.unitBlueprintId} route permissions come from navigation, not visual type`,
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
        runtime.navigation.allowOnGround === expected.allowOnGround &&
        runtime.navigation.allowInAir === expected.allowInAir &&
        runtime.navigation.allowInWater === expected.allowInWater &&
        runtime.environmentalHazards.waterFatal === expected.waterFatal,
      `${unitBlueprintId} matches its intended ground, air, and water locomotion`,
    );
  }

  for (const unitBlueprintId of ['unitJackal', 'unitTick'] as const) {
    const locomotion = getUnitLocomotion(unitBlueprintId);
    assertContract(
      locomotion.physics.water.lift.buoyancyRatio === 0,
      `${unitBlueprintId} is a water-fatal land unit, not a floating one`,
    );
  }

  const commander = getUnitLocomotion('unitCommander');
  assertContract(
    commander.physicsPresetId === 'amphibiousLegs' &&
      commander.navigation.allowOnGround &&
      commander.navigation.allowInWater &&
      !commander.navigation.allowInAir &&
      !commander.environmentalHazards.waterFatal &&
      commander.physics.water.lift.buoyancyRatio === 0,
    'Commander uses its leg rig to walk the seabed, rather than floating or flying',
  );

  const eagle = getUnitLocomotion('unitEagle');
  assertContract(
    eagle.navigation.allowInAir && eagle.actuator.maxPropulsiveForce > 0,
    'Eagle has explicit air navigation and an actuator force budget',
  );
  const orca = getUnitLocomotion('unitOrca');
  assertContract(
    !orca.navigation.allowOnGround &&
      orca.navigation.allowInWater &&
      orca.actuator.maxPropulsiveForce > 0 &&
      !orca.motionControl.maintainFullThrustAtWaypoints &&
      !orca.motionControl.cruiseWhenUncommanded,
    'Orca is water-navigable and brakes to stop at a waypoint',
  );

  const incompleteAirLift = cloneBlueprint(getUnitBlueprint('unitEagle').unitLocomotion);
  delete incompleteAirLift.physics.air?.lift.surfaceFollowingForceFromWater;
  expectLocomotionError(incompleteAirLift, 'air lift requires both surface-following sources');

  const invalidWaterLift = cloneBlueprint(getUnitBlueprint('unitOrca').unitLocomotion);
  const waterLift = invalidWaterLift.physics.water?.lift;
  assertContract(waterLift !== undefined, 'Orca authors water lift');
  waterLift.surfaceFollowingForceFromWater = 1;
  expectLocomotionError(invalidWaterLift, 'water lift cannot source the water surface');
}
