import { getTransformCosSin } from '../math';
import { deterministicMath as DMath } from './deterministicMath';
import { getBuildingBlueprint, getUnitBlueprint, TURRET_BLUEPRINTS } from './blueprints';
import { createBuildable } from './buildableHelpers';
import { CT_TURRET_STATE_ENGAGED } from '../sim-wasm/init';
import { DamageSystem } from './damage';
import { ForceAccumulator } from './ForceAccumulator';
import { spatialGrid } from './SpatialGrid';
import { beamIndex } from './BeamIndex';
import type { Entity, EntityId, PlayerId, Turret } from './types';
import { isProjectileShot, NO_ENTITY_ID } from './types';
import {
  checkProjectileCollisions,
  collectTurretRotationUnits,
  finalizePendingProjectileLaunchVelocities,
  fireTurrets,
  hasPendingProjectileLaunchVelocityFinalization,
  updateProjectiles,
  updateShieldState,
  updateTargetingAndFiringState,
  updateTurretRotation,
} from './combat';
import { getActiveShields } from './combat/shieldTurret';
import {
  getProjectileLaunchSpeed,
  isShieldSubmunitionTurret,
  resolveWeaponEmissionSocket,
  resolveWeaponWorldMount,
} from './combat/combatUtils';
import {
  SIGHT_DROP_GRACE_TICKS,
  turretIgnoresForceMaterialSightObstruction,
} from './combat/lineOfSight';
import { buildFreeForAllRoster } from './teamRoster';
import { resetProjectileBuffers } from './combat/projectileSystem';
import {
  readTurretCooldownForFire,
} from './combat/combatActivitySlab';
import {
  readCombatTargetingTurretFsmInto,
  stampCombatTargetingPool,
  stampShieldSurfacePool,
} from './combat/targetingInputStamping';
import { isAttackEmitter, isPassiveShieldFieldConfig } from './emitterKinds';
import { createProjectileConfigFromTurret } from './projectileConfigs';
import { getUnitGroundZ } from './unitGeometry';
import { isWaterAt, WATER_LEVEL } from './Terrain';
import type { WindState } from './wind';
import { WorldState } from './WorldState';
import {
  beamPulseCollisionPhaseForEntityId,
  beamPulseNeedsCollisionSample,
  canTurretTrackBeamPulse,
  consumeBeamPulseCollisionWindow,
  createBeamPulsePlan,
  evaluateBeamPulsePlan,
  getMaximumBeamPulseOnTimeMs,
  rollBeamPulseOffTimeMs,
  rollBeamPulseOnTimeMs,
  scheduleBeamPulseCollisionSamples,
} from './combat/beamPulse';
import {
  BEAM_PULSE_ACTIVE_OUTPUT_MULTIPLIER,
  BEAM_PULSE_COLLISION_SAMPLE_INTERVAL_TICKS,
  BEAM_PULSE_OFF_TIME_MS,
  BEAM_PULSE_OFF_TIME_RANDOMNESS,
  BEAM_PULSE_ON_TIME_MS,
  BEAM_PULSE_ON_TIME_RANDOMNESS,
} from '../../config';
import { rollTurretCooldownDuration } from './turretCooldown';
import { SHIELD_REFLECTION_ENTITY_BEAM } from './combat/reflectorBatch';

const TEST_UNIT_BLUEPRINT_ID = 'unitFormik';
const TEST_VERTICAL_ROCKET_UNIT_BLUEPRINT_ID = 'unitBadger';
const TEST_BEAM_UNIT_BLUEPRINT_ID = 'unitDaddy';
const STILL_AIR: WindState = { x: 0, y: 0, z: 0, speed: 0, angle: 0 };

function resetTurretHostIntegrationState(): void {
  spatialGrid.clear();
  beamIndex.clear();
  resetProjectileBuffers();
}

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[turret host integration] ${message}`);
  }
}

function assertNear(actual: number, expected: number, message: string): void {
  if (Math.abs(actual - expected) > 1e-6) {
    throw new Error(
      `[turret host integration] ${message}: expected ${expected}, got ${actual}`,
    );
  }
}

function getFirstAttackTurret(entity: Entity): { turret: Turret; turretIndex: number } {
  const turrets = entity.combat?.turrets;
  if (turrets === undefined) {
    throw new Error('[turret host integration] entity must have a combat assembly');
  }
  const turretIndex = turrets.findIndex((candidate) => candidate.config.kind === 'attack');
  if (turretIndex < 0) {
    throw new Error('[turret host integration] entity must mount an attack turret');
  }
  return { turret: turrets[turretIndex], turretIndex };
}

function assertLogicalTurretPresentationOwnership(): void {
  const forbiddenVisualFields = [
    'barrel',
    'radius',
    'headOnly',
    'shieldPanels',
  ] as const;
  for (const [turretId, blueprint] of Object.entries(TURRET_BLUEPRINTS)) {
    for (const field of forbiddenVisualFields) {
      assertContract(
        !Object.prototype.hasOwnProperty.call(blueprint, field),
        `${turretId} logical blueprint must not own visual field ${field}`,
      );
    }
  }

  for (const host of [getUnitBlueprint('unitHuman'), getUnitBlueprint('unitCommander')]) {
    for (const mount of host.turrets) {
      const logical = TURRET_BLUEPRINTS[mount.turretBlueprintId];
      assertContract(
        logical.kind === 'attack' ? mount.presentation !== null : mount.presentation === null,
        `${host.unitBlueprintId}/${mount.mountId} presentation ownership matches mounted role`,
      );
    }
  }
  const humanWeapon = getUnitBlueprint('unitHuman').turrets[0].presentation;
  assertContract(
    humanWeapon?.headRadius === 3 &&
      humanWeapon.barrel?.type === 'singleCylinderBarrel' &&
      humanWeapon.barrel.barrelLength === 2,
    'Human keeps the pre-migration light-gun physical representation on its host mount',
  );
  const commander = getUnitBlueprint('unitCommander');
  const commanderBeam = commander.turrets.find((mount) => mount.mountId === 'beam')?.presentation;
  const commanderDgun = commander.turrets.find((mount) => mount.mountId === 'disruptor')?.presentation;
  assertContract(
    // Head radius is absolute world units, so it tracks the host's authored
    // scale; barrelLength is a fraction of it and therefore does not.
    commanderBeam?.headRadius === 7.8 &&
      commanderBeam.barrel?.type === 'singleConeBarrel' &&
      commanderBeam.barrel.barrelLength === 1.2,
    'Commander keeps the pre-migration beam physical representation on its host mount',
  );
  assertContract(
    commanderDgun?.headRadius === null &&
      commanderDgun.barrel?.type === 'singleCylinderBarrel',
    'Commander keeps its body-integrated zero-head-radius D-gun presentation',
  );
  const antiAir = getBuildingBlueprint('towerAntiAir').turrets[0].presentation;
  assertContract(
    antiAir?.headRadius === 20 &&
      antiAir.barrel?.type === 'simpleMultiBarrel' &&
      antiAir.barrel.barrelCount === 6,
    'Anti-Air tower keeps its pre-migration six-barrel host presentation',
  );
}

let nextTestWorldEntityIdFloor = 64;

function createIsolatedTestWorld(
  seed: number,
  width: number,
  height: number,
): WorldState {
  const world = new WorldState(seed, width, height);
  // The native targeting slab deliberately preserves per-entity FSM and
  // cooldown state across tick clears. Independent test worlds therefore
  // need distinct entity-id ranges so they are not mistaken for successive
  // ticks of the same entity.
  while (world.getNextEntityId() < nextTestWorldEntityIdFloor) {
    world.generateEntityId();
  }
  nextTestWorldEntityIdFloor += 64;
  return world;
}

function assertSlowRocketLaunchVelocityInheritance(addTurretVelocityToEmissionLaunch: boolean): void {
  resetTurretHostIntegrationState();
  const launchWorld = createIsolatedTestWorld(
    addTurretVelocityToEmissionLaunch ? 4321 : 4322,
    1024,
    1024,
  );
  launchWorld.playerCount = 2;
  const badger = launchWorld.createUnitFromBlueprint(
    120,
    120,
    1 as PlayerId,
    TEST_VERTICAL_ROCKET_UNIT_BLUEPRINT_ID,
  );
  const launchTarget = launchWorld.createUnitFromBlueprint(
    720,
    120,
    2 as PlayerId,
    'unitJackal',
  );
  launchWorld.addEntity(badger);
  launchWorld.addEntity(launchTarget);
  spatialGrid.updateUnit(badger);
  spatialGrid.updateUnit(launchTarget);
  if (badger.unit === null || badger.combat === null) {
    throw new Error('[turret host integration] badger must be an armed unit');
  }

  const { turret: badgerTurret } = getFirstAttackTurret(badger);
  const previousInheritanceFlag = badgerTurret.config.addTurretVelocityToEmissionLaunch;
  badgerTurret.config.addTurretVelocityToEmissionLaunch = addTurretVelocityToEmissionLaunch;
  try {
    badger.combat.priorityTargetId = launchTarget.id;
    badger.combat.priorityTargetPoint = null;
    const dtMs = 50;
    stampCombatTargetingPool(launchWorld);
    const activeCombatUnits = updateTargetingAndFiringState(launchWorld, dtMs);
    updateTurretRotation(launchWorld, dtMs, activeCombatUnits);
    const fireResult = fireTurrets(
      launchWorld,
      dtMs,
      new DamageSystem(launchWorld),
      new ForceAccumulator(),
      activeCombatUnits,
    );
    assertContract(fireResult.projectiles.length === 1, 'badger slow rocket should fire one projectile');
    assertContract(fireResult.spawnEvents.length === 1, 'badger slow rocket should emit one spawn event');

    const rocketEntity = fireResult.projectiles[0];
    const rocket = rocketEntity.projectile;
    const rocketSpawn = fireResult.spawnEvents[0];
    if (rocket === null) {
      throw new Error('[turret host integration] fired rocket must have a projectile component');
    }
    const transformTrig = getTransformCosSin(badger.transform);
    const expectedEmission = resolveWeaponEmissionSocket(
      badger,
      badgerTurret,
      rocketSpawn.turretIndex,
      rocketSpawn.barrelIndex,
      transformTrig.cos,
      transformTrig.sin,
      {
        currentTick: launchWorld.getTick(),
        dtMs,
        unitGroundZ: getUnitGroundZ(badger),
        surfaceN: badger.unit.surfaceNormal,
      },
      {
        position: { x: 0, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        forward: { x: 0, y: 0, z: 0 },
      },
    );
    assertNear(rocketEntity.transform.x, expectedEmission.position.x, 'shot launch x must be QueryWeapon x');
    assertNear(rocketEntity.transform.y, expectedEmission.position.y, 'shot launch y must be QueryWeapon y');
    assertNear(rocketEntity.transform.z, expectedEmission.position.z, 'shot launch z must be QueryWeapon z');
    assertNear(rocketSpawn.pos.x, expectedEmission.position.x, 'spawn event x must be QueryWeapon x');
    assertNear(rocketSpawn.pos.y, expectedEmission.position.y, 'spawn event y must be QueryWeapon y');
    assertNear(rocketSpawn.pos.z, expectedEmission.position.z, 'spawn event z must be QueryWeapon z');
    assertContract(!rocket.isArmed, 'fresh physical shot must begin inert inside its host ARM volume');
    assertContract(
      hasPendingProjectileLaunchVelocityFinalization(rocketEntity.id),
      'fresh turret projectile must wait for post-physics launch velocity finalization',
    );
    launchWorld.addEntity(rocketEntity);

    const badgerShot = badgerTurret.config.shot;
    assertContract(
      badgerShot !== null && isProjectileShot(badgerShot),
      'badger turret must fire a physical projectile shot',
    );
    const relativeLaunchSpeed = getProjectileLaunchSpeed(badgerShot);
    const finalHostVx = 37;
    const finalHostVy = -11;
    const finalHostVz = 3;
    badger.transform.x += finalHostVx * (dtMs / 1000);
    badger.transform.y += finalHostVy * (dtMs / 1000);
    badger.transform.z += finalHostVz * (dtMs / 1000);
    badger.unit.velocityX = finalHostVx;
    badger.unit.velocityY = finalHostVy;
    badger.unit.velocityZ = finalHostVz;
    launchWorld.incrementTick();

    finalizePendingProjectileLaunchVelocities(launchWorld, dtMs);
    assertContract(
      !hasPendingProjectileLaunchVelocityFinalization(rocketEntity.id),
      'post-physics finalization must clear the pending launch marker',
    );
    const expectedInheritedVx = addTurretVelocityToEmissionLaunch ? finalHostVx : 0;
    const expectedInheritedVy = addTurretVelocityToEmissionLaunch ? finalHostVy : 0;
    const expectedInheritedVz = addTurretVelocityToEmissionLaunch ? finalHostVz : 0;
    assertNear(rocket.velocityX, expectedInheritedVx, 'vertical rocket launch vx must match inheritance flag');
    assertNear(rocket.velocityY, expectedInheritedVy, 'vertical rocket launch vy must match inheritance flag');
    assertNear(
      rocket.velocityZ,
      expectedInheritedVz + relativeLaunchSpeed,
      'vertical rocket launch vz must match inheritance flag plus relative launch speed',
    );
    assertNear(rocketSpawn.velocity.x, rocket.velocityX, 'spawn event vx must match finalized projectile vx');
    assertNear(rocketSpawn.velocity.y, rocket.velocityY, 'spawn event vy must match finalized projectile vy');
    assertNear(rocketSpawn.velocity.z, rocket.velocityZ, 'spawn event vz must match finalized projectile vz');
  } finally {
    badgerTurret.config.addTurretVelocityToEmissionLaunch = previousInheritanceFlag;
    resetTurretHostIntegrationState();
  }
}

function assertSlowRocketDropsLockAfterLosingTarget(): void {
  resetTurretHostIntegrationState();
  const world = createIsolatedTestWorld(5321, 1024, 1024);
  world.playerCount = 2;
  const badger = world.createUnitFromBlueprint(
    120,
    120,
    1 as PlayerId,
    TEST_VERTICAL_ROCKET_UNIT_BLUEPRINT_ID,
  );
  const lostTarget = world.createUnitFromBlueprint(
    290,
    120,
    2 as PlayerId,
    'unitJackal',
  );
  const replacementTarget = world.createUnitFromBlueprint(
    330,
    120,
    2 as PlayerId,
    'unitJackal',
  );
  world.addEntity(badger);
  world.addEntity(lostTarget);
  world.addEntity(replacementTarget);
  spatialGrid.updateUnit(badger);
  spatialGrid.updateUnit(replacementTarget);
  if (lostTarget.unit === null || badger.combat === null) {
    throw new Error('[turret host integration] retarget fixtures must be armed/live units');
  }
  lostTarget.unit.hp = 0;

  const { turret } = getFirstAttackTurret(badger);
  const projectileConfig = createProjectileConfigFromTurret(
    turret.config,
    turret.mountIndex,
  );
  const rocket = world.createProjectile(
    250,
    120,
    40,
    0,
    1 as PlayerId,
    badger.id,
    projectileConfig,
  );
  world.addEntity(rocket);
  if (rocket.projectile === null) {
    throw new Error('[turret host integration] retarget rocket must have a projectile component');
  }
  rocket.projectile.velocityZ = 0;
  rocket.projectile.timeAlive = 3000;
  rocket.projectile.homingTargetId = lostTarget.id;

  updateProjectiles(world, 50, new DamageSystem(world), STILL_AIR);
  assertContract(
    rocket.projectile.homingTargetId === NO_ENTITY_ID,
    'homing rocket must drop its dead inherited lock instead of acquiring a replacement target',
  );
  resetTurretHostIntegrationState();
}

function assertBeamUsesSharedSnappyTurretAim(): void {
  resetTurretHostIntegrationState();
  const world = createIsolatedTestWorld(5322, 1024, 1024);
  world.playerCount = 2;
  const daddy = world.createUnitFromBlueprint(
    120,
    120,
    1 as PlayerId,
    TEST_BEAM_UNIT_BLUEPRINT_ID,
  );
  const target = world.createUnitFromBlueprint(
    120,
    250,
    2 as PlayerId,
    'unitJackal',
  );
  world.addEntity(daddy);
  world.addEntity(target);
  if (target.unit === null) {
    throw new Error('[turret host integration] beam target must be a unit');
  }
  target.unit.velocityX = 20;
  spatialGrid.updateUnit(daddy);
  spatialGrid.updateUnit(target);
  if (daddy.combat === null) {
    throw new Error('[turret host integration] beam source must be armed');
  }
  const shieldField = daddy.combat.turrets.find(
    (turret) => turret.config.shot?.type === 'shield',
  );
  assertContract(shieldField !== undefined, 'Daddy must mount its passive shield field');
  assertContract(
    isPassiveShieldFieldConfig(shieldField.config) && !isAttackEmitter(shieldField),
    'persistent shield field must not enter attack-turret acquisition',
  );
  assertContract(
    !isShieldSubmunitionTurret(shieldField),
    'ordinary shield field must not be classified as a submunition shield turret',
  );
  assertContract(
    turretIgnoresForceMaterialSightObstruction(shieldField),
    'ordinary shield field must retain the non-offensive force-material exemption',
  );

  daddy.combat.priorityTargetId = target.id;
  daddy.combat.priorityTargetPoint = null;
  const dtMs = 50;
  stampCombatTargetingPool(world);
  const activeCombatUnits = updateTargetingAndFiringState(world, dtMs);
  const { turret: beamTurret } = getFirstAttackTurret(daddy);
  // Staggering has its own pulse contract; this test isolates the shared
  // servo/launch-direction relationship.
  beamTurret.beamPulseInitialDelayMs = 0;
  assertContract(
    beamTurret.config.aimMotionSnapshotVisible,
    'beam turret must publish ordinary full-barrel aim',
  );

  // Prove there is no beam-only snap hidden ahead of the shared actuator:
  // with deliberately low rate/acceleration caps, one update leaves an error
  // and the ordinary aim gate must refuse to fire.
  const authoredYawActuator = { ...beamTurret.config.angular.yaw };
  const authoredPitchActuator = { ...beamTurret.config.angular.pitch };
  beamTurret.config.angular.yaw.maxSpeed = 0.05;
  beamTurret.config.angular.yaw.maxAcceleration = 0.1;
  beamTurret.config.angular.pitch.maxSpeed = 0.05;
  beamTurret.config.angular.pitch.maxAcceleration = 0.1;
  updateTurretRotation(world, dtMs, activeCombatUnits);
  assertContract(
    Math.abs(beamTurret.aimErrorYaw) > 0.1,
    'beam aim must retain error when its shared actuator is deliberately slowed',
  );
  const beamDamageSystem = new DamageSystem(world);
  const earlyFireResult = fireTurrets(
    world,
    dtMs,
    beamDamageSystem,
    new ForceAccumulator(),
    activeCombatUnits,
  );
  assertContract(
    !earlyFireResult.spawnEvents.some((event) => event.beam !== undefined),
    'beam must not bypass the shared aim-error firing gate',
  );

  // Restore the authored actuator and let the same finite motor settle.
  Object.assign(beamTurret.config.angular.yaw, authoredYawActuator);
  Object.assign(beamTurret.config.angular.pitch, authoredPitchActuator);
  for (let i = 0; i < 200 && Math.abs(beamTurret.aimErrorYaw) > 1e-6; i++) {
    updateTurretRotation(world, dtMs, activeCombatUnits);
  }
  const expectedYaw = Math.PI / 2;
  assertNear(beamTurret.rotation, expectedYaw, 'beam shared actuator must settle to target yaw');
  assertNear(beamTurret.aimErrorYaw, 0, 'beam shared actuator must leave negligible yaw error');

  // The ordinary fixed angular tolerance alone is wider than a small target's
  // silhouette at range. Prove the new spawn trace rejects such a geometric
  // near-miss even though it remains inside the generic 0.16-radian aim gate.
  beamTurret.rotation = expectedYaw - 0.1;
  beamTurret.aimErrorYaw = 0.1;
  const randomStateBeforeNearMiss = world.getRandomStreamState();
  const nearMissFireResult = fireTurrets(
    world,
    dtMs,
    beamDamageSystem,
    new ForceAccumulator(),
    activeCombatUnits,
  );
  assertContract(
    !nearMissFireResult.spawnEvents.some((event) => event.beam !== undefined),
    'beam spawn must wait when the physical barrel ray misses its selected target',
  );
  assertContract(
    world.getRandomStreamState() === randomStateBeforeNearMiss,
    'a rejected beam attempt must not consume a duration-variance RNG sample',
  );
  beamTurret.rotation = expectedYaw;
  beamTurret.aimErrorYaw = 0;

  const randomStateBeforeCommittedPulse = world.getRandomStreamState();
  const fireResult = fireTurrets(
    world,
    dtMs,
    beamDamageSystem,
    new ForceAccumulator(),
    activeCombatUnits,
  );
  const beamSpawn = fireResult.spawnEvents.find((event) => event.beam !== undefined);
  assertContract(beamSpawn !== undefined, 'mini beam turret must spawn a beam event');
  const beam = beamSpawn.beam;
  assertContract(beam !== undefined, 'beam spawn must carry start/end metadata');
  assertNear(
    DMath.atan2(beam.end.y - beam.start.y, beam.end.x - beam.start.x),
    beamTurret.rotation,
    'beam spawn line must follow the authoritative turret yaw',
  );
  assertNear(
    beamSpawn.rotation,
    beamTurret.rotation,
    'beam spawn metadata must follow shared turret aim',
  );
  const beamEntity = fireResult.projectiles.find((entity) => entity.id === beamSpawn.id);
  const pulsePlan = beamEntity?.projectile?.beamPulsePlan;
  assertContract(pulsePlan !== null && pulsePlan !== undefined, 'attack beam must capture a committed pulse plan');
  assertContract(
    world.getRandomStreamState() !== randomStateBeforeCommittedPulse,
    'a committed beam must consume one canonical duration-variance RNG sample',
  );
  const initialBeamPoints = beamEntity?.projectile?.points;
  const initialBeamEnd = initialBeamPoints?.[initialBeamPoints.length - 1];
  assertContract(
    initialBeamPoints !== null && initialBeamPoints !== undefined &&
      initialBeamPoints.length >= 2 &&
      initialBeamEnd !== undefined &&
      beamEntity?.projectile?.prevEndEntityId === target.id,
    'a committed beam pulse must be seeded by a real trace that terminates on its selected target',
  );
  const initialBeamStart = initialBeamPoints![0];
  assertContract(
    DMath.hypot(
      initialBeamEnd!.x - initialBeamStart.x,
      initialBeamEnd!.y - initialBeamStart.y,
      initialBeamEnd!.z - initialBeamStart.z,
    ) <= beamTurret.config.targeting.effect.range + 1e-6,
    'the initial authoritative beam path must remain inside its finite turret effect radius',
  );
  const airBoundaryPath = beamDamageSystem.findBeamPath(
    initialBeamStart.x,
    initialBeamStart.y,
    initialBeamStart.z,
    initialBeamStart.x,
    initialBeamStart.y,
    initialBeamStart.z + 100000,
    daddy.id,
    beamEntity!.projectile!.config.shotProfile.runtime.radius.collision,
    6,
    {
      centerX: initialBeamStart.x,
      centerY: initialBeamStart.y,
      centerZ: initialBeamStart.z,
      radius: beamTurret.config.targeting.effect.range,
      rangeVolume: 'turret-range-top-and-bottom-unbounded',
      hardRadius: beamTurret.config.targeting.effect.range,
    },
    0,
    true,
  );
  assertContract(
    airBoundaryPath.endEntityId === NO_ENTITY_ID &&
      airBoundaryPath.endpointDamageable &&
      DMath.hypot(
        airBoundaryPath.endX - initialBeamStart.x,
        airBoundaryPath.endY - initialBeamStart.y,
        airBoundaryPath.endZ - initialBeamStart.z,
      ) <= beamTurret.config.targeting.effect.range + 1e-6,
    'a collision-free beam must terminate as a damageable air endpoint at its finite effect boundary',
  );
  let waterX = -1;
  let waterY = -1;
  for (let x = 32; x < world.mapWidth && waterX < 0; x += 32) {
    for (let y = 32; y < world.mapHeight; y += 32) {
      if (isWaterAt(x, y, world.mapWidth, world.mapHeight)) {
        waterX = x;
        waterY = y;
        break;
      }
    }
  }
  assertContract(waterX >= 0, 'beam medium test map must contain water');
  const beamShot = beamTurret.config.shot;
  assertContract(beamShot !== null && beamShot.type === 'beam', 'beam turret must own a ray matrix');
  const waterBoundaryPath = beamDamageSystem.findBeamPath(
    waterX,
    waterY,
    WATER_LEVEL + 50,
    waterX,
    waterY,
    WATER_LEVEL - 50,
    daddy.id,
    1,
    4,
    undefined,
    0,
    true,
    SHIELD_REFLECTION_ENTITY_BEAM,
    beamShot.mediumTrajectory,
  );
  assertContract(
    Math.abs(waterBoundaryPath.endZ - WATER_LEVEL) <= 1e-6 &&
      !waterBoundaryPath.endpointDamageable,
    `an A->A-only ray must physically terminate at the exact water boundary ` +
      `(expected z=${WATER_LEVEL}, actual z=${waterBoundaryPath.endZ}, ` +
      `damageable=${waterBoundaryPath.endpointDamageable}, entity=${waterBoundaryPath.endEntityId})`,
  );
  assertContract(
    pulsePlan.durationMs >= BEAM_PULSE_ON_TIME_MS * (1 - BEAM_PULSE_ON_TIME_RANDOMNESS) &&
      pulsePlan.durationMs <= BEAM_PULSE_ON_TIME_MS * (1 + BEAM_PULSE_ON_TIME_RANDOMNESS) &&
      beamEntity?.projectile?.maxLifespan === pulsePlan.durationMs &&
      beamSpawn.maxLifespan === pulsePlan.durationMs,
    'attack beam pulse, projectile, and spawn wire metadata must share one bounded rolled on-time',
  );
  assertNear(
    pulsePlan.targetVelocityX,
    20,
    'beam pulse must capture target velocity once at emission',
  );
  const capturedTargetX = pulsePlan.targetX;
  target.transform.x += 500;
  target.unit.velocityX = -100;
  assertNear(
    pulsePlan.targetX,
    capturedTargetX,
    'an emitted beam plan must not follow later live-target position changes',
  );
  assertNear(
    pulsePlan.targetVelocityX,
    20,
    'an emitted beam plan must not follow later live-target velocity changes',
  );

  const evaluation = {
    sourceX: 0, sourceY: 0, sourceZ: 0,
    targetX: 0, targetY: 0, targetZ: 0,
    dirX: 1, dirY: 0, dirZ: 0,
    yaw: 0, pitch: 0,
  };
  evaluateBeamPulsePlan(pulsePlan, pulsePlan.durationMs, evaluation);
  assertContract(
    evaluation.targetX > pulsePlan.targetX,
    'committed pulse evaluation must advance the captured constant-velocity target fit',
  );

  const cadencePlan = {
    ...pulsePlan,
    lastCollisionSampleMs: 0,
  };
  const cadenceSpawnTick = 0;
  scheduleBeamPulseCollisionSamples(cadencePlan, beamEntity!.id, cadenceSpawnTick);
  let integratedWindowMs = 0;
  let sampleCount = 0;
  let previousSampleTick = cadenceSpawnTick;
  const fixedStepMs = 1000 / 30;
  const pulseExpiryTick = Math.ceil(pulsePlan.durationMs / fixedStepMs);
  for (let tick = 1; tick <= pulseExpiryTick; tick++) {
    const elapsedMs = Math.min(pulsePlan.durationMs, tick * fixedStepMs);
    if (!beamPulseNeedsCollisionSample(cadencePlan, tick, elapsedMs)) continue;
    const isFinalPartialSample = elapsedMs >= pulsePlan.durationMs;
    assertContract(
      isFinalPartialSample || tick % BEAM_PULSE_COLLISION_SAMPLE_INTERVAL_TICKS ===
        cadencePlan.collisionSamplePhase,
      'non-final beam collision work must stay in its hashed tick phase',
    );
    assertContract(
      tick - previousSampleTick <= BEAM_PULSE_COLLISION_SAMPLE_INTERVAL_TICKS,
      'the phase ring must never leave a beam unsampled beyond its configured interval',
    );
    previousSampleTick = tick;
    integratedWindowMs += consumeBeamPulseCollisionWindow(cadencePlan, tick, elapsedMs);
    sampleCount++;
  }
  assertNear(
    integratedWindowMs,
    pulsePlan.durationMs,
    'coarse collision samples must integrate every millisecond of the active pulse exactly once',
  );
  assertContract(
    sampleCount >= Math.floor(
      pulsePlan.durationMs /
        (fixedStepMs * BEAM_PULSE_COLLISION_SAMPLE_INTERVAL_TICKS),
    ),
    'the faster tick ring must sustain its configured per-beam collision frequency',
  );
  const phaseCounts = new Array<number>(BEAM_PULSE_COLLISION_SAMPLE_INTERVAL_TICKS).fill(0);
  for (let entityId = 1; entityId <= 4096; entityId++) {
    phaseCounts[beamPulseCollisionPhaseForEntityId(entityId)]++;
  }
  const idealPhasePopulation = 4096 / BEAM_PULSE_COLLISION_SAMPLE_INTERVAL_TICKS;
  assertContract(
    phaseCounts.every((count) => Math.abs(count - idealPhasePopulation) <= 4096 * 0.05),
    'beam entity hashing must distribute collision work evenly across the tick ring',
  );
  assertNear(
    BEAM_PULSE_ACTIVE_OUTPUT_MULTIPLIER * BEAM_PULSE_ON_TIME_MS /
      (BEAM_PULSE_ON_TIME_MS + BEAM_PULSE_OFF_TIME_MS),
    1,
    'pulse duty cycle must preserve authored sustained beam output',
  );
  let onRollCalls = 0;
  const fixedSample = 0.25;
  const rolledOnTime = rollBeamPulseOnTimeMs(() => {
    onRollCalls++;
    return fixedSample;
  });
  assertNear(
    rolledOnTime,
    rollTurretCooldownDuration(
      {
        duration: BEAM_PULSE_ON_TIME_MS,
        durationRandomness: BEAM_PULSE_ON_TIME_RANDOMNESS,
      },
      () => fixedSample,
    ),
    'beam on-time must use the same centered duration roll as plasma cooldowns',
  );
  assertContract(onRollCalls === 1, 'beam on-time must consume exactly one RNG sample');
  assertNear(
    rollBeamPulseOffTimeMs(() => fixedSample),
    rollTurretCooldownDuration(
      {
        duration: BEAM_PULSE_OFF_TIME_MS,
        durationRandomness: BEAM_PULSE_OFF_TIME_RANDOMNESS,
      },
      () => fixedSample,
    ),
    'beam off-time must use the same centered duration roll as plasma cooldowns',
  );
  assertNear(
    getMaximumBeamPulseOnTimeMs(),
    BEAM_PULSE_ON_TIME_MS * (1 + BEAM_PULSE_ON_TIME_RANDOMNESS),
    'beam tracking feasibility must cover the longest possible rolled pulse',
  );

  const impossiblePlan = createBeamPulsePlan(
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 100, z: 0 },
    1000,
  );
  assertContract(
    !canTurretTrackBeamPulse(impossiblePlan, 1, 0),
    'pulse fire gate must reject a trajectory whose line-of-sight rate exceeds the turret servo',
  );

  world.addEntity(beamEntity!);
  assertContract(
    collectTurretRotationUnits(world, []).some((entity) => entity.id === daddy.id),
    'committed beam host must keep rotating from its pulse plan after live targeting goes idle',
  );
  const pulseDamageSystem = new DamageSystem(world);
  const pulseForces = new ForceAccumulator();
  const pulseExpiryTestMs = Math.ceil(pulsePlan.durationMs / 50) * 50;
  for (let elapsedMs = 50; elapsedMs <= pulseExpiryTestMs; elapsedMs += 50) {
    world.incrementTick();
    pulseForces.clear();
    updateTurretRotation(world, 50, collectTurretRotationUnits(world, []));
    updateProjectiles(world, 50, pulseDamageSystem, STILL_AIR);
    const liveBeam = world.getEntity(beamEntity!.id);
    if (liveBeam !== undefined) {
      assertNear(
        liveBeam.transform.rotation,
        beamTurret.rotation,
        'committed beam ray must always leave along the physical turret barrel pose',
      );
    }
    checkProjectileCollisions(world, 50, pulseDamageSystem, pulseForces);
  }
  assertContract(
    Math.abs(beamTurret.rotation - beamSpawn.rotation) > 0.05,
    'beam turret must advance along the captured target-velocity trajectory during the pulse',
  );
  assertContract(
    world.getEntity(beamEntity!.id) === undefined &&
      !beamIndex.hasActiveBeam(daddy.id, 0),
    'attack beam must despawn and release its active-beam index at one second',
  );
  const rolledOffCooldownMs = readTurretCooldownForFire(daddy, 0);
  assertContract(
    rolledOffCooldownMs >= BEAM_PULSE_OFF_TIME_MS * (1 - BEAM_PULSE_OFF_TIME_RANDOMNESS) &&
      rolledOffCooldownMs <= BEAM_PULSE_OFF_TIME_MS * (1 + BEAM_PULSE_OFF_TIME_RANDOMNESS),
    'attack beam expiry must arm a bounded rolled off cooldown',
  );
  resetTurretHostIntegrationState();
}

function assertLorisReflectorRemainsAutonomousFromHostTask(): void {
  resetTurretHostIntegrationState();
  const world = createIsolatedTestWorld(7321, 1024, 1024);
  world.playerCount = 2;
  world.turretShieldPanelsEnabled = true;
  const loris = world.createUnitFromBlueprint(
    500,
    500,
    1 as PlayerId,
    'unitLoris',
  );
  const unrelatedEnemy = world.createUnitFromBlueprint(
    600,
    500,
    2 as PlayerId,
    'unitJackal',
  );
  world.addEntity(loris);
  world.addEntity(unrelatedEnemy);
  spatialGrid.updateUnit(loris);
  spatialGrid.updateUnit(unrelatedEnemy);

  if (loris.combat === null) {
    throw new Error('[turret host integration] Loris test units must have combat assemblies');
  }
  const panelIndex = loris.combat.turrets.findIndex((turret) => {
    const shot = turret.config.shot;
    return shot?.type === 'shield' && shot.barrier === undefined;
  });
  assertContract(panelIndex >= 0, 'Loris must mount a shield-panel turret');
  const panel = loris.combat.turrets[panelIndex];
  assertContract(
    panel.config.controlMode === 'autonomous',
    'Loris shield panel must own its incoming-threat target independently of the host',
  );

  // Give the Loris a host attack intent and run the sole host-to-emitter task
  // projection. The reflector must remain taskless so its reciprocal target
  // policy stays free to choose the actual incoming threat.
  loris.combat.priorityTargetId = unrelatedEnemy.id;
  stampCombatTargetingPool(world);

  assertContract(
    panel.task === null,
    'host attack intent must not overwrite the Loris reflector task',
  );
  resetTurretHostIntegrationState();
}

function assertOrcaTargetsEnemyOrca(manualTarget: boolean): void {
  resetTurretHostIntegrationState();
  const world = createIsolatedTestWorld(manualTarget ? 6321 : 6322, 1024, 1024);
  world.playerCount = 2;
  const source = world.createUnitFromBlueprint(160, 160, 1 as PlayerId, 'unitOrca');
  const target = world.createUnitFromBlueprint(360, 160, 2 as PlayerId, 'unitOrca');
  source.transform.z = WATER_LEVEL - 10;
  target.transform.z = WATER_LEVEL - 10;
  world.addEntity(source);
  world.addEntity(target);
  spatialGrid.updateUnit(source);
  spatialGrid.updateUnit(target);
  if (source.combat === null) {
    throw new Error('[turret host integration] Orca source must be armed');
  }

  const { turret, turretIndex } = getFirstAttackTurret(source);
  // This contract isolates target eligibility from terrain generation. The
  // production turret still requires LOS; that behavior is covered by the
  // shared targeting contracts.
  turret.config.requiresNonObstructedLineOfSight = false;
  if (manualTarget) {
    source.combat.priorityTargetId = target.id;
    source.combat.priorityTargetPoint = null;
  }

  stampCombatTargetingPool(world);
  updateTargetingAndFiringState(world, 50);
  const targetingState = { stateCode: CT_TURRET_STATE_ENGAGED, targetId: -1 };
  assertContract(
    readCombatTargetingTurretFsmInto(source, turretIndex, targetingState),
    'Orca torpedo turret must have authoritative targeting state',
  );
  assertContract(
    targetingState.targetId === target.id,
    `Orca torpedo turret must accept an enemy Orca ${manualTarget ? 'attack order' : 'auto-target'}`,
  );
  assertContract(
    targetingState.stateCode === CT_TURRET_STATE_ENGAGED,
    `Orca torpedo turret must engage after ${manualTarget ? 'an attack order' : 'auto-acquisition'}`,
  );
  resetTurretHostIntegrationState();
}

function assertOrcaRejectsEnemyAboveWater(manualTarget: boolean): void {
  resetTurretHostIntegrationState();
  const world = createIsolatedTestWorld(manualTarget ? 6323 : 6324, 1024, 1024);
  world.playerCount = 2;
  const source = world.createUnitFromBlueprint(160, 160, 1 as PlayerId, 'unitOrca');
  const target = world.createUnitFromBlueprint(360, 160, 2 as PlayerId, 'unitOrca');
  source.transform.z = WATER_LEVEL - 10;
  target.transform.z = WATER_LEVEL + getUnitBlueprint('unitOrca').radius.hitbox + 1;
  world.addEntity(source);
  world.addEntity(target);
  spatialGrid.updateUnit(source);
  spatialGrid.updateUnit(target);
  if (source.combat === null) {
    throw new Error('[turret host integration] Orca source must be armed');
  }

  const { turret, turretIndex } = getFirstAttackTurret(source);
  assertContract(
    turret.config.targeting.engagement.rangeVolume === 'turret-range-bottom-unbounded',
    'Orca torpedo range volume must remain geometric; its emission matrix owns water legality',
  );
  turret.config.requiresNonObstructedLineOfSight = false;
  if (manualTarget) {
    source.combat.priorityTargetId = target.id;
    source.combat.priorityTargetPoint = null;
  }

  stampCombatTargetingPool(world);
  updateTargetingAndFiringState(world, 50);
  const targetingState = { stateCode: CT_TURRET_STATE_ENGAGED, targetId: -1 };
  assertContract(
    readCombatTargetingTurretFsmInto(source, turretIndex, targetingState),
    'Orca torpedo turret must have authoritative targeting state',
  );
  assertContract(
    targetingState.targetId === -1,
    `Orca torpedo turret must reject an above-water enemy ${manualTarget ? 'attack order' : 'during auto-targeting'}`,
  );
  resetTurretHostIntegrationState();
}

function assertSeaTurtleTargetMediumEligibility(
  manualTarget: boolean,
  fullySubmerged: boolean,
): void {
  resetTurretHostIntegrationState();
  const world = createIsolatedTestWorld(
    manualTarget ? (fullySubmerged ? 6325 : 6326) : (fullySubmerged ? 6327 : 6328),
    1024,
    1024,
  );
  world.playerCount = 2;
  const source = world.createUnitFromBlueprint(160, 160, 1 as PlayerId, 'unitSeaTurtle');
  const target = world.createUnitFromBlueprint(360, 160, 2 as PlayerId, 'unitOrca');
  source.transform.z = WATER_LEVEL + 10;
  target.transform.z = fullySubmerged
    ? WATER_LEVEL - getUnitBlueprint('unitOrca').radius.hitbox - 1
    : WATER_LEVEL - 10;
  world.addEntity(source);
  world.addEntity(target);
  spatialGrid.updateUnit(source);
  spatialGrid.updateUnit(target);
  if (source.combat === null) {
    throw new Error('[turret host integration] Sea Turtle source must be armed');
  }

  const { turret, turretIndex } = getFirstAttackTurret(source);
  // This contract isolates the weapon's physical-volume medium gate. Give
  // the weapon-composed sensor an explicit A→W lane so center-based
  // visibility does not independently hide the underwater-center target.
  turret.config.targeting.observation.sensors.fullSight.aboveWater.underwater = 900;
  turret.config.requiresNonObstructedLineOfSight = false;
  if (manualTarget) {
    source.combat.priorityTargetId = target.id;
    source.combat.priorityTargetPoint = null;
  }

  stampCombatTargetingPool(world);
  updateTargetingAndFiringState(world, 50);
  const targetingState = { stateCode: CT_TURRET_STATE_ENGAGED, targetId: -1 };
  assertContract(
    readCombatTargetingTurretFsmInto(source, turretIndex, targetingState),
    'Sea Turtle plasma turret must have authoritative targeting state',
  );
  if (fullySubmerged) {
    assertContract(
      targetingState.targetId === -1,
      `Sea Turtle air-only plasma must reject a fully submerged enemy ${manualTarget ? 'attack order' : 'during auto-targeting'}`,
    );
  } else {
    assertContract(
      targetingState.targetId === target.id && targetingState.stateCode === CT_TURRET_STATE_ENGAGED,
      `Sea Turtle air-only plasma must accept an enemy with exposed physical volume ${manualTarget ? 'after an attack order' : 'during auto-targeting'}`,
    );
  }
  resetTurretHostIntegrationState();
}

/** SHIELD-AWARE targeting is an earned per-player upgrade (see
 *  budget_design_philosophy.html, "Shield-aware targeting is an earned,
 *  per-player upgrade"). This contract encodes the whole behavioral
 *  arc for an AUTONOMOUS mount:
 *    1. NAIVE (no tech building): the mortar — which authors
 *       requiresNonObstructedLineOfSight OFF, proving the shield gate
 *       is independent of the terrain-LOS flag — locks an enemy
 *       straight through its shield dome.
 *    2. Completing a Shield-Aware Targeting Tech building flips the
 *       owner's mask bit; the existing shield-blocked lock drops
 *       within the shared sight-drop grace instead of parking in a
 *       locked-not-firing state.
 *    3. While the field holds, the blocked enemy is never re-acquired;
 *       when a hittable enemy appears, acquisition chooses it.
 *    4. Losing the last tech building revokes the upgrade the same
 *       tick (derived state, no stored flag). */
function assertShieldAwareTargetingUpgradeContract(): void {
  resetTurretHostIntegrationState();
  const world = createIsolatedTestWorld(9241, 2048, 2048);
  world.playerCount = 2;
  world.setTeamRoster(buildFreeForAllRoster([1 as PlayerId, 2 as PlayerId]));

  const attacker = world.createUnitFromBlueprint(300, 300, 1 as PlayerId, TEST_UNIT_BLUEPRINT_ID);
  // The Widow's shieldSphere (range 700, outerRatio 0.8) raises a dome of
  // roughly 560 world units: the attacker at distance 1000 sits outside
  // the field while its mortar (range 2000) can reach the body inside.
  const shieldedEnemy = world.createUnitFromBlueprint(1300, 300, 2 as PlayerId, 'unitWidow');
  world.addEntity(attacker);
  world.addEntity(shieldedEnemy);
  // Shields are powered equipment: the Widow only raises its dome while its
  // own side has a Shield Generator up. This suite is about the ATTACKER's
  // targeting upgrade, so give the defender power and leave it on throughout.
  const defenderShieldGenerator = world.createBuilding(1300, 900, 60, 60, 120, 2 as PlayerId);
  defenderShieldGenerator.buildingBlueprintId = 'buildingShieldTech';
  world.addEntity(defenderShieldGenerator);
  spatialGrid.updateUnit(attacker);
  spatialGrid.updateUnit(shieldedEnemy);
  const { turretIndex } = getFirstAttackTurret(attacker);
  const dtMs = 50;
  const fsm = { stateCode: CT_TURRET_STATE_ENGAGED, targetId: -1 as EntityId };

  // One combat tick in the SimulationCombatController's stamping order.
  const tickCombat = (): void => {
    world.incrementTick();
    updateShieldState(world, dtMs);
    stampShieldSurfacePool(world);
    stampCombatTargetingPool(world);
    updateTargetingAndFiringState(world, dtMs);
  };

  // Raise the dome before any targeting runs (500 ms transition ramp).
  for (let i = 0; i < 24; i++) updateShieldState(world, dtMs);
  assertContract(
    getActiveShields().length > 0,
    'Widow must hold an active shield field before the targeting phases run',
  );

  // Phase 1 — NAIVE: no tech building, mask empty, gate skipped.
  assertContract(
    world.getShieldAwareTargetingPlayerMask() === 0,
    'a player with no completed targeting tech building must carry no mask bit',
  );
  let lockedThroughShield = false;
  for (let i = 0; i < 40 && !lockedThroughShield; i++) {
    tickCombat();
    readCombatTargetingTurretFsmInto(attacker, turretIndex, fsm);
    lockedThroughShield = fsm.targetId === shieldedEnemy.id;
  }
  assertContract(
    lockedThroughShield,
    'a NAIVE attacker must lock the enemy straight through its shield dome',
  );

  // Phase 2 — the upgrade arrives: one completed tech building.
  const techBuilding = world.createBuilding(600, 1600, 60, 60, 120, 1 as PlayerId);
  techBuilding.buildingBlueprintId = 'buildingShieldTargetingTech';
  world.addEntity(techBuilding);
  assertContract(
    world.getShieldAwareTargetingPlayerMask() === 1,
    'a completed targeting tech building must set the owner\'s mask bit the same tick',
  );

  // ON/OFF powered channel (BAR armtarg): a switched-off tech building
  // grants nothing; reopening restores the upgrade the same tick.
  assertContract(techBuilding.building !== null, 'tech building entity must carry a building component');
  const techActiveState = {
    open: false, wantOpen: false, damageDelayMs: 0, reopenDelayMs: 0,
  };
  techBuilding.building.activeState = techActiveState;
  assertContract(
    world.getShieldAwareTargetingPlayerMask() === 0,
    'a closed (fortified/OFF) targeting tech building must not grant the upgrade',
  );
  techActiveState.open = true;
  techActiveState.wantOpen = true;
  // A tech structure is an installation the SIDE runs, like radar or sight: an
  // ally standing next to the lab can obviously see what it sees, so the
  // upgrade reaches every seat on the team and no seat off it.
  assertContract(
    world.playerHasShieldAwareTargeting(1 as PlayerId),
    'the owning seat must hold the shield-aware targeting upgrade',
  );
  const allyOfOwner = [...world.getAllies(1 as PlayerId)][0];
  if (allyOfOwner !== undefined) {
    assertContract(
      world.playerHasShieldAwareTargeting(allyOfOwner),
      'an ALLY of the lab owner must hold the upgrade too — it is a team installation',
    );
  }
  for (const playerId of world.teamRoster.playerIds) {
    if (world.arePlayersAllied(playerId, 1 as PlayerId)) continue;
    assertContract(
      !world.playerHasShieldAwareTargeting(playerId),
      `player ${playerId} is not on the lab owner's side and must not hold the upgrade`,
    );
  }
  assertContract(
    world.getShieldAwareTargetingPlayerMask() === 1,
    'reopening the targeting tech building must restore the upgrade the same tick',
  );
  let dropped = false;
  for (let i = 0; i < SIGHT_DROP_GRACE_TICKS + 4 && !dropped; i++) {
    tickCombat();
    readCombatTargetingTurretFsmInto(attacker, turretIndex, fsm);
    dropped = fsm.targetId !== shieldedEnemy.id;
  }
  assertContract(
    dropped,
    'a shield-aware attacker must drop a shield-blocked autonomous lock within the sight-drop grace',
  );

  // Phase 3a — while the field holds, the blocked enemy stays untargeted.
  for (let i = 0; i < 24; i++) {
    tickCombat();
    readCombatTargetingTurretFsmInto(attacker, turretIndex, fsm);
    assertContract(
      fsm.targetId !== shieldedEnemy.id,
      'a shield-aware attacker must not re-acquire a shield-blocked enemy',
    );
  }

  // Phase 3b — a hittable enemy appears; acquisition must choose it.
  const openEnemy = world.createUnitFromBlueprint(300, 1100, 2 as PlayerId, 'unitJackal');
  world.addEntity(openEnemy);
  spatialGrid.updateUnit(openEnemy);
  let lockedOpenEnemy = false;
  for (let i = 0; i < 40 && !lockedOpenEnemy; i++) {
    tickCombat();
    readCombatTargetingTurretFsmInto(attacker, turretIndex, fsm);
    lockedOpenEnemy = fsm.targetId === openEnemy.id;
  }
  assertContract(
    lockedOpenEnemy,
    'a shield-aware attacker must reacquire the unshielded enemy instead of parking',
  );

  // Phase 4 — losing the last tech building revokes the upgrade.
  world.removeEntity(techBuilding.id);
  assertContract(
    world.getShieldAwareTargetingPlayerMask() === 0,
    'destroying the last targeting tech building must clear the mask the same tick',
  );
  resetTurretHostIntegrationState();
}

/** Shield power.
 *
 *  A shield is not something a unit owns outright; it is equipment run off the
 *  team's Shield Generators. The rules this pins down:
 *
 *    1. A shield host still under construction has no field, even with power.
 *    2. A finished host has no field while its side has no generator switched
 *       on — nothing is blocked at production time, so unshielded shield-units
 *       are an ordinary battlefield state, not an impossible one.
 *    3. One generator powers the whole team's shields, and the LAST one going
 *       dark drops all of them. Switching a generator off is the same as not
 *       having one; switching it back on restores every field.
 *    4. Two seats on the same side share power, and no seat off it does. */
function assertShieldPowerContract(): void {
  resetTurretHostIntegrationState();
  const world = createIsolatedTestWorld(4471, 2048, 2048);
  world.playerCount = 2;
  world.setTeamRoster(buildFreeForAllRoster([1 as PlayerId, 2 as PlayerId]));

  const shieldHost = world.createUnitFromBlueprint(400, 400, 1 as PlayerId, 'unitWidow');
  world.addEntity(shieldHost);
  spatialGrid.updateUnit(shieldHost);

  const dtMs = 50;
  // 24 steps clears the authored 500 ms transition ramp in either direction.
  const settleShields = (): void => {
    for (let i = 0; i < 24; i++) updateShieldState(world, dtMs);
  };

  settleShields();
  assertContract(
    getActiveShields().length === 0,
    'a shield host whose side has no Shield Generator must stand unshielded',
  );

  const generator = world.createBuilding(400, 900, 60, 60, 120, 1 as PlayerId);
  generator.buildingBlueprintId = 'buildingShieldTech';
  world.addEntity(generator);
  assertContract(
    world.playerHasShieldPower(1 as PlayerId)
      && !world.playerHasShieldPower(2 as PlayerId),
    'a completed Shield Generator must power its own side and no other',
  );

  // An unfinished host stays dark even with the generator up: a shell is not
  // yet a unit, so it has no equipment to run.
  shieldHost.buildable = createBuildable({ energy: 100, metal: 100 });
  settleShields();
  assertContract(
    getActiveShields().length === 0,
    'a shield host under construction must have no field even with power available',
  );

  shieldHost.buildable = null;
  settleShields();
  assertContract(
    getActiveShields().length > 0,
    'a finished host on a powered side must raise its field',
  );

  // Switching the generator off is the same as not owning one.
  assertContract(generator.building !== null, 'the generator must carry a building component');
  const generatorActiveState = {
    open: false, wantOpen: false, damageDelayMs: 0, reopenDelayMs: 0,
  };
  generator.building.activeState = generatorActiveState;
  settleShields();
  assertContract(
    getActiveShields().length === 0,
    'switching the last Shield Generator OFF must drop every shield on that side',
  );

  generatorActiveState.open = true;
  generatorActiveState.wantOpen = true;
  settleShields();
  assertContract(
    getActiveShields().length > 0,
    'switching a Shield Generator back ON must restore the team\'s shields',
  );

  // One generator ON is enough, however many are off.
  const darkGenerator = world.createBuilding(900, 900, 60, 60, 120, 1 as PlayerId);
  darkGenerator.buildingBlueprintId = 'buildingShieldTech';
  darkGenerator.building!.activeState = {
    open: false, wantOpen: false, damageDelayMs: 0, reopenDelayMs: 0,
  };
  world.addEntity(darkGenerator);
  settleShields();
  assertContract(
    getActiveShields().length > 0,
    'a second switched-OFF generator must not take down shields the first one is powering',
  );

  world.removeEntity(generator.id);
  settleShields();
  assertContract(
    getActiveShields().length === 0,
    'destroying the last powered generator must drop the shields the same way switching it off does',
  );
  resetTurretHostIntegrationState();
}

export function runOrcaTargetingContractTest(): void {
  assertOrcaTargetsEnemyOrca(true);
  assertOrcaTargetsEnemyOrca(false);
  assertOrcaRejectsEnemyAboveWater(true);
  assertOrcaRejectsEnemyAboveWater(false);
}

/** Shield sight obstruction is directional, and the direction is the barrier's,
 *  not the sight system's.
 *
 *  A dome intercepts what comes at it and lets its own side's fire out (every
 *  barrier in shields.json authors `reflect-outside`). Sight has to agree with
 *  that, or a shield-aware gunner refuses shots that would have landed. The
 *  case that used to be wrong is a gunner standing UNDER a dome: the old
 *  direction-agnostic crossing count blocked it from acquiring anything outside
 *  its own bubble, while its rounds left that bubble unimpeded.
 *
 *  Geometry (dome center at the Widow, radius ~560; the firing line runs 200
 *  units off the Widow's axis so no BODY sits on it and only the field is
 *  under test):
 *
 *      far(300,1200)      widow(1000,1000)      enemy(1700,1200)
 *          outside          [ dome r~560 ]          outside
 *                     inside(1100,1200)
 */
function assertShieldSightObstructionIsOutsideInContract(): void {
  resetTurretHostIntegrationState();
  const world = createIsolatedTestWorld(9377, 4096, 4096);
  world.playerCount = 2;
  world.setTeamRoster(buildFreeForAllRoster([1 as PlayerId, 2 as PlayerId]));

  // Player 1 runs the shield and reads it: a generator to raise the dome, a
  // detection lab so its turrets respect shields at all.
  const generator = world.createBuilding(1000, 3000, 60, 60, 120, 1 as PlayerId);
  generator.buildingBlueprintId = 'buildingShieldTech';
  world.addEntity(generator);
  const detectionLab = world.createBuilding(1400, 3000, 60, 60, 120, 1 as PlayerId);
  detectionLab.buildingBlueprintId = 'buildingShieldTargetingTech';
  world.addEntity(detectionLab);
  assertContract(
    world.getShieldAwareTargetingPlayerMask() === 1 && world.playerHasShieldPower(1 as PlayerId),
    'the firing side must hold both shield power and shield-aware targeting for this case to mean anything',
  );

  const widow = world.createUnitFromBlueprint(1000, 1000, 1 as PlayerId, 'unitWidow');
  const insideAttacker = world.createUnitFromBlueprint(
    1100, 1200, 1 as PlayerId, TEST_UNIT_BLUEPRINT_ID,
  );
  const farAttacker = world.createUnitFromBlueprint(
    300, 1200, 1 as PlayerId, TEST_UNIT_BLUEPRINT_ID,
  );
  const enemy = world.createUnitFromBlueprint(1700, 1200, 2 as PlayerId, 'unitJackal');
  for (const entity of [widow, insideAttacker, farAttacker, enemy]) {
    world.addEntity(entity);
    spatialGrid.updateUnit(entity);
  }

  const dtMs = 50;
  const tickCombat = (): void => {
    world.incrementTick();
    updateShieldState(world, dtMs);
    stampShieldSurfacePool(world);
    stampCombatTargetingPool(world);
    updateTargetingAndFiringState(world, dtMs);
  };

  // Raise the dome before any targeting runs (500 ms transition ramp).
  for (let i = 0; i < 24; i++) updateShieldState(world, dtMs);
  assertContract(
    getActiveShields().length > 0,
    'the Widow must hold an active dome before the sight cases run',
  );

  const insideTurret = getFirstAttackTurret(insideAttacker).turretIndex;
  const farTurret = getFirstAttackTurret(farAttacker).turretIndex;
  const fsm = { stateCode: CT_TURRET_STATE_ENGAGED, targetId: -1 as EntityId };

  let insideLocked = false;
  for (let i = 0; i < 40 && !insideLocked; i++) {
    tickCombat();
    readCombatTargetingTurretFsmInto(insideAttacker, insideTurret, fsm);
    insideLocked = fsm.targetId === enemy.id;
  }
  assertContract(
    insideLocked,
    'a gunner standing under a friendly dome must be able to acquire a target outside it — '
      + 'its own rounds leave that dome unimpeded',
  );

  // Control: the same weapon, same enemy, but from outside. The sightline now
  // enters the dome before it leaves, so the inbound half still blocks it.
  for (let i = 0; i < 40; i++) {
    tickCombat();
    readCombatTargetingTurretFsmInto(farAttacker, farTurret, fsm);
    assertContract(
      fsm.targetId !== enemy.id,
      'a sightline that passes through a dome must stay blocked by its inbound half',
    );
  }
  resetTurretHostIntegrationState();
}

export function runWaterWeaponMediumTargetingContractTest(): void {
  assertSeaTurtleTargetMediumEligibility(true, true);
  assertSeaTurtleTargetMediumEligibility(false, true);
  assertSeaTurtleTargetMediumEligibility(true, false);
  assertSeaTurtleTargetMediumEligibility(false, false);
}

export function runTurretHostIntegrationContractTest(): void {
  resetTurretHostIntegrationState();
  try {
    assertLogicalTurretPresentationOwnership();
    const world = createIsolatedTestWorld(1234, 512, 512);
    world.playerCount = 2;
    const host = world.createUnitFromBlueprint(
      0,
      0,
      1 as PlayerId,
      TEST_UNIT_BLUEPRINT_ID,
    );
    world.addEntity(host);
    spatialGrid.updateUnit(host);
    stampCombatTargetingPool(world);

    const combat = host.combat;
    const hostUnit = host.unit;
    const blueprint = getUnitBlueprint(TEST_UNIT_BLUEPRINT_ID);
    if (combat === null || hostUnit === null) {
      throw new Error('[turret host integration] test host must be an armed unit');
    }
    assertContract(
      combat.turrets.length === blueprint.turrets.length,
      'host runtime turret count must match the authored blueprint assembly',
    );

    const { turret } = getFirstAttackTurret(host);
    assertContract(turret.id !== NO_ENTITY_ID, 'mounted turret must have an addressable id');
    const turretFields = turret as unknown as Record<string, unknown>;
    for (const field of ['hp', 'maxHp', 'cost', 'mass', 'deathExplosion', 'buildable', 'body', 'ownership', 'actions']) {
      assertContract(!(field in turretFields), `mounted turret must not carry independent ${field}`);
    }
    assertContract(world.getEntity(turret.id) === undefined, 'mounted turret must not be a detached entity');

    const meta = world.getEntityMeta(turret.id);
    if (meta === undefined) {
      throw new Error('[turret host integration] mounted turret metadata must be registered');
    }
    assertContract(meta.kind === 'turret', 'mounted turret metadata kind must be turret');
    assertContract(meta.parentId === host.id, 'mounted turret parent must be the host body');
    assertContract(meta.rootHostId === host.id, 'mounted turret root host must be the host body');
    assertContract(meta.mountIndex === turret.mountIndex, 'mounted turret metadata must preserve mount index');
    assertContract(meta.storagePool === 'combat.turrets', 'mounted turret metadata must resolve to the host combat pool');
    assertContract(meta.targetable, 'mounted non-visual turret must be targetable while the host body is live');
    const resolved = world.resolveMountedTurret(turret.id);
    assertContract(resolved?.host === host && resolved.turret === turret, 'mounted turret id must resolve back to its host assembly');

    const cs = getTransformCosSin(host.transform);
    const mount = resolveWeaponWorldMount(
      host,
      turret,
      turret.mountIndex,
      cs.cos,
      cs.sin,
      {
        currentTick: world.getTick(),
        unitGroundZ: getUnitGroundZ(host),
        surfaceN: hostUnit.surfaceNormal,
      },
    );
    // A turret is not a separate hit/collide body — radius.hitbox/collision
    // are removed. Area damage landing on a turret mount must never spawn a
    // separate turret kill, and the turret stays part of its host assembly.
    // (Whether the host body is hit now depends solely on the host's own
    // collider, never on a turret hit-surface, so we don't assert that here.)
    new DamageSystem(world).applyDamage({
      type: 'area',
      sourceEntityId: 9999 as EntityId,
      ownerId: 2 as PlayerId,
      damage: 7,
      excludeEntities: new Set<EntityId>(),
      center: { x: mount.x, y: mount.y, z: mount.z },
      radius: 1,
      knockbackForce: 0,
    });
    // Turrets never die separately from their host: DamageResult has no
    // killed-turret set at all, so the old size===0 assertion is now a
    // structural guarantee. The mount check below still proves the turret
    // survives area damage aimed directly at it.
    assertContract(world.resolveMountedTurret(turret.id)?.host === host, 'turret must remain mounted after area damage at its mount');

    const authoredTurrets = combat.turrets;
    host.buildable = createBuildable({ energy: 1, metal: 1 });
    host.buildable.pieces.push({
      id: host.id,
      kind: 'body',
      mountIndex: null,
      paid: { energy: 0, metal: 0 },
      required: { energy: 1, metal: 1 },
      healthBuildFraction: 0,
      isActive: false,
      isComplete: false,
    });
    world.refreshEntityMetadata(host);
    assertContract(world.resolveMountedTurret(turret.id) === undefined, 'unmaterialized host body must not leave a live turret');
    assertContract(host.combat?.turrets === authoredTurrets, 'construction state must keep the authored turret list on the host');

    host.buildable = null;
    hostUnit.hp = 0;
    world.refreshEntityMetadata(host);
    assertContract(world.resolveMountedTurret(turret.id) === undefined, 'dead host body must not leave a hostless live turret');
    assertContract(host.combat?.turrets === authoredTurrets, 'host death must keep turrets as part of the host assembly until removal');

    runOrcaTargetingContractTest();
    runWaterWeaponMediumTargetingContractTest();
    assertSlowRocketLaunchVelocityInheritance(true);
    assertSlowRocketLaunchVelocityInheritance(false);
    assertSlowRocketDropsLockAfterLosingTarget();
    assertBeamUsesSharedSnappyTurretAim();
    assertLorisReflectorRemainsAutonomousFromHostTask();
    assertShieldAwareTargetingUpgradeContract();
    assertShieldPowerContract();
    assertShieldSightObstructionIsOutsideInContract();
  } finally {
    resetTurretHostIntegrationState();
  }
}
