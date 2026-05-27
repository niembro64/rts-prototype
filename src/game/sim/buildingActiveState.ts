// Shared ON/OFF state for producer buildings — solar collectors, wind
// turbines, and metal extractors. ON (open) = producing + normal
// damage; OFF (closed) = not producing + 10× damage resistance. The
// flag drives both outcomes simultaneously — see "Producer Buildings
// Are ON/OFF" in design_philosophy.html.
//
// Lifecycle:
//
//   - At completion (real construction or pre-placed) the building
//     starts OFF (not producing) and counts down BUILDING_REOPEN_DELAY_MS
//     before flipping ON for the first time. This is the shared
//     activation debounce — every ON/OFF producer goes through it, no
//     per-type variation.
//   - Once ON they produce their resource.
//   - The first incoming damage hit starts a 2-second grace timer
//     (state.damageDelayMs counts down from BUILDING_DAMAGE_DELAY_MS).
//     During the grace they still take full damage and still produce.
//   - When the grace expires the building snaps OFF. Production stops
//     and incoming damage is multiplied by
//     BUILDING_CLOSED_DAMAGE_MULTIPLIER (0.1 = 10× more durable).
//   - After BUILDING_REOPEN_DELAY_MS (5 s) of quiet (no further hits)
//     the building auto-flips ON and production resumes.
//   - Any hit while OFF RESETS the reopen timer to the full 5 s.

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
/** Damage multiplier applied while the building is OFF. 0.1 = 10× tougher. */
export const BUILDING_CLOSED_DAMAGE_MULTIPLIER = 0.1;

/** Which building types use the active-state fortify mechanic.
 *  Producer buildings (solar/wind/extractor) gate resource income on
 *  state.open; radar gates sensor coverage on state.open; converter
 *  gates the energy↔metal swap on state.open. All five fortify
 *  identically while OFF (BUILDING_CLOSED_DAMAGE_MULTIPLIER). */
export function buildingTypeHasActiveState(type: BuildingType | null | undefined): boolean {
  return type === 'solar'
    || type === 'wind'
    || type === 'extractor'
    || type === 'radar'
    || type === 'resourceConverter';
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

  if (entity.buildingType === 'radar') {
    // Radar provides sensor coverage rather than a resource flow; the
    // coverage seeding path already gates on state.open, so this
    // setter just tracks the producing flag for the renderer.
    state.producing = producing;
    return true;
  }

  if (entity.buildingType === 'resourceConverter') {
    // Converter ticks (energy↔metal swap) run through processConverters
    // in economy.ts and are gated there on state.open. Track the flag
    // so the renderer / wire stay in sync.
    state.producing = producing;
    return true;
  }

  return false;
}

/** Called from applyCompletedBuildingEffects (and the standalone
 *  background-battle spawner) once any ON/OFF producer building is
 *  alive and owned. Puts it into the shared initial pose: OFF, not
 *  producing, with the reopen timer primed to BUILDING_REOPEN_DELAY_MS.
 *  The per-tick driver then counts that down and flips the building
 *  ON, matching every later OFF→ON transition in the lifecycle. */
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
  if (setBuildingProducing(entity, false)) changed = true;
  if (changed) world.markSnapshotDirty(entity.id, ENTITY_CHANGED_BUILDING);
}

/** Called from removeCompletedBuildingEffects. Stops production without
 *  touching the open/closed flag (we're about to destroy the entity). */
export function deactivateBuildingActiveState(entity: Entity): void {
  if (!ensureBuildingActiveState(entity)) return;
  setBuildingProducing(entity, false);
}

/** Player-driven ON/OFF toggle. Sets `state.open` directly, resets the
 *  damage/reopen timers so the chosen state is durable for the next
 *  full cycle, and updates production accounting through
 *  setBuildingProducing. The auto-flap timer behavior continues to
 *  run after — manual ON can be auto-closed by sustained damage, and
 *  manual OFF will auto-reopen after the normal quiet period. */
export function setBuildingActiveOpen(world: WorldState, entity: Entity, open: boolean): boolean {
  const state = ensureBuildingActiveState(entity);
  if (state === null || entity.building === null) return false;
  if (!isEntityActive(entity) || entity.building.hp <= 0) return false;
  let changed = false;
  if (state.open !== open) {
    state.open = open;
    changed = true;
  }
  if (open) {
    if (state.damageDelayMs !== 0) {
      state.damageDelayMs = 0;
      changed = true;
    }
  } else {
    if (state.reopenDelayMs !== BUILDING_REOPEN_DELAY_MS) {
      state.reopenDelayMs = BUILDING_REOPEN_DELAY_MS;
      changed = true;
    }
  }
  if (setBuildingProducing(entity, open)) changed = true;
  if (changed) world.markSnapshotDirty(entity.id, ENTITY_CHANGED_BUILDING);
  return changed;
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

/** Per-tick driver. Counts down the grace timer (ON → OFF) and the
 *  reopen timer (OFF → ON). Production follows the ON flag. */
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
