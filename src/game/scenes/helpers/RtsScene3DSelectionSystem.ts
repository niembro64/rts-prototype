import type { ClientViewState } from '../../network/ClientViewState';
import type { Command } from '../../sim/commands';
import { buildSelectionInfo } from './UIUpdateManager';
import type {
  BuildingBlueprintId,
  Entity,
  EntityId,
  PlayerId,
  WaypointType,
} from '../../sim/types';
import type { ControlGroupInfo, SelectionInfo, UIEntitySource, UIInputState } from '@/types/ui';
import { CONTROL_GROUP_COUNT, type ControlGroupSlotSnapshot } from '../../input/helpers';
import type {
  BuildFacingInfo,
  BuildLineSpacingInfo,
} from '../../render3d/Input3DBuildPlacementState';

type SelectionChangeHandler = ((info: SelectionInfo) => void) | undefined;

function createControlGroupSlotSnapshots(): ControlGroupSlotSnapshot[] {
  const slots = new Array<ControlGroupSlotSnapshot>(CONTROL_GROUP_COUNT);
  for (let i = 0; i < CONTROL_GROUP_COUNT; i++) {
    slots[i] = { entityIds: [], auto: false };
  }
  return slots;
}

export class RtsScene3DSelectionSystem {
  private selectedUnits: Entity[] = [];
  private selectedBuildings: Entity[] = [];
  private scratchSelectedBuildingIds: EntityId[] = [];
  private controlGroupSlots: ControlGroupSlotSnapshot[] = createControlGroupSlotSnapshots();
  private selectedEntityCacheDirty = true;
  private selectionInfoDirty = true;
  private waypointMode: WaypointType = 'move';
  private activeBuildingBlueprintId: BuildingBlueprintId | null = null;
  private buildLineSpacingMultiplier = 1;
  private buildFacingDegrees = 0;
  private queueInsertIndex: number | null = null;
  private dgunActive = false;
  private repairAreaActive = false;
  private formationAssumeActive = false;
  private formationMoveActive = false;
  private attackActive = false;
  private attackAreaActive = false;
  private attackGroundActive = false;
  private manualLaunchActive = false;
  private guardActive = false;
  private reclaimActive = false;
  private captureActive = false;
  private resurrectActive = false;
  private resurrectAreaActive = false;
  private loadTransportActive = false;
  private unloadTransportActive = false;
  private mexUpgradeActive = false;
  private pingActive = false;
  private towerTargetActive = false;

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

  setBuildMode(buildingBlueprintId: BuildingBlueprintId | null): void {
    this.activeBuildingBlueprintId = buildingBlueprintId;
    this.selectionInfoDirty = true;
  }

  setBuildLineSpacing(spacing: BuildLineSpacingInfo): void {
    this.buildLineSpacingMultiplier = spacing.multiplier;
    this.selectionInfoDirty = true;
  }

  setBuildFacing(facing: BuildFacingInfo): void {
    this.buildFacingDegrees = facing.degrees;
    this.selectionInfoDirty = true;
  }

  setQueueInsertIndex(index: number | null): void {
    this.queueInsertIndex = index;
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

  setFormationAssumeMode(active: boolean): void {
    this.formationAssumeActive = active;
    this.selectionInfoDirty = true;
  }

  setFormationMoveMode(active: boolean): void {
    this.formationMoveActive = active;
    this.selectionInfoDirty = true;
  }

  setAttackMode(active: boolean): void {
    this.attackActive = active;
    this.selectionInfoDirty = true;
  }

  setAttackAreaMode(active: boolean): void {
    this.attackAreaActive = active;
    this.selectionInfoDirty = true;
  }

  setAttackGroundMode(active: boolean): void {
    this.attackGroundActive = active;
    this.selectionInfoDirty = true;
  }

  setManualLaunchMode(active: boolean): void {
    this.manualLaunchActive = active;
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

  setCaptureMode(active: boolean): void {
    this.captureActive = active;
    this.selectionInfoDirty = true;
  }

  setResurrectMode(active: boolean): void {
    this.resurrectActive = active;
    this.selectionInfoDirty = true;
  }

  setResurrectAreaMode(active: boolean): void {
    this.resurrectAreaActive = active;
    this.selectionInfoDirty = true;
  }

  setLoadTransportMode(active: boolean): void {
    this.loadTransportActive = active;
    this.selectionInfoDirty = true;
  }

  setUnloadTransportMode(active: boolean): void {
    this.unloadTransportActive = active;
    this.selectionInfoDirty = true;
  }

  setMexUpgradeMode(active: boolean): void {
    this.mexUpgradeActive = active;
    this.selectionInfoDirty = true;
  }

  setPingMode(active: boolean): void {
    this.pingActive = active;
    this.selectionInfoDirty = true;
  }

  setTowerTargetMode(active: boolean): void {
    this.towerTargetActive = active;
    this.selectionInfoDirty = true;
  }

  setControlGroups(groups: readonly ControlGroupSlotSnapshot[]): void {
    for (let i = 0; i < CONTROL_GROUP_COUNT; i++) {
      const group = groups[i];
      this.controlGroupSlots[i] = {
        entityIds: [...(group?.entityIds ?? [])],
        auto: group?.auto === true,
      };
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
      let hasProducingFactory = false;
      for (let i = 0; i < this.selectedBuildings.length; i++) {
        if (this.selectedBuildings[i].factory?.isProducing !== true) continue;
        hasProducingFactory = true;
        break;
      }
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
      isBuildMode: this.activeBuildingBlueprintId !== null,
      selectedBuildingBlueprintId: this.activeBuildingBlueprintId,
      buildLineSpacingMultiplier: this.buildLineSpacingMultiplier,
      buildFacingDegrees: this.buildFacingDegrees,
      queueInsertIndex: this.queueInsertIndex,
      isDGunMode: this.dgunActive,
      isRepairAreaMode: this.repairAreaActive,
      isFormationAssumeMode: this.formationAssumeActive,
      isFormationMoveMode: this.formationMoveActive,
      isAttackMode: this.attackActive,
      isAttackAreaMode: this.attackAreaActive,
      isAttackGroundMode: this.attackGroundActive,
      isManualLaunchMode: this.manualLaunchActive,
      isGuardMode: this.guardActive,
      isReclaimMode: this.reclaimActive,
      isCaptureMode: this.captureActive,
      isResurrectMode: this.resurrectActive,
      isResurrectAreaMode: this.resurrectAreaActive,
      isLoadTransportMode: this.loadTransportActive,
      isUnloadTransportMode: this.unloadTransportActive,
      isMexUpgradeMode: this.mexUpgradeActive,
      isPingMode: this.pingActive,
      isTowerTargetMode: this.towerTargetActive,
      controlGroups: this.buildControlGroupInfo(),
    };
  }

  private buildControlGroupInfo(): ControlGroupInfo[] {
    const selectedIds = this.clientViewState.getSelectedIds();
    const playerId = this.getLocalPlayerId();
    const groups: ControlGroupInfo[] = [];

    for (let i = 0; i < CONTROL_GROUP_COUNT; i++) {
      const group = this.controlGroupSlots[i];
      let count = 0;
      let allSelected = selectedIds.size > 0;

      for (let j = 0; j < group.entityIds.length; j++) {
        const entity = this.clientViewState.getEntity(group.entityIds[j]);
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
        auto: group.auto,
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
