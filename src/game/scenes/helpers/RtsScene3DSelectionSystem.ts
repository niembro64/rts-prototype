import type { ClientViewState } from '../../network/ClientViewState';
import type { Command } from '../../sim/commands';
import { buildSelectionInfo } from './UIUpdateManager';
import type {
  BuildingType,
  Entity,
  EntityId,
  PlayerId,
  WaypointType,
} from '../../sim/types';
import type { ControlGroupInfo, SelectionInfo, UIEntitySource, UIInputState } from '@/types/ui';

export type SelectionChangeHandler = ((info: SelectionInfo) => void) | undefined;
const CONTROL_GROUP_COUNT = 9;

export class RtsScene3DSelectionSystem {
  private selectedUnits: Entity[] = [];
  private selectedBuildings: Entity[] = [];
  private scratchSelectedBuildingIds: EntityId[] = [];
  private controlGroupEntityIds: EntityId[][] = Array.from(
    { length: CONTROL_GROUP_COUNT },
    () => [],
  );
  private selectedEntityCacheDirty = true;
  private selectionInfoDirty = true;
  private waypointMode: WaypointType = 'move';
  private buildType: BuildingType | null = null;
  private dgunActive = false;
  private repairAreaActive = false;
  private attackAreaActive = false;
  private guardActive = false;
  private reclaimActive = false;

  constructor(
    private readonly clientViewState: ClientViewState,
    private readonly getLocalPlayerId: () => PlayerId,
  ) {}

  getSelectedUnits(): Entity[] {
    this.rebuildEntityCachesIfNeeded();
    return this.selectedUnits;
  }

  getSelectedBuildings(): Entity[] {
    this.rebuildEntityCachesIfNeeded();
    return this.selectedBuildings;
  }

  markSelectionDirty(): void {
    this.selectionInfoDirty = true;
    this.selectedEntityCacheDirty = true;
  }

  setWaypointMode(mode: WaypointType): void {
    this.waypointMode = mode;
    this.selectionInfoDirty = true;
  }

  setBuildMode(type: BuildingType | null): void {
    this.buildType = type;
    this.selectionInfoDirty = true;
  }

  setDGunMode(active: boolean): void {
    this.dgunActive = active;
    this.selectionInfoDirty = true;
  }

  setRepairAreaMode(active: boolean): void {
    this.repairAreaActive = active;
    this.selectionInfoDirty = true;
  }

  setAttackAreaMode(active: boolean): void {
    this.attackAreaActive = active;
    this.selectionInfoDirty = true;
  }

  setGuardMode(active: boolean): void {
    this.guardActive = active;
    this.selectionInfoDirty = true;
  }

  setReclaimMode(active: boolean): void {
    this.reclaimActive = active;
    this.selectionInfoDirty = true;
  }

  setControlGroups(groups: readonly (readonly EntityId[])[]): void {
    for (let i = 0; i < CONTROL_GROUP_COUNT; i++) {
      this.controlGroupEntityIds[i] = [...(groups[i] ?? [])];
    }
    this.selectionInfoDirty = true;
  }

  handleLocalCommand(command: Command, resetWaypointMode: () => void): boolean {
    if (command.type === 'select') {
      if (!command.additive) this.clientViewState.clearSelection();
      for (const id of command.entityIds) this.clientViewState.selectEntity(id);
      this.preferUnitsOverBuildingsInSelection();
      resetWaypointMode();
      this.markSelectionDirty();
      return true;
    }

    if (command.type === 'clearSelection') {
      this.clientViewState.clearSelection();
      resetWaypointMode();
      this.markSelectionDirty();
      return true;
    }

    return false;
  }

  rebuildEntityCachesIfNeeded(): void {
    if (!this.selectedEntityCacheDirty) return;
    this.selectedEntityCacheDirty = false;

    this.selectedUnits.length = 0;
    this.selectedBuildings.length = 0;
    const playerId = this.getLocalPlayerId();

    // Was: walk every unit then every building looking for selected ones.
    // Iterating the maintained selection set is O(N_selected).
    for (const id of this.clientViewState.getSelectedIds()) {
      const entity = this.clientViewState.getEntity(id);
      if (!entity?.selectable?.selected || entity.ownership?.playerId !== playerId) continue;
      if (entity.unit) this.selectedUnits.push(entity);
      else if (entity.building) this.selectedBuildings.push(entity);
    }
  }

  emitSelectionInfoIfDirty(
    entitySource: UIEntitySource,
    onSelectionChange: SelectionChangeHandler,
  ): void {
    this.rebuildEntityCachesIfNeeded();
    if (!this.selectionInfoDirty) {
      const hasProducingFactory = this.selectedBuildings.some(
        (building) => building.factory?.isProducing,
      );
      if (hasProducingFactory) this.selectionInfoDirty = true;
    }
    if (!this.selectionInfoDirty) return;

    this.emitSelectionInfo(entitySource, onSelectionChange);
    this.selectionInfoDirty = false;
  }

  emitSelectionInfo(
    entitySource: UIEntitySource,
    onSelectionChange: SelectionChangeHandler,
  ): void {
    if (!onSelectionChange) return;
    onSelectionChange(buildSelectionInfo(entitySource, this.getInputState()));
  }

  private getInputState(): UIInputState {
    return {
      waypointMode: this.waypointMode,
      isBuildMode: this.buildType !== null,
      selectedBuildingType: this.buildType,
      isDGunMode: this.dgunActive,
      isRepairAreaMode: this.repairAreaActive,
      isAttackAreaMode: this.attackAreaActive,
      isGuardMode: this.guardActive,
      isReclaimMode: this.reclaimActive,
      controlGroups: this.buildControlGroupInfo(),
    };
  }

  private buildControlGroupInfo(): ControlGroupInfo[] {
    const selectedIds = this.clientViewState.getSelectedIds();
    const playerId = this.getLocalPlayerId();
    const groups: ControlGroupInfo[] = [];

    for (let i = 0; i < CONTROL_GROUP_COUNT; i++) {
      const group = this.controlGroupEntityIds[i];
      let count = 0;
      let allSelected = selectedIds.size > 0;

      for (let j = 0; j < group.length; j++) {
        const entity = this.clientViewState.getEntity(group[j]);
        if (!entity?.selectable || entity.ownership?.playerId !== playerId) continue;
        if (entity.unit && entity.unit.hp <= 0) continue;
        if (entity.building && entity.building.hp <= 0) continue;
        count++;
        if (!selectedIds.has(entity.id)) allSelected = false;
      }

      groups.push({
        index: i,
        count,
        active: count > 0 && selectedIds.size === count && allSelected,
      });
    }

    return groups;
  }

  private preferUnitsOverBuildingsInSelection(): void {
    const playerId = this.getLocalPlayerId();
    const selectedIds = this.clientViewState.getSelectedIds();

    let hasSelectedUnit = false;
    for (const id of selectedIds) {
      const entity = this.clientViewState.getEntity(id);
      if (
        entity?.unit &&
        entity.selectable?.selected &&
        entity.ownership?.playerId === playerId
      ) {
        hasSelectedUnit = true;
        break;
      }
    }
    if (!hasSelectedUnit) return;

    // Snapshot before mutating; deselectEntity drops from the live set.
    const buildingsToDeselect = this.scratchSelectedBuildingIds;
    buildingsToDeselect.length = 0;
    for (const id of selectedIds) {
      const entity = this.clientViewState.getEntity(id);
      if (
        entity?.building &&
        entity.selectable?.selected &&
        entity.ownership?.playerId === playerId
      ) {
        buildingsToDeselect.push(id);
      }
    }
    for (let i = 0; i < buildingsToDeselect.length; i++) {
      this.clientViewState.deselectEntity(buildingsToDeselect[i]);
    }
  }
}
