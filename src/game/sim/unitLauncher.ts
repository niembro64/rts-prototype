import { GRAVITY, UNIT_MASS_MULTIPLIER } from '../../config';
import {
  ENTITY_CHANGED_ACTIONS,
  ENTITY_CHANGED_COMBAT_MODE,
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_TURRETS,
  ENTITY_CHANGED_VEL,
} from '../../types/network';
import type { EntityId } from '../../types/entityTypes';
import type { Vec3 } from '../../types/vec2';
import { solveTurretShotAngles, type TurretShotAngleSolution } from '../math/Ballistics';
import { getBarrelTip } from '../math/BarrelGeometry';
import { getTransformCosSin, normalizeAngle } from '../math';
import { getEntityTargetPoint } from './buildingAnchors';
import type { ForceAccumulator } from './ForceAccumulator';
import {
  getEntityAcceleration3d,
  getEntityVelocity3d,
  updateWeaponWorldKinematics,
} from './combat/combatUtils';
import type { Entity, Turret, UnitAction } from './types';
import { setUnitActions } from './unitActions';
import { getUnitGroundZ } from './unitGeometry';
import type { WorldState } from './WorldState';

const FALLBACK_LAUNCH_PITCH = Math.PI / 4;
const MIN_DIRECTION_LENGTH = 1e-6;
const EXTERNAL_FORCE_KERNEL_DIVISOR = 3600;
const EXTERNAL_FORCE_KERNEL_ACCEL_SCALE = 1_000_000;

const _mount = { x: 0, y: 0, z: 0 };
const _hostVelocity = { x: 0, y: 0, z: 0 };
const _targetVelocity = { x: 0, y: 0, z: 0 };
const _targetAcceleration = { x: 0, y: 0, z: 0 };
const _zeroAcceleration = { x: 0, y: 0, z: 0 };
const _targetPoint = { x: 0, y: 0, z: 0 };
const _launchSolution: TurretShotAngleSolution = {
  time: 0,
  aimPoint: { x: 0, y: 0, z: 0 },
  launchVelocity: { x: 0, y: 0, z: 0 },
  yaw: 0,
  pitch: 0,
  direction: { x: 1, y: 0, z: 0 },
};

export type UnitLauncherTurretRef = {
  turret: Turret;
  turretIndex: number;
};

export function findUnitLauncherTurret(
  host: Entity,
  predicate: ((turret: Turret) => boolean) | null = null,
): UnitLauncherTurretRef | null {
  const turrets = host.combat?.turrets;
  if (turrets === undefined) return null;
  for (let i = 0; i < turrets.length; i++) {
    const turret = turrets[i];
    if (turret.config.unitLauncher === null) continue;
    if (predicate !== null && !predicate(turret)) continue;
    return { turret, turretIndex: i };
  }
  return null;
}

export function isLiveUnitLauncherTarget(
  world: WorldState,
  host: Entity,
  target: Entity | null,
): target is Entity {
  if (target === null || target.ownership === null || host.ownership === null) return false;
  if (world.arePlayersAllied(host.ownership.playerId, target.ownership.playerId)) return false;
  if (target.unit !== null) return target.unit.hp > 0;
  if (target.building !== null) return target.building.hp > 0;
  return false;
}

export function inheritProducedUnitIntent(
  world: WorldState,
  host: Entity,
  produced: Entity,
  target: Entity | null,
): void {
  const producedUnit = produced.unit;
  if (producedUnit === null) return;

  if (isLiveUnitLauncherTarget(world, host, target)) {
    const targetPoint = getEntityTargetPoint(target);
    setUnitActions(producedUnit, [{
      type: 'attack',
      x: targetPoint.x,
      y: targetPoint.y,
      z: targetPoint.z,
      targetId: target.id,
    }]);
    producedUnit.patrolStartIndex = null;
    if (produced.combat !== null) {
      produced.combat.priorityTargetId = target.id;
      produced.combat.priorityTargetPoint = null;
      produced.combat.manualLaunchActive = false;
    }
    world.markSnapshotDirty(
      produced.id,
      ENTITY_CHANGED_ACTIONS | ENTITY_CHANGED_COMBAT_MODE,
    );
    return;
  }

  const hostUnit = host.unit;
  if (hostUnit === null || hostUnit.actions.length === 0) return;
  const actions = new Array<UnitAction>(hostUnit.actions.length);
  for (let i = 0; i < hostUnit.actions.length; i++) {
    actions[i] = { ...hostUnit.actions[i] };
  }
  setUnitActions(producedUnit, actions);
  producedUnit.patrolStartIndex = hostUnit.patrolStartIndex;
  world.markSnapshotDirty(produced.id, ENTITY_CHANGED_ACTIONS);
}

export function launchProducedUnitFromTurret(
  world: WorldState,
  forceAccumulator: ForceAccumulator,
  host: Entity,
  launcher: UnitLauncherTurretRef,
  produced: Entity,
  dtMs: number,
  target: Entity | null = null,
): void {
  if (produced.unit === null || host.combat === null) return;
  const turret = launcher.turret;
  const unitLauncher = turret.config.unitLauncher;
  if (unitLauncher === null) return;

  const { cos, sin } = getTransformCosSin(host.transform);
  const currentTick = world.getTick();
  const mount = updateWeaponWorldKinematics(
    host,
    turret,
    launcher.turretIndex,
    cos,
    sin,
    {
      currentTick,
      dtMs,
      unitGroundZ: getUnitGroundZ(host),
      surfaceN: host.unit !== null ? host.unit.surfaceNormal : undefined,
    },
    _mount,
  );

  const dir = chooseLaunchDirection(world, host, turret, produced, mount, target);
  if (!isFiniteDirection(dir)) {
    writeFallbackDirection(host, produced, dir);
  }
  const yaw = Math.atan2(dir.y, dir.x);
  const horizontal = Math.hypot(dir.x, dir.y);
  const pitch = Math.atan2(dir.z, horizontal);

  turret.rotation = normalizeAngle(yaw);
  turret.pitch = pitch;
  turret.aimTargetYaw = turret.rotation;
  turret.aimTargetPitch = pitch;
  turret.aimErrorYaw = 0;
  turret.aimErrorPitch = 0;
  turret.angularVelocity = 0;
  turret.angularAcceleration = 0;
  turret.pitchVelocity = 0;
  turret.pitchAcceleration = 0;
  turret.ballisticAimInRange = true;

  const barrelTip = getBarrelTip(
    mount.x,
    mount.y,
    mount.z,
    yaw,
    pitch,
    turret.config,
    0,
    0,
  );
  const clearance = Math.max(4, produced.unit.radius.collision * 0.75);
  const spawn = {
    x: barrelTip.x + dir.x * clearance,
    y: barrelTip.y + dir.y * clearance,
    z: barrelTip.z + dir.z * clearance,
  };
  if (!Number.isFinite(spawn.x) || !Number.isFinite(spawn.y) || !Number.isFinite(spawn.z)) {
    return;
  }
  const inheritedVelocity = getEntityVelocity3d(host, _hostVelocity);
  writeProducedLaunchPose(produced, spawn, inheritedVelocity, yaw);

  const launchForce = turret.config.launchForce;
  const dtSec = Math.max(dtMs / 1000, 1 / 120);
  if (Number.isFinite(launchForce) && launchForce > 0 && dtSec > 0) {
    const forceMagnitude =
      launchForce *
      UNIT_MASS_MULTIPLIER *
      EXTERNAL_FORCE_KERNEL_DIVISOR /
      (EXTERNAL_FORCE_KERNEL_ACCEL_SCALE * dtSec);
    forceAccumulator.addForce(
      produced.id,
      dir.x * forceMagnitude,
      dir.y * forceMagnitude,
      'unit-launch',
      dir.z * forceMagnitude,
    );
  }

  world.markSnapshotDirty(
    host.id,
    ENTITY_CHANGED_TURRETS,
  );
  world.markSnapshotDirty(
    produced.id,
    ENTITY_CHANGED_POS | ENTITY_CHANGED_VEL,
  );
}

function chooseLaunchDirection(
  world: WorldState,
  host: Entity,
  turret: Turret,
  produced: Entity,
  origin: Vec3,
  target: Entity | null,
): Vec3 {
  const mode = turret.config.unitLauncher?.aimMode ?? 'ballistic-or-waypoint';
  if (mode === 'direct-target' && isLiveUnitLauncherTarget(world, host, target)) {
    writeEntityTargetPoint(target, _targetPoint);
    return directionToPoint(origin, _targetPoint, fallbackDirection(host, produced, origin));
  }

  if (isLiveUnitLauncherTarget(world, host, target)) {
    const solved = solveBallisticLaunchDirection(turret, produced, origin, target);
    if (solved !== null) return solved;
    writeEntityTargetPoint(target, _targetPoint);
    return fallbackFortyFiveDirectionToPoint(host, produced, origin, _targetPoint);
  }

  const actionPoint = firstProducedActionPoint(produced);
  if (actionPoint !== null) {
    return fallbackFortyFiveDirectionToPoint(host, produced, origin, actionPoint);
  }
  return fallbackDirection(host, produced, origin);
}

function solveBallisticLaunchDirection(
  turret: Turret,
  produced: Entity,
  origin: Vec3,
  target: Entity,
): Vec3 | null {
  const unit = produced.unit;
  if (unit === null || unit.mass <= 1e-6) return null;
  const projectileSpeed = turret.config.launchForce / unit.mass;
  if (!Number.isFinite(projectileSpeed) || projectileSpeed <= 1e-6) return null;

  writeEntityTargetPoint(target, _targetPoint);
  const targetVelocity = getEntityVelocity3d(target, _targetVelocity);
  const targetAcceleration = getEntityAcceleration3d(target, _targetAcceleration);
  const solution = solveTurretShotAngles(
    {
      myPosition: origin,
      myVelocity: turret.worldVelocity,
      myAcceleration: _zeroAcceleration,
      targetPosition: _targetPoint,
      targetVelocity,
      targetAcceleration,
      projectileSpeed,
      gravity: GRAVITY,
      arcPreference: 'low',
      maxTimeSec: 0,
    },
    _launchSolution,
  );
  if (solution === null) return null;
  return solution.direction;
}

function firstProducedActionPoint(produced: Entity): Vec3 | null {
  const action = produced.unit?.actions[0];
  if (action === undefined) return null;
  _targetPoint.x = action.x;
  _targetPoint.y = action.y;
  _targetPoint.z = action.z ?? produced.transform.z;
  return _targetPoint;
}

function writeEntityTargetPoint(entity: Entity, out: Vec3): Vec3 {
  const point = getEntityTargetPoint(entity);
  out.x = point.x;
  out.y = point.y;
  out.z = point.z;
  return out;
}

function directionToPoint(origin: Vec3, point: Vec3, fallback: Vec3): Vec3 {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const dz = point.z - origin.z;
  const len = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(len) || len <= MIN_DIRECTION_LENGTH) return fallback;
  fallback.x = dx / len;
  fallback.y = dy / len;
  fallback.z = dz / len;
  return fallback;
}

function fallbackFortyFiveDirectionToPoint(
  host: Entity,
  produced: Entity,
  origin: Vec3,
  point: Vec3,
): Vec3 {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const len = Math.hypot(dx, dy);
  const out = fallbackDirection(host, produced, origin);
  if (Number.isFinite(len) && len > MIN_DIRECTION_LENGTH) {
    const pitchCos = Math.cos(FALLBACK_LAUNCH_PITCH);
    out.x = (dx / len) * pitchCos;
    out.y = (dy / len) * pitchCos;
    out.z = Math.sin(FALLBACK_LAUNCH_PITCH);
  }
  return out;
}

function fallbackDirection(host: Entity, produced: Entity, _origin: Vec3): Vec3 {
  const out = _launchSolution.direction;
  writeFallbackDirection(host, produced, out);
  return out;
}

function writeFallbackDirection(host: Entity, produced: Entity, out: Vec3): void {
  const action = produced.unit?.actions[0];
  let yaw = host.transform.rotation;
  if (action !== undefined) {
    const dx = action.x - produced.transform.x;
    const dy = action.y - produced.transform.y;
    if (Math.hypot(dx, dy) > MIN_DIRECTION_LENGTH) {
      yaw = Math.atan2(dy, dx);
    }
  }
  const pitchCos = Math.cos(FALLBACK_LAUNCH_PITCH);
  out.x = Math.cos(yaw) * pitchCos;
  out.y = Math.sin(yaw) * pitchCos;
  out.z = Math.sin(FALLBACK_LAUNCH_PITCH);
}

function isFiniteDirection(dir: Vec3): boolean {
  return (
    Number.isFinite(dir.x) &&
    Number.isFinite(dir.y) &&
    Number.isFinite(dir.z) &&
    Math.hypot(dir.x, dir.y, dir.z) > MIN_DIRECTION_LENGTH
  );
}

function writeProducedLaunchPose(
  produced: Entity,
  position: Vec3,
  inheritedVelocity: Vec3,
  yaw: number,
): void {
  produced.transform.x = position.x;
  produced.transform.y = position.y;
  produced.transform.z = position.z;
  produced.transform.rotation = yaw;
  produced.transform.rotCos = null;
  produced.transform.rotSin = null;

  if (produced.unit !== null) {
    produced.unit.velocityX = Number.isFinite(inheritedVelocity.x) ? inheritedVelocity.x : 0;
    produced.unit.velocityY = Number.isFinite(inheritedVelocity.y) ? inheritedVelocity.y : 0;
    produced.unit.velocityZ = Number.isFinite(inheritedVelocity.z) ? inheritedVelocity.z : 0;
  }

  const body = produced.body?.physicsBody;
  if (body !== undefined) {
    body.x = position.x;
    body.y = position.y;
    body.z = position.z;
    body.vx = Number.isFinite(inheritedVelocity.x) ? inheritedVelocity.x : 0;
    body.vy = Number.isFinite(inheritedVelocity.y) ? inheritedVelocity.y : 0;
    body.vz = Number.isFinite(inheritedVelocity.z) ? inheritedVelocity.z : 0;
  }
}

export function targetIdToLiveEnemyEntity(
  world: WorldState,
  host: Entity,
  targetId: EntityId | null | undefined,
): Entity | null {
  if (targetId === null || targetId === undefined || targetId < 0) return null;
  const target = world.getEntity(targetId) ?? null;
  return isLiveUnitLauncherTarget(world, host, target) ? target : null;
}
