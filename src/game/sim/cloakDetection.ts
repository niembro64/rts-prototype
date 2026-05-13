import type { WorldState } from './WorldState';
import type { Entity, PlayerId } from './types';

export type EntitySensorBlueprint = {
  cloak?: { enabled: boolean };
  detector?: { radius: number };
};

export function applyEntitySensorBlueprint(
  entity: Entity,
  blueprint: EntitySensorBlueprint,
): void {
  if (blueprint.cloak?.enabled === true) {
    entity.cloak = { enabled: true };
  } else {
    delete entity.cloak;
  }

  const detectorRadius = blueprint.detector?.radius ?? 0;
  if (Number.isFinite(detectorRadius) && detectorRadius > 0) {
    entity.detector = { radius: detectorRadius };
  } else {
    delete entity.detector;
  }
}

export function isEntityOnlineForSensors(entity: Entity): boolean {
  if (entity.buildable && !entity.buildable.isComplete) return false;
  if (entity.unit) return entity.unit.hp > 0;
  if (entity.building) return entity.building.hp > 0;
  return false;
}

export function isEntityCloaked(entity: Entity): boolean {
  return entity.cloak?.enabled === true && isEntityOnlineForSensors(entity);
}

export function canEntityProvideDetection(entity: Entity): boolean {
  return getEntityDetectorRadius(entity) > 0;
}

export function getEntityDetectorRadius(entity: Entity): number {
  if (!isEntityOnlineForSensors(entity)) return 0;
  const radius = entity.detector?.radius ?? 0;
  return Number.isFinite(radius) && radius > 0 ? radius : 0;
}

export function getEntityDetectionPadding(entity: Entity): number {
  if (entity.unit) {
    return Math.max(
      entity.unit.radius.body,
      entity.unit.radius.shot,
      entity.unit.radius.push,
    );
  }
  if (entity.building) {
    return Math.max(entity.building.width, entity.building.height) * 0.5;
  }
  return 0;
}

export function isEntityDetectedByPlayer(
  world: WorldState,
  target: Entity,
  playerId: PlayerId,
  padding = getEntityDetectionPadding(target),
): boolean {
  if (target.ownership?.playerId === playerId) return true;
  // FOW-OPT-19: detector-equipped entities are a tiny minority of a
  // player's roster, so iterate just the cached slice instead of
  // scanning every owned unit + building to filter for the rare
  // detector property. Online status is still checked at query time
  // via getEntityDetectorRadius — same contract as before.
  return isDetectedBySources(
    world.getDetectorsByPlayer(playerId),
    target.transform.x,
    target.transform.y,
    padding,
  );
}

export function canPlayerObserveCloakedEntity(
  world: WorldState,
  target: Entity,
  playerId: PlayerId,
  padding = getEntityDetectionPadding(target),
): boolean {
  if (!isEntityCloaked(target)) return true;
  return isEntityDetectedByPlayer(world, target, playerId, padding);
}

function isDetectedBySources(
  sources: readonly Entity[],
  targetX: number,
  targetY: number,
  padding: number,
): boolean {
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const radius = getEntityDetectorRadius(source);
    if (radius <= 0) continue;
    const dx = targetX - source.transform.x;
    const dy = targetY - source.transform.y;
    const r = radius + padding;
    if (dx * dx + dy * dy <= r * r) return true;
  }
  return false;
}
