import type { ClientViewState } from '../../network/ClientViewState';
import type { Command } from '../../sim/commands';
import { buildSelectionInfo, type SelectionViewerContext } from './UIUpdateManager';
import type {
  BuildingBlueprintId,
  Entity,
  EntityId,
  PlayerId,
  WaypointType,
} from '../../sim/types';
import type { ControlGroupInfo, SelectionInfo, UIEntitySource, UIInputState } from '@/types/ui';
import type { BarBuildCategoryId } from '../../input/buildMenuLayout';
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

/** Steady-state (snapshot-driven / producing-factory) selection-panel
 *  publishes are capped to this interval; player-input marks still publish
 *  on the next frame. Matches the economy UI cadence. */
const SELECTION_INFO_PUBLISH_INTERVAL_MS = 100;

export class RtsScene3DSelectionSystem {
  private selectedUnits: Entity[] = [];
  private selectedBuildings: Entity[] = [];
  private scratchSelectedBuildingIds: EntityId[] = [];
  private controlGroupSlots: ControlGroupSlotSnapshot[] = createControlGroupSlotSnapshots();
  private selectedEntityCacheDirty = true;
  private selectionInfoDirty = true;
  /** Snapshot-intake refresh requests; honored on the publish interval. */
  private selectionInfoThrottledDirty = false;
  private lastSelectionInfoEmitMs = 0;
  /** The hovered entity the last emitted info described. The panel reads hover
   *  first (BAR-style), so a new entity under the cursor is a real change to
   *  what it shows — but only when the ENTITY changes, not every frame the
   *  mouse moves within one. */
  private lastHoveredEntityId: number | null = null;
  private waypointMode: WaypointType = 'move';
  private buildGridCategory: BarBuildCategoryId | null = null;
  private buildGridPage = 0;
  private factoryGridPage = 0;
  private factoryQueueMode = false;
  private factoryPresetOverlayVisible = false;
  private activeBuilderUnitBlueprintId: string | null = null;
  private activeBuildingBlueprintId: BuildingBlueprintId | null = null;
  private buildLineSpacingMultiplier = 1;
  private buildFacingDegrees = 0;
  private queueInsertIndex: number | null = null;
  private dgunActive = false;
  private repairAreaActive = false;
  private restoreAreaActive = false;
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
  private towerTargetNoGroundActive = false;

  constructor(
    private readonly clientViewState: ClientViewState,
    /** The owning seat, or undefined for a seatless SPECTATOR — every
     *  owner filter below is skipped then, so a watcher's selection caches
     *  (panel, cursor, control groups) see foreign entities too. */
    private readonly getLocalPlayerId: () => PlayerId | undefined,
    /** Allegiance + owner-name lens for the info panel's BAR-style owner
     *  line and foreign-intel gate. Optional so fixtures need not care. */
    private readonly getViewerContext?: () => SelectionViewerContext,
  ) {}

  getSelectedUnits(): Entity[] {
    this.rebuildEntityCachesIfNeeded();
    return this.selectedUnits;
  }

  getSelectedBuildings(): Entity[] {
    this.rebuildEntityCachesIfNeeded();
    return this.selectedBuildings;
  }

  /** Urgent marks (the default — selection clicks, waypoint mode, control
   *  groups) republish on the next frame. Non-urgent marks (steady snapshot
   *  intake) wait out the UI publish interval, because rebuilding the whole
   *  selection panel payload at snapshot rate was the single largest sim→Vue
   *  cost in the profile. */
  markSelectionDirty(urgent = true): void {
    if (urgent) this.selectionInfoDirty = true;
    else this.selectionInfoThrottledDirty = true;
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

  setBuildGridCategory(categoryId: BarBuildCategoryId | null): void {
    this.buildGridCategory = categoryId;
    this.selectionInfoDirty = true;
  }

  setBuildGridPage(pageIndex: number): void {
    this.buildGridPage = pageIndex;
    this.selectionInfoDirty = true;
  }

  setFactoryGridPage(pageIndex: number): void {
    this.factoryGridPage = pageIndex;
    this.selectionInfoDirty = true;
  }

  setFactoryQueueMode(active: boolean): void {
    this.factoryQueueMode = active;
    this.selectionInfoDirty = true;
  }

  setFactoryPresetOverlayVisible(active: boolean): void {
    this.factoryPresetOverlayVisible = active;
    this.selectionInfoDirty = true;
  }

  setActiveBuilder(unitBlueprintId: string | null): void {
    this.activeBuilderUnitBlueprintId = unitBlueprintId;
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

  setRestoreAreaMode(active: boolean): void {
    this.restoreAreaActive = active;
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

  setTowerTargetNoGroundMode(active: boolean): void {
    this.towerTargetNoGroundActive = active;
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
      if (!entity?.selectable?.selected) continue;
      if (playerId !== undefined && entity.ownership?.playerId !== playerId) continue;
      if (entity.unit) this.selectedUnits.push(entity);
      else if (entity.building) this.selectedBuildings.push(entity);
    }
  }

  emitSelectionInfoIfDirty(
    entitySource: UIEntitySource,
    onSelectionChange: SelectionChangeHandler,
  ): void {
    this.rebuildEntityCachesIfNeeded();
    const hoveredEntityId = entitySource.getHoveredEntity?.()?.id ?? null;
    if (hoveredEntityId !== this.lastHoveredEntityId) {
      this.lastHoveredEntityId = hoveredEntityId;
      this.selectionInfoDirty = true;
    }
    if (!this.selectionInfoDirty && !this.selectionInfoThrottledDirty) {
      // A producing factory keeps its progress bar live — on the UI publish
      // interval below, no longer at full render framerate.
      for (let i = 0; i < this.selectedBuildings.length; i++) {
        if (this.selectedBuildings[i].factory?.isProducing !== true) continue;
        this.selectionInfoThrottledDirty = true;
        break;
      }
    }
    const nowMs = performance.now();
    if (!this.selectionInfoDirty) {
      if (!this.selectionInfoThrottledDirty) return;
      if (nowMs - this.lastSelectionInfoEmitMs < SELECTION_INFO_PUBLISH_INTERVAL_MS) return;
    }

    this.emitSelectionInfo(entitySource, onSelectionChange);
    this.selectionInfoDirty = false;
    this.selectionInfoThrottledDirty = false;
    this.lastSelectionInfoEmitMs = nowMs;
  }

  emitSelectionInfo(
    entitySource: UIEntitySource,
    onSelectionChange: SelectionChangeHandler,
  ): void {
    if (!onSelectionChange) return;
    onSelectionChange(buildSelectionInfo(
      entitySource,
      this.getInputState(),
      this.getViewerContext?.(),
    ));
  }

  private getInputState(): UIInputState {
    return {
      waypointMode: this.waypointMode,
      buildGridCategory: this.buildGridCategory,
      buildGridPage: this.buildGridPage,
      factoryGridPage: this.factoryGridPage,
      factoryQueueMode: this.factoryQueueMode,
      factoryPresetOverlayVisible: this.factoryPresetOverlayVisible,
      activeBuilderUnitBlueprintId: this.activeBuilderUnitBlueprintId,
      isBuildMode: this.activeBuildingBlueprintId !== null,
      selectedBuildingBlueprintId: this.activeBuildingBlueprintId,
      buildLineSpacingMultiplier: this.buildLineSpacingMultiplier,
      buildFacingDegrees: this.buildFacingDegrees,
      queueInsertIndex: this.queueInsertIndex,
      isDGunMode: this.dgunActive,
      isRepairAreaMode: this.repairAreaActive,
      isRestoreAreaMode: this.restoreAreaActive,
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
      isTowerTargetNoGroundMode: this.towerTargetNoGroundActive,
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
        if (!entity?.selectable) continue;
        if (playerId !== undefined && entity.ownership?.playerId !== playerId) continue;
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
        (playerId === undefined || entity.ownership?.playerId === playerId)
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
        (playerId === undefined || entity.ownership?.playerId === playerId)
      ) {
        buildingsToDeselect.push(id);
      }
    }
    for (let i = 0; i < buildingsToDeselect.length; i++) {
      this.clientViewState.deselectEntity(buildingsToDeselect[i]);
    }
  }
}
