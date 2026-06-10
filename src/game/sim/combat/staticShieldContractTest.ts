import type { EntityId, PlayerId, TurretShieldState } from '../types';
import { WorldState } from '../WorldState';
import {
  isShieldSurfaceDeployed,
  isStaticShieldDeploymentReady,
  isStaticShieldHostSettled,
  isStaticShieldTurretPoseSettled,
} from './staticShield';
import { getActiveShields, updateShieldState } from './shieldTurret';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[static shield contract] ${message}`);
  }
}

export function runStaticShieldContractTest(): void {
  const world = new WorldState(91, 512, 512);
  const unit = world.createUnitFromBlueprint(0, 0, 1 as PlayerId, 'unitAlbatros');
  const host = unit.unit;
  const turret = unit.combat?.turrets[0];
  assertContract(host !== null, 'test host must have a unit component');
  assertContract(turret !== undefined, 'Albatros must expose its shield turret');

  host.velocityX = 0;
  host.velocityY = 0;
  host.velocityZ = 0;
  host.thrustDirX = 0;
  host.thrustDirY = 0;
  turret.angularVelocity = 0;
  turret.pitchVelocity = 0;
  turret.aimErrorYaw = 0;
  turret.aimErrorPitch = 0;
  assertContract(isStaticShieldHostSettled(unit), 'stopped host must be shield-settled');
  assertContract(isStaticShieldTurretPoseSettled(turret), 'still turret must be pose-settled');
  assertContract(
    isStaticShieldDeploymentReady(unit, turret, true),
    'stopped host with still aimed turret must be ready to deploy',
  );

  host.velocityX = 5;
  assertContract(!isStaticShieldHostSettled(unit), 'moving host must not be shield-settled');
  assertContract(
    !isStaticShieldDeploymentReady(unit, turret, true),
    'moving host must not be ready to deploy',
  );

  host.velocityX = 0;
  host.thrustDirX = 1;
  assertContract(
    !isStaticShieldDeploymentReady(unit, turret, true),
    'host with movement thrust intent must not be ready to deploy',
  );

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
  assertContract(deployedPose !== null, 'settled Albatros must latch a deployed shield lane');
  assertContract(getActiveShields().length === 1, 'latched shield lane must publish one active surface');

  turret.aimTargetYaw = deployedPose.rotation + 0.1;
  updateShieldState(world, 16);
  const shieldAfterDrift = turret.shield as TurretShieldState | null;
  assertContract(shieldAfterDrift?.deployedPose === null, 'aim drift must drop the deployed shield lane');
  assertContract(shieldAfterDrift?.transition === 0, 'dropped aimed lane must stow immediately');
  assertContract(getActiveShields().length === 0, 'dropped aimed lane must remove active surface');
}
