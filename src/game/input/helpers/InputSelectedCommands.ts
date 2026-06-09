import type { CommandQueue } from '../../sim/commands';
import type { CombatFireState, CombatTrajectoryMode, Entity, EntityId, UnitMoveState } from '../../sim/types';
import { buildingBlueprintHasActiveState } from '../../sim/buildingActiveState';
import { isBallisticArcWeapon } from '../../sim/combat/combatUtils';

type SelectedCommandEntitySource = {
  getSelectedUnits: () => Entity[];
  getSelectedBuildings: () => Entity[];
};

function nextUnitMoveState(state: UnitMoveState): UnitMoveState {
  switch (state) {
    case 'maneuver': return 'holdPosition';
    case 'holdPosition': return 'roam';
    case 'roam': return 'maneuver';
  }
}

function combatFireState(combat: Entity['combat']): CombatFireState {
  if (combat === null) return 'holdFire';
  return combat.fireState ?? (combat.fireEnabled === false ? 'holdFire' : 'fireAtWill');
}

function nextCombatFireState(state: CombatFireState): CombatFireState {
  switch (state) {
    case 'fireAtWill': return 'returnFire';
    case 'returnFire': return 'holdFire';
    case 'holdFire': return 'fireAtWill';
  }
}

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

  wait(queue: boolean, queueFront = false, queueInsertIndex?: number): void {
    const entityIds = this.selectedUnitIds();
    if (entityIds.length === 0) return;
    this.commandQueue.enqueue({
      type: 'wait',
      tick: this.getTick(),
      entityIds,
      queue,
      queueFront,
      queueInsertIndex,
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

  setUnitMoveState(): void {
    const selectedUnits = this.source.getSelectedUnits();
    const entityIds: EntityId[] = [];
    let firstMoveState: UnitMoveState | null = null;
    let allSameMoveState = true;
    for (let i = 0; i < selectedUnits.length; i++) {
      const unit = selectedUnits[i].unit;
      if (unit === null) continue;
      entityIds.push(selectedUnits[i].id);
      if (firstMoveState === null) firstMoveState = unit.moveState;
      else if (unit.moveState !== firstMoveState) allSameMoveState = false;
    }
    if (entityIds.length === 0) return;
    const moveState = firstMoveState !== null && allSameMoveState
      ? nextUnitMoveState(firstMoveState)
      : 'holdPosition';
    this.commandQueue.enqueue({
      type: 'setUnitMoveState',
      tick: this.getTick(),
      entityIds,
      moveState,
    });
  }

  setFireEnabled(): void {
    const selectedUnits = this.source.getSelectedUnits();
    const selectedStatic = this.source.getSelectedBuildings();
    const entityIds: EntityId[] = [];
    let firstFireState: CombatFireState | null = null;
    let allSameFireState = true;
    for (let i = 0; i < selectedUnits.length; i++) {
      const unit = selectedUnits[i];
      if (!unit.combat || unit.combat.turrets.length === 0) continue;
      entityIds.push(unit.id);
      const state = combatFireState(unit.combat);
      if (firstFireState === null) firstFireState = state;
      else if (state !== firstFireState) allSameFireState = false;
    }
    // Towers carry the same host-fire contract as units; include any
    // tower in the selection whose combat has at least one turret.
    for (let i = 0; i < selectedStatic.length; i++) {
      const tower = selectedStatic[i];
      if (tower.type !== 'tower') continue;
      if (!tower.combat || tower.combat.turrets.length === 0) continue;
      entityIds.push(tower.id);
      const state = combatFireState(tower.combat);
      if (firstFireState === null) firstFireState = state;
      else if (state !== firstFireState) allSameFireState = false;
    }
    if (entityIds.length === 0) return;
    const fireState = firstFireState !== null && allSameFireState
      ? nextCombatFireState(firstFireState)
      : 'fireAtWill';
    this.commandQueue.enqueue({
      type: 'setFireEnabled',
      tick: this.getTick(),
      entityIds,
      enabled: fireState !== 'holdFire',
      fireState,
    });
  }

  setTrajectoryMode(): void {
    const selectedUnits = this.source.getSelectedUnits();
    const selectedStatic = this.source.getSelectedBuildings();
    const entityIds: EntityId[] = [];
    let allHigh = true;
    let allLow = true;
    for (let i = 0; i < selectedUnits.length; i++) {
      const entity = selectedUnits[i];
      if (!entityHasBallisticCombat(entity)) continue;
      entityIds.push(entity.id);
      if (entity.combat!.trajectoryMode !== 'high') allHigh = false;
      if (entity.combat!.trajectoryMode !== 'low') allLow = false;
    }
    for (let i = 0; i < selectedStatic.length; i++) {
      const entity = selectedStatic[i];
      if (!entityHasBallisticCombat(entity)) continue;
      entityIds.push(entity.id);
      if (entity.combat!.trajectoryMode !== 'high') allHigh = false;
      if (entity.combat!.trajectoryMode !== 'low') allLow = false;
    }
    if (entityIds.length === 0) return;
    const trajectoryMode: CombatTrajectoryMode = allHigh ? 'low' : allLow ? 'auto' : 'high';
    this.commandQueue.enqueue({
      type: 'setTrajectoryMode',
      tick: this.getTick(),
      entityIds,
      trajectoryMode,
    });
  }

  setCloakState(): void {
    const selectedUnits = this.source.getSelectedUnits();
    const entityIds: EntityId[] = [];
    let allWantCloak = true;
    for (let i = 0; i < selectedUnits.length; i++) {
      const unit = selectedUnits[i].unit;
      if (unit === null) continue;
      entityIds.push(selectedUnits[i].id);
      if (unit.wantCloak !== true) allWantCloak = false;
    }
    if (entityIds.length === 0) return;
    this.commandQueue.enqueue({
      type: 'setCloakState',
      tick: this.getTick(),
      entityIds,
      enabled: !allWantCloak,
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

function entityHasBallisticCombat(entity: Entity): boolean {
  const combat = entity.combat;
  if (combat === null || combat.turrets.length === 0) return false;
  for (let i = 0; i < combat.turrets.length; i++) {
    if (isBallisticArcWeapon(combat.turrets[i])) return true;
  }
  return false;
}
