// Shared active/fortified state for economy and utility buildings. ON
// (open) = normal operation + normal damage; OFF (closed) = disabled
// operation + 10× damage resistance. A single `open` flag drives both
// outcomes simultaneously — production/sensors/conversion gate on it and
// so does the fortify/pose — so they can never disagree. See "Producer
// Buildings Are ON/OFF" in budget_design_philosophy.html.
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
import { isMetalExtractorBlueprintId } from '../../types/buildingTypes';
import { getBuildingConfig } from './buildConfigs';
import { isEntityActive } from './buildableHelpers';
import { economyManager } from './economy';
import { getSimWasm } from '../sim-wasm/init';
import type { WorldState } from './WorldState';
import type { BuildingActiveState, BuildingBlueprintId, Entity } from './types';

/** Grace period from first hit to the building actually closing. */
const BUILDING_DAMAGE_DELAY_MS = 2000;
/** Auto-reopen timer once closed: must go this long without taking damage. */
const BUILDING_REOPEN_DELAY_MS = 5000;
/** Damage multiplier applied while the building is OFF. 0.1 = 10× tougher. */
export const BUILDING_CLOSED_DAMAGE_MULTIPLIER = 0.1;

/** Which building blueprints use the active-state fortify mechanic.
 *  Producer buildings (solar/wind/extractor) gate resource income on
 *  state.open; radar/sonar gate sensor coverage on state.open; converter
 *  gates the energy↔metal swap on state.open. Every active-state structure fortifies
 *  identically while OFF (BUILDING_CLOSED_DAMAGE_MULTIPLIER). */
export function buildingBlueprintHasActiveState(
  buildingBlueprintId: BuildingBlueprintId | null | undefined,
): boolean {
  return buildingBlueprintId === 'buildingSolar'
    || buildingBlueprintId === 'buildingWind'
    || isMetalExtractorBlueprintId(buildingBlueprintId)
    || buildingBlueprintId === 'buildingRadar'
    || buildingBlueprintId === 'buildingSonar'
    || buildingBlueprintId === 'buildingResourceConverter';
}

export function buildingBlueprintHasBarOnOffCommand(
  buildingBlueprintId: BuildingBlueprintId | null | undefined,
): boolean {
  return buildingBlueprintId === 'buildingSolar'
    || isMetalExtractorBlueprintId(buildingBlueprintId)
    || buildingBlueprintId === 'buildingResourceConverter';
}

function createInitialBuildingActiveState(): BuildingActiveState {
  return {
    open: false,
    damageDelayMs: 0,
    reopenDelayMs: BUILDING_REOPEN_DELAY_MS,
  };
}

export function ensureBuildingActiveState(entity: Entity): BuildingActiveState | null {
  if (entity.building === null) return null;
  if (!buildingBlueprintHasActiveState(entity.buildingBlueprintId)) return null;
  if (entity.building.activeState === null) {
    entity.building.activeState = createInitialBuildingActiveState();
  }
  return entity.building.activeState;
}

function getSolarEnergyProduction(): number {
  return getBuildingConfig('buildingSolar').energyProduction ?? 0;
}

function getExtractorMetalRate(entity: Entity): number {
  return entity.metalExtractionRate ?? 0;
}

/** Apply the income-RATE-stat delta for a single open↔closed transition.
 *  Must be called exactly once per real transition (the invariant is
 *  "rate applied iff state.open"); callers gate on an actual change.
 *
 *  Only solar (energy production) and extractor (metal extraction) feed
 *  the displayed per-player income-rate stat through economyManager.
 *  Wind is aggregated per-tick by WindPowerTracker, radar is sensor
 *  coverage, and the converter swap runs in processConverters — all gate
 *  directly on `open` at their iteration site and need no rate-stat push.
 *  Actual per-tick resource crediting is separate (applyIncomeCredits in
 *  economy.ts) and also gates on `open`. */
function applyProducerRateDelta(entity: Entity, open: boolean): void {
  const ownership = entity.ownership;
  if (ownership === null) return;
  const playerId = ownership.playerId;

  if (entity.buildingBlueprintId === 'buildingSolar') {
    const amount = getSolarEnergyProduction();
    if (amount <= 0) return;
    if (open) economyManager.addProduction(playerId, amount);
    else economyManager.removeProduction(playerId, amount);
  } else if (isMetalExtractorBlueprintId(entity.buildingBlueprintId)) {
    const rate = getExtractorMetalRate(entity);
    if (rate <= 0) return;
    if (open) economyManager.addMetalExtraction(playerId, rate);
    else economyManager.removeMetalExtraction(playerId, rate);
  }
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
    applyProducerRateDelta(entity, false);
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
  if (changed) world.markSnapshotDirty(entity.id, ENTITY_CHANGED_BUILDING);
}

/** Called from removeCompletedBuildingEffects. Releases the income-rate
 *  contribution by forcing the building closed before it is destroyed. */
export function deactivateBuildingActiveState(entity: Entity): void {
  const state = ensureBuildingActiveState(entity);
  if (state === null) return;
  if (state.open) {
    state.open = false;
    applyProducerRateDelta(entity, false);
  }
}

/** Player-driven ON/OFF toggle. Sets `state.open` directly, applies the
 *  income-rate delta on the transition, and resets the damage/reopen
 *  timers so the chosen state is durable for the next full cycle. The
 *  auto-flap timer behavior continues to run after — manual ON can be
 *  auto-closed by sustained damage, and manual OFF will auto-reopen
 *  after the normal quiet period. */
export function setBuildingActiveOpen(world: WorldState, entity: Entity, open: boolean): boolean {
  const state = ensureBuildingActiveState(entity);
  if (state === null || entity.building === null) return false;
  if (!isEntityActive(entity) || entity.building.hp <= 0) return false;
  let changed = false;
  if (state.open !== open) {
    state.open = open;
    applyProducerRateDelta(entity, open);
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
  return buildingBlueprintHasActiveState(entity.buildingBlueprintId)
    && building !== null
    && building.activeState !== null
    && building.activeState.open === false;
}

const activeStateRows: Entity[] = [];
const DEFAULT_ACTIVE_STATE_STEP_CAPACITY = 32;
let activeStateOpen = new Uint8Array(32);
let activeStateActive = new Uint8Array(32);
let activeStateDamageDelayMs = new Float64Array(32);
let activeStateReopenDelayMs = new Float64Array(32);
let activeStateOpenChanged = new Uint8Array(32);

export function trimBuildingActiveStateBuffers(
  maxRetained = DEFAULT_ACTIVE_STATE_STEP_CAPACITY,
): void {
  activeStateRows.length = 0;
  if (activeStateOpen.length <= maxRetained) return;
  activeStateOpen = new Uint8Array(maxRetained);
  activeStateActive = new Uint8Array(maxRetained);
  activeStateDamageDelayMs = new Float64Array(maxRetained);
  activeStateReopenDelayMs = new Float64Array(maxRetained);
  activeStateOpenChanged = new Uint8Array(maxRetained);
}

function ensureActiveStateStepCapacity(count: number): void {
  if (count <= activeStateOpen.length) return;
  let nextCapacity = activeStateOpen.length;
  while (nextCapacity < count) nextCapacity *= 2;
  activeStateOpen = new Uint8Array(nextCapacity);
  activeStateActive = new Uint8Array(nextCapacity);
  activeStateDamageDelayMs = new Float64Array(nextCapacity);
  activeStateReopenDelayMs = new Float64Array(nextCapacity);
  activeStateOpenChanged = new Uint8Array(nextCapacity);
}

/** Per-tick driver. Counts down the grace timer (ON → OFF) and the
 *  reopen timer (OFF → ON). Production follows the ON flag. */
export function updateBuildingActiveStates(world: WorldState, dtMs: number): void {
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('updateBuildingActiveStates: sim-wasm is not initialized');
  }

  const entities = world.getActiveStateBuildings();
  ensureActiveStateStepCapacity(entities.length);
  activeStateRows.length = 0;

  let count = 0;
  for (const entity of entities) {
    if (!entity.building) continue;
    const state = ensureBuildingActiveState(entity);
    if (!state) continue;

    activeStateRows[count] = entity;
    activeStateOpen[count] = state.open ? 1 : 0;
    activeStateActive[count] = isEntityActive(entity) && entity.building.hp > 0 ? 1 : 0;
    activeStateDamageDelayMs[count] = state.damageDelayMs;
    activeStateReopenDelayMs[count] = state.reopenDelayMs;
    count++;
  }

  if (count <= 0) return;

  if (sim.buildingActiveStateStepBatch(
    activeStateOpen,
    activeStateActive,
    activeStateDamageDelayMs,
    activeStateReopenDelayMs,
    count,
    dtMs,
    BUILDING_REOPEN_DELAY_MS,
    activeStateOpenChanged,
  ) === 0) {
    throw new Error(
      'updateBuildingActiveStates: building_active_state_step_batch rejected its buffers',
    );
  }

  for (let i = 0; i < count; i++) {
    const entity = activeStateRows[i];
    const building = entity.building;
    if (building === null || building.activeState === null) continue;
    const state = building.activeState;
    const nextOpen = activeStateOpen[i] !== 0;
    state.open = nextOpen;
    state.damageDelayMs = activeStateDamageDelayMs[i];
    state.reopenDelayMs = activeStateReopenDelayMs[i];

    // `activeStateOpenChanged` is set iff `open` flipped this tick, so
    // the rate delta fires exactly once per transition.
    if (activeStateOpenChanged[i] !== 0) {
      applyProducerRateDelta(entity, nextOpen);
      world.markSnapshotDirty(entity.id, ENTITY_CHANGED_BUILDING);
    }
  }
}
