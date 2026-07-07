import type { LocomotionBlueprint } from './types';
import type { UnitLocomotion } from '@/types/locomotionTypes';
import {
  AIR_LIFT_HEIGHT_FORCE_EXPONENT,
  cloneUnitLocomotion,
  createUnitLocomotion,
  getAirLiftHeightDistanceScale,
} from '../locomotion';
import {
  AIR_LIFT_TOTAL_GROUND_PROBE_COUNT,
  forEachAirLiftGroundProbePoint,
} from '../airLiftGroundProbes';
import { getUnitBlueprint, getUnitLocomotion } from './index';
import rawLocomotionConfig from '../locomotionConfig.json';

const LOCOMOTION_MEDIUM_NAMES = ['ground', 'air', 'water'] as const;
const MEDIUM_COPY_FIELDS = [
  'traction',
  'friction',
  'gravityCounterUpwardForceRatio',
  'heightUpwardForce',
  'heightUpwardForceRandomizationAmount',
  'heightUpwardForceEMA',
] as const;

type LocomotionType = LocomotionBlueprint['type'];
type AuthoredMediumPhysics = LocomotionBlueprint['physics']['ground'];
type RuntimeMediumPhysics = UnitLocomotion['physics']['ground'];

type LocomotionTypeConfig = {
  physics: {
    driveForceMultiplier: number;
    forwardForceRequiresFacing: boolean;
    driveForceScalesWithFacing: boolean;
    maintainFullThrustAtWaypoints: boolean;
    airLiftGroundProbeAheadDistance: number;
    airLiftGroundProbeAheadRadiusMultiplier: number;
  };
};

type LocomotionConfigContract = {
  airLiftHeightForceFalloff: {
    heightForceExponent: number;
  };
  types: Record<LocomotionType, LocomotionTypeConfig>;
};

const LOCOMOTION_CONFIG = rawLocomotionConfig as LocomotionConfigContract;
const LOCOMOTION_TYPE_CONFIGS = LOCOMOTION_CONFIG.types;

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
  return Math.cos(maxSlopeDeg * Math.PI / 180);
}

function getLocomotionTypeConfig(type: LocomotionType): LocomotionTypeConfig {
  const config = LOCOMOTION_TYPE_CONFIGS[type];
  assertContract(config !== undefined, `locomotionConfig.json must define ${type}`);
  return config;
}

function assertAirLiftHeightForceFalloffMatchesConfig(): void {
  const exponent = LOCOMOTION_CONFIG.airLiftHeightForceFalloff.heightForceExponent;
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
    Math.pow(16 / 4, exponent) / 16,
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
    5,
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
    'direct:10:20|forward:20:20|forward:30:20|forward:40:20|forward:50:20|left:10:25|right:10:15|rear:5:20',
    'air lift ground probe layout matches direct, four forward, left, right, rear',
  );
}

function assertMediumOwnsFields(
  medium: RuntimeMediumPhysics,
  label: string,
): void {
  assertContract(
    Object.prototype.hasOwnProperty.call(medium, 'force'),
    `${label} must own force`,
  );
  for (const field of MEDIUM_COPY_FIELDS) {
    assertContract(
      Object.prototype.hasOwnProperty.call(medium, field),
      `${label} must own ${field}`,
    );
  }
}

function assertRuntimeMediumMatchesAuthored(
  runtime: RuntimeMediumPhysics,
  authored: AuthoredMediumPhysics,
  typeConfig: LocomotionTypeConfig,
  label: string,
): void {
  assertMediumOwnsFields(runtime, label);
  assertEqual(
    runtime.force,
    authored.force * typeConfig.physics.driveForceMultiplier,
    `${label} force follows authored force and locomotion type multiplier`,
  );
  for (const field of MEDIUM_COPY_FIELDS) {
    assertEqual(runtime[field], authored[field], `${label} ${field} follows blueprint JSON`);
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
  const typeConfig = getLocomotionTypeConfig(authored.type);

  assertEqual(locomotion.type, authored.type, `${unitBlueprintId} locomotion type follows unit JSON`);
  for (const medium of LOCOMOTION_MEDIUM_NAMES) {
    assertRuntimeMediumMatchesAuthored(
      locomotion.physics[medium],
      authored.physics[medium],
      typeConfig,
      `${unitBlueprintId} ${medium}`,
    );
  }
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

  const hippoBlueprint = getUnitBlueprint('unitHippo');
  const hippoLocomotion = assertRuntimeLocomotionMatchesSources('unitHippo');
  const clonedHippoLocomotion = cloneUnitLocomotion(hippoLocomotion);
  assertClonedLocomotionMatchesSource(clonedHippoLocomotion, hippoLocomotion, 'Hippo');

  const eagleLocomotion = assertRuntimeLocomotionMatchesSources('unitEagle');
  assertClonedLocomotionMatchesSource(cloneUnitLocomotion(eagleLocomotion), eagleLocomotion, 'Eagle');

  const nonAmphibiousLocomotion = assertRuntimeLocomotionMatchesSources('unitJackal');
  assertClonedLocomotionMatchesSource(
    cloneUnitLocomotion(nonAmphibiousLocomotion),
    nonAmphibiousLocomotion,
    'Jackal',
  );

  const seaTurtleLocomotion = assertRuntimeLocomotionMatchesSources('unitSeaTurtle');
  const seaTurtleWaterDrive =
    seaTurtleLocomotion.physics.water.force * seaTurtleLocomotion.physics.water.traction;
  const seaTurtleGroundDrive =
    seaTurtleLocomotion.physics.ground.force * seaTurtleLocomotion.physics.ground.traction;
  assertContract(
    seaTurtleWaterDrive >= seaTurtleGroundDrive * 50,
    'Sea Turtle must be much stronger in water than on ground',
  );

  const zeroWaterForce = cloneLocomotionBlueprint(hippoBlueprint.locomotion);
  zeroWaterForce.physics.water.force = 0;
  const zeroWaterRuntime = createUnitLocomotion(zeroWaterForce);
  assertEqual(zeroWaterRuntime.physics.water.force, 0, 'zero-water Hippo water force');

  const negativeWaterForce = cloneLocomotionBlueprint(hippoBlueprint.locomotion);
  negativeWaterForce.physics.water.force = -1;
  expectLocomotionError(negativeWaterForce, 'water.force');

  const invalidSwimCounter = cloneLocomotionBlueprint(hippoBlueprint.locomotion);
  invalidSwimCounter.physics.water.gravityCounterUpwardForceRatio = 1;
  expectLocomotionError(invalidSwimCounter, 'water.gravityCounterUpwardForceRatio');
}
