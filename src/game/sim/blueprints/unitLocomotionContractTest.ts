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
import rawLocomotionConfig from '../unitLocomotionConfig.json';

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

export function runUnitLocomotionContractTest(): void {
  for (const [presetId, rawPreset] of Object.entries(rawLocomotionConfig.presets)) {
    const preset = getUnitLocomotionPreset(presetId);
    const ground = preset.actuator.ground;
    assertContract(
      ground.maxPropulsiveForce >= 0 &&
        ground.staticFrictionCoefficient >= 0 &&
        ground.tangentialDampingRate >= 0,
      `${presetId} ground physics is finite and non-negative`,
    );
    for (const medium of ['air', 'water'] as const) {
      const authored = rawPreset.actuator[medium];
      const runtime = preset.actuator[medium];
      assertContract(
        authored.maxPropulsiveForce === runtime.maxPropulsiveForce,
        `${presetId}.${medium} owns a direct maximum propulsive force`,
      );
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
      clone.physics.ground.maxPropulsiveForce === runtime.physics.ground.maxPropulsiveForce &&
        clone.navigation.allowOnGround === runtime.navigation.allowOnGround,
      `${blueprint.unitBlueprintId} locomotion cloning preserves direct physics and navigation`,
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

  const eagle = getUnitLocomotion('unitEagle');
  assertContract(
    eagle.navigation.allowInAir && eagle.physics.air.maxPropulsiveForce > 0,
    'Eagle has explicit air navigation and direct air propulsion',
  );
  const orca = getUnitLocomotion('unitOrca');
  assertContract(
    !orca.navigation.allowOnGround &&
      orca.navigation.allowInWater &&
      orca.physics.water.maxPropulsiveForce > 0 &&
      orca.physics.ground.maxPropulsiveForce === 0,
    'Orca is water-navigable through its navigation and water-force profiles',
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
