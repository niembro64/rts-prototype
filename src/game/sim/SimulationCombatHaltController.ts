import {
  CT_COMBAT_HALT_MODE_ANY_ENGAGED,
  CT_COMBAT_HALT_MODE_FIGHT_REQUIRED,
  getSimWasm,
} from '../sim-wasm/init';
import { spatialGrid } from './SpatialGrid';
import { getUnitBlueprint } from './blueprints';
import type { Entity } from './types';
import type { WorldState } from './WorldState';

export class SimulationCombatHaltController {
  private readonly world: WorldState;
  private readonly touchedSlots: number[] = [];
  private slots = new Uint32Array(0);
  private modes = new Uint8Array(0);
  private priorityPoint = new Uint8Array(0);
  private out = new Uint8Array(0);
  private modeBySlot = new Uint8Array(0);
  private priorityPointBySlot = new Uint8Array(0);
  private stopBySlot = new Uint8Array(0);

  constructor(world: WorldState) {
    this.world = world;
  }

  prepare(): void {
    this.clear();
    const sim = getSimWasm();
    if (sim === undefined) return;
    const units = this.world.getUnits();
    this.ensureRowCapacity(units.length);

    let count = 0;
    for (let i = 0; i < units.length; i++) {
      const entity = units[i];
      const unit = entity.unit;
      if (!unit || !entity.combat || unit.actions.length === 0) continue;
      const action = unit.actions[0];
      let mode = -1;
      let priorityPointPresent = false;
      if (
        (action.type === 'attack' && action.targetId !== undefined) ||
        action.type === 'guard'
      ) {
        mode = CT_COMBAT_HALT_MODE_ANY_ENGAGED;
      } else if (action.type === 'attackGround') {
        mode = CT_COMBAT_HALT_MODE_ANY_ENGAGED;
        priorityPointPresent = true;
      } else if (action.type === 'fight' || action.type === 'patrol') {
        if (!this.unitHasFightStopRequiredMount(unit.unitBlueprintId)) continue;
        mode = CT_COMBAT_HALT_MODE_FIGHT_REQUIRED;
      } else {
        continue;
      }
      const slot = spatialGrid.getSlot(entity.id);
      if (slot < 0) continue;
      this.queue(count, slot, mode, priorityPointPresent);
      count++;
    }
    if (count === 0) return;

    sim.combatTargeting.haltDecisionBatch(
      this.slots.subarray(0, count),
      this.modes.subarray(0, count),
      this.priorityPoint.subarray(0, count),
      this.out.subarray(0, count),
    );

    for (let i = 0; i < count; i++) {
      this.cache(
        this.slots[i],
        this.modes[i],
        this.priorityPoint[i],
        this.out[i],
      );
    }
  }

  shouldStopForEngagedCombat(entity: Entity): boolean {
    const combat = entity.combat;
    if (!combat || combat.turrets.length === 0) return false;
    return this.read(
      entity,
      CT_COMBAT_HALT_MODE_ANY_ENGAGED,
      combat.priorityTargetPoint !== null,
    );
  }

  shouldStopForFightCombat(entity: Entity): boolean {
    if (!entity.unit) return false;
    if (!this.unitHasFightStopRequiredMount(entity.unit.unitBlueprintId)) return false;
    const combat = entity.combat;
    if (!combat || combat.turrets.length === 0) return false;
    return this.read(
      entity,
      CT_COMBAT_HALT_MODE_FIGHT_REQUIRED,
      combat.priorityTargetPoint !== null,
    );
  }

  reset(): void {
    this.clear();
  }

  private ensureRowCapacity(required: number): void {
    if (this.slots.length >= required) return;
    const next = Math.max(required, this.slots.length * 2, 128);
    const slots = new Uint32Array(next);
    slots.set(this.slots);
    this.slots = slots;
    const modes = new Uint8Array(next);
    modes.set(this.modes);
    this.modes = modes;
    const priorityPoint = new Uint8Array(next);
    priorityPoint.set(this.priorityPoint);
    this.priorityPoint = priorityPoint;
    this.out = new Uint8Array(next);
  }

  private ensureSlotCapacity(required: number): void {
    if (this.modeBySlot.length >= required) return;
    const next = Math.max(required, this.modeBySlot.length * 2, 128);
    const modes = new Uint8Array(next);
    modes.set(this.modeBySlot);
    this.modeBySlot = modes;
    const priorityPoint = new Uint8Array(next);
    priorityPoint.set(this.priorityPointBySlot);
    this.priorityPointBySlot = priorityPoint;
    const stop = new Uint8Array(next);
    stop.set(this.stopBySlot);
    this.stopBySlot = stop;
  }

  private clear(): void {
    const touched = this.touchedSlots;
    for (let i = 0; i < touched.length; i++) {
      const slot = touched[i];
      this.modeBySlot[slot] = 0;
      this.priorityPointBySlot[slot] = 0;
      this.stopBySlot[slot] = 0;
    }
    touched.length = 0;
  }

  private queue(
    index: number,
    slot: number,
    mode: number,
    priorityPointPresent: boolean,
  ): void {
    this.slots[index] = slot;
    this.modes[index] = mode;
    this.priorityPoint[index] = priorityPointPresent ? 1 : 0;
  }

  private cache(
    slot: number,
    mode: number,
    priorityPointPresent: number,
    shouldStop: number,
  ): void {
    this.ensureSlotCapacity(slot + 1);
    this.modeBySlot[slot] = mode + 1;
    this.priorityPointBySlot[slot] = priorityPointPresent;
    this.stopBySlot[slot] = shouldStop;
    this.touchedSlots.push(slot);
  }

  private read(
    entity: Entity,
    mode: number,
    priorityPointPresent: boolean,
  ): boolean {
    const slot = spatialGrid.getSlot(entity.id);
    if (slot < 0) return false;
    this.ensureSlotCapacity(slot + 1);
    const modeKey = mode + 1;
    const priorityPointFlag = priorityPointPresent ? 1 : 0;
    if (
      this.modeBySlot[slot] === modeKey &&
      this.priorityPointBySlot[slot] === priorityPointFlag
    ) {
      return this.stopBySlot[slot] !== 0;
    }

    const sim = getSimWasm();
    if (sim === undefined) return false;
    this.ensureRowCapacity(1);
    this.queue(0, slot, mode, priorityPointPresent);
    sim.combatTargeting.haltDecisionBatch(
      this.slots.subarray(0, 1),
      this.modes.subarray(0, 1),
      this.priorityPoint.subarray(0, 1),
      this.out.subarray(0, 1),
    );
    this.cache(slot, mode, priorityPointFlag, this.out[0]);
    return this.out[0] !== 0;
  }

  private unitHasFightStopRequiredMount(unitBlueprintId: string): boolean {
    const turrets = getUnitBlueprint(unitBlueprintId).turrets;
    for (let i = 0; i < turrets.length; i++) {
      if (turrets[i].requiredEngagedForFightStop === true) return true;
    }
    return false;
  }
}
