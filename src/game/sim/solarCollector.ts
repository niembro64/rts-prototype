import { ENTITY_CHANGED_BUILDING } from '../../types/network';
import { getBuildingConfig } from './buildConfigs';
import { economyManager } from './economy';
import type { WorldState } from './WorldState';
import type { Entity, SolarCollectorState } from './types';

export const SOLAR_DAMAGE_REOPEN_DELAY_MS = 5000;
export const SOLAR_CLOSED_DAMAGE_MULTIPLIER = 0.1;

function getEnergyProduction(): number {
  return getBuildingConfig('solar').energyProduction ?? 0;
}

export function createClosedSolarCollectorState(): SolarCollectorState {
  return {
    open: false,
    producing: false,
    reopenDelayMs: SOLAR_DAMAGE_REOPEN_DELAY_MS,
  };
}

export function ensureSolarCollectorState(entity: Entity): SolarCollectorState | undefined {
  if (entity.buildingType !== 'solar' || !entity.building) return undefined;
  if (!entity.building.solar) {
    entity.building.solar = createClosedSolarCollectorState();
  }
  return entity.building.solar;
}

function setSolarProduction(entity: Entity, producing: boolean): boolean {
  const state = ensureSolarCollectorState(entity);
  if (!state || state.producing === producing) return false;
  const playerId = entity.ownership?.playerId;
  const amount = getEnergyProduction();
  if (!playerId || amount <= 0) {
    state.producing = false;
    return false;
  }
  state.producing = producing;
  if (producing) economyManager.addProduction(playerId, amount);
  else economyManager.removeProduction(playerId, amount);
  return true;
}

export function activateSolarCollector(world: WorldState, entity: Entity): void {
  const state = ensureSolarCollectorState(entity);
  if (!state || !entity.building || !entity.buildable?.isComplete || entity.building.hp <= 0) return;
  let changed = false;
  if (!state.open || state.reopenDelayMs !== 0) {
    state.open = true;
    state.reopenDelayMs = 0;
    changed = true;
  }
  setSolarProduction(entity, true);
  if (changed) world.markSnapshotDirty(entity.id, ENTITY_CHANGED_BUILDING);
}

export function startSolarCollectorClosed(world: WorldState, entity: Entity): void {
  const state = ensureSolarCollectorState(entity);
  if (!state || !entity.building || !entity.buildable?.isComplete || entity.building.hp <= 0) return;
  let changed = false;
  if (state.open) {
    state.open = false;
    changed = true;
  }
  if (state.reopenDelayMs !== SOLAR_DAMAGE_REOPEN_DELAY_MS) {
    state.reopenDelayMs = SOLAR_DAMAGE_REOPEN_DELAY_MS;
    changed = true;
  }
  if (setSolarProduction(entity, false)) changed = true;
  if (changed) world.markSnapshotDirty(entity.id, ENTITY_CHANGED_BUILDING);
}

export function deactivateSolarCollector(entity: Entity): void {
  const state = ensureSolarCollectorState(entity);
  if (!state) return;
  setSolarProduction(entity, false);
}

export function notifySolarCollectorDamaged(world: WorldState, entity: Entity): void {
  const state = ensureSolarCollectorState(entity);
  if (!state) return;
  let changed = false;
  if (state.open) {
    state.open = false;
    changed = true;
  }
  state.reopenDelayMs = SOLAR_DAMAGE_REOPEN_DELAY_MS;
  setSolarProduction(entity, false);
  if (changed) world.markSnapshotDirty(entity.id, ENTITY_CHANGED_BUILDING);
}

export function isSolarCollectorDamageReduced(entity: Entity): boolean {
  return entity.buildingType === 'solar' && entity.building?.solar?.open === false;
}

export function updateSolarCollectors(world: WorldState, dtMs: number): void {
  for (const entity of world.getSolarBuildings()) {
    if (!entity.building) continue;
    const state = ensureSolarCollectorState(entity);
    if (!state) continue;
    if (!entity.buildable?.isComplete || entity.building.hp <= 0) {
      setSolarProduction(entity, false);
      continue;
    }

    let changed = false;
    if (!state.open) {
      state.reopenDelayMs = Math.max(0, state.reopenDelayMs - dtMs);
      if (state.reopenDelayMs <= 0) {
        state.open = true;
        changed = true;
      }
    }

    setSolarProduction(entity, state.open);
    if (changed) world.markSnapshotDirty(entity.id, ENTITY_CHANGED_BUILDING);
  }
}
