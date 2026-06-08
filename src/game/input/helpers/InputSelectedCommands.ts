import type { CommandQueue } from '../../sim/commands';
import type { Entity, EntityId } from '../../sim/types';
import { buildingBlueprintHasActiveState } from '../../sim/buildingActiveState';

type SelectedCommandEntitySource = {
  getSelectedUnits: () => Entity[];
  getSelectedBuildings: () => Entity[];
};

export class InputSelectedCommands {
  private source: SelectedCommandEntitySource;
  private readonly commandQueue: CommandQueue;
  private readonly getTick: () => number;

  constructor(
    source: SelectedCommandEntitySource,
    commandQueue: CommandQueue,
    getTick: () => number,
  ) {
    this.source = source;
    this.commandQueue = commandQueue;
    this.getTick = getTick;
  }

  setSource(source: SelectedCommandEntitySource): void {
    this.source = source;
  }

  selectedTowers(): Entity[] {
    const selectedStatic = this.source.getSelectedBuildings();
    const out: Entity[] = [];
    for (let i = 0; i < selectedStatic.length; i++) {
      if (selectedStatic[i].type === 'tower') out.push(selectedStatic[i]);
    }
    return out;
  }

  selectedTargetableCombatEntities(): Entity[] {
    const out: Entity[] = [];
    const selectedUnits = this.source.getSelectedUnits();
    for (let i = 0; i < selectedUnits.length; i++) {
      const unit = selectedUnits[i];
      if (unit.combat && unit.combat.turrets.length > 0) out.push(unit);
    }
    const towers = this.selectedTowers();
    for (let i = 0; i < towers.length; i++) {
      const tower = towers[i];
      if (tower.combat && tower.combat.turrets.length > 0) out.push(tower);
    }
    return out;
  }

  stop(): void {
    const entityIds = this.selectedUnitIds();
    if (entityIds.length === 0) return;
    this.commandQueue.enqueue({
      type: 'stop',
      tick: this.getTick(),
      entityIds,
    });
  }

  clearQueuedOrders(): void {
    const entityIds = this.selectedUnitIds();
    if (entityIds.length === 0) return;
    this.commandQueue.enqueue({
      type: 'clearQueuedOrders',
      tick: this.getTick(),
      entityIds,
    });
  }

  removeLastQueuedOrder(): void {
    const entityIds = this.selectedUnitIds();
    if (entityIds.length === 0) return;
    this.commandQueue.enqueue({
      type: 'removeLastQueuedOrder',
      tick: this.getTick(),
      entityIds,
    });
  }

  skipCurrentOrder(): void {
    const entityIds = this.selectedUnitIds();
    if (entityIds.length === 0) return;
    this.commandQueue.enqueue({
      type: 'skipCurrentOrder',
      tick: this.getTick(),
      entityIds,
    });
  }

  wait(queue: boolean, queueFront = false): void {
    const entityIds = this.selectedUnitIds();
    if (entityIds.length === 0) return;
    this.commandQueue.enqueue({
      type: 'wait',
      tick: this.getTick(),
      entityIds,
      queue,
      queueFront,
    });
  }

  setRepeatQueue(): void {
    const selectedUnits = this.source.getSelectedUnits();
    const entityIds: EntityId[] = [];
    let allEnabled = true;
    for (let i = 0; i < selectedUnits.length; i++) {
      const unit = selectedUnits[i].unit;
      if (unit === null) continue;
      entityIds.push(selectedUnits[i].id);
      if (unit.repeatQueue !== true) allEnabled = false;
    }
    if (entityIds.length === 0) return;
    this.commandQueue.enqueue({
      type: 'setRepeatQueue',
      tick: this.getTick(),
      entityIds,
      enabled: !allEnabled,
    });
  }

  setFireEnabled(): void {
    const selectedUnits = this.source.getSelectedUnits();
    const selectedStatic = this.source.getSelectedBuildings();
    const entityIds: EntityId[] = [];
    let allEnabled = true;
    for (let i = 0; i < selectedUnits.length; i++) {
      const unit = selectedUnits[i];
      if (!unit.combat || unit.combat.turrets.length === 0) continue;
      entityIds.push(unit.id);
      if (unit.combat.fireEnabled === false) allEnabled = false;
    }
    // Towers carry the same host-fire contract as units; include any
    // tower in the selection whose combat has at least one turret.
    for (let i = 0; i < selectedStatic.length; i++) {
      const tower = selectedStatic[i];
      if (tower.type !== 'tower') continue;
      if (!tower.combat || tower.combat.turrets.length === 0) continue;
      entityIds.push(tower.id);
      if (tower.combat.fireEnabled === false) allEnabled = false;
    }
    if (entityIds.length === 0) return;
    this.commandQueue.enqueue({
      type: 'setFireEnabled',
      tick: this.getTick(),
      entityIds,
      enabled: !allEnabled,
    });
  }

  setBuildingActive(): void {
    const selectedStatic = this.source.getSelectedBuildings();
    const entityIds: EntityId[] = [];
    let allOpen = true;
    for (let i = 0; i < selectedStatic.length; i++) {
      const building = selectedStatic[i];
      if (building.type !== 'building') continue;
      if (!buildingBlueprintHasActiveState(building.buildingBlueprintId)) continue;
      entityIds.push(building.id);
      const state = building.building !== null ? building.building.activeState : null;
      if (state === null || state.open === false) allOpen = false;
    }
    if (entityIds.length === 0) return;
    this.commandQueue.enqueue({
      type: 'setBuildingActive',
      tick: this.getTick(),
      entityIds,
      open: !allOpen,
    });
  }

  selfDestruct(): void {
    const selectedUnits = this.source.getSelectedUnits();
    const selectedStatic = this.source.getSelectedBuildings();
    const entityIds: EntityId[] = [];
    for (let i = 0; i < selectedUnits.length; i++) entityIds.push(selectedUnits[i].id);
    for (let i = 0; i < selectedStatic.length; i++) entityIds.push(selectedStatic[i].id);
    if (entityIds.length === 0) return;
    this.commandQueue.enqueue({
      type: 'selfDestruct',
      tick: this.getTick(),
      entityIds,
    });
  }

  setTowerTarget(targetId: EntityId | null): void {
    const targetableEntities = this.selectedTargetableCombatEntities();
    if (targetableEntities.length === 0) return;
    const entityIds: EntityId[] = [];
    for (let i = 0; i < targetableEntities.length; i++) entityIds.push(targetableEntities[i].id);
    this.commandQueue.enqueue({
      type: 'setTowerTarget',
      tick: this.getTick(),
      entityIds,
      targetId,
    });
  }

  private selectedUnitIds(): EntityId[] {
    const selectedUnits = this.source.getSelectedUnits();
    const entityIds: EntityId[] = [];
    for (let i = 0; i < selectedUnits.length; i++) entityIds.push(selectedUnits[i].id);
    return entityIds;
  }
}
