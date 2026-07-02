import type { ClientCommandSink } from '../ClientCommandSink';
import type { CombatFireState, CombatTrajectoryMode, Entity, EntityId, UnitMoveState } from '../../sim/types';
import { buildingBlueprintHasActiveState } from '../../sim/buildingActiveState';
import { isBallisticArcWeapon } from '../../sim/combat/combatUtils';
import {
  entityHasBarBuilderPriorityCommand,
  entityHasBarCarrierSpawnCommand,
  entityHasBarSetTargetCommand,
  entityHasBarMoveStateCommand,
  entityHasBarStopCommand,
  entityHasCloakCommand,
} from '../../sim/unitCommandCapabilities';

type SelectedCommandEntitySource = {
  getSelectedUnits: () => Entity[];
  getSelectedBuildings: () => Entity[];
};
type BuildingActivePredicate = typeof buildingBlueprintHasActiveState;
type TrajectoryControlPredicate = (entity: Entity) => boolean;
type TrajectoryModeResolver = (entity: Entity) => CombatTrajectoryMode;

const DEFAULT_TRAJECTORY_MODE_CYCLE: readonly CombatTrajectoryMode[] = ['high', 'low', 'auto'];

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

function entityTrajectoryMode(entity: Entity): CombatTrajectoryMode {
  return entity.combat?.trajectoryMode ?? 'auto';
}

function nextTrajectoryModeFromSelection(
  firstMode: CombatTrajectoryMode | null,
  allSameMode: boolean,
  cycle: readonly CombatTrajectoryMode[],
): CombatTrajectoryMode {
  if (!allSameMode || firstMode === null || cycle.length === 0) return cycle[0] ?? 'high';
  const currentIndex = cycle.indexOf(firstMode);
  return currentIndex >= 0 ? cycle[(currentIndex + 1) % cycle.length] ?? 'high' : cycle[0] ?? 'high';
}

export class InputSelectedCommands {
  private source: SelectedCommandEntitySource;
  private readonly commandQueue: ClientCommandSink;
  private readonly getTick: () => number;
  private gatherWaitSerial = 0;

  constructor(
    source: SelectedCommandEntitySource,
    commandQueue: ClientCommandSink,
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
      if (entityHasBarSetTargetCommand(unit)) out.push(unit);
    }
    const towers = this.selectedTowers();
    for (let i = 0; i < towers.length; i++) {
      const tower = towers[i];
      if (entityHasBarSetTargetCommand(tower)) out.push(tower);
    }
    return out;
  }

  stop(): void {
    const entityIds = this.selectedStopEntityIds();
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
    const entityIds = this.selectedWaitEntityIds();
    if (entityIds.length === 0) return;
    const tick = this.getTick();
    this.commandQueue.enqueue({
      type: 'wait',
      tick,
      entityIds,
      queue,
      queueFront,
      queueInsertIndex,
    });
  }

  gatherWait(queue: boolean, queueFront = false, queueInsertIndex?: number): void {
    const entityIds = this.selectedUnitIds();
    if (entityIds.length === 0) return;
    const tick = this.getTick();
    this.commandQueue.enqueue({
      type: 'wait',
      tick,
      entityIds,
      queue,
      queueFront,
      queueInsertIndex,
      gather: true,
      waitGroupId: this.createGatherWaitGroupId(entityIds, tick),
    });
  }

  setRepeatQueue(enabled?: boolean): void {
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
      enabled: enabled ?? !allEnabled,
    });
  }

  setBuilderPriority(lowPriority?: boolean): void {
    const selectedUnits = this.source.getSelectedUnits();
    const selectedStatic = this.source.getSelectedBuildings();
    const entityIds: EntityId[] = [];
    let allLowPriority = true;
    for (let i = 0; i < selectedUnits.length; i++) {
      const entity = selectedUnits[i];
      if (!entityHasBarBuilderPriorityCommand(entity)) continue;
      const builder = entity.builder ?? null;
      const factory = entity.factory ?? null;
      if (builder === null && factory === null) continue;
      entityIds.push(entity.id);
      if (
        (builder !== null && builder.lowPriority !== true) ||
        (factory !== null && factory.lowPriority !== true)
      ) {
        allLowPriority = false;
      }
    }
    for (let i = 0; i < selectedStatic.length; i++) {
      const entity = selectedStatic[i];
      if (!entityHasBarBuilderPriorityCommand(entity)) continue;
      const builder = entity.builder ?? null;
      const factory = entity.factory ?? null;
      if (builder === null && factory === null) continue;
      entityIds.push(entity.id);
      if (
        (builder !== null && builder.lowPriority !== true) ||
        (factory !== null && factory.lowPriority !== true)
      ) {
        allLowPriority = false;
      }
    }
    if (entityIds.length === 0) return;
    this.commandQueue.enqueue({
      type: 'setBuilderPriority',
      tick: this.getTick(),
      entityIds,
      lowPriority: lowPriority ?? !allLowPriority,
    });
  }

  setCarrierSpawn(enabled?: boolean): void {
    const selectedUnits = this.source.getSelectedUnits();
    const entityIds: EntityId[] = [];
    let allEnabled = true;
    for (let i = 0; i < selectedUnits.length; i++) {
      const entity = selectedUnits[i];
      const factory = entity.factory ?? null;
      if (entity.type !== 'unit' || factory === null || !entityHasBarCarrierSpawnCommand(entity)) continue;
      entityIds.push(entity.id);
      if (factory.carrierSpawnEnabled !== true) allEnabled = false;
    }
    if (entityIds.length === 0) return;
    this.commandQueue.enqueue({
      type: 'setCarrierSpawn',
      tick: this.getTick(),
      entityIds,
      enabled: enabled ?? !allEnabled,
    });
  }

  setUnitMoveState(nextMoveState?: UnitMoveState): void {
    const selectedUnits = this.source.getSelectedUnits();
    const selectedStatic = this.source.getSelectedBuildings();
    const entityIds: EntityId[] = [];
    let firstMoveState: UnitMoveState | null = null;
    let allSameMoveState = true;
    for (let i = 0; i < selectedUnits.length; i++) {
      const entity = selectedUnits[i];
      if (!entityHasBarMoveStateCommand(entity)) continue;
      const unit = entity.unit;
      if (unit === null) continue;
      entityIds.push(entity.id);
      if (firstMoveState === null) firstMoveState = unit.moveState;
      else if (unit.moveState !== firstMoveState) allSameMoveState = false;
    }
    for (let i = 0; i < selectedStatic.length; i++) {
      const entity = selectedStatic[i];
      if (!entityHasBarMoveStateCommand(entity)) continue;
      const factory = entity.factory;
      if (factory === null) continue;
      entityIds.push(entity.id);
      if (firstMoveState === null) firstMoveState = factory.moveState;
      else if (factory.moveState !== firstMoveState) allSameMoveState = false;
    }
    if (entityIds.length === 0) return;
    const moveState = nextMoveState ?? (firstMoveState !== null && allSameMoveState
      ? nextUnitMoveState(firstMoveState)
      : 'holdPosition');
    this.commandQueue.enqueue({
      type: 'setUnitMoveState',
      tick: this.getTick(),
      entityIds,
      moveState,
    });
  }

  setFireEnabled(nextFireState?: CombatFireState): void {
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
    const fireState = nextFireState ?? (firstFireState !== null && allSameFireState
      ? nextCombatFireState(firstFireState)
      : 'fireAtWill');
    this.commandQueue.enqueue({
      type: 'setFireEnabled',
      tick: this.getTick(),
      entityIds,
      enabled: fireState !== 'holdFire',
      fireState,
    });
  }

  setTrajectoryMode(
    nextTrajectoryMode?: CombatTrajectoryMode,
    includeEntity: TrajectoryControlPredicate = entityHasBallisticCombat,
    resolveTrajectoryMode: TrajectoryModeResolver = entityTrajectoryMode,
    toggleCycle: readonly CombatTrajectoryMode[] = DEFAULT_TRAJECTORY_MODE_CYCLE,
  ): void {
    const selectedUnits = this.source.getSelectedUnits();
    const selectedStatic = this.source.getSelectedBuildings();
    const entityIds: EntityId[] = [];
    let firstMode: CombatTrajectoryMode | null = null;
    let allSameMode = true;
    for (let i = 0; i < selectedUnits.length; i++) {
      const entity = selectedUnits[i];
      if (!includeEntity(entity)) continue;
      entityIds.push(entity.id);
      const mode = resolveTrajectoryMode(entity);
      if (firstMode === null) firstMode = mode;
      else if (mode !== firstMode) allSameMode = false;
    }
    for (let i = 0; i < selectedStatic.length; i++) {
      const entity = selectedStatic[i];
      if (!includeEntity(entity)) continue;
      entityIds.push(entity.id);
      const mode = resolveTrajectoryMode(entity);
      if (firstMode === null) firstMode = mode;
      else if (mode !== firstMode) allSameMode = false;
    }
    if (entityIds.length === 0) return;
    const trajectoryMode: CombatTrajectoryMode =
      nextTrajectoryMode ?? nextTrajectoryModeFromSelection(firstMode, allSameMode, toggleCycle);
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
      if (unit === null || !entityHasCloakCommand(selectedUnits[i])) continue;
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

  setBuildingActive(open?: boolean, includeBuilding: BuildingActivePredicate = buildingBlueprintHasActiveState): void {
    const selectedStatic = this.source.getSelectedBuildings();
    const entityIds: EntityId[] = [];
    let allOpen = true;
    for (let i = 0; i < selectedStatic.length; i++) {
      const building = selectedStatic[i];
      if (building.type !== 'building') continue;
      if (!includeBuilding(building.buildingBlueprintId)) continue;
      entityIds.push(building.id);
      const state = building.building !== null ? building.building.activeState : null;
      if (state === null || state.open === false) allOpen = false;
    }
    if (entityIds.length === 0) return;
    this.commandQueue.enqueue({
      type: 'setBuildingActive',
      tick: this.getTick(),
      entityIds,
      open: open ?? !allOpen,
    });
  }

  selfDestruct(queue = false, queueFront = false, queueInsertIndex?: number): void {
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
      queue,
      queueFront,
      queueInsertIndex,
    });
  }

  setTowerTarget(
    targetId: EntityId | null,
    targetPoint?: { x: number; y: number; z?: number },
  ): void {
    const targetableEntities = this.selectedTargetableCombatEntities();
    if (targetableEntities.length === 0) return;
    const entityIds: EntityId[] = [];
    for (let i = 0; i < targetableEntities.length; i++) entityIds.push(targetableEntities[i].id);
    if (targetId === null && targetPoint !== undefined) {
      this.commandQueue.enqueue({
        type: 'setTowerTarget',
        tick: this.getTick(),
        entityIds,
        targetId: null,
        targetX: targetPoint.x,
        targetY: targetPoint.y,
        targetZ: targetPoint.z,
      });
      return;
    }
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

  private selectedStopEntityIds(): EntityId[] {
    const selectedUnits = this.source.getSelectedUnits();
    const selectedStatic = this.source.getSelectedBuildings();
    const entityIds: EntityId[] = [];
    for (let i = 0; i < selectedUnits.length; i++) entityIds.push(selectedUnits[i].id);
    for (let i = 0; i < selectedStatic.length; i++) {
      const entity = selectedStatic[i];
      if (!entityHasBarStopCommand(entity)) continue;
      entityIds.push(entity.id);
    }
    return entityIds;
  }

  private selectedWaitEntityIds(): EntityId[] {
    const selectedUnits = this.source.getSelectedUnits();
    const entityIds: EntityId[] = [];
    const seen = new Set<EntityId>();
    for (let i = 0; i < selectedUnits.length; i++) {
      const id = selectedUnits[i].id;
      if (seen.has(id)) continue;
      seen.add(id);
      entityIds.push(id);
    }
    const selectedStatic = this.source.getSelectedBuildings();
    for (let i = 0; i < selectedStatic.length; i++) {
      const entity = selectedStatic[i];
      if (entity.factory === null || seen.has(entity.id)) continue;
      seen.add(entity.id);
      entityIds.push(entity.id);
    }
    return entityIds;
  }

  private createGatherWaitGroupId(entityIds: readonly EntityId[], tick: number): number {
    this.gatherWaitSerial = (this.gatherWaitSerial + 1) & 0x7FFF_FFFF;
    let hash = Math.imul(tick | 0, 0x45D9F3B) >>> 0;
    hash = Math.imul(hash ^ this.gatherWaitSerial, 0x01000193) >>> 0;
    for (let i = 0; i < entityIds.length; i++) {
      hash = Math.imul(hash ^ entityIds[i], 0x01000193) >>> 0;
    }
    return hash & 0x7FFF_FFFF;
  }
}

function entityHasBallisticCombat(entity: Entity): boolean {
  const combat = entity.combat ?? null;
  if (combat === null || combat.turrets.length === 0) return false;
  for (let i = 0; i < combat.turrets.length; i++) {
    if (isBallisticArcWeapon(combat.turrets[i])) return true;
  }
  return false;
}
