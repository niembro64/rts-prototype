import { getTransformCosSin } from '../math';
import { getUnitBlueprint } from './blueprints';
import { createBuildable } from './buildableHelpers';
import { CT_TURRET_STATE_ENGAGED } from '../sim-wasm/init';
import { DamageSystem } from './damage';
import { ForceAccumulator } from './ForceAccumulator';
import { spatialGrid } from './SpatialGrid';
import { beamIndex } from './BeamIndex';
import type { EntityId, PlayerId } from './types';
import { isProjectileShot, NO_ENTITY_ID } from './types';
import {
  finalizePendingProjectileLaunchVelocities,
  fireTurrets,
  hasPendingProjectileLaunchVelocityFinalization,
  updateProjectiles,
  updateTargetingAndFiringState,
  updateTurretRotation,
} from './combat';
import { getProjectileLaunchSpeed, resolveWeaponWorldMount } from './combat/combatUtils';
import { resetProjectileBuffers } from './combat/projectileSystem';
import {
  readCombatTargetingTurretFsmInto,
  stampCombatTargetingPool,
} from './combat/targetingInputStamping';
import { createProjectileConfigFromTurret } from './projectileConfigs';
import { getUnitGroundZ } from './unitGeometry';
import { WATER_LEVEL } from './Terrain';
import type { WindState } from './wind';
import { WorldState } from './WorldState';

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

function assertSlowRocketLaunchVelocityInheritance(addTurretVelocityToEmissionLaunch: boolean): void {
  resetTurretHostIntegrationState();
  const launchWorld = new WorldState(
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

  const badgerTurret = badger.combat.turrets[0];
  const previousInheritanceFlag = badgerTurret.config.addTurretVelocityToEmissionLaunch;
  badgerTurret.config.addTurretVelocityToEmissionLaunch = addTurretVelocityToEmissionLaunch;
  try {
    badger.combat.priorityTargetId = launchTarget.id;
    badger.combat.priorityTargetPoint = null;
    const dtMs = 50;
    stampCombatTargetingPool(launchWorld);
    const activeCombatUnits = updateTargetingAndFiringState(launchWorld, dtMs);
    updateTurretRotation(launchWorld, dtMs, activeCombatUnits);
    const fireResult = fireTurrets(launchWorld, dtMs, new ForceAccumulator(), activeCombatUnits);
    assertContract(fireResult.projectiles.length === 1, 'badger slow rocket should fire one projectile');
    assertContract(fireResult.spawnEvents.length === 1, 'badger slow rocket should emit one spawn event');

    const rocketEntity = fireResult.projectiles[0];
    const rocket = rocketEntity.projectile;
    const rocketSpawn = fireResult.spawnEvents[0];
    if (rocket === null) {
      throw new Error('[turret host integration] fired rocket must have a projectile component');
    }
    assertNear(rocketEntity.transform.x, badgerTurret.worldPos.x, 'shot launch x must be turret center x');
    assertNear(rocketEntity.transform.y, badgerTurret.worldPos.y, 'shot launch y must be turret center y');
    assertNear(rocketEntity.transform.z, badgerTurret.worldPos.z, 'shot launch z must be turret center z');
    assertNear(rocketSpawn.pos.x, badgerTurret.worldPos.x, 'spawn event x must be turret center x');
    assertNear(rocketSpawn.pos.y, badgerTurret.worldPos.y, 'spawn event y must be turret center y');
    assertNear(rocketSpawn.pos.z, badgerTurret.worldPos.z, 'spawn event z must be turret center z');
    assertContract(!rocket.isArmed, 'fresh physical shot must begin inert inside its host ARM sphere');
    assertNear(
      rocket.shotArmingRadius,
      badger.unit.radius.shotArmingRadius ?? 0,
      'shot must snapshot its host authored ARM radius at launch',
    );
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

function assertSlowRocketRetargetsAfterLosingTarget(): void {
  resetTurretHostIntegrationState();
  const world = new WorldState(5321, 1024, 1024);
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

  const turret = badger.combat.turrets[0];
  const projectileConfig = createProjectileConfigFromTurret(turret.config, 0);
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
    rocket.projectile.homingTargetId === replacementTarget.id,
    'homing rocket must acquire a replacement live target after its lock dies',
  );
  resetTurretHostIntegrationState();
}

function assertBeamSpawnAimsAtTargetOrigin(): void {
  resetTurretHostIntegrationState();
  const world = new WorldState(5322, 1024, 1024);
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
  spatialGrid.updateUnit(daddy);
  spatialGrid.updateUnit(target);
  if (daddy.combat === null) {
    throw new Error('[turret host integration] beam source must be armed');
  }

  daddy.combat.priorityTargetId = target.id;
  daddy.combat.priorityTargetPoint = null;
  const dtMs = 50;
  stampCombatTargetingPool(world);
  const activeCombatUnits = updateTargetingAndFiringState(world, dtMs);
  updateTurretRotation(world, dtMs, activeCombatUnits);

  const beamTurret = daddy.combat.turrets[0];
  beamTurret.rotation = 0;
  beamTurret.pitch = 0;
  beamTurret.aimErrorYaw = 0;
  beamTurret.aimErrorPitch = 0;

  const fireResult = fireTurrets(world, dtMs, new ForceAccumulator(), activeCombatUnits);
  const beamSpawn = fireResult.spawnEvents.find((event) => event.beam !== undefined);
  assertContract(beamSpawn !== undefined, 'mini beam turret must spawn a beam event');
  const beam = beamSpawn.beam;
  assertContract(beam !== undefined, 'beam spawn must carry start/end metadata');
  assertNear(beam.end.x, target.transform.x, 'beam spawn endpoint x must snap to target origin');
  assertNear(beam.end.y, target.transform.y, 'beam spawn endpoint y must snap to target origin');
  assertNear(beamSpawn.rotation, Math.PI / 2, 'beam spawn yaw must follow target-origin ray, not stale turret yaw');
  resetTurretHostIntegrationState();
}

function assertOrcaTargetsEnemyOrca(manualTarget: boolean): void {
  resetTurretHostIntegrationState();
  const world = new WorldState(manualTarget ? 6321 : 6322, 1024, 1024);
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

  const turret = source.combat.turrets[0];
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
    readCombatTargetingTurretFsmInto(source, 0, targetingState),
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
  const world = new WorldState(manualTarget ? 6323 : 6324, 1024, 1024);
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

  const turret = source.combat.turrets[0];
  assertContract(
    turret.config.rangeVolume === 'turret-range-top-water-and-bottom-unbounded',
    'Orca torpedo turret must use the authored water-ceiling range volume',
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
    readCombatTargetingTurretFsmInto(source, 0, targetingState),
    'Orca torpedo turret must have authoritative targeting state',
  );
  assertContract(
    targetingState.targetId === -1,
    `Orca torpedo turret must reject an above-water enemy ${manualTarget ? 'attack order' : 'during auto-targeting'}`,
  );
  resetTurretHostIntegrationState();
}

export function runOrcaTargetingContractTest(): void {
  assertOrcaTargetsEnemyOrca(true);
  assertOrcaTargetsEnemyOrca(false);
  assertOrcaRejectsEnemyAboveWater(true);
  assertOrcaRejectsEnemyAboveWater(false);
}

export function runTurretHostIntegrationContractTest(): void {
  resetTurretHostIntegrationState();
  try {
    const world = new WorldState(1234, 512, 512);
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

    const turret = combat.turrets[0];
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

    assertSlowRocketLaunchVelocityInheritance(true);
    assertSlowRocketLaunchVelocityInheritance(false);
    assertSlowRocketRetargetsAfterLosingTarget();
    assertBeamSpawnAimsAtTargetOrigin();
    runOrcaTargetingContractTest();
  } finally {
    resetTurretHostIntegrationState();
  }
}
