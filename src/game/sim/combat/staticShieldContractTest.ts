import type { Entity, EntityId, PlayerId, ShieldDeployedPose, Turret, TurretShieldState } from '../types';
import { NO_ENTITY_ID } from '../types';
import { WorldState } from '../WorldState';
import { getActiveShieldPanelTurret } from '../shieldPanelRuntime';
import { DamageSystem } from '../damage/DamageSystem';
import { spatialGrid } from '../SpatialGrid';
import { getMirrorArmDirection, getShieldPanelCenter } from '../shieldPanelCache';
import { getUnitGroundZ } from '../unitGeometry';
import { getTransformCosSin } from '../../math';
import { getSimWasm } from '../../sim-wasm/init';
import {
  advanceStaticShieldHostReadiness,
  getStaticShieldPanelEmissionPose,
  isShieldSurfaceDeployed,
  isStaticShieldDeploymentReady,
  isStaticShieldHostSettled,
  isStaticShieldPanelEmissionReady,
  isStaticShieldTurretPoseSettled,
  updateStaticShieldPanelEmissionState,
} from './staticShield';
import { findShieldSegmentIntersection, getActiveShields, updateShieldState } from './shieldTurret';
import { resolveWeaponWorldMount } from './combatUtils';
import { stampShieldSurfacePool } from './targetingInputStamping';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[static shield contract] ${message}`);
  }
}

function getBarrierShieldTurret(entity: Entity, unitName: string): Turret {
  const turret = entity.combat?.turrets.find(
    (candidate) => candidate.config.shot?.type === 'shield' && candidate.config.shot.barrier !== undefined,
  );
  assertContract(turret !== undefined, `${unitName} must expose a barrier shield turret`);
  return turret;
}

function settleStaticShieldHost(entity: Entity): void {
  const unit = entity.unit;
  assertContract(unit !== null, 'static shield test unit must have a unit component');
  unit.velocityX = 0;
  unit.velocityY = 0;
  unit.velocityZ = 0;
  unit.thrustDirX = 0;
  unit.thrustDirY = 0;
  const turrets = entity.combat?.turrets ?? [];
  for (const turret of turrets) {
    turret.angularVelocity = 0;
    turret.pitchVelocity = 0;
    turret.aimErrorYaw = 0;
    turret.aimErrorPitch = 0;
  }
  advanceStaticShieldHostReadiness(entity, 200);
}

function assertLatchedLorisPanelReflectors(
  world: WorldState,
  loris: Entity,
  turret: Turret,
  turretIndex: number,
): void {
  const unit = loris.unit;
  assertContract(unit !== null, 'Loris reflector contract requires a unit component');
  assertContract(unit.shieldPanels.length > 0, 'Loris reflector contract requires shield panels');
  const pose = getStaticShieldPanelEmissionPose(loris, turret);
  const unitGroundZ = getUnitGroundZ(loris);
  const unitCS = getTransformCosSin(loris.transform);
  const pivot = resolveWeaponWorldMount(
    loris,
    turret,
    turretIndex,
    unitCS.cos,
    unitCS.sin,
    {
      currentTick: world.getTick(),
      unitGroundZ,
      surfaceN: unit.surfaceNormal,
    },
    { x: 0, y: 0, z: 0 },
  );
  const panel = unit.shieldPanels[0];
  const center = getShieldPanelCenter(
    pivot.x,
    pivot.y,
    pivot.z,
    panel.offsetX,
    pose.rotation,
    pose.pitch,
    { x: 0, y: 0, z: 0 },
  );
  const normal = getMirrorArmDirection(pose.rotation, pose.pitch, { x: 0, y: 0, z: 0 });
  const startX = center.x + normal.x * 32;
  const startY = center.y + normal.y * 32;
  const startZ = center.z + normal.z * 32;
  const endX = center.x - normal.x * 32;
  const endY = center.y - normal.y * 32;
  const endZ = center.z - normal.z * 32;

  spatialGrid.clear();
  world.addEntity(loris);
  spatialGrid.updateUnit(loris);
  const damage = new DamageSystem(world);
  const beamPath = damage.findBeamPath(
    startX, startY, startZ,
    endX, endY, endZ,
    NO_ENTITY_ID,
    1,
    'beam',
    2,
  );
  assertContract(
    beamPath.reflections.length > 0 || beamPath.terminalReflection !== undefined,
    'latched Loris panel emission must reflect beam traces even while turret arms move',
  );

  stampShieldSurfacePool(world, { includeWhenSightDisabled: true });
  const sim = getSimWasm();
  assertContract(sim !== undefined, 'static shield reflector contract requires sim-wasm');
  const enabled = new Uint8Array([1]);
  const startXs = new Float64Array([startX]);
  const startYs = new Float64Array([startY]);
  const startZs = new Float64Array([startZ]);
  const endXs = new Float64Array([endX]);
  const endYs = new Float64Array([endY]);
  const endZs = new Float64Array([endZ]);
  const radii = new Float64Array([0]);
  const excludes = new Int32Array([NO_ENTITY_ID]);
  const outKind = new Uint8Array(1);
  const outEntity = new Int32Array(1);
  const outT = new Float64Array(1);
  const outX = new Float64Array(1);
  const outY = new Float64Array(1);
  const outZ = new Float64Array(1);
  const outNx = new Float64Array(1);
  const outNy = new Float64Array(1);
  const outNz = new Float64Array(1);
  const outSvx = new Float64Array(1);
  const outSvy = new Float64Array(1);
  const outSvz = new Float64Array(1);
  sim.projectileReflectorIntersectionsBatch(
    1,
    enabled,
    startXs,
    startYs,
    startZs,
    endXs,
    endYs,
    endZs,
    radii,
    excludes,
    1,
    0,
    0,
    16,
    outKind,
    outEntity,
    outT,
    outX,
    outY,
    outZ,
    outNx,
    outNy,
    outNz,
    outSvx,
    outSvy,
    outSvz,
  );
  assertContract(
    outKind[0] !== 0 && outEntity[0] === loris.id,
    'latched Loris panel emission must be stamped into the projectile reflector pool',
  );
  sim.shieldSurfacePool.clear();
  spatialGrid.clear();
}

function assertBarrierShieldReflectors(
  world: WorldState,
  host: Entity,
  turret: Turret,
  deployedPose: ShieldDeployedPose,
): void {
  const shot = turret.config.shot;
  assertContract(shot !== null && shot.type === 'shield', 'barrier reflector contract requires a shield shot');
  const barrier = shot.barrier;
  assertContract(barrier !== undefined, 'barrier reflector contract requires barrier geometry');
  const radius = barrier.outerRange;
  const startX = deployedPose.centerX + radius + 32;
  const startY = deployedPose.centerY;
  const startZ = deployedPose.centerZ;
  const endX = deployedPose.centerX;
  const endY = deployedPose.centerY;
  const endZ = deployedPose.centerZ;

  const beamShieldHit = findShieldSegmentIntersection(
    world,
    startX, startY, startZ,
    endX, endY, endZ,
  );
  assertContract(
    beamShieldHit !== null && beamShieldHit.entityId === host.id,
    'latched barrier shield must reflect beam traces through the active shield list',
  );

  stampShieldSurfacePool(world, { includeWhenSightDisabled: true });
  const sim = getSimWasm();
  assertContract(sim !== undefined, 'barrier reflector contract requires sim-wasm');
  const enabled = new Uint8Array([1]);
  const startXs = new Float64Array([startX]);
  const startYs = new Float64Array([startY]);
  const startZs = new Float64Array([startZ]);
  const endXs = new Float64Array([endX]);
  const endYs = new Float64Array([endY]);
  const endZs = new Float64Array([endZ]);
  const radii = new Float64Array([0]);
  const excludes = new Int32Array([NO_ENTITY_ID]);
  const outKind = new Uint8Array(1);
  const outEntity = new Int32Array(1);
  const outT = new Float64Array(1);
  const outX = new Float64Array(1);
  const outY = new Float64Array(1);
  const outZ = new Float64Array(1);
  const outNx = new Float64Array(1);
  const outNy = new Float64Array(1);
  const outNz = new Float64Array(1);
  const outSvx = new Float64Array(1);
  const outSvy = new Float64Array(1);
  const outSvz = new Float64Array(1);
  sim.projectileReflectorIntersectionsBatch(
    1,
    enabled,
    startXs,
    startYs,
    startZs,
    endXs,
    endYs,
    endZs,
    radii,
    excludes,
    0,
    1,
    0,
    16,
    outKind,
    outEntity,
    outT,
    outX,
    outY,
    outZ,
    outNx,
    outNy,
    outNz,
    outSvx,
    outSvy,
    outSvz,
  );
  assertContract(
    outKind[0] !== 0 && outEntity[0] === host.id,
    'latched barrier shield must be stamped into the projectile reflector pool',
  );
  sim.shieldSurfacePool.clear();
}

export function runStaticShieldContractTest(): void {
  const world = new WorldState(91, 512, 512);
  const unit = world.createUnitFromBlueprint(0, 0, 1 as PlayerId, 'unitDaddy');
  const host = unit.unit;
  const turret = getBarrierShieldTurret(unit, 'Daddy');
  assertContract(host !== null, 'test host must have a unit component');

  settleStaticShieldHost(unit);
  assertContract(isStaticShieldHostSettled(unit), 'stopped host must be shield-settled');
  assertContract(isStaticShieldTurretPoseSettled(turret), 'still turret must be pose-settled');
  assertContract(
    isStaticShieldDeploymentReady(unit, turret, true),
    'stopped host with still aimed turret must be ready to deploy',
  );

  host.velocityX = 5;
  advanceStaticShieldHostReadiness(unit, 16);
  assertContract(
    isStaticShieldHostSettled(unit),
    'single-frame body velocity jitter must not unsettle a latched static shield host',
  );
  advanceStaticShieldHostReadiness(unit, 200);
  assertContract(!isStaticShieldHostSettled(unit), 'moving host must not be shield-settled');
  assertContract(
    !isStaticShieldDeploymentReady(unit, turret, true),
    'moving host must not be ready to deploy',
  );

  settleStaticShieldHost(unit);
  host.thrustDirX = 1;
  assertContract(
    isStaticShieldHostSettled(unit),
    'movement intent alone must not unsettle a stopped static shield host',
  );
  assertContract(
    isStaticShieldDeploymentReady(unit, turret, true),
    'movement intent alone must not block static shield deployment while the body is stopped',
  );

  const widow = world.createUnitFromBlueprint(40, 0, 1 as PlayerId, 'unitWidow');
  const widowTurret = getBarrierShieldTurret(widow, 'Widow');
  settleStaticShieldHost(widow);
  widow.unit!.thrustDirX = 1;
  assertContract(
    isStaticShieldDeploymentReady(widow, widowTurret, true),
    'Widow shield deployment must not flicker off from movement intent while the body is stopped',
  );

  const loris = world.createUnitFromBlueprint(80, 0, 1 as PlayerId, 'unitLoris');
  settleStaticShieldHost(loris);
  loris.unit!.thrustDirX = 1;
  const initialLorisPanel = getActiveShieldPanelTurret(loris);
  assertContract(initialLorisPanel !== null, 'Loris must expose a shield panel turret');
  assertContract(
    updateStaticShieldPanelEmissionState(loris, initialLorisPanel.turret),
    'settled Loris panel turret must latch a static shield emission',
  );
  assertContract(
    getActiveShieldPanelTurret(loris) !== null,
    'Loris shield panel emission must not flicker off from movement intent while the body is stopped',
  );
  const lorisPanel = getActiveShieldPanelTurret(loris);
  assertContract(lorisPanel !== null, 'Loris must expose an active settled shield panel turret');
  const latchedLorisPose = getStaticShieldPanelEmissionPose(loris, lorisPanel.turret);
  lorisPanel.turret.angularVelocity = 0.5;
  lorisPanel.turret.rotation = latchedLorisPose.rotation + Math.PI / 2;
  assertContract(
    isStaticShieldPanelEmissionReady(loris, lorisPanel.turret),
    'moving Loris panel turret arms must not stow an already latched static shield panel',
  );
  assertContract(
    getActiveShieldPanelTurret(loris) !== null,
    'Loris shield panel emission must remain active while the colored arms track',
  );
  const movingArmPose = getStaticShieldPanelEmissionPose(loris, lorisPanel.turret);
  assertContract(
    movingArmPose.rotation === latchedLorisPose.rotation &&
      movingArmPose.pitch === latchedLorisPose.pitch,
    'Loris shield panel emission pose must stay latched while the turret arms move',
  );
  assertLatchedLorisPanelReflectors(world, loris, lorisPanel.turret, lorisPanel.turretIndex);
  lorisPanel.turret.angularVelocity = 0;
  assertContract(
    isStaticShieldPanelEmissionReady(loris, lorisPanel.turret),
    'stopped Loris host with settled panel turret must be ready to emit a static shield panel',
  );
  loris.unit!.velocityX = 5;
  advanceStaticShieldHostReadiness(loris, 200);
  updateStaticShieldPanelEmissionState(loris, lorisPanel.turret);
  assertContract(
    getActiveShieldPanelTurret(loris) === null,
    'moving Loris host must stow the static shield panel emission',
  );

  settleStaticShieldHost(unit);
  host.thrustDirX = 0;
  turret.angularVelocity = 0.5;
  assertContract(
    !isStaticShieldDeploymentReady(unit, turret, true),
    'moving turret aim must not be ready to deploy',
  );

  turret.angularVelocity = 0;
  turret.shield = { transition: 0, range: 0, deployedPose: null };
  assertContract(!isShieldSurfaceDeployed(turret), 'zero transition must not count as deployed');
  turret.shield.transition = 0.5;
  assertContract(isShieldSurfaceDeployed(turret), 'positive transition must count as deployed');

  turret.shield = null;
  turret.state = 'engaged';
  turret.target = 777 as EntityId;
  world.addEntity(unit);
  updateShieldState(world, 16);
  const shieldAfterDeploy = turret.shield as TurretShieldState | null;
  const deployedPose = shieldAfterDeploy?.deployedPose ?? null;
  assertContract(deployedPose !== null, 'settled host must latch a deployed shield surface');
  assertContract(getActiveShields().length === 1, 'latched shield surface must publish one active barrier');
  assertBarrierShieldReflectors(world, unit, turret, deployedPose);

  turret.target = 888 as EntityId;
  updateShieldState(world, 16);
  const shieldAfterTargetChange = turret.shield as TurretShieldState | null;
  assertContract(
    shieldAfterTargetChange?.deployedPose === deployedPose,
    'non-aimed shield target changes must not relatch the static surface',
  );
  assertContract(getActiveShields().length === 1, 'target change must keep the active barrier published');

  host.velocityX = 5;
  advanceStaticShieldHostReadiness(unit, 200);
  updateShieldState(world, 16);
  const shieldAfterMove = turret.shield as TurretShieldState | null;
  assertContract(shieldAfterMove?.deployedPose === null, 'moving host must drop the deployed shield surface');
  assertContract(shieldAfterMove?.transition === 0, 'moving host must stow the shield immediately');
  assertContract(getActiveShields().length === 0, 'stowed shield must remove active surface');
}
