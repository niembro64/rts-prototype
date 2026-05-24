// Shared "fortifiable" state for producer buildings — solar collectors,
// wind turbines, and metal extractors.
//
// Open/closed (the visible "on"/"off" pose) is purely a damage-survival
// mechanic and is INDEPENDENT of whether the building produces its
// resource. Production runs continuously from completion to destruction
// regardless of the open flag.
//
// Lifecycle:
//
//   - At completion (real construction or pre-placed) the building
//     starts CLOSED and counts down BUILDING_REOPEN_DELAY_MS before
//     opening for the first time. This is the shared activation
//     debounce — every on/off producer goes through it, no per-type
//     variation. Production is already running at this point.
//   - The first incoming damage hit starts a 2-second grace timer
//     (state.damageDelayMs counts down from BUILDING_DAMAGE_DELAY_MS).
//   - When the grace expires the building snaps CLOSED. Incoming
//     damage is multiplied by BUILDING_CLOSED_DAMAGE_MULTIPLIER
//     (0.25 = 4× more durable).
//   - After BUILDING_REOPEN_DELAY_MS (5 s) of quiet (no further hits)
//     the building auto-reopens.
//   - Any hit while closed RESETS the reopen timer to the full 5 s.

import { ENTITY_CHANGED_BUILDING } from '../../types/network';
import { getBuildingConfig } from './buildConfigs';
import { isEntityActive } from './buildableHelpers';
import { economyManager } from './economy';
import type { WorldState } from './WorldState';
import type { BuildingActiveState, BuildingType, Entity } from './types';

/** Grace period from first hit to the building actually closing. */
export const BUILDING_DAMAGE_DELAY_MS = 2000;
/** Auto-reopen timer once closed: must go this long without taking damage. */
export const BUILDING_REOPEN_DELAY_MS = 5000;
/** Damage multiplier applied while the building is closed. 0.25 = 4× tougher. */
export const BUILDING_CLOSED_DAMAGE_MULTIPLIER = 0.25;

/** Which building types use the active-state fortify mechanic. */
export function buildingTypeHasActiveState(type: BuildingType | null | undefined): boolean {
  return type === 'solar' || type === 'wind' || type === 'extractor';
}

export function createInitialBuildingActiveState(): BuildingActiveState {
  return {
    open: false,
    producing: false,
    damageDelayMs: 0,
    reopenDelayMs: BUILDING_REOPEN_DELAY_MS,
  };
}

export function ensureBuildingActiveState(entity: Entity): BuildingActiveState | null {
  if (entity.building === null) return null;
  if (!buildingTypeHasActiveState(entity.buildingType)) return null;
  if (entity.building.activeState === null) {
    entity.building.activeState = createInitialBuildingActiveState();
  }
  return entity.building.activeState;
}

function getSolarEnergyProduction(): number {
  return getBuildingConfig('solar').energyProduction ?? 0;
}

function getExtractorMetalRate(entity: Entity): number {
  return entity.metalExtractionRate ?? 0;
}

/** Drive the per-tick production deltas for the entity according to its
 *  current `producing` flag vs the new desired flag.
 *
 *  Solar collectors push energy income through economyManager directly.
 *  Wind turbines are aggregated by WindPowerTracker each tick — gated by
 *  the open state at the iteration site — so we only need to track the
 *  flag here (no economy delta). Metal extractors push metal income
 *  through economyManager when they open and remove it when they close;
 *  the covered-cell rate computed at completion is suspended while the
 *  extractor is fortified. */
function setBuildingProducing(entity: Entity, producing: boolean): boolean {
  const building = entity.building;
  if (building === null) return false;
  const state = building.activeState;
  if (state === null || state.producing === producing) return false;
  const ownership = entity.ownership;
  if (ownership === null) {
    state.producing = false;
    return false;
  }
  const playerId = ownership.playerId;

  if (entity.buildingType === 'solar') {
    const amount = getSolarEnergyProduction();
    if (amount <= 0) {
      state.producing = false;
      return false;
    }
    state.producing = producing;
    if (producing) economyManager.addProduction(playerId, amount);
    else economyManager.removeProduction(playerId, amount);
    return true;
  }

  if (entity.buildingType === 'wind') {
    // Wind income is aggregated per-tick by WindPowerTracker, which
    // filters on state.open at the iteration site. We just record the
    // flag so the renderer / serializers can see it.
    state.producing = producing;
    return true;
  }

  if (entity.buildingType === 'extractor') {
    const rate = getExtractorMetalRate(entity);
    if (rate <= 0) {
      // Extractor with no covered deposits: nothing to suspend. Track
      // the flag for the renderer but skip the economy delta.
      state.producing = producing;
      return true;
    }
    state.producing = producing;
    if (producing) economyManager.addMetalExtraction(playerId, rate);
    else economyManager.removeMetalExtraction(playerId, rate);
    return true;
  }

  return false;
}

/** Called from applyCompletedBuildingEffects (and the standalone
 *  background-battle spawner) once any on/off producer building is
 *  alive and owned. Puts it into the shared initial pose: CLOSED with
 *  the reopen timer primed to BUILDING_REOPEN_DELAY_MS, while
 *  production starts immediately (production is independent of the
 *  open flag). */
export function initializeBuildingActiveState(world: WorldState, entity: Entity): void {
  const state = ensureBuildingActiveState(entity);
  if (!state || !entity.building || !isEntityActive(entity) || entity.building.hp <= 0) return;
  let changed = false;
  if (state.open) {
    state.open = false;
    changed = true;
  }
  if (state.damageDelayMs !== 0) {
    state.damageDelayMs = 0;
    changed = true;
  }
  if (state.reopenDelayMs !== BUILDING_REOPEN_DELAY_MS) {
    state.reopenDelayMs = BUILDING_REOPEN_DELAY_MS;
    changed = true;
  }
  if (setBuildingProducing(entity, true)) changed = true;
  if (changed) world.markSnapshotDirty(entity.id, ENTITY_CHANGED_BUILDING);
}

/** Called from removeCompletedBuildingEffects. Stops production without
 *  touching the open/closed flag (we're about to destroy the entity). */
export function deactivateBuildingActiveState(entity: Entity): void {
  if (!ensureBuildingActiveState(entity)) return;
  setBuildingProducing(entity, false);
}

/** Single-hit damage notification. While the building is OPEN this
 *  starts the 2-second grace timer if not already running. While the
 *  building is CLOSED this resets the reopen timer to the full 5 s
 *  (so persistent harassment keeps the building fortified). */
export function notifyBuildingActiveStateDamaged(world: WorldState, entity: Entity): void {
  const state = ensureBuildingActiveState(entity);
  if (!state) return;
  if (state.open) {
    if (state.damageDelayMs <= 0) {
      state.damageDelayMs = BUILDING_DAMAGE_DELAY_MS;
      world.markSnapshotDirty(entity.id, ENTITY_CHANGED_BUILDING);
    }
  } else {
    state.reopenDelayMs = BUILDING_REOPEN_DELAY_MS;
  }
}

/** True iff this entity is a fortifiable building currently in its
 *  closed pose. DamageSystem multiplies incoming damage by
 *  BUILDING_CLOSED_DAMAGE_MULTIPLIER when this is true. */
export function isBuildingActiveStateFortified(entity: Entity): boolean {
  const building = entity.building;
  return buildingTypeHasActiveState(entity.buildingType)
    && building !== null
    && building.activeState !== null
    && building.activeState.open === false;
}

/** Per-tick driver. Counts down the grace timer (open → closed) and
 *  the reopen timer (closed → open). Production runs continuously and
 *  is independent of the open flag. */
export function updateBuildingActiveStates(world: WorldState, dtMs: number): void {
  for (const entity of world.getActiveStateBuildings()) {
    if (!entity.building) continue;
    const state = ensureBuildingActiveState(entity);
    if (!state) continue;
    if (!isEntityActive(entity) || entity.building.hp <= 0) {
      setBuildingProducing(entity, false);
      continue;
    }

    let changed = false;
    if (state.open) {
      if (state.damageDelayMs > 0) {
        state.damageDelayMs = Math.max(0, state.damageDelayMs - dtMs);
        if (state.damageDelayMs <= 0) {
          state.open = false;
          state.reopenDelayMs = BUILDING_REOPEN_DELAY_MS;
          changed = true;
        }
      }
    } else {
      state.reopenDelayMs = Math.max(0, state.reopenDelayMs - dtMs);
      if (state.reopenDelayMs <= 0) {
        state.open = true;
        state.damageDelayMs = 0;
        changed = true;
      }
    }

    setBuildingProducing(entity, true);
    if (changed) world.markSnapshotDirty(entity.id, ENTITY_CHANGED_BUILDING);
  }
}
