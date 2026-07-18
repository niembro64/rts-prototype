import type { UnitLocomotionBlueprint } from './types';
import type {
  UnitLocomotion,
  UnitLocomotionFluidPhysics,
  UnitLocomotionGroundPhysics,
} from '@/types/unitLocomotionTypes';
import {
  cloneUnitLocomotion,
  createUnitLocomotion,
} from '../unitLocomotion';
import {
  getSurfaceLiftDistanceResponse,
  getSurfaceLiftDistanceToSurfaceWorld,
} from '../surfaceLiftDistanceResponse';
import { resolveSurfaceLiftGroundZ } from '../surfaceLiftGroundSupport';
import {
  accumulateSurfaceProbeProposedForce,
  finalizeSurfaceProbeProposedForce,
  surfaceProbeUsesWaterSurface,
} from '../surfaceProbeAggregation';
import { resolveUnitLocomotionRouteCapabilities } from '../unitLocomotionNavigation';
import {
  UNIT_LOCOMOTION_FORCE_SCALE,
  UNIT_LOCOMOTION_FRICTION_BY_MEDIUM,
  UNIT_LOCOMOTION_MEDIUM_NAMES,
  SURFACE_LIFT_FORCE_MULTIPLIER,
  SURFACE_LIFT_PROBE_AGGREGATION_MODE,
  getUnitLocomotionEffectiveFriction,
  getUnitLocomotionPreset,
  type UnitLocomotionPresetConfig,
} from '../unitLocomotionPresetConfig';
import {
  forEachSurfaceProbePoint,
  getSurfaceProbePointCount,
} from '../surfaceProbeSets';
import { getShotBlueprint, getTurretBlueprint, getUnitBlueprint, getUnitLocomotion } from './index';
import { getAllUnitBlueprints } from './units';
import rawLocomotionConfig from '../unitLocomotionConfig.json';
import { deterministicMath as DMath } from '../deterministicMath';
import { getShotLocomotionPreset } from '../shotLocomotion';
import {
  GRAVITY,
  UNIT_GROUND_FRICTION_PER_60HZ_FRAME,
  UNIT_LOCOMOTION_FORCE_REFERENCE_MASS,
  UNIT_MASS_MULTIPLIER,
  UNIT_THRUST_MULTIPLIER_GAME,
} from '@/config';

type AuthoredFluidPhysics = NonNullable<UnitLocomotionBlueprint['physics']['air']>;

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

function cloneUnitLocomotionBlueprint(locomotion: UnitLocomotionBlueprint): UnitLocomotionBlueprint {
  return JSON.parse(JSON.stringify(locomotion)) as UnitLocomotionBlueprint;
}

function expectLocomotionError(
  blueprint: UnitLocomotionBlueprint,
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

function assertSurfaceLiftDefaultsMatchConfig(): void {
  const {
    minimumDistanceWorld,
    forceMultiplier,
    probeAggregation,
  } = rawLocomotionConfig.surfaceLiftDefaults;
  assertContract(
    Number.isFinite(minimumDistanceWorld) && minimumDistanceWorld > 0,
    'surfaceLiftDefaults.minimumDistanceWorld must be positive',
  );
  assertContract(
    Number.isFinite(forceMultiplier) && forceMultiplier > 0,
    'surfaceLiftDefaults.forceMultiplier must be positive',
  );
  assertContract(
    probeAggregation === 'average' || probeAggregation === 'max',
    'surfaceLiftDefaults.probeAggregation must select average or max',
  );
  assertEqual(
    SURFACE_LIFT_PROBE_AGGREGATION_MODE,
    probeAggregation,
    'runtime surface lift aggregation mode follows config',
  );
  assertEqual(
    SURFACE_LIFT_FORCE_MULTIPLIER,
    forceMultiplier,
    'runtime surface lift force multiplier follows config',
  );
  assertEqual(
    getSurfaceLiftDistanceResponse(4),
    1 / 4,
    'surface lift is the reciprocal of probe distance',
  );
  assertEqual(
    getSurfaceLiftDistanceResponse(minimumDistanceWorld / 2),
    1 / minimumDistanceWorld,
    'surface lift clamps distance before taking its reciprocal',
  );
  assertEqual(
    getSurfaceLiftDistanceToSurfaceWorld(25, 5),
    20,
    'probe debug and force response share the signed body-to-surface distance',
  );
  assertEqual(
    getSurfaceLiftDistanceToSurfaceWorld(5, 25),
    minimumDistanceWorld,
    'probe debug and force response share the minimum-distance clamp below a surface',
  );
  const minimumDistanceResponse = 1 / minimumDistanceWorld;
  for (const invalidProbeDistance of [0, -1, Number.NEGATIVE_INFINITY, Number.NaN]) {
    assertEqual(
      getSurfaceLiftDistanceResponse(invalidProbeDistance),
      minimumDistanceResponse,
      `probe distance ${String(invalidProbeDistance)} resolves through the configured positive minimum`,
    );
  }
  const hotProbeForce = 100;
  const averageAggregate = accumulateSurfaceProbeProposedForce(
    accumulateSurfaceProbeProposedForce(0, hotProbeForce, 'average'),
    0,
    'average',
  );
  assertEqual(
    finalizeSurfaceProbeProposedForce(averageAggregate, 2, 'average'),
    hotProbeForce / 2,
    'average mode is the arithmetic mean of proposed probe forces',
  );
  const maxAggregate = accumulateSurfaceProbeProposedForce(
    accumulateSurfaceProbeProposedForce(0, hotProbeForce, 'max'),
    hotProbeForce / 2,
    'max',
  );
  assertEqual(
    finalizeSurfaceProbeProposedForce(maxAggregate, 2, 'max'),
    hotProbeForce,
    'max mode is the strict strongest proposed probe force',
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
    const { air, water } = unit.unitLocomotion.physics;
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
      getUnitLocomotionPreset(presetId).physics.surfaceProbeSetId,
      '1-point',
      `${presetId} uses center sampling`,
    );
  }
  for (const presetId of ['amphibiousTreads', 'swim']) {
    assertEqual(
      getUnitLocomotionPreset(presetId).physics.surfaceProbeSetId,
      '5-points',
      `${presetId} uses footprint sampling`,
    );
  }
  for (const presetId of ['flippers', 'hover', 'flying']) {
    assertEqual(
      getUnitLocomotionPreset(presetId).physics.surfaceProbeSetId,
      '8-points',
      `${presetId} preserves lookahead sampling`,
    );
  }
}

function assertMobilityTuningIntent(): void {
  const wheels = getUnitLocomotionPreset('wheels').physics;
  const treads = getUnitLocomotionPreset('treads').physics;
  const legs = getUnitLocomotionPreset('legs').physics;
  const flippers = getUnitLocomotionPreset('flippers').physics;
  const swim = getUnitLocomotionPreset('swim').physics;
  const hover = getUnitLocomotionPreset('hover').physics;
  const flying = getUnitLocomotionPreset('flying').physics;

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
  assertContract(
    flippers.ground.propulsion.driveForce < legs.ground.propulsion.driveForce &&
      flippers.ground.contact.surfaceGrip < legs.ground.contact.surfaceGrip,
    'flippers deliberately trade leg-family land drive and grip for swimming authority',
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
    ['swim.air', swim.air],
    ['swim.water', swim.water],
    ['hover.air', hover.air],
    ['flying.air', flying.air],
  ] as const) {
    assertContract(
      fluid.surfaceLiftResponse.randomizationAmount >= 0 &&
        fluid.surfaceLiftResponse.randomizationAmount <= 1 &&
        fluid.surfaceLiftResponse.ema >= 0 &&
        fluid.surfaceLiftResponse.ema < 1,
      `${label} owns a bounded surface-lift force response`,
    );
  }
  for (const [label, fluid] of [
    ['flippers.water', flippers.water],
    ['swim.water', swim.water],
    ['hover.air', hover.air],
    ['flying.air', flying.air],
  ] as const) {
    assertContract(
      fluid.resistance.directionalScale.vertical >= 4,
      `${label} keeps its strongly damped vertical resistance tuning`,
    );
  }
}

function assertGlobalFrictionContract(): void {
  for (const medium of UNIT_LOCOMOTION_MEDIUM_NAMES) {
    assertEqual(
      UNIT_LOCOMOTION_FRICTION_BY_MEDIUM[medium],
      rawLocomotionConfig.mediumDefaults[medium].resistance.linearFriction,
      `${medium} global friction follows unitLocomotionConfig.json`,
    );
  }
  for (const presetId of Object.keys(rawLocomotionConfig.presets)) {
    const preset = getUnitLocomotionPreset(presetId);
    for (const medium of UNIT_LOCOMOTION_MEDIUM_NAMES) {
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
        getUnitLocomotionEffectiveFriction(medium, physics) <=
          UNIT_LOCOMOTION_FRICTION_BY_MEDIUM[medium],
        `${presetId}.${medium} effective friction cannot exceed its global medium value`,
      );
    }
  }
  assertEqual(
    getUnitLocomotionEffectiveFriction('air', getUnitLocomotionPreset('swim').physics.air),
    1,
    'swim preserves its effective air friction',
  );
  assertEqual(
    getUnitLocomotionEffectiveFriction('water', getUnitLocomotionPreset('flippers').physics.water),
    5,
    'flippers preserve their effective water friction',
  );
  assertEqual(
    getUnitLocomotionEffectiveFriction('water', getUnitLocomotionPreset('swim').physics.water),
    2.5,
    'swim preserves its effective water friction',
  );
}

function assertRuntimeGroundMatchesPreset(
  runtime: UnitLocomotionGroundPhysics,
  preset: UnitLocomotionPresetConfig['physics']['ground'],
  label: string,
): void {
  assertEqual(JSON.stringify(runtime), JSON.stringify(preset), `${label} follows its ground preset`);
}

function assertRuntimeFluidMatchesSources(
  runtime: UnitLocomotionFluidPhysics,
  authored: AuthoredFluidPhysics | undefined,
  preset: UnitLocomotionPresetConfig['physics']['air'],
  label: string,
): void {
  assertEqual(
    JSON.stringify(runtime.propulsion),
    JSON.stringify(preset.propulsion),
    `${label} propulsion follows unitLocomotionConfig.json`,
  );
  assertEqual(
    JSON.stringify(runtime.resistance),
    JSON.stringify(preset.resistance),
    `${label} resistance follows unitLocomotionConfig.json`,
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
    `${label} lift randomization follows unitLocomotionConfig.json`,
  );
  assertEqual(
    runtime.lift.ema,
    preset.surfaceLiftResponse.ema,
    `${label} lift EMA follows unitLocomotionConfig.json`,
  );
}

function assertRuntimeLocomotionMatchesSources(unitBlueprintId: string): UnitLocomotion {
  const unitBlueprint = getUnitBlueprint(unitBlueprintId);
  const locomotion = getUnitLocomotion(unitBlueprintId);
  const authored = unitBlueprint.unitLocomotion;
  const typeConfig = getUnitLocomotionPreset(authored.physicsPresetId);

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
    `${unitBlueprintId} idle air drive follows unitLocomotionConfig.json`,
  );
  assertEqual(
    locomotion.forwardForceRequiresFacing,
    typeConfig.physics.forwardForceRequiresFacing,
    `${unitBlueprintId} forward force gate follows unitLocomotionConfig.json`,
  );
  assertEqual(
    locomotion.driveForceScalesWithFacing,
    typeConfig.physics.driveForceScalesWithFacing,
    `${unitBlueprintId} facing force scaling follows unitLocomotionConfig.json`,
  );
  assertEqual(
    locomotion.maintainFullThrustAtWaypoints,
    typeConfig.physics.maintainFullThrustAtWaypoints,
    `${unitBlueprintId} waypoint thrust mode follows unitLocomotionConfig.json`,
  );
  assertEqual(
    locomotion.surfaceProbeSetId,
    typeConfig.physics.surfaceProbeSetId,
    `${unitBlueprintId} surface probe set follows unitLocomotionConfig.json`,
  );
  return locomotion;
}

function assertClonedLocomotionMatchesSource(
  clone: UnitLocomotion,
  source: UnitLocomotion,
  label: string,
): void {
  assertEqual(JSON.stringify(clone), JSON.stringify(source), `${label} clone preserves runtime locomotion`);
}

export function runUnitLocomotionContractTest(): void {
  assertSurfaceLiftDefaultsMatchConfig();
  assertSurfaceLiftGroundSupportContract();
  assertAllLiftObjectsAreExplicit();
  assertSurfaceProbeLayouts();
  assertMobilityTuningIntent();
  assertGlobalFrictionContract();

  const hippoBlueprint = getUnitBlueprint('unitHippo');
  const hippoLocomotion = assertRuntimeLocomotionMatchesSources('unitHippo');
  const hippoRoutes = resolveUnitLocomotionRouteCapabilities(hippoLocomotion);
  assertContract(hippoRoutes.allowOnGround, 'Hippo allows on-ground routes');
  assertContract(hippoRoutes.allowInWater, 'Hippo allows in-water routes');
  assertContract(!hippoRoutes.allowInAir, 'Hippo does not allow in-air routes');
  const clonedHippoLocomotion = cloneUnitLocomotion(hippoLocomotion);
  assertClonedLocomotionMatchesSource(clonedHippoLocomotion, hippoLocomotion, 'Hippo');

  const eagleLocomotion = assertRuntimeLocomotionMatchesSources('unitEagle');
  const eagleRoutes = resolveUnitLocomotionRouteCapabilities(eagleLocomotion);
  assertContract(!eagleRoutes.allowOnGround, 'Eagle does not allow on-ground routes');
  assertContract(!eagleRoutes.allowInWater, 'Eagle does not allow in-water routes');
  assertContract(eagleRoutes.allowInAir, 'Eagle allows in-air routes');
  assertClonedLocomotionMatchesSource(cloneUnitLocomotion(eagleLocomotion), eagleLocomotion, 'Eagle');

  const jackalBlueprint = getUnitBlueprint('unitJackal');
  const nonAmphibiousLocomotion = assertRuntimeLocomotionMatchesSources('unitJackal');
  const jackalRoutes = resolveUnitLocomotionRouteCapabilities(nonAmphibiousLocomotion);
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
  const lynxRoutes = resolveUnitLocomotionRouteCapabilities(
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
    seaTurtleBlueprint.unitLocomotion.type,
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
    seaTurtleWaterDrive > seaTurtleGroundDrive,
    'Sea Turtle couples more drive force through water than through dry-land flippers',
  );
  assertContract(
    seaTurtleLocomotion.physics.ground.contact.surfaceGrip <= 0.15,
    'Sea Turtle flippers have low dry-land grip so land speed stays below swim speed',
  );
  const seaTurtlePhysicsMass = seaTurtleBlueprint.mass * UNIT_MASS_MULTIPLIER;
  const driveAcceleration = (driveForce: number, forceCoupling: number): number =>
    driveForce * forceCoupling * UNIT_THRUST_MULTIPLIER_GAME *
    UNIT_LOCOMOTION_FORCE_REFERENCE_MASS / UNIT_LOCOMOTION_FORCE_SCALE *
    1_000_000 / seaTurtlePhysicsMass;
  const groundDriveAcceleration = Math.min(
    driveAcceleration(
      seaTurtleLocomotion.physics.ground.propulsion.driveForce,
      seaTurtleLocomotion.physics.ground.propulsion.forceCoupling,
    ),
    GRAVITY * seaTurtleLocomotion.physics.ground.contact.surfaceGrip,
  );
  const groundDamp = DMath.pow(
    1 - UNIT_GROUND_FRICTION_PER_60HZ_FRAME,
    seaTurtleLocomotion.physics.ground.contact.tangentDamping,
  );
  const groundEquilibriumSpeed =
    groundDriveAcceleration * groundDamp / (60 * (1 - groundDamp));
  const waterDriveAcceleration = driveAcceleration(
    seaTurtleLocomotion.physics.water.propulsion.driveForce,
    seaTurtleLocomotion.physics.water.propulsion.forceCoupling,
  );
  const waterForwardScale = seaTurtleLocomotion.physics.water.resistance.directionalScale.forward;
  const waterLinearDrag =
    getUnitLocomotionEffectiveFriction('water', seaTurtleLocomotion.physics.water) *
    waterForwardScale;
  const waterQuadraticDrag =
    seaTurtleLocomotion.physics.water.resistance.quadraticDrag * waterForwardScale;
  const waterEquilibriumSpeed = waterQuadraticDrag > 0
    ? (
        DMath.sqrt(waterLinearDrag * waterLinearDrag + 4 * waterQuadraticDrag * waterDriveAcceleration) -
        waterLinearDrag
      ) / (2 * waterQuadraticDrag)
    : waterDriveAcceleration / waterLinearDrag;
  assertContract(
    waterEquilibriumSpeed > groundEquilibriumSpeed,
    `Sea Turtle swim equilibrium speed (${waterEquilibriumSpeed}) must exceed land speed (${groundEquilibriumSpeed})`,
  );
  assertContract(
    seaTurtleLocomotion.physics.water.lift.liftForceFromGroundSurface > 0 &&
      seaTurtleLocomotion.physics.water.lift.gravityCounterRatio === 1 &&
      seaTurtleLocomotion.physics.air.lift.liftForceFromWaterSurface > 0,
    'Sea Turtle holds the waterline with explicit buoyancy and air-water surface lift',
  );
  const seaTurtleRoutes = resolveUnitLocomotionRouteCapabilities(seaTurtleLocomotion);
  assertContract(
    seaTurtleRoutes.allowOnGround && seaTurtleRoutes.allowInWater && !seaTurtleRoutes.allowInAir,
    'flippers route on ground and in water, never through air',
  );
  const orcaLocomotion = assertRuntimeLocomotionMatchesSources('unitOrca');
  const orcaBlueprint = getUnitBlueprint('unitOrca');
  assertEqual(
    orcaBlueprint.unitLocomotion.type,
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
    getShotLocomotionPreset(
      getShotBlueprint('shotTorpedo').shotLocomotionPresetId,
    ).media.water.operational,
    true,
    'the dedicated torpedo shot remains water-only',
  );
  const orcaRoutes = resolveUnitLocomotionRouteCapabilities(orcaLocomotion);
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
      orcaLocomotion.physics.water.lift.gravityCounterRatio > 0 &&
      orcaLocomotion.physics.water.lift.gravityCounterRatio < 1 &&
      orcaLocomotion.physics.air.lift.liftForceFromWaterSurface === 0,
    'Orca retains water-only depth buoyancy rather than a surface-swimmer controller',
  );
  const eagleAirLiftLocomotion = assertRuntimeLocomotionMatchesSources('unitEagle');
  assertContract(
    eagleAirLiftLocomotion.physics.air.lift.liftForceFromGroundSurface > 0 &&
      eagleAirLiftLocomotion.physics.air.lift.liftForceFromWaterSurface > 0,
    'air lift explicitly owns independent ground-surface and water-surface force sources',
  );

  const incompleteAirLift = cloneUnitLocomotionBlueprint(
    getUnitBlueprint('unitEagle').unitLocomotion,
  );
  delete incompleteAirLift.physics.air?.lift.liftForceFromWaterSurface;
  expectLocomotionError(
    incompleteAirLift,
    'air lift must explicitly author both liftForceFromGroundSurface and ' +
      'liftForceFromWaterSurface',
  );

  const missingAirObject = cloneUnitLocomotionBlueprint(
    getUnitBlueprint('unitHippo').unitLocomotion,
  );
  delete (missingAirObject.physics as { air?: AuthoredFluidPhysics }).air;
  expectLocomotionError(
    missingAirObject,
    'air and water lift objects must always be explicitly authored',
  );

  const invalidWaterSurfaceLift = cloneUnitLocomotionBlueprint(
    getUnitBlueprint('unitOrca').unitLocomotion,
  );
  const invalidWaterLift = invalidWaterSurfaceLift.physics.water?.lift;
  assertContract(invalidWaterLift !== undefined, 'Orca authors a water lift object');
  invalidWaterLift.liftForceFromWaterSurface = 1;
  expectLocomotionError(
    invalidWaterSurfaceLift,
    'water lift may only be sourced from the ground surface',
  );
  assertEqual(
    hippoBlueprint.unitLocomotion.type,
    'treads',
    'Hippo remains the amphibious tread unit',
  );

  const strayUnitMediumConfig = cloneUnitLocomotionBlueprint(hippoBlueprint.unitLocomotion);
  (strayUnitMediumConfig.physics.water as AuthoredFluidPhysics & {
    propulsion: { driveForce: number };
  }).propulsion = { driveForce: 1 };
  expectLocomotionError(strayUnitMediumConfig, 'moved to unitLocomotionConfig.json');
}
