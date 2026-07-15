import type { LocomotionBlueprint } from './types';
import type { UnitLocomotion } from '@/types/locomotionTypes';
import {
  cloneUnitLocomotion,
  createUnitLocomotion,
} from '../locomotion';
import {
  AIR_LIFT_HEIGHT_FORCE_EXPONENT,
  getAirLiftHeightDistanceScale,
} from '../airLiftForce';
import { resolveLocomotionRouteCapabilities } from '../locomotionNavigation';
import {
  LOCOMOTION_CONFIG_MEDIUM_FIELDS,
  LOCOMOTION_MEDIUM_NAMES,
  getLocomotionPreset,
  type LocomotionMediumName,
  type LocomotionPresetConfig,
} from '../locomotionPresetConfig';
import {
  AIR_LIFT_TOTAL_GROUND_PROBE_COUNT,
  forEachAirLiftGroundProbePoint,
} from '../airLiftGroundProbes';
import { getUnitBlueprint, getUnitLocomotion } from './index';
import rawLocomotionConfig from '../locomotionConfig.json';
import { deterministicMath as DMath } from '../deterministicMath';

type AuthoredMediumPhysics = LocomotionBlueprint['physics']['ground'];
type RuntimeMediumPhysics = UnitLocomotion['physics']['ground'];

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[locomotion contract] ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  assertContract(
    Object.is(actual, expected),
    `${message}; expected ${String(expected)}, got ${String(actual)}`,
  );
}

function cloneLocomotionBlueprint(locomotion: LocomotionBlueprint): LocomotionBlueprint {
  return JSON.parse(JSON.stringify(locomotion)) as LocomotionBlueprint;
}

function expectLocomotionError(
  blueprint: LocomotionBlueprint,
  expectedMessagePart: string,
): void {
  try {
    createUnitLocomotion(blueprint);
  } catch (err) {
    assertContract(
      err instanceof Error && err.message.includes(expectedMessagePart),
      `expected validation error containing "${expectedMessagePart}", got ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  throw new Error(`[locomotion contract] expected validation error containing "${expectedMessagePart}"`);
}

function minSurfaceNormalZ(maxSlopeDeg: number): number {
  return DMath.cos(maxSlopeDeg * Math.PI / 180);
}

function assertAirLiftHeightForceFalloffMatchesConfig(): void {
  const exponent = rawLocomotionConfig.airLiftHeightForceFalloff.heightForceExponent;
  assertContract(
    Number.isFinite(exponent) && exponent > 0 && exponent <= 1,
    'airLiftHeightForceFalloff.heightForceExponent must be finite in (0, 1]',
  );
  assertEqual(
    AIR_LIFT_HEIGHT_FORCE_EXPONENT,
    exponent,
    'air lift height force exponent follows locomotionConfig.json',
  );
  assertEqual(
    getAirLiftHeightDistanceScale(4, 16),
    DMath.pow(16 / 4, exponent) / 16,
    'air lift height distance scale roots the inverse-distance height force',
  );
  assertEqual(
    getAirLiftHeightDistanceScale(64, 16),
    1 / 64,
    'air lift height distance scale does not amplify below exact inverse distance',
  );
}

function assertAirLiftGroundProbeLayout(): void {
  const probes: string[] = [];
  const count = forEachAirLiftGroundProbePoint(
    10,
    20,
    1,
    0,
    40,
    (x, y, kind) => {
      probes.push(`${kind}:${x}:${y}`);
    },
  );
  assertEqual(
    count,
    AIR_LIFT_TOTAL_GROUND_PROBE_COUNT,
    'air lift ground probe layout uses eight samples',
  );
  assertEqual(
    probes.join('|'),
    'direct:10:20|forward:20:20|forward:30:20|forward:40:20|forward:50:20|left:10:30|right:10:10|rear:0:20',
    'air lift ground probe layout uses one forward spacing for side and rear probes',
  );
}

function assertMobilityTuningIntent(): void {
  const wheels = getLocomotionPreset('wheels').physics;
  const treads = getLocomotionPreset('treads').physics;
  const legs = getLocomotionPreset('legs').physics;
  const flippers = getLocomotionPreset('flippers').physics;
  const flying = getLocomotionPreset('flying').physics;

  assertContract(
    wheels.ground.driveForce > 0 && wheels.ground.surfaceGrip >= 0.55,
    'wheels keep ground drive and their grip envelope',
  );
  assertContract(
    treads.ground.driveForce > 0 && treads.ground.surfaceGrip >= 0.85,
    'treads keep ground drive and their grip envelope',
  );
  assertContract(
    legs.ground.driveForce > 0 && legs.ground.surfaceGrip >= 1,
    'legs keep ground drive without weakening contact grip',
  );
  assertEqual(
    flippers.ground.driveForce,
    legs.ground.driveForce,
    'flippers inherit leg-family ground propulsion',
  );
  assertContract(
    flying.air.dragForwardScale >= 0.5 &&
      flying.air.dragForwardScale < flying.air.dragLateralScale,
    'flying keeps a lower cruise speed while remaining laterally draggy',
  );
  assertContract(
    flying.air.traction >= 3,
    'flying speed tuning must not remove air turn authority',
  );
}

function assertMediumOwnsFields(
  medium: RuntimeMediumPhysics,
  label: string,
): void {
  assertContract(
    Object.prototype.hasOwnProperty.call(medium, 'heightUpwardForce'),
    `${label} must own heightUpwardForce`,
  );
  for (const field of LOCOMOTION_CONFIG_MEDIUM_FIELDS) {
    assertContract(
      Object.prototype.hasOwnProperty.call(medium, field),
      `${label} must own ${field}`,
    );
  }
}

function assertRuntimeMediumMatchesAuthored(
  runtime: RuntimeMediumPhysics,
  authored: AuthoredMediumPhysics,
  typeConfig: LocomotionPresetConfig,
  medium: LocomotionMediumName,
  label: string,
): void {
  assertMediumOwnsFields(runtime, label);
  assertEqual(
    runtime.heightUpwardForce,
    authored.heightUpwardForce,
    `${label} heightUpwardForce follows blueprint JSON`,
  );
  for (const field of LOCOMOTION_CONFIG_MEDIUM_FIELDS) {
    assertEqual(
      runtime[field],
      typeConfig.physics[medium][field],
      `${label} ${field} follows locomotionConfig.json`,
    );
  }
}

function assertPathfindingMatchesAuthored(
  runtime: UnitLocomotion['pathfinding'],
  authored: LocomotionBlueprint['pathfinding'],
  label: string,
): void {
  assertEqual(
    runtime.pathfindingBlueprintId,
    authored.pathfindingBlueprintId,
    `${label} pathfinding id follows pathfinding JSON`,
  );
  assertEqual(
    runtime.terrainMode,
    authored.terrainMode,
    `${label} terrain mode follows pathfinding JSON`,
  );
  if (authored.terrainMode === 'anywhere') {
    assertEqual(runtime.ignoreTerrainBlocking, true, `${label} anywhere pathfinding ignores terrain blocking`);
    assertEqual(runtime.maxSlopeDeg, null, `${label} anywhere pathfinding has no slope cap`);
    assertEqual(runtime.minSurfaceNormalZ, 0, `${label} anywhere pathfinding has no surface-normal cap`);
    return;
  }
  assertEqual(runtime.ignoreTerrainBlocking, false, `${label} land pathfinding uses terrain blocking`);
  assertEqual(runtime.maxSlopeDeg, authored.maxSlopeDeg, `${label} slope cap follows pathfinding JSON`);
  assertContract(authored.maxSlopeDeg !== null, `${label} land pathfinding must author maxSlopeDeg`);
  assertEqual(
    runtime.minSurfaceNormalZ,
    minSurfaceNormalZ(authored.maxSlopeDeg),
    `${label} min surface normal derives from pathfinding slope cap`,
  );
}

function assertRuntimeLocomotionMatchesSources(unitBlueprintId: string): UnitLocomotion {
  const unitBlueprint = getUnitBlueprint(unitBlueprintId);
  const locomotion = getUnitLocomotion(unitBlueprintId);
  const authored = unitBlueprint.locomotion;
  const typeConfig = getLocomotionPreset(authored.physicsPresetId);

  assertEqual(locomotion.type, authored.type, `${unitBlueprintId} locomotion type follows unit JSON`);
  assertEqual(
    locomotion.physicsPresetId,
    authored.physicsPresetId,
    `${unitBlueprintId} physics preset follows unit JSON`,
  );
  assertEqual(
    JSON.stringify(locomotion.navigation),
    JSON.stringify(typeConfig.navigation),
    `${unitBlueprintId} navigation policy follows locomotion preset`,
  );
  assertEqual(
    JSON.stringify(locomotion.survival),
    JSON.stringify(authored.survival),
    `${unitBlueprintId} survival policy follows unit JSON`,
  );
  for (const medium of LOCOMOTION_MEDIUM_NAMES) {
    assertRuntimeMediumMatchesAuthored(
      locomotion.physics[medium],
      authored.physics[medium],
      typeConfig,
      medium,
      `${unitBlueprintId} ${medium}`,
    );
  }
  assertEqual(
    locomotion.idleAirDrive,
    typeConfig.physics.idleAirDrive,
    `${unitBlueprintId} idle air drive follows locomotionConfig.json`,
  );
  assertEqual(
    locomotion.forwardForceRequiresFacing,
    typeConfig.physics.forwardForceRequiresFacing,
    `${unitBlueprintId} forward force gate follows locomotionConfig.json`,
  );
  assertEqual(
    locomotion.driveForceScalesWithFacing,
    typeConfig.physics.driveForceScalesWithFacing,
    `${unitBlueprintId} facing force scaling follows locomotionConfig.json`,
  );
  assertEqual(
    locomotion.maintainFullThrustAtWaypoints,
    typeConfig.physics.maintainFullThrustAtWaypoints,
    `${unitBlueprintId} waypoint thrust mode follows locomotionConfig.json`,
  );
  assertEqual(
    locomotion.airLiftGroundProbeAheadDistance,
    typeConfig.physics.airLiftGroundProbeAheadDistance,
    `${unitBlueprintId} air lift probe distance follows locomotionConfig.json`,
  );
  assertEqual(
    locomotion.airLiftGroundProbeAheadRadiusMultiplier,
    typeConfig.physics.airLiftGroundProbeAheadRadiusMultiplier,
    `${unitBlueprintId} air lift probe radius follows locomotionConfig.json`,
  );
  assertPathfindingMatchesAuthored(locomotion.pathfinding, authored.pathfinding, unitBlueprintId);
  return locomotion;
}

function assertClonedLocomotionMatchesSource(
  clone: UnitLocomotion,
  source: UnitLocomotion,
  label: string,
): void {
  assertEqual(JSON.stringify(clone), JSON.stringify(source), `${label} clone preserves runtime locomotion`);
}

export function runLocomotionContractTest(): void {
  assertAirLiftHeightForceFalloffMatchesConfig();
  assertAirLiftGroundProbeLayout();
  assertMobilityTuningIntent();

  const hippoBlueprint = getUnitBlueprint('unitHippo');
  const hippoLocomotion = assertRuntimeLocomotionMatchesSources('unitHippo');
  const hippoRoutes = resolveLocomotionRouteCapabilities(hippoLocomotion);
  assertContract(hippoRoutes.allowOnGround, 'Hippo allows on-ground routes');
  assertContract(hippoRoutes.allowInWater, 'Hippo allows in-water routes');
  assertContract(!hippoRoutes.allowInAir, 'Hippo does not allow in-air routes');
  const clonedHippoLocomotion = cloneUnitLocomotion(hippoLocomotion);
  assertClonedLocomotionMatchesSource(clonedHippoLocomotion, hippoLocomotion, 'Hippo');

  const eagleLocomotion = assertRuntimeLocomotionMatchesSources('unitEagle');
  const eagleRoutes = resolveLocomotionRouteCapabilities(eagleLocomotion);
  assertContract(!eagleRoutes.allowOnGround, 'Eagle does not allow on-ground routes');
  assertContract(!eagleRoutes.allowInWater, 'Eagle does not allow in-water routes');
  assertContract(eagleRoutes.allowInAir, 'Eagle allows in-air routes');
  assertClonedLocomotionMatchesSource(cloneUnitLocomotion(eagleLocomotion), eagleLocomotion, 'Eagle');

  const jackalBlueprint = getUnitBlueprint('unitJackal');
  const nonAmphibiousLocomotion = assertRuntimeLocomotionMatchesSources('unitJackal');
  const jackalRoutes = resolveLocomotionRouteCapabilities(nonAmphibiousLocomotion);
  assertContract(jackalRoutes.allowOnGround, 'Jackal allows on-ground routes');
  assertContract(
    !jackalRoutes.allowInWater,
    'Jackal water-only preset envelope still requires physical water authority',
  );
  assertContract(!jackalRoutes.allowInAir, 'Jackal does not allow in-air routes');
  assertClonedLocomotionMatchesSource(
    cloneUnitLocomotion(nonAmphibiousLocomotion),
    nonAmphibiousLocomotion,
    'Jackal',
  );
  const lynxRoutes = resolveLocomotionRouteCapabilities(
    assertRuntimeLocomotionMatchesSources('unitLynx'),
  );
  assertContract(
    !lynxRoutes.allowInWater,
    'standard treads do not inherit amphibious water authority',
  );
  const mongooseBlueprint = getUnitBlueprint('unitMongoose');
  const mongooseLocomotion = assertRuntimeLocomotionMatchesSources('unitMongoose');
  assertEqual(
    nonAmphibiousLocomotion.physics.ground.driveForce,
    mongooseLocomotion.physics.ground.driveForce,
    'units sharing the wheels preset receive the same ground drive force',
  );
  assertContract(
    jackalBlueprint.mass < mongooseBlueprint.mass &&
      nonAmphibiousLocomotion.physics.ground.driveForce /
        jackalBlueprint.mass >
        mongooseLocomotion.physics.ground.driveForce / mongooseBlueprint.mass,
    'shared preset drive force makes the lighter Jackal accelerate faster than the Mongoose',
  );

  const seaTurtleLocomotion = assertRuntimeLocomotionMatchesSources('unitSeaTurtle');
  const seaTurtleBlueprint = getUnitBlueprint('unitSeaTurtle');
  assertEqual(
    seaTurtleBlueprint.locomotion.type,
    'flippers',
    'Sea Turtle owns the independent flipper visual rig',
  );
  assertEqual(
    seaTurtleLocomotion.physicsPresetId,
    'flippers',
    'Sea Turtle owns the independent flipper physics preset',
  );
  const seaTurtleWaterDrive =
    seaTurtleLocomotion.physics.water.driveForce * seaTurtleLocomotion.physics.water.traction;
  const seaTurtleGroundDrive =
    seaTurtleLocomotion.physics.ground.driveForce * seaTurtleLocomotion.physics.ground.traction;
  assertEqual(
    seaTurtleWaterDrive,
    3570,
    'flippers preserve the prior Sea Turtle coupled water drive exactly',
  );
  assertContract(
    seaTurtleWaterDrive > seaTurtleGroundDrive * 4,
    'Sea Turtle remains much stronger in water than on ground',
  );
  const seaTurtleRoutes = resolveLocomotionRouteCapabilities(seaTurtleLocomotion);
  assertContract(
    seaTurtleRoutes.allowOnGround && seaTurtleRoutes.allowInWater && !seaTurtleRoutes.allowInAir,
    'flippers route on ground and in water, never through air',
  );
  assertEqual(
    hippoBlueprint.locomotion.type,
    'treads',
    'Hippo remains the amphibious tread unit',
  );

  const strayUnitMediumConfig = cloneLocomotionBlueprint(hippoBlueprint.locomotion);
  (strayUnitMediumConfig.physics.water as AuthoredMediumPhysics & {
    driveForce: number;
  }).driveForce = 1;
  expectLocomotionError(strayUnitMediumConfig, 'moved to locomotionConfig.json');
}
