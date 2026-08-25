import { GRAVITY } from '../../config';
import {
  solveKinematicIntercept,
  type KinematicInterceptSolution,
} from '../math';
import { rayDistanceToMapEdge } from '../math/rayMapBounds';
import { deterministicMath as DMath } from './deterministicMath';
import type { Entity } from './types';
import type { WorldState } from './WorldState';
import {
  isDirectionalFabricatorBuildingBlueprintId,
  isFabricatorBuildingBlueprintId,
} from './blueprints/buildings';

export const MOBILE_FACTORY_VERTICAL_LAUNCH_SPEED = 520;
const PRODUCTION_LAUNCH_SPEED = MOBILE_FACTORY_VERTICAL_LAUNCH_SPEED;
const PRODUCTION_LAUNCH_MAX_TIME_SEC = 4.5;
const PRODUCTION_LAUNCH_SEARCH_ITERATIONS = 14;
const PRODUCTION_LAUNCH_MIN_DISTANCE = 24;
const PRODUCTION_LAUNCH_FALLBACK_UP_FRACTION = 0.42;

type FactoryProductionLaunchPlan = {
  yaw: number;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  targetX: number;
  targetY: number;
  targetZ: number;
};

const _intercept: KinematicInterceptSolution = {
  time: 0,
  aimPoint: { x: 0, y: 0, z: 0 },
  launchVelocity: { x: 0, y: 0, z: 0 },
};
const _zero = { x: 0, y: 0, z: 0 };
const _originVelocity = { x: 0, y: 0, z: 0 };
const _originPosition = { x: 0, y: 0, z: 0 };
const _targetPosition = { x: 0, y: 0, z: 0 };

function entityIsAlive(entity: Entity | undefined): entity is Entity {
  if (entity === undefined) return false;
  if (entity.unit !== null) return entity.unit.hp > 0;
  if (entity.building !== null) return entity.building.hp > 0;
  return false;
}

function productionLaunchSpeedForFactory(factory: Entity): number {
  if (isFabricatorBuildingBlueprintId(factory.buildingBlueprintId)) return 0;
  return PRODUCTION_LAUNCH_SPEED;
}

function resolveLaunchDirectionTarget(
  world: WorldState,
  factory: Entity,
): { x: number; y: number; z: number | null } {
  const combat = factory.combat;
  const priorityTargetId = combat?.priorityTargetId ?? null;
  if (factory.unit !== null && priorityTargetId !== null) {
    const target = world.getEntity(priorityTargetId);
    if (entityIsAlive(target)) {
      return {
        x: target.transform.x,
        y: target.transform.y,
        z: target.transform.z,
      };
    }
  }
  const priorityTargetPoint = combat?.priorityTargetPoint ?? null;
  if (factory.unit !== null && priorityTargetPoint !== null) {
    return priorityTargetPoint;
  }

  const factoryComp = factory.factory;
  const route = factoryComp?.defaultWaypoints ?? null;
  if (route !== null && route.length > 0) {
    return route[0];
  }
  if (factoryComp !== null) {
    return { x: factoryComp.rallyX, y: factoryComp.rallyY, z: factoryComp.rallyZ };
  }
  const yaw = factory.transform.rotation;
  return {
    x: factory.transform.x + DMath.cos(yaw) * 128,
    y: factory.transform.y + DMath.sin(yaw) * 128,
    z: null,
  };
}

function writeTargetAtDistance(
  world: WorldState,
  heldUnit: Entity,
  dirX: number,
  dirY: number,
  distance: number,
): void {
  const unit = heldUnit.unit;
  const supportPointOffsetZ = unit?.supportPointOffsetZ ?? 0;
  const x = heldUnit.transform.x + dirX * distance;
  const y = heldUnit.transform.y + dirY * distance;
  const support = world.sampleSupportSurface(x, y);
  _targetPosition.x = x;
  _targetPosition.y = y;
  _targetPosition.z = support.groundZ + supportPointOffsetZ;
}

function solveLaunchToCurrentTarget(
  heldUnit: Entity,
  projectileSpeed: number,
): KinematicInterceptSolution | null {
  const unit = heldUnit.unit;
  if (unit === null) return null;
  _originPosition.x = heldUnit.transform.x;
  _originPosition.y = heldUnit.transform.y;
  _originPosition.z = heldUnit.transform.z;
  _originVelocity.x = unit.velocityX;
  _originVelocity.y = unit.velocityY;
  _originVelocity.z = unit.velocityZ;
  return solveKinematicIntercept({
    myPosition: _originPosition,
    myVelocity: _originVelocity,
    targetPosition: _targetPosition,
    targetVelocity: _zero,
    projectileSpeed,
    projectileLinearDampingRate: 0,
    gravity: GRAVITY,
    preferLateSolution: false,
    maxTimeSec: PRODUCTION_LAUNCH_MAX_TIME_SEC,
  }, _intercept);
}

function canReachAtDistance(
  world: WorldState,
  heldUnit: Entity,
  dirX: number,
  dirY: number,
  distance: number,
  projectileSpeed: number,
): boolean {
  if (distance <= PRODUCTION_LAUNCH_MIN_DISTANCE) return true;
  writeTargetAtDistance(world, heldUnit, dirX, dirY, distance);
  return solveLaunchToCurrentTarget(heldUnit, projectileSpeed) !== null;
}

function resolveFactoryProductionLaunchPlan(
  world: WorldState,
  factory: Entity,
  heldUnit: Entity,
): FactoryProductionLaunchPlan | null {
  if (heldUnit.unit === null) return null;
  if (factory.unit !== null) {
    // A mobile factory's horizontal hold ring faces world-up. Release its
    // finished product along that normal instead of aiming a ballistic arc
    // toward the queen's rally or combat target.
    const yaw = factory.transform.rotation;
    return {
      yaw,
      velocityX: 0,
      velocityY: 0,
      velocityZ: MOBILE_FACTORY_VERTICAL_LAUNCH_SPEED,
      targetX: heldUnit.transform.x,
      targetY: heldUnit.transform.y,
      targetZ: heldUnit.transform.z + MOBILE_FACTORY_VERTICAL_LAUNCH_SPEED,
    };
  }
  if (isDirectionalFabricatorBuildingBlueprintId(factory.buildingBlueprintId)) {
    // A specialist's facing owns its exit lane. Rally points are applied only
    // after the shell clears the mouth, so a rally behind the factory cannot
    // make a new unit turn through the rear machine block.
    const yaw = factory.transform.rotation;
    return stationaryDropPlan(
      heldUnit,
      DMath.cos(yaw),
      DMath.sin(yaw),
      yaw,
    );
  }
  const target = resolveLaunchDirectionTarget(world, factory);
  let dx = target.x - heldUnit.transform.x;
  let dy = target.y - heldUnit.transform.y;
  let len = DMath.hypot(dx, dy);
  if (!Number.isFinite(len) || len <= 1e-6) {
    dx = DMath.cos(factory.transform.rotation);
    dy = DMath.sin(factory.transform.rotation);
    len = 1;
  }
  const dirX = dx / len;
  const dirY = dy / len;
  const yaw = DMath.atan2(dirY, dirX);
  const launchSpeed = productionLaunchSpeedForFactory(factory);

  if (launchSpeed <= 0) {
    return stationaryDropPlan(heldUnit, dirX, dirY, yaw);
  }

  const mapLimit = rayDistanceToMapEdge(
    heldUnit.transform.x,
    heldUnit.transform.y,
    dirX,
    dirY,
    world.mapWidth,
    world.mapHeight,
  );
  if (mapLimit <= PRODUCTION_LAUNCH_MIN_DISTANCE) {
    return fallbackLaunchPlan(heldUnit, dirX, dirY, yaw, launchSpeed);
  }

  let distance = mapLimit;
  if (!canReachAtDistance(world, heldUnit, dirX, dirY, mapLimit, launchSpeed)) {
    let lo = 0;
    let hi = mapLimit;
    for (let i = 0; i < PRODUCTION_LAUNCH_SEARCH_ITERATIONS; i++) {
      const mid = (lo + hi) * 0.5;
      if (canReachAtDistance(world, heldUnit, dirX, dirY, mid, launchSpeed)) lo = mid;
      else hi = mid;
    }
    distance = lo;
  }

  if (distance <= PRODUCTION_LAUNCH_MIN_DISTANCE) {
    return fallbackLaunchPlan(heldUnit, dirX, dirY, yaw, launchSpeed);
  }
  writeTargetAtDistance(world, heldUnit, dirX, dirY, distance);
  const solution = solveLaunchToCurrentTarget(heldUnit, launchSpeed);
  if (solution === null) return fallbackLaunchPlan(heldUnit, dirX, dirY, yaw, launchSpeed);
  return {
    yaw,
    velocityX: solution.launchVelocity.x + _originVelocity.x,
    velocityY: solution.launchVelocity.y + _originVelocity.y,
    velocityZ: solution.launchVelocity.z + _originVelocity.z,
    targetX: _targetPosition.x,
    targetY: _targetPosition.y,
    targetZ: _targetPosition.z,
  };
}

function stationaryDropPlan(
  heldUnit: Entity,
  dirX: number,
  dirY: number,
  yaw: number,
): FactoryProductionLaunchPlan {
  return {
    yaw,
    velocityX: 0,
    velocityY: 0,
    velocityZ: 0,
    targetX: heldUnit.transform.x + dirX * PRODUCTION_LAUNCH_MIN_DISTANCE,
    targetY: heldUnit.transform.y + dirY * PRODUCTION_LAUNCH_MIN_DISTANCE,
    targetZ: heldUnit.transform.z,
  };
}

function fallbackLaunchPlan(
  heldUnit: Entity,
  dirX: number,
  dirY: number,
  yaw: number,
  launchSpeed: number,
): FactoryProductionLaunchPlan {
  const horizontalSpeed = launchSpeed * 0.9;
  return {
    yaw,
    velocityX: dirX * horizontalSpeed,
    velocityY: dirY * horizontalSpeed,
    velocityZ: launchSpeed * PRODUCTION_LAUNCH_FALLBACK_UP_FRACTION,
    targetX: heldUnit.transform.x + dirX * PRODUCTION_LAUNCH_MIN_DISTANCE,
    targetY: heldUnit.transform.y + dirY * PRODUCTION_LAUNCH_MIN_DISTANCE,
    targetZ: heldUnit.transform.z,
  };
}

export function updateFactoryProductionHoldLaunchPose(
  world: WorldState,
  factory: Entity,
  heldUnit: Entity,
): FactoryProductionLaunchPlan | null {
  const plan = resolveFactoryProductionLaunchPlan(world, factory, heldUnit);
  if (plan === null) return null;
  if (heldUnit.heldBy !== null && heldUnit.heldBy.kind === 'production') {
    heldUnit.heldBy.worldRotation = plan.yaw;
  }
  heldUnit.transform.rotation = plan.yaw;
  heldUnit.transform.rotCos = null;
  heldUnit.transform.rotSin = null;
  return plan;
}

export function applyFactoryProductionLaunch(
  heldUnit: Entity,
  plan: FactoryProductionLaunchPlan,
): void {
  heldUnit.transform.rotation = plan.yaw;
  heldUnit.transform.rotCos = null;
  heldUnit.transform.rotSin = null;
  const unit = heldUnit.unit;
  if (unit !== null) {
    unit.velocityX = plan.velocityX;
    unit.velocityY = plan.velocityY;
    unit.velocityZ = plan.velocityZ;
  }
  const body = heldUnit.body?.physicsBody;
  if (body !== undefined) {
    body.vx = plan.velocityX;
    body.vy = plan.velocityY;
    body.vz = plan.velocityZ;
  }
}
