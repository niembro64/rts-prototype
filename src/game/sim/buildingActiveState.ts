// Shared "fortifiable" state for producer buildings — solar collectors,
// wind turbines, and metal extractors.
//
// All three buildings share the same lifecycle:
//
//   - When complete and undamaged they sit OPEN (state.open = true) and
//     produce their resource.
//   - The first incoming damage hit starts a 2-second grace timer
//     (state.damageDelayMs counts down from BUILDING_DAMAGE_DELAY_MS).
//     During the grace they still take full damage and still produce.
//   - When the grace expires the building snaps CLOSED. Production
//     stops and incoming damage is multiplied by
//     BUILDING_CLOSED_DAMAGE_MULTIPLIER (0.25 = 4× more durable).
//   - After BUILDING_REOPEN_DELAY_MS (5 s) of quiet (no further hits)
//     the building auto-reopens and production resumes.
//   - Any hit while closed RESETS the reopen timer to the full 5 s.
//
// Per-type production hooks (solar adds to energy income, wind feeds the
// WindPowerTracker, extractor feeds metal income through the deposit
// ownership rate) plug into the same open/close transitions so the
// renderer's "is it open?" predicate and the sim's "does it produce?"
// flag never disagree.

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
export function buildingTypeHasActiveState(type: BuildingType | undefined): boolean {
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

export function ensureBuildingActiveState(entity: Entity): BuildingActiveState | undefined {
  if (!entity.building) return undefined;
  if (!buildingTypeHasActiveState(entity.buildingType)) return undefined;
  if (!entity.building.activeState) {
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
 *  the per-deposit rate that was added at claim time is suspended while
 *  the extractor is fortified. */
function setBuildingProducing(entity: Entity, producing: boolean): boolean {
  const state = entity.building?.activeState;
  if (!state || state.producing === producing) return false;
  const playerId = entity.ownership?.playerId;
  if (!playerId) {
    state.producing = false;
    return false;
  }

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

/** Called from applyCompletedBuildingEffects (and the standalone background
 *  battle spawner) once the building is alive and owned. Snaps the
 *  active-state to OPEN and starts production. */
export function activateBuildingActiveState(world: WorldState, entity: Entity): void {
  const state = ensureBuildingActiveState(entity);
  if (!state || !entity.building || !isEntityActive(entity) || entity.building.hp <= 0) return;
  let changed = false;
  if (!state.open || state.damageDelayMs !== 0 || state.reopenDelayMs !== 0) {
    state.open = true;
    state.damageDelayMs = 0;
    state.reopenDelayMs = 0;
    changed = true;
  }
  setBuildingProducing(entity, true);
  if (changed) world.markSnapshotDirty(entity.id, ENTITY_CHANGED_BUILDING);
}

/** Called during spawn for the visual "starts closed" pose on solar
 *  collectors — it makes their first-frame appearance match the rest
 *  of the close-on-damage flow. Wind/extractor don't use this path
 *  (they're built open and stay open until damaged). */
export function startBuildingActiveStateClosed(world: WorldState, entity: Entity): void {
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
  if (setBuildingProducing(entity, false)) changed = true;
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
  return buildingTypeHasActiveState(entity.buildingType)
    && entity.building?.activeState?.open === false;
}

/** Per-tick driver. Counts down the grace timer (open → closed) and
 *  the reopen timer (closed → open). Production follows the open flag. */
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

    setBuildingProducing(entity, state.open);
    if (changed) world.markSnapshotDirty(entity.id, ENTITY_CHANGED_BUILDING);
  }
}
