import type { WorldState } from './WorldState';
import type { Entity, PlayerId } from './types';
import { factoryProductionSystem } from './factoryProduction';
import {
  deactivateBuildingActiveState,
  initializeBuildingActiveState,
  buildingBlueprintHasActiveState,
} from './buildingActiveState';
import { isEntityActive } from './buildableHelpers';
import { isMetalExtractorBlueprintId } from '../../types/buildingTypes';
import { getBuildingConfig } from './buildConfigs';
import { economyManager } from './economy';
import {
  clearExtractorMetalCoverage,
  computeExtractorMetalCoverage,
} from './metalDepositOwnership';

const completedStorageOwnerByEntity = new WeakMap<Entity, PlayerId>();

export function applyCompletedBuildingEffects(world: WorldState, entity: Entity): void {
  applyCompletedBuildingStorageCapacity(entity);

  if (isMetalExtractorBlueprintId(entity.buildingBlueprintId) && entity.ownership) {
    // Covered-cell extraction. Walk every deposit the extractor
    // footprint overlaps and store metal/sec as a direct function of
    // how many generated metal cells are under this built footprint.
    // We DON'T credit income here — initializeBuildingActiveState
    // below starts the extractor CLOSED, and the per-tick driver only
    // flips it open (applying the rate delta) once the activation
    // debounce elapses; `open` is the single source of truth for "is
    // this extractor's rate currently in the player's tally."
    computeExtractorMetalCoverage(world, entity);
  }

  // Every on/off producer (solar, wind, extractor) goes through the
  // same activation policy: start CLOSED / not-producing, debounce to
  // OPEN after BUILDING_REOPEN_DELAY_MS.
  if (buildingBlueprintHasActiveState(entity.buildingBlueprintId) && entity.ownership) {
    initializeBuildingActiveState(world, entity);
  }
}

export function removeCompletedBuildingEffects(world: WorldState, entity: Entity): void {
  removeCompletedBuildingStorageCapacity(entity);

  if (entity.factory) {
    // The factory is being destroyed — its in-progress unit frame dies
    // with it (no refund, and never released as a live unit).
    factoryProductionSystem.cancelActiveShell(world, entity, false);
  }

  // Deactivate forces the building closed, releasing its current
  // production (energy for solar, metal-rate for an open extractor) from
  // its owner's tally. A fortified (closed) building was already not
  // producing, so this is a no-op for it.
  if (
    buildingBlueprintHasActiveState(entity.buildingBlueprintId)
    && entity.ownership
    && isEntityActive(entity)
  ) {
    deactivateBuildingActiveState(entity);
  }

  if (isMetalExtractorBlueprintId(entity.buildingBlueprintId) && entity.ownership && isEntityActive(entity)) {
    // Clear covered-cell bookkeeping. The destroyed extractor's own
    // income was already removed by deactivateBuildingActiveState above,
    // so we ignore the helper's lostIncome return.
    clearExtractorMetalCoverage(world, entity);
  }
}

function getBuildingStorageCapacity(entity: Entity): { energy: number; metal: number } | null {
  if (
    entity.buildingBlueprintId === null
    || entity.ownership === null
    || entity.building === null
  ) return null;
  const config = getBuildingConfig(entity.buildingBlueprintId);
  const energy = Math.max(0, config.energyStorage ?? 0);
  const metal = Math.max(0, config.metalStorage ?? 0);
  return energy > 0 || metal > 0 ? { energy, metal } : null;
}

function applyCompletedBuildingStorageCapacity(entity: Entity): void {
  const capacity = getBuildingStorageCapacity(entity);
  if (capacity === null || entity.ownership === null || !isEntityActive(entity)) return;
  const playerId = entity.ownership.playerId;
  const appliedOwner = completedStorageOwnerByEntity.get(entity);
  if (appliedOwner === playerId) return;
  if (appliedOwner !== undefined) {
    economyManager.removeStorageCapacity(appliedOwner, capacity);
  }
  economyManager.addStorageCapacity(playerId, capacity);
  completedStorageOwnerByEntity.set(entity, playerId);
}

function removeCompletedBuildingStorageCapacity(entity: Entity): void {
  const capacity = getBuildingStorageCapacity(entity);
  const appliedOwner = completedStorageOwnerByEntity.get(entity);
  if (capacity === null || appliedOwner === undefined) return;
  economyManager.removeStorageCapacity(appliedOwner, capacity);
  completedStorageOwnerByEntity.delete(entity);
}

/** Ownership transfer is a remove/add, so each player remains exactly the sum
 *  of their completed storage buildings. The caller invokes this around the
 *  authoritative ownership write. */
export function transferCompletedBuildingStorageCapacity(
  entity: Entity,
  previousPlayerId: PlayerId,
  nextPlayerId: PlayerId,
): void {
  const capacity = getBuildingStorageCapacity(entity);
  if (capacity === null || !isEntityActive(entity) || previousPlayerId === nextPlayerId) return;
  const appliedOwner = completedStorageOwnerByEntity.get(entity);
  if (appliedOwner === nextPlayerId) return;
  if (appliedOwner !== undefined) {
    economyManager.removeStorageCapacity(appliedOwner, capacity);
  }
  economyManager.addStorageCapacity(nextPlayerId, capacity);
  completedStorageOwnerByEntity.set(entity, nextPlayerId);
}
