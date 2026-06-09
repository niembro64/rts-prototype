import type { Entity, PlayerId } from './types';
import type { WorldState } from './WorldState';
import { applyBuildingBlueprintRuntime } from './buildingEntityRuntime';
import { getBuildingConfig } from './buildConfigs';
import { BUILD_GRID_CELL_SIZE } from './buildGrid';
import { isUnitBlueprintId } from '@/types/blueprintIds';
import { ENTITY_CHANGED_HP } from '@/types/network';

export const WRECK_BLUEPRINT_ID = 'buildingWreck';
const RESURRECT_SECONDS_PER_MAX_HP = 0.03;
const MIN_RESURRECT_REQUIRED_MS = 850;
const MAX_RESURRECT_REQUIRED_MS = 5000;

function resurrectRequiredMs(maxHp: number): number {
  return Math.max(
    MIN_RESURRECT_REQUIRED_MS,
    Math.min(MAX_RESURRECT_REQUIRED_MS, maxHp * RESURRECT_SECONDS_PER_MAX_HP * 1000),
  );
}

export function isResurrectableWreck(target: Entity | null | undefined): target is Entity {
  return target !== null &&
    target !== undefined &&
    target.wreck !== null &&
    target.building !== null &&
    target.building.hp > 0 &&
    target.wreck.source.kind === 'unit' &&
    isUnitBlueprintId(target.wreck.source.unitBlueprintId);
}

export function createWreckFromDeadUnit(world: WorldState, source: Entity): Entity | null {
  if (source.unit === null || source.wreck !== null || source.commander !== null) return null;
  if (!isUnitBlueprintId(source.unit.unitBlueprintId)) return null;
  const config = getBuildingConfig(WRECK_BLUEPRINT_ID);
  const width = config.gridWidth * BUILD_GRID_CELL_SIZE;
  const height = config.gridHeight * BUILD_GRID_CELL_SIZE;
  const depth = config.gridDepth * BUILD_GRID_CELL_SIZE;
  const ownerId = source.ownership?.playerId ?? null;
  const wreck = world.createBuilding(
    source.transform.x,
    source.transform.y,
    width,
    height,
    depth,
    ownerId,
    source.transform.rotation,
  );
  applyBuildingBlueprintRuntime(wreck, WRECK_BLUEPRINT_ID);
  if (wreck.building !== null) {
    wreck.building.hp = config.hp;
    wreck.building.maxHp = config.hp;
  }
  wreck.wreck = {
    source: {
      kind: 'unit',
      unitBlueprintId: source.unit.unitBlueprintId,
    },
    originalOwnerId: ownerId,
    resurrectProgressMs: 0,
    resurrectRequiredMs: resurrectRequiredMs(source.unit.maxHp),
  };
  world.addEntity(wreck);
  world.markSnapshotDirty(wreck.id, ENTITY_CHANGED_HP);
  return wreck;
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
