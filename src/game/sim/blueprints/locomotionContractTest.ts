import type { LocomotionBlueprint } from './types';
import type {
  UnitLocomotion,
  UnitLocomotionFluidPhysics,
  UnitLocomotionGroundPhysics,
} from '@/types/locomotionTypes';
import {
  cloneUnitLocomotion,
  createUnitLocomotion,
} from '../locomotion';
import { getSurfaceLiftDistanceResponse } from '../surfaceLiftDistanceResponse';
import { resolveSurfaceLiftGroundZ } from '../surfaceLiftGroundSupport';
import {
  accumulateSurfaceProbeResponse,
  finalizeSurfaceProbeResponse,
  isSurfaceProbeAggregation,
  surfaceProbeUsesWaterSurface,
} from '../surfaceProbeAggregation';
import { resolveLocomotionRouteCapabilities } from '../locomotionNavigation';
import {
  LOCOMOTION_FRICTION_BY_MEDIUM,
  LOCOMOTION_MEDIUM_NAMES,
  getLocomotionEffectiveFriction,
  getLocomotionPreset,
  type LocomotionPresetConfig,
} from '../locomotionPresetConfig';
import {
  forEachSurfaceProbePoint,
  getSurfaceProbePointCount,
} from '../surfaceProbeSets';
import { getShotBlueprint, getTurretBlueprint, getUnitBlueprint, getUnitLocomotion } from './index';
import { getAllUnitBlueprints } from './units';
import rawLocomotionConfig from '../locomotionConfig.json';
import { deterministicMath as DMath } from '../deterministicMath';

type AuthoredFluidPhysics = NonNullable<LocomotionBlueprint['physics']['air']>;

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

function assertSurfaceLiftDefaultsMatchConfig(): void {
  const {
    referenceDistanceWorld,
    minimumDistanceWorld,
    distanceExponent,
    probeAggregation,
  } = rawLocomotionConfig.surfaceLiftDefaults;
  assertContract(
    Number.isFinite(referenceDistanceWorld) && referenceDistanceWorld > 0,
    'surfaceLiftDefaults.referenceDistanceWorld must be positive',
  );
  assertContract(
    Number.isFinite(minimumDistanceWorld) && minimumDistanceWorld > 0,
    'surfaceLiftDefaults.minimumDistanceWorld must be positive',
  );
  assertContract(
    Number.isFinite(distanceExponent) && distanceExponent > 0 && distanceExponent <= 1,
    'surfaceLiftDefaults.distanceExponent must be finite in (0, 1]',
  );
  assertContract(
    isSurfaceProbeAggregation(probeAggregation),
    'surfaceLiftDefaults.probeAggregation must be average or max',
  );
  assertEqual(
    getSurfaceLiftDistanceResponse(4),
    DMath.pow(referenceDistanceWorld / 4, distanceExponent),
    'surface lift uses the configured power-law distance response',
  );
  assertEqual(
    getSurfaceLiftDistanceResponse(minimumDistanceWorld / 2),
    DMath.pow(referenceDistanceWorld / minimumDistanceWorld, distanceExponent),
    'surface lift clamps distance before applying the shared power law',
  );
  const averageAggregate = accumulateSurfaceProbeResponse(
    accumulateSurfaceProbeResponse(0, 0.25, 'average'),
    0.75,
    'average',
  );
  assertEqual(
    finalizeSurfaceProbeResponse(averageAggregate, 2, 'average'),
    0.5,
    'average probe aggregation averages nonlinear per-probe responses',
  );
  const maxAggregate = accumulateSurfaceProbeResponse(
    accumulateSurfaceProbeResponse(0, 0.25, 'max'),
    0.75,
    'max',
  );
  assertEqual(
    finalizeSurfaceProbeResponse(maxAggregate, 2, 'max'),
    0.75,
    'max probe aggregation selects the strongest nonlinear per-probe response',
  );
  assertContract(
    !surfaceProbeUsesWaterSurface(0, 0) && surfaceProbeUsesWaterSurface(-1, 0),
    'air lift probes choose ground at/above water level and water below it',
  );
}

function assertSurfaceLiftGroundSupportContract(): void {
  assertEqual(
    resolveSurfaceLiftGroundZ({ groundZ: 0, materialKind: 'water' }, -240),
    -240,
    'surface-lift ground probes resolve water material to the terrain bed',
  );
  assertEqual(
    resolveSurfaceLiftGroundZ({ groundZ: 80, materialKind: 'solid' }, -240),
    80,
    'surface-lift ground probes preserve a real solid support above the terrain bed',
  );
}

function assertAllLiftObjectsAreExplicit(): void {
  for (const unit of getAllUnitBlueprints()) {
    const id = unit.unitBlueprintId;
    const { air, water } = unit.locomotion.physics;
    assertContract(air !== undefined, `${id} explicitly authors physics.air`);
    assertContract(water !== undefined, `${id} explicitly authors physics.water`);
    assertContract(
      Object.prototype.hasOwnProperty.call(air.lift, 'liftForceFromGroundSurface') &&
        Object.prototype.hasOwnProperty.call(air.lift, 'liftForceFromWaterSurface') &&
        Object.prototype.hasOwnProperty.call(air.lift, 'gravityCounterRatio'),
      `${id} explicitly authors every air lift value, including inert zeroes`,
    );
    assertContract(
      Object.prototype.hasOwnProperty.call(water.lift, 'liftForceFromGroundSurface') &&
        Object.prototype.hasOwnProperty.call(water.lift, 'gravityCounterRatio'),
      `${id} explicitly authors every water lift value, including inert zeroes`,
    );
    assertContract(
      !Object.prototype.hasOwnProperty.call(water.lift, 'liftForceFromWaterSurface'),
      `${id} does not invent a water-surface source inside the water medium`,
    );
  }
}

function sampleProbeLayout(setId: UnitLocomotion['surfaceProbeSetId'], bodyRadius: number): string {
  const probes: string[] = [];
  const count = forEachSurfaceProbePoint(
    setId,
    10,
    20,
    1,
    0,
    bodyRadius,
    (x, y, role) => {
      probes.push(`${role}:${x}:${y}`);
    },
  );
  assertEqual(count, getSurfaceProbePointCount(setId), `${setId} visits every configured point`);
  return probes.join('|');
}

function assertSurfaceProbeLayouts(): void {
  assertEqual(sampleProbeLayout('1-point', 10), 'center:10:20', '1-point samples body center');
  assertEqual(
    sampleProbeLayout('5-points', 10),
    'center:10:20|forward:20:20|rear:0:20|side:10:30|side:10:10',
    '5-points samples body center plus one body radius in four cardinal directions',
  );
  assertEqual(
    sampleProbeLayout('8-points', 0),
    'center:10:20|forward:235:20|forward:460:20|forward:685:20|forward:910:20|side:10:245|side:10:-205|rear:-215:20',
    '8-points preserves the existing four-step lookahead with side and rear probes',
  );
  for (const presetId of ['wheels', 'treads', 'legs']) {
    assertEqual(
      getLocomotionPreset(presetId).physics.surfaceProbeSetId,
      '1-point',
      `${presetId} uses center sampling`,
    );
  }
  for (const presetId of ['amphibiousTreads', 'swim']) {
    assertEqual(
      getLocomotionPreset(presetId).physics.surfaceProbeSetId,
      '5-points',
      `${presetId} uses footprint sampling`,
    );
  }
  for (const presetId of ['flippers', 'hover', 'flying']) {
    assertEqual(
      getLocomotionPreset(presetId).physics.surfaceProbeSetId,
      '8-points',
      `${presetId} preserves lookahead sampling`,
    );
  }
}

function assertMobilityTuningIntent(): void {
  const wheels = getLocomotionPreset('wheels').physics;
  const treads = getLocomotionPreset('treads').physics;
  const legs = getLocomotionPreset('legs').physics;
  const flippers = getLocomotionPreset('flippers').physics;
  const swim = getLocomotionPreset('swim').physics;
  const hover = getLocomotionPreset('hover').physics;
  const flying = getLocomotionPreset('flying').physics;

  assertContract(
    wheels.ground.propulsion.driveForce > 0 && wheels.ground.contact.surfaceGrip >= 0.55,
    'wheels keep ground drive and their grip envelope',
  );
  assertContract(
    treads.ground.propulsion.driveForce > 0 && treads.ground.contact.surfaceGrip >= 0.85,
    'treads keep ground drive and their grip envelope',
  );
  assertContract(
    legs.ground.propulsion.driveForce > 0 && legs.ground.contact.surfaceGrip >= 1,
    'legs keep ground drive without weakening contact grip',
  );
  assertEqual(
    flippers.ground.propulsion.driveForce,
    legs.ground.propulsion.driveForce,
    'flippers inherit leg-family ground propulsion',
  );
  assertContract(
    flying.air.resistance.directionalScale.forward >= 0.5 &&
      flying.air.resistance.directionalScale.forward <
        flying.air.resistance.directionalScale.lateral,
    'flying keeps a lower cruise speed while remaining laterally draggy',
  );
  assertContract(
    flying.air.propulsion.forceCoupling >= 3,
    'flying speed tuning must not remove air turn authority',
  );
  for (const [label, fluid] of [
    ['flippers.water', flippers.water],
    ['swim.water', swim.water],
    ['hover.air', hover.air],
    ['flying.air', flying.air],
  ] as const) {
    assertContract(
      fluid.surfaceLiftResponse.randomizationAmount === 0 &&
        fluid.surfaceLiftResponse.ema <= 0.1 &&
        fluid.resistance.directionalScale.vertical >= 4,
      `${label} keeps the stable, strongly damped surface-lift tuning`,
    );
  }
}

function assertGlobalFrictionContract(): void {
  for (const medium of LOCOMOTION_MEDIUM_NAMES) {
    assertEqual(
      LOCOMOTION_FRICTION_BY_MEDIUM[medium],
      rawLocomotionConfig.mediumDefaults[medium].resistance.linearFriction,
      `${medium} global friction follows locomotionConfig.json`,
    );
  }
  for (const presetId of Object.keys(rawLocomotionConfig.presets)) {
    const preset = getLocomotionPreset(presetId);
    for (const medium of LOCOMOTION_MEDIUM_NAMES) {
      const physics = preset.physics[medium];
      assertContract(
        physics.resistance.frictionMultiplier >= 0 &&
          physics.resistance.frictionMultiplier <= 1,
        `${presetId}.${medium}.frictionMultiplier remains in [0, 1]`,
      );
      assertContract(
        !Object.prototype.hasOwnProperty.call(physics.resistance, 'linearFriction'),
        `${presetId}.${medium} does not duplicate global friction`,
      );
      assertContract(
        getLocomotionEffectiveFriction(medium, physics) <=
          LOCOMOTION_FRICTION_BY_MEDIUM[medium],
        `${presetId}.${medium} effective friction cannot exceed its global medium value`,
      );
    }
  }
  assertEqual(
    getLocomotionEffectiveFriction('air', getLocomotionPreset('swim').physics.air),
    1,
    'swim preserves its effective air friction',
  );
  assertEqual(
    getLocomotionEffectiveFriction('water', getLocomotionPreset('flippers').physics.water),
    5,
    'flippers preserve their effective water friction',
  );
  assertEqual(
    getLocomotionEffectiveFriction('water', getLocomotionPreset('swim').physics.water),
    2.5,
    'swim preserves its effective water friction',
  );
}

function assertRuntimeGroundMatchesPreset(
  runtime: UnitLocomotionGroundPhysics,
  preset: LocomotionPresetConfig['physics']['ground'],
  label: string,
): void {
  assertEqual(JSON.stringify(runtime), JSON.stringify(preset), `${label} follows its ground preset`);
}

function assertRuntimeFluidMatchesSources(
  runtime: UnitLocomotionFluidPhysics,
  authored: AuthoredFluidPhysics | undefined,
  preset: LocomotionPresetConfig['physics']['air'],
  label: string,
): void {
  assertEqual(
    JSON.stringify(runtime.propulsion),
    JSON.stringify(preset.propulsion),
    `${label} propulsion follows locomotionConfig.json`,
  );
  assertEqual(
    JSON.stringify(runtime.resistance),
    JSON.stringify(preset.resistance),
    `${label} resistance follows locomotionConfig.json`,
  );
  assertEqual(
    runtime.lift.liftForceFromGroundSurface,
    authored?.lift.liftForceFromGroundSurface ?? 0,
    `${label} lift force from ground surface follows unit blueprint lift`,
  );
  assertEqual(
    runtime.lift.liftForceFromWaterSurface,
    authored?.lift.liftForceFromWaterSurface ?? 0,
    `${label} lift force from water surface follows unit blueprint lift`,
  );
  assertEqual(
    runtime.lift.gravityCounterRatio,
    authored?.lift.gravityCounterRatio ?? 0,
    `${label} gravity counter ratio follows unit blueprint lift`,
  );
  assertEqual(
    runtime.lift.randomizationAmount,
    preset.surfaceLiftResponse.randomizationAmount,
    `${label} lift randomization follows locomotionConfig.json`,
  );
  assertEqual(
    runtime.lift.ema,
    preset.surfaceLiftResponse.ema,
    `${label} lift EMA follows locomotionConfig.json`,
  );
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
  assertRuntimeGroundMatchesPreset(
    locomotion.physics.ground,
    typeConfig.physics.ground,
    `${unitBlueprintId} ground`,
  );
  assertRuntimeFluidMatchesSources(
    locomotion.physics.air,
    authored.physics.air,
    typeConfig.physics.air,
    `${unitBlueprintId} air`,
  );
  assertRuntimeFluidMatchesSources(
    locomotion.physics.water,
    authored.physics.water,
    typeConfig.physics.water,
    `${unitBlueprintId} water`,
  );
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
    locomotion.surfaceProbeSetId,
    typeConfig.physics.surfaceProbeSetId,
    `${unitBlueprintId} surface probe set follows locomotionConfig.json`,
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
  assertSurfaceLiftDefaultsMatchConfig();
  assertSurfaceLiftGroundSupportContract();
  assertAllLiftObjectsAreExplicit();
  assertSurfaceProbeLayouts();
  assertMobilityTuningIntent();
  assertGlobalFrictionContract();

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
    nonAmphibiousLocomotion.physics.ground.propulsion.driveForce,
    mongooseLocomotion.physics.ground.propulsion.driveForce,
    'units sharing the wheels preset receive the same ground drive force',
  );
  assertContract(
    jackalBlueprint.mass < mongooseBlueprint.mass &&
      nonAmphibiousLocomotion.physics.ground.propulsion.driveForce /
        jackalBlueprint.mass >
        mongooseLocomotion.physics.ground.propulsion.driveForce / mongooseBlueprint.mass,
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
    seaTurtleLocomotion.physics.water.propulsion.driveForce *
    seaTurtleLocomotion.physics.water.propulsion.forceCoupling;
  const seaTurtleGroundDrive =
    seaTurtleLocomotion.physics.ground.propulsion.driveForce *
    seaTurtleLocomotion.physics.ground.propulsion.forceCoupling;
  assertEqual(
    seaTurtleWaterDrive,
    300,
    'flippers use the normalized Sea Turtle coupled water drive',
  );
  assertContract(
    seaTurtleWaterDrive < seaTurtleGroundDrive,
    'Sea Turtle water propulsion accounts for the absence of a ground-grip force cap',
  );
  assertContract(
    seaTurtleLocomotion.physics.water.lift.liftForceFromGroundSurface > 0 &&
      seaTurtleLocomotion.physics.water.lift.randomizationAmount === 0 &&
      seaTurtleLocomotion.physics.water.lift.ema > 0,
    'Sea Turtle water lift owns active upward force and responsive, noise-free EMA smoothing',
  );
  const seaTurtleRoutes = resolveLocomotionRouteCapabilities(seaTurtleLocomotion);
  assertContract(
    seaTurtleRoutes.allowOnGround && seaTurtleRoutes.allowInWater && !seaTurtleRoutes.allowInAir,
    'flippers route on ground and in water, never through air',
  );
  const orcaLocomotion = assertRuntimeLocomotionMatchesSources('unitOrca');
  const orcaBlueprint = getUnitBlueprint('unitOrca');
  assertEqual(
    orcaBlueprint.locomotion.type,
    'swim',
    'Orca owns the independent swim visual rig',
  );
  assertEqual(
    orcaLocomotion.physicsPresetId,
    'swim',
    'Orca owns the water-only swim physics preset',
  );
  assertEqual(
    orcaBlueprint.turrets[0]?.turretBlueprintId,
    'turretTorpedo',
    'Orca mounts its dedicated torpedo turret',
  );
  const torpedoTurret = getTurretBlueprint('turretTorpedo');
  assertEqual(
    torpedoTurret.emissionBlueprintId,
    'shotTorpedo',
    'the dedicated torpedo turret emits the dedicated torpedo shot',
  );
  assertEqual(
    getShotBlueprint('shotTorpedo').physicsMedium,
    'water-only',
    'the dedicated torpedo shot remains water-only',
  );
  const orcaRoutes = resolveLocomotionRouteCapabilities(orcaLocomotion);
  assertContract(
    !orcaRoutes.allowOnGround && orcaRoutes.allowInWater && !orcaRoutes.allowInAir,
    'Orca routes only through the water medium',
  );
  assertContract(
    orcaLocomotion.physics.water.propulsion.driveForce > 0 &&
      orcaLocomotion.physics.ground.propulsion.driveForce === 0 &&
      orcaLocomotion.physics.air.propulsion.driveForce === 0,
    'Orca propulsion is owned exclusively by its water medium preset',
  );
  assertContract(
    orcaLocomotion.physics.water.lift.liftForceFromGroundSurface > 0 &&
      orcaLocomotion.physics.water.lift.randomizationAmount === 0 &&
      orcaLocomotion.physics.water.lift.ema > 0,
    'Orca water lift owns active upward force and responsive, noise-free EMA smoothing',
  );
  const eagleAirLiftLocomotion = assertRuntimeLocomotionMatchesSources('unitEagle');
  assertContract(
    eagleAirLiftLocomotion.physics.air.lift.liftForceFromGroundSurface > 0 &&
      eagleAirLiftLocomotion.physics.air.lift.liftForceFromWaterSurface > 0,
    'air lift explicitly owns independent ground-surface and water-surface force sources',
  );

  const incompleteAirLift = cloneLocomotionBlueprint(
    getUnitBlueprint('unitEagle').locomotion,
  );
  delete incompleteAirLift.physics.air?.lift.liftForceFromWaterSurface;
  expectLocomotionError(
    incompleteAirLift,
    'air lift must explicitly author both liftForceFromGroundSurface and ' +
      'liftForceFromWaterSurface',
  );

  const missingAirObject = cloneLocomotionBlueprint(
    getUnitBlueprint('unitHippo').locomotion,
  );
  delete (missingAirObject.physics as { air?: AuthoredFluidPhysics }).air;
  expectLocomotionError(
    missingAirObject,
    'air and water lift objects must always be explicitly authored',
  );

  const invalidWaterSurfaceLift = cloneLocomotionBlueprint(
    getUnitBlueprint('unitOrca').locomotion,
  );
  const invalidWaterLift = invalidWaterSurfaceLift.physics.water?.lift;
  assertContract(invalidWaterLift !== undefined, 'Orca authors a water lift object');
  invalidWaterLift.liftForceFromWaterSurface = 1;
  expectLocomotionError(
    invalidWaterSurfaceLift,
    'water lift may only be sourced from the ground surface',
  );
  assertEqual(
    hippoBlueprint.locomotion.type,
    'treads',
    'Hippo remains the amphibious tread unit',
  );

  const strayUnitMediumConfig = cloneLocomotionBlueprint(hippoBlueprint.locomotion);
  (strayUnitMediumConfig.physics.water as AuthoredFluidPhysics & {
    propulsion: { driveForce: number };
  }).propulsion = { driveForce: 1 };
  expectLocomotionError(strayUnitMediumConfig, 'moved to locomotionConfig.json');
}
