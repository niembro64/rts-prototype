import type { Entity, PlayerId } from './types';
import type { WorldState } from './WorldState';
import { isUnitBlueprintId } from '@/types/blueprintIds';

export function isResurrectableWreck(target: Entity | null | undefined): target is Entity {
  return target !== null &&
    target !== undefined &&
    target.wreck !== null &&
    target.building !== null &&
    target.building.hp > 0 &&
    target.wreck.source.kind === 'unit' &&
    isUnitBlueprintId(target.wreck.source.unitBlueprintId);
}

export function createWreckFromDeadUnit(_world: WorldState, _source: Entity): Entity | null {
  return null;
}

export function restoreUnitFromWreck(world: WorldState, wreck: Entity, playerId: PlayerId): Entity | null {
  if (!isResurrectableWreck(wreck)) return null;
  const wreckComponent = wreck.wreck;
  if (wreckComponent === null || wreckComponent.source.kind !== 'unit') return null;
  const unit = world.createUnitFromBlueprint(
    wreck.transform.x,
    wreck.transform.y,
    playerId,
    wreckComponent.source.unitBlueprintId,
  );
  unit.transform.rotation = wreck.transform.rotation;
  world.removeEntity(wreck.id);
  world.addEntity(unit);
  return unit;
}
