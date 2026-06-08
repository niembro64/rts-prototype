// Input3DManager — 3D equivalent of (a subset of) InputManager.
//
// Handles mouse input in the 3D view:
//   - Left mousedown: start a selection drag (or a click if the mouse didn't move)
//   - Left mouseup: resolve selection via performSelection (shared with 2D path)
//   - Right mousedown: issue a move/fight/patrol command to the selected units,
//     using the current waypoint mode
//
// Camera pan/orbit/zoom (middle mouse + scroll) is handled by OrbitCamera, so
// this class only cares about left (button 0) and right (button 2).
//
// Cursor → world-point picking goes through the shared CursorGround
// service: every command point (move target, attack-move target,
// build click, dgun target, factory rally / waypoint, line-path
// chain) is the ACTUAL 3D ground point the user clicked on the
// rendered terrain mesh. No y=0 plane projection anywhere in the
// input pipeline; the same picker the camera zoom + pan uses also
// drives every command, so cursor anchoring is consistent across
// all input flows.

import type { ThreeApp } from './ThreeApp';
import type { BuildGhost3D } from './BuildGhost3D';
import type { CursorGround } from './CursorGround';
import type { CommandQueue } from '../sim/commands';
import type { InputContext } from '@/types/input';
import type { TerrainBuildabilityGrid } from '@/types/terrain';
import type { PlayerId, Entity, EntityId, WaypointType, BuildingBlueprintId, StructureBlueprintId } from '../sim/types';
import {
  entityMatchesScreenRectSelectionOptions,
  findClosestSelectableEntityToPoint,
  SelectionChangeTracker,
  CommanderModeController,
  InputControlGroups,
  InputSelectedCommands,
  type ScreenRectSelectionOptions,
} from '../input/helpers';
import { CLICK_DRAG_THRESHOLD_PX } from '../input/constants';
import { getCommandCursorStyle, type CommandCursorKind } from '../input/CommandCursors';
import { isBuildInProgress } from '../sim/buildableHelpers';
import { getSelectedBuilderAllowedBuildBlueprintIds } from '../sim/builderBuildRoster';
import { isCommander } from '../sim/combat/combatUtils';
import { Input3DSpecialModes, type Input3DSpecialMode } from './Input3DSpecialModes';
import { Input3DHoverState, resolveInput3DHoverTargets } from './Input3DHoverState';
import { Input3DSelectionDragState } from './Input3DSelectionDragState';
import { Input3DKeyboardController } from './Input3DKeyboardController';
import { Input3DPicker } from './Input3DPicker';
import { Input3DRightDragController, type Input3DLineDragState } from './Input3DRightDragController';
import { Input3DModeClickController } from './Input3DModeClickController';

const SELECTABLE_GROUND_MIN_UNIT_RADIUS = 8;

function isTextEntryTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  const tag = element?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || Boolean(element?.isContentEditable);
}

type EntitySource = {
  getUnits: () => Entity[];
  getBuildings: () => Entity[];
  getProjectiles: () => Entity[];
  getAllEntities: () => Entity[];
  getEntity: (id: EntityId) => Entity | undefined;
  getSelectedUnits: () => Entity[];
  getSelectedBuildings: () => Entity[];
  getBuildingsByPlayer: (playerId: PlayerId) => Entity[];
  getUnitsByPlayer: (playerId: PlayerId) => Entity[];
  getEntitySetVersion?: () => number;
  getTerrainBuildabilityGrid?: () => TerrainBuildabilityGrid | null;
};

export class Input3DManager {
  private canvas: HTMLCanvasElement;
  private context: InputContext;
  private entitySource: EntitySource;
  private localCommandQueue: CommandQueue;

  // Current waypoint mode (move/fight/patrol) — driven by UI or M/F/H hotkeys.
  private waypointMode: WaypointType = 'move';
  // Fires when the mode changes (from hotkey or setter). RtsScene3D hooks this
  // to refresh the selection panel so the active mode chip stays in sync.
  public onWaypointModeChange?: (mode: WaypointType) => void;
  public onControlGroupsChange?: (groups: readonly (readonly EntityId[])[]) => void;
  public onControlGroupFocus?: (x: number, y: number) => void;

  // Shared build / commander-special state machine. The 2D
  // BuildingPlacementController owns one of these too so the two
  // renderers can't drift on mode entry/exit semantics. Click
  // dispatch while a mode is active is handled below in
  // handleLeftMouseDown.
  private mode = new CommanderModeController();
  public onBuildModeChange?: (buildingBlueprintId: BuildingBlueprintId | null) => void;
  public onDGunModeChange?: (active: boolean) => void;
  public onRepairAreaModeChange?: (active: boolean) => void;
  public onAttackModeChange?: (active: boolean) => void;
  public onAttackAreaModeChange?: (active: boolean) => void;
  public onAttackGroundModeChange?: (active: boolean) => void;
  public onGuardModeChange?: (active: boolean) => void;
  public onReclaimModeChange?: (active: boolean) => void;
  public onPingModeChange?: (active: boolean) => void;
  public onTowerTargetModeChange?: (active: boolean) => void;
  private specialModes: Input3DSpecialModes;
  private hoverState = new Input3DHoverState();
  private appliedCursor: CommandCursorKind = 'default';

  // Drag state (screen coords only — box select is screen-space)
  private selectionDrag: Input3DSelectionDragState;

  /** Shared cursor/entity picker. Single canonical source of truth
   *  for every command point in this manager, with entity raycasts
   *  and screen-rectangle selection kept out of command dispatch. */
  private picker: Input3DPicker;
  // Resets waypoint mode back to 'move' when the owned-selected set
  // changes — matches the 2D SelectionController's rule so squads
  // don't accidentally inherit 'fight'/'patrol' from a prior group.
  private selectionChangeTracker = new SelectionChangeTracker();
  private controlGroups: InputControlGroups;
  private previousSelectionIds: EntityId[] = [];
  private loopSelectionIds: EntityId[] = [];
  private loopSelectionCursor = -1;
  private selectedCommands: InputSelectedCommands;
  private keyboard: Input3DKeyboardController;
  private rightDrag: Input3DRightDragController;
  private modeClicks: Input3DModeClickController;

  // DOM handlers bound once for add/remove
  private onMouseDown: (e: MouseEvent) => void;
  private onMouseMove: (e: MouseEvent) => void;
  private onMouseUp: (e: MouseEvent) => void;
  private onKeyDown: (e: KeyboardEvent) => void;
  private onKeyUp: (e: KeyboardEvent) => void;
  private onWindowBlur: () => void;
  private selectBoxSameTypeHeld = false;
  private selectBoxIdleHeld = false;

  constructor(
    threeApp: ThreeApp,
    context: InputContext,
    entitySource: EntitySource,
    localCommandQueue: CommandQueue,
    cursorGround: CursorGround,
  ) {
    this.canvas = threeApp.renderer.domElement;
    this.context = context;
    this.entitySource = entitySource;
    this.localCommandQueue = localCommandQueue;
    this.picker = new Input3DPicker(threeApp, cursorGround);
    this.controlGroups = new InputControlGroups(
      entitySource,
      (entity) => this.isSelectableByActivePlayer(entity),
      (entityIds, additive) => this.enqueueSelection(entityIds, additive),
    );
    this.controlGroups.onChange = (groups) => this.onControlGroupsChange?.(groups);
    this.selectedCommands = new InputSelectedCommands(
      entitySource,
      localCommandQueue,
      () => this.context.getTick(),
    );
    this.modeClicks = new Input3DModeClickController({
      getEntitySource: () => this.entitySource,
      commandQueue: this.localCommandQueue,
      picker: this.picker,
      mode: this.mode,
      selectedCommands: this.selectedCommands,
      getTick: () => this.context.getTick(),
      getActivePlayerId: () => this.context.activePlayerId,
      getSelectedCommander: () => this.getSelectedCommander(),
      getSelectedBuilder: () => this.getSelectedBuilder(),
      applyCursor: (kind) => this.applyCursor(kind),
      isRepairAreaMode: () => this.repairAreaMode,
      isAttackMode: () => this.attackMode,
      isAttackAreaMode: () => this.attackAreaMode,
      isAttackGroundMode: () => this.attackGroundMode,
      isGuardMode: () => this.guardMode,
      isReclaimMode: () => this.reclaimMode,
      isPingMode: () => this.pingMode,
      isTowerTargetMode: () => this.towerTargetMode,
      exitRepairAreaMode: () => this.exitRepairAreaMode(),
      exitAttackMode: () => this.exitAttackMode(),
      exitAttackAreaMode: () => this.exitAttackAreaMode(),
      exitAttackGroundMode: () => this.exitAttackGroundMode(),
      exitGuardMode: () => this.exitGuardMode(),
      exitReclaimMode: () => this.exitReclaimMode(),
      exitPingMode: () => this.exitPingMode(),
      exitTowerTargetMode: () => this.exitTowerTargetMode(),
    });
    this.rightDrag = new Input3DRightDragController({
      getEntitySource: () => this.entitySource,
      commandQueue: this.localCommandQueue,
      picker: this.picker,
      getTick: () => this.context.getTick(),
      getActivePlayerId: () => this.context.activePlayerId,
      getWaypointMode: () => this.waypointMode,
      getSelectedCommander: () => this.getSelectedCommander(),
      getMapSampleBounds: () => this.modeClicks.getMapSampleBounds(),
      applyCursor: (kind) => this.applyCursor(kind),
      refreshCursor: () => this.refreshCursor(),
    });
    this.keyboard = new Input3DKeyboardController({
      mode: this.mode,
      commandQueue: this.localCommandQueue,
      getTick: () => this.context.getTick(),
      setWaypointMode: (mode) => this.setWaypointMode(mode),
      storeControlGroupSlot: (index) => this.storeControlGroupSlot(index),
      addToControlGroupSlot: (index) => this.addToControlGroupSlot(index),
      recallControlGroupSlot: (index, additive) => this.recallControlGroupSlot(index, additive),
      toggleControlGroupSlot: (index) => this.toggleControlGroupSlot(index),
      unsetSelectedFromControlGroups: () => this.unsetSelectedFromControlGroups(),
      focusControlGroupSlot: (index) => this.focusControlGroupSlot(index),
      panCameraByKeyboard: (screenX, screenY, fine) => this.panCameraByKeyboard(
        threeApp.orbit,
        screenX,
        screenY,
        fine,
      ),
      hasSelectedBuilder: () => this.hasSelectedBuilder(),
      getSelectedBuilderAllowedBuildBlueprintIds: () => this.getSelectedBuilderAllowedBuildBlueprintIds(),
      exitSpecialModes: (includeTowerTarget) => this.exitSpecialModes(includeTowerTarget),
      stopSelectedUnits: () => this.stopSelectedUnits(),
      removeLastQueuedOrder: () => this.removeLastQueuedOrder(),
      clearQueuedOrders: () => this.clearQueuedOrders(),
      toggleSelectedWait: (queue) => this.toggleSelectedWait(queue),
      toggleSelectedFire: () => this.toggleSelectedFire(),
      toggleBuildingActive: () => this.toggleBuildingActive(),
      selfDestructSelected: () => this.selfDestructSelected(),
      toggleTowerTargetMode: () => this.toggleTowerTargetMode(),
      clearTowerTarget: () => this.clearTowerTarget(),
      toggleAttackMode: () => this.toggleAttackMode(),
      toggleAttackAreaMode: () => this.toggleAttackAreaMode(),
      toggleAttackGroundMode: () => this.toggleAttackGroundMode(),
      toggleGuardMode: () => this.toggleGuardMode(),
      toggleReclaimMode: () => this.toggleReclaimMode(),
      toggleRepairAreaMode: () => this.toggleRepairAreaMode(),
      togglePingMode: () => this.togglePingMode(),
      toggleDGunMode: () => this.toggleDGunMode(),
      enqueueScanAtCursor: () => this.enqueueScanAtCursor(),
      selectActiveCommander: (additive) => this.selectActiveCommander(additive),
      selectAllOwnedUnits: () => this.selectAllOwnedUnits(),
      selectAllMatching: () => this.selectAllMatching(),
      selectAllMatchingInView: () => this.selectAllMatchingInView(),
      selectPreviousSelection: () => this.selectPreviousSelection(),
      selectIdleBuilders: () => this.selectIdleBuilders(),
      selectWaitingUnits: () => this.selectWaitingUnits(),
      selectSameTypeOnly: () => this.selectSameTypeOnly(),
      selectMobileOnly: () => this.selectMobileOnly(),
      invertSelection: () => this.invertSelection(),
      splitArmySelection: () => this.splitArmySelection(),
      loopSelection: () => this.loopSelection(),
      isRepairAreaMode: () => this.repairAreaMode,
      isAttackMode: () => this.attackMode,
      isAttackAreaMode: () => this.attackAreaMode,
      isAttackGroundMode: () => this.attackGroundMode,
      isGuardMode: () => this.guardMode,
      isReclaimMode: () => this.reclaimMode,
      isPingMode: () => this.pingMode,
      isTowerTargetMode: () => this.towerTargetMode,
      exitRepairAreaMode: () => this.exitRepairAreaMode(),
      exitAttackMode: () => this.exitAttackMode(),
      exitAttackAreaMode: () => this.exitAttackAreaMode(),
      exitAttackGroundMode: () => this.exitAttackGroundMode(),
      exitGuardMode: () => this.exitGuardMode(),
      exitReclaimMode: () => this.exitReclaimMode(),
      exitPingMode: () => this.exitPingMode(),
      exitTowerTargetMode: () => this.exitTowerTargetMode(),
    });
    this.specialModes = new Input3DSpecialModes({
      refreshCursor: () => this.refreshCursor(),
      onRepairAreaModeChange: (active) => this.onRepairAreaModeChange?.(active),
      onAttackModeChange: (active) => this.onAttackModeChange?.(active),
      onAttackAreaModeChange: (active) => this.onAttackAreaModeChange?.(active),
      onAttackGroundModeChange: (active) => this.onAttackGroundModeChange?.(active),
      onGuardModeChange: (active) => this.onGuardModeChange?.(active),
      onReclaimModeChange: (active) => this.onReclaimModeChange?.(active),
      onPingModeChange: (active) => this.onPingModeChange?.(active),
      onTowerTargetModeChange: (active) => this.onTowerTargetModeChange?.(active),
    });
    this.selectionDrag = new Input3DSelectionDragState(this.canvas);

    this.onMouseDown = (e) => this.handleMouseDown(e);
    this.onMouseMove = (e) => this.handleMouseMove(e);
    this.onMouseUp = (e) => this.handleMouseUp(e);
    this.onKeyDown = (e) => this.handleKeyDown(e);
    this.onKeyUp = (e) => this.handleKeyUp(e);
    this.onWindowBlur = () => this.clearHeldSelectBoxModifiers();

    this.canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onWindowBlur);

    // Forward shared mode events to the scene's UI callbacks; also
    // hide the build ghost whenever build mode exits.
    this.mode.onBuildModeChange = (buildingBlueprintId) => {
      this.modeClicks.handleBuildModeChange(buildingBlueprintId);
      this.refreshCursor();
      this.onBuildModeChange?.(buildingBlueprintId);
    };
    this.mode.onDGunModeChange = (active) => {
      this.refreshCursor();
      this.onDGunModeChange?.(active);
    };
  }

  /** Inject the scene's build-ghost preview renderer. Input3DManager
   *  calls setTarget on it each mouse-move while build mode is
   *  active and hide() when the mode exits. */
  setBuildGhost(ghost: BuildGhost3D | null): void {
    this.modeClicks.setBuildGhost(ghost);
  }

  /** Scene hook — feeds the client-side placement validator so the
   *  build ghost turns red at the map edge or when overlapping an
   *  existing building. */
  setMapBounds(
    width: number,
    height: number,
    playerCount: number,
  ): void {
    this.modeClicks.setMapBounds(width, height, playerCount);
  }

  getHoveredEntity(): Entity | null {
    const hoveredEntityId = this.hoverState.hoveredEntityId;
    return hoveredEntityId !== null
      ? this.entitySource.getEntity(hoveredEntityId) ?? null
      : null;
  }

  private get leftDown(): boolean {
    return this.selectionDrag.active;
  }

  private get repairAreaMode(): boolean {
    return this.specialModes.isActive('repairArea');
  }

  private get attackAreaMode(): boolean {
    return this.specialModes.isActive('attackArea');
  }

  private get attackMode(): boolean {
    return this.specialModes.isActive('attack');
  }

  private get attackGroundMode(): boolean {
    return this.specialModes.isActive('attackGround');
  }

  private get guardMode(): boolean {
    return this.specialModes.isActive('guard');
  }

  private get reclaimMode(): boolean {
    return this.specialModes.isActive('reclaim');
  }

  private get pingMode(): boolean {
    return this.specialModes.isActive('ping');
  }

  private get towerTargetMode(): boolean {
    return this.specialModes.isActive('towerTarget');
  }

  private exitSpecialModes(includeTowerTarget = true): void {
    this.specialModes.exitAll(includeTowerTarget);
  }

  private enterSpecialMode(mode: Input3DSpecialMode): void {
    this.specialModes.enter(mode);
  }

  setWaypointMode(mode: WaypointType): void {
    this.exitSpecialModes();
    if (this.waypointMode === mode) return;
    this.waypointMode = mode;
    this.refreshCursor();
    this.onWaypointModeChange?.(mode);
  }

  setActivePlayerId(playerId: PlayerId): void {
    if (this.context.activePlayerId === playerId) return;
    this.context.activePlayerId = playerId;
    this.previousSelectionIds = [];
    this.selectionChangeTracker.reset();
    this.mode.exitBuildMode();
    this.mode.exitDGunMode();
    this.exitSpecialModes();
    this.setWaypointMode('move');
    this.clearHoveredEntities();
    this.refreshCursor();
  }

  /** Enter build mode with a building blueprint. Called from the UI
   *  (scene.startBuildMode forwards to here). Next left-click on the
   *  ground will issue a startBuild command for the selected builder. */
  setBuildMode(buildingBlueprintId: BuildingBlueprintId): void {
    this.exitSpecialModes();
    this.mode.enterBuildMode(buildingBlueprintId);
  }

  /** Exit build mode (from UI or internal flow). No-op if not in build mode. */
  cancelBuildMode(): void {
    this.mode.exitBuildMode();
  }

  /** True if build mode is currently active. */
  isInBuildMode(): boolean {
    return this.mode.isInBuildMode;
  }

  /** Toggle D-gun mode from UI. Only enters if a commander is
   *  selected — mirrors the 2D BuildingPlacementController's gate. */
  toggleDGunMode(): void {
    if (!this.hasSelectedCommander()) return;
    this.exitSpecialModes();
    this.mode.toggleDGunMode();
  }

  stopSelectedUnits(): void {
    this.selectedCommands.stop();
  }

  clearQueuedOrders(): void {
    this.selectedCommands.clearQueuedOrders();
  }

  removeLastQueuedOrder(): void {
    this.selectedCommands.removeLastQueuedOrder();
  }

  toggleSelectedWait(queue = false): void {
    this.selectedCommands.wait(queue);
  }

  togglePingMode(): void {
    if (this.pingMode) {
      this.exitPingMode();
      return;
    }
    this.mode.exitBuildMode();
    this.mode.exitDGunMode();
    this.exitSpecialModes();
    this.enterSpecialMode('ping');
  }

  toggleSelectedFire(): void {
    this.selectedCommands.setFireEnabled();
  }

  toggleBuildingActive(): void {
    this.selectedCommands.setBuildingActive();
  }

  selfDestructSelected(): void {
    this.selectedCommands.selfDestruct();
  }

  selectAllOwnedUnits(): void {
    const entityIds: EntityId[] = [];
    const units = this.entitySource.getUnitsByPlayer(this.context.activePlayerId);
    for (let i = 0; i < units.length; i++) {
      if (this.isSelectableByActivePlayer(units[i])) entityIds.push(units[i].id);
    }
    this.enqueueSelection(entityIds, false);
  }

  selectAllMatching(): void {
    this.selectMatching(false);
  }

  selectAllMatchingInView(): void {
    this.selectMatching(true);
  }

  private selectMatching(inView: boolean): void {
    const selectedUnits = this.entitySource.getSelectedUnits();
    const selectedStatic = this.entitySource.getSelectedBuildings();
    if (selectedUnits.length === 0 && selectedStatic.length === 0) return;

    const unitBlueprintIds = new Set<string>();
    const structureBlueprintIds = new Set<string>();
    for (let i = 0; i < selectedUnits.length; i++) {
      const unitBlueprintId = selectedUnits[i].unit?.unitBlueprintId;
      if (unitBlueprintId) unitBlueprintIds.add(unitBlueprintId);
    }
    for (let i = 0; i < selectedStatic.length; i++) {
      const buildingBlueprintId = selectedStatic[i].buildingBlueprintId;
      if (buildingBlueprintId) structureBlueprintIds.add(buildingBlueprintId);
    }

    const visibleEntityIds = inView ? this.getViewportSelectableEntityIds() : null;
    const entityIds: EntityId[] = [];
    const units = this.entitySource.getUnitsByPlayer(this.context.activePlayerId);
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      if (!this.isSelectableByActivePlayer(unit)) continue;
      if (visibleEntityIds !== null && !visibleEntityIds.has(unit.id)) continue;
      const unitBlueprintId = unit.unit?.unitBlueprintId;
      if (unitBlueprintId && unitBlueprintIds.has(unitBlueprintId)) entityIds.push(unit.id);
    }

    const buildings = this.entitySource.getBuildingsByPlayer(this.context.activePlayerId);
    for (let i = 0; i < buildings.length; i++) {
      const building = buildings[i];
      if (!this.isSelectableByActivePlayer(building)) continue;
      if (visibleEntityIds !== null && !visibleEntityIds.has(building.id)) continue;
      const buildingBlueprintId = building.buildingBlueprintId;
      if (buildingBlueprintId && structureBlueprintIds.has(buildingBlueprintId)) {
        entityIds.push(building.id);
      }
    }
    this.enqueueSelection(entityIds, false);
  }

  private getViewportSelectableEntityIds(): Set<EntityId> {
    const rect = this.picker.canvasRect();
    return new Set(this.picker.selectEntitiesInScreenRect(
      this.entitySource,
      this.context.activePlayerId,
      { x: rect.left, y: rect.top },
      { x: rect.right, y: rect.bottom },
    ));
  }

  selectIdleBuilders(): void {
    const entityIds: EntityId[] = [];
    const units = this.entitySource.getUnitsByPlayer(this.context.activePlayerId);
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      if (!this.isSelectableByActivePlayer(unit)) continue;
      if (unit.builder === null || unit.unit === null) continue;
      if (unit.unit.actions.length === 0) entityIds.push(unit.id);
    }
    this.enqueueSelection(entityIds, false);
  }

  selectWaitingUnits(): void {
    const entityIds: EntityId[] = [];
    const units = this.entitySource.getUnitsByPlayer(this.context.activePlayerId);
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      if (!this.isSelectableByActivePlayer(unit)) continue;
      if (unit.unit?.actions[0]?.type === 'wait') entityIds.push(unit.id);
    }
    this.enqueueSelection(entityIds, false);
  }

  selectSameTypeOnly(): void {
    const selectedUnits = this.entitySource.getSelectedUnits();
    if (selectedUnits.length > 0) {
      const unitBlueprintId = selectedUnits[0].unit?.unitBlueprintId;
      if (!unitBlueprintId) return;
      const entityIds = selectedUnits
        .filter((unit) => unit.unit?.unitBlueprintId === unitBlueprintId)
        .map((unit) => unit.id);
      this.enqueueSelection(entityIds, false);
      return;
    }

    const selectedStatic = this.entitySource.getSelectedBuildings();
    if (selectedStatic.length === 0) return;
    const buildingBlueprintId = selectedStatic[0].buildingBlueprintId;
    if (!buildingBlueprintId) return;
    const entityIds = selectedStatic
      .filter((building) => building.buildingBlueprintId === buildingBlueprintId)
      .map((building) => building.id);
    this.enqueueSelection(entityIds, false);
  }

  selectMobileOnly(): void {
    const selectedUnits = this.entitySource.getSelectedUnits();
    if (selectedUnits.length === 0) return;
    const entityIds: EntityId[] = [];
    for (let i = 0; i < selectedUnits.length; i++) entityIds.push(selectedUnits[i].id);
    this.enqueueSelection(entityIds, false);
  }

  invertSelection(): void {
    const selectedEntityIds = new Set(this.getCurrentSelectedEntityIds());
    const entityIds: EntityId[] = [];
    const units = this.entitySource.getUnitsByPlayer(this.context.activePlayerId);
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      if (!this.isSelectableByActivePlayer(unit) || selectedEntityIds.has(unit.id)) continue;
      entityIds.push(unit.id);
    }

    const buildings = this.entitySource.getBuildingsByPlayer(this.context.activePlayerId);
    for (let i = 0; i < buildings.length; i++) {
      const building = buildings[i];
      if (!this.isSelectableByActivePlayer(building) || selectedEntityIds.has(building.id)) continue;
      entityIds.push(building.id);
    }

    if (entityIds.length === 0) {
      this.enqueueClearSelection();
      return;
    }
    this.enqueueSelection(entityIds, false);
  }

  splitArmySelection(): void {
    const selectedUnits = this.entitySource.getSelectedUnits();
    if (selectedUnits.length < 2) return;
    const entityIds: EntityId[] = [];
    for (let i = 0; i < selectedUnits.length; i += 2) {
      if (this.isSelectableByActivePlayer(selectedUnits[i])) entityIds.push(selectedUnits[i].id);
    }
    if (entityIds.length === 0 || entityIds.length === selectedUnits.length) return;
    this.enqueueSelection(entityIds, false);
  }

  loopSelection(): void {
    const currentIds = this.getCurrentSelectedEntityIds();
    if (currentIds.length === 0) return;

    const liveLoopIds = this.getLiveEntityIds(this.loopSelectionIds);
    const currentIdSet = new Set(currentIds);
    const canContinueLoop = currentIds.length === 1
      && liveLoopIds.length > 1
      && liveLoopIds.some((id) => currentIdSet.has(id));

    if (!canContinueLoop) {
      this.loopSelectionIds = currentIds;
      this.loopSelectionCursor = -1;
    } else {
      this.loopSelectionIds = liveLoopIds;
    }

    if (this.loopSelectionIds.length === 0) return;
    if (currentIds.length === 1) {
      const currentIndex = this.loopSelectionIds.indexOf(currentIds[0]);
      if (currentIndex >= 0) this.loopSelectionCursor = currentIndex;
    }
    this.loopSelectionCursor = (this.loopSelectionCursor + 1) % this.loopSelectionIds.length;
    this.enqueueSelection([this.loopSelectionIds[this.loopSelectionCursor]], false);
  }

  selectPreviousSelection(): void {
    const entityIds = this.getLiveEntityIds(this.previousSelectionIds);
    if (entityIds.length === 0) return;
    this.enqueueSelection(entityIds, false);
  }

  selectOnlyEntityType(entityType: 'unit' | 'tower' | 'building'): void {
    const entityIds: EntityId[] = [];
    if (entityType === 'unit') {
      const selectedUnits = this.entitySource.getSelectedUnits();
      for (let i = 0; i < selectedUnits.length; i++) {
        entityIds.push(selectedUnits[i].id);
      }
    } else {
      const selectedStatic = this.entitySource.getSelectedBuildings();
      for (let i = 0; i < selectedStatic.length; i++) {
        const entity = selectedStatic[i];
        if (entity.type === entityType) entityIds.push(entity.id);
      }
    }
    if (entityIds.length === 0) return;
    this.enqueueSelection(entityIds, false);
  }

  toggleAttackAreaMode(): void {
    if (this.attackAreaMode) {
      this.exitAttackAreaMode();
      return;
    }
    if (this.entitySource.getSelectedUnits().length === 0) return;
    this.mode.exitBuildMode();
    this.mode.exitDGunMode();
    this.exitSpecialModes();
    this.enterSpecialMode('attackArea');
  }

  toggleAttackMode(): void {
    if (this.attackMode) {
      this.exitAttackMode();
      return;
    }
    if (this.entitySource.getSelectedUnits().length === 0) return;
    this.mode.exitBuildMode();
    this.mode.exitDGunMode();
    this.exitSpecialModes();
    this.enterSpecialMode('attack');
  }

  toggleAttackGroundMode(): void {
    if (this.attackGroundMode) {
      this.exitAttackGroundMode();
      return;
    }
    if (this.entitySource.getSelectedUnits().length === 0) return;
    this.mode.exitBuildMode();
    this.mode.exitDGunMode();
    this.exitSpecialModes();
    this.enterSpecialMode('attackGround');
  }

  toggleGuardMode(): void {
    if (this.guardMode) {
      this.exitGuardMode();
      return;
    }
    if (this.entitySource.getSelectedUnits().length === 0) return;
    this.mode.exitBuildMode();
    this.mode.exitDGunMode();
    this.exitSpecialModes();
    this.enterSpecialMode('guard');
  }

  toggleRepairAreaMode(): void {
    if (this.repairAreaMode) {
      this.exitRepairAreaMode();
      return;
    }
    if (!this.hasSelectedCommander()) return;
    this.mode.exitBuildMode();
    this.mode.exitDGunMode();
    this.exitSpecialModes();
    this.enterSpecialMode('repairArea');
  }

  toggleReclaimMode(): void {
    if (this.reclaimMode) {
      this.exitReclaimMode();
      return;
    }
    if (!this.hasSelectedCommander()) return;
    this.mode.exitBuildMode();
    this.mode.exitDGunMode();
    this.exitSpecialModes(false);
    this.enterSpecialMode('reclaim');
  }

  storeControlGroupSlot(index: number): void {
    this.controlGroups.storeSlot(index);
  }

  addToControlGroupSlot(index: number): void {
    this.controlGroups.addToSlot(index);
  }

  recallControlGroupSlot(index: number, additive: boolean): boolean {
    return this.controlGroups.recallSlot(index, additive);
  }

  focusControlGroupSlot(index: number): boolean {
    const center = this.getControlGroupCenter(index);
    if (!center) return false;
    this.onControlGroupFocus?.(center.x, center.y);
    return true;
  }

  toggleControlGroupSlot(index: number): boolean {
    return this.controlGroups.toggleSlotSelection(index);
  }

  unsetSelectedFromControlGroups(): void {
    this.controlGroups.unsetSelectedFromGroups();
  }

  private getControlGroupCenter(index: number): { x: number; y: number } | null {
    const entityIds = this.controlGroups.getLiveSlotEntityIds(index);
    if (entityIds.length === 0) return null;
    let totalX = 0;
    let totalY = 0;
    let count = 0;
    for (let i = 0; i < entityIds.length; i++) {
      const entity = this.entitySource.getEntity(entityIds[i]);
      if (!entity || !this.isSelectableByActivePlayer(entity)) continue;
      totalX += entity.transform.x;
      totalY += entity.transform.y;
      count++;
    }
    if (count === 0) return null;
    return { x: totalX / count, y: totalY / count };
  }

  private panCameraByKeyboard(
    orbit: ThreeApp['orbit'],
    screenX: number,
    screenY: number,
    fine: boolean,
  ): void {
    const magnitude = Math.hypot(screenX, screenY);
    if (magnitude <= 0) return;
    const x = screenX / magnitude;
    const y = screenY / magnitude;
    const step = Math.max(32, Math.min(360, orbit.distance * 0.12)) * (fine ? 0.1 : 1);
    const rightX = Math.cos(orbit.yaw);
    const rightZ = Math.sin(orbit.yaw);
    const forwardX = Math.sin(orbit.yaw);
    const forwardZ = -Math.cos(orbit.yaw);
    orbit.panByWorldDelta(
      (rightX * x + forwardX * y) * step,
      (rightZ * x + forwardZ * y) * step,
    );
  }

  /** True if D-gun mode is currently active. */
  isInDGunMode(): boolean {
    return this.mode.isInDGunMode;
  }

  /** True while the next left-click will issue an area-repair command. */
  isInRepairAreaMode(): boolean {
    return this.repairAreaMode;
  }

  /** True while the next left-click will issue an area-attack command. */
  isInAttackAreaMode(): boolean {
    return this.attackAreaMode;
  }

  isInAttackMode(): boolean {
    return this.attackMode;
  }

  /** True while the next left-click will issue an attack-ground command. */
  isInAttackGroundMode(): boolean {
    return this.attackGroundMode;
  }

  /** True while the next left-click will issue a guard command. */
  isInGuardMode(): boolean {
    return this.guardMode;
  }

  /** True while the next left-click will issue a reclaim command. */
  isInReclaimMode(): boolean {
    return this.reclaimMode;
  }

  /** True while the next left-click will issue a map ping. */
  isInPingMode(): boolean {
    return this.pingMode;
  }

  private exitRepairAreaMode(): void {
    this.specialModes.exit('repairArea');
  }

  private exitAttackAreaMode(): void {
    this.specialModes.exit('attackArea');
  }

  private exitAttackMode(): void {
    this.specialModes.exit('attack');
  }

  private exitAttackGroundMode(): void {
    this.specialModes.exit('attackGround');
  }

  private exitGuardMode(): void {
    this.specialModes.exit('guard');
  }

  private exitReclaimMode(): void {
    this.specialModes.exit('reclaim');
  }

  private exitPingMode(): void {
    this.specialModes.exit('ping');
  }

  private exitTowerTargetMode(): void {
    this.specialModes.exit('towerTarget');
  }

  toggleTowerTargetMode(): void {
    if (this.towerTargetMode) {
      this.exitTowerTargetMode();
      return;
    }
    if (!this.hasSelectedTargetableCombatEntities()) return;
    this.mode.exitBuildMode();
    this.mode.exitDGunMode();
    this.exitSpecialModes(false);
    this.enterSpecialMode('towerTarget');
  }

  clearTowerTarget(): void {
    this.selectedCommands.setTowerTarget(null);
  }

  isInTowerTargetMode(): boolean {
    return this.towerTargetMode;
  }

  private hasSelectedTargetableCombatEntities(): boolean {
    return this.selectedCommands.selectedTargetableCombatEntities().length > 0;
  }

  private hasSelectedCommander(): boolean {
    return this.entitySource.getSelectedUnits().some(isCommander);
  }

  private hasSelectedBuilder(): boolean {
    return this.entitySource.getSelectedUnits().some((unit) => unit.builder !== null);
  }

  private getSelectedCommander(): Entity | null {
    return (
      this.entitySource.getSelectedUnits().find(isCommander) ?? null
    );
  }

  private getSelectedBuilder(): Entity | null {
    return (
      this.entitySource.getSelectedUnits().find((unit) => unit.builder !== null) ?? null
    );
  }

  private getSelectedBuilderAllowedBuildBlueprintIds(): readonly StructureBlueprintId[] {
    return getSelectedBuilderAllowedBuildBlueprintIds(this.entitySource.getSelectedUnits());
  }

  private applyCursor(kind: CommandCursorKind): void {
    if (this.appliedCursor === kind) return;
    this.appliedCursor = kind;
    this.canvas.style.cursor = getCommandCursorStyle(kind);
  }

  private waypointCursorKind(): CommandCursorKind {
    switch (this.waypointMode) {
      case 'fight': return 'fight';
      case 'patrol': return 'patrol';
      case 'move':
      default: return 'move';
    }
  }

  private isRepairableBySelectedCommander(entity: Entity | null): boolean {
    const commander = this.getSelectedCommander();
    if (!commander?.ownership || !entity?.ownership) return false;
    if (entity.ownership.playerId !== commander.ownership.playerId) return false;
    if (entity.building) {
      return isBuildInProgress(entity.buildable);
    }
    if (entity.unit) {
      return entity.unit.hp > 0 && entity.unit.hp < entity.unit.maxHp;
    }
    return false;
  }

  private isAttackableBySelectedUnits(entity: Entity | null): boolean {
    if (!entity?.ownership || entity.ownership.playerId === this.context.activePlayerId) return false;
    if (this.entitySource.getSelectedUnits().length === 0) return false;
    if (entity.unit) return entity.unit.hp > 0;
    if (entity.building) return entity.building.hp > 0;
    return false;
  }

  private isSelectableHoverTarget(entity: Entity | null): boolean {
    if (!entity) return false;
    if (entity.unit) return entity.unit.hp > 0;
    if (entity.building) return entity.building.hp > 0;
    return false;
  }

  private isSelectableByActivePlayer(entity: Entity | null): boolean {
    return this.isSelectableHoverTarget(entity) &&
      entity?.ownership?.playerId === this.context.activePlayerId;
  }

  private inferCursorKind(): CommandCursorKind {
    const activeModeCursor = this.modeClicks.cursorKindForActiveMode();
    if (activeModeCursor !== null) return activeModeCursor;
    if (this.leftDown) return 'select';
    if (this.rightDrag.active) return this.waypointCursorKind();

    const hoveredEntityId = this.hoverState.hoveredEntityId;
    const hovered = hoveredEntityId !== null
      ? this.entitySource.getEntity(hoveredEntityId) ?? null
      : null;
    if (this.isRepairableBySelectedCommander(hovered)) return 'repair';
    if (this.isAttackableBySelectedUnits(hovered)) return 'attack';
    const selectableHoveredId = this.hoverState.hoveredSelectableEntityId;
    const selectableHovered = selectableHoveredId !== null
      ? this.entitySource.getEntity(selectableHoveredId) ?? null
      : null;
    if (this.isSelectableByActivePlayer(selectableHovered)) return 'select';
    if (this.entitySource.getSelectedUnits().length > 0) return this.waypointCursorKind();
    if (this.rightDrag.hasSelectedFactories()) return 'factoryWaypoint';
    return 'game';
  }

  private refreshCursor(): void {
    this.applyCursor(this.inferCursorKind());
  }

  /** Per-frame poll. Right now it only runs the selection-change
   *  tracker (which resets waypoint mode on change), but any other
   *  "once-per-frame" input bookkeeping should live here so the
   *  scene has one call site. Mirrors InputManager.update() on 2D. */
  tick(): void {
    const changed = this.selectionChangeTracker.poll(
      this.entitySource,
      this.context.activePlayerId,
    );
    if (changed) this.setWaypointMode('move');
    if (this.mode.isInBuildMode && !this.hasSelectedBuilder()) {
      this.mode.exitBuildMode();
    }
    if (this.repairAreaMode && !this.hasSelectedCommander()) {
      this.exitRepairAreaMode();
    }
    if (this.attackMode && this.entitySource.getSelectedUnits().length === 0) {
      this.exitAttackMode();
    }
    if (this.attackAreaMode && this.entitySource.getSelectedUnits().length === 0) {
      this.exitAttackAreaMode();
    }
    if (this.attackGroundMode && this.entitySource.getSelectedUnits().length === 0) {
      this.exitAttackGroundMode();
    }
    if (this.guardMode && this.entitySource.getSelectedUnits().length === 0) {
      this.exitGuardMode();
    }
    if (this.reclaimMode && !this.hasSelectedCommander()) {
      this.exitReclaimMode();
    }
    if (this.towerTargetMode && !this.hasSelectedTargetableCombatEntities()) {
      this.exitTowerTargetMode();
    }
    this.refreshCursor();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    this.updateHeldSelectBoxModifier(e, true);
    this.keyboard.handleKeyDown(e);
  }

  private handleKeyUp(e: KeyboardEvent): void {
    this.updateHeldSelectBoxModifier(e, false);
  }

  private updateHeldSelectBoxModifier(e: KeyboardEvent, held: boolean): void {
    if (isTextEntryTarget(e.target)) return;
    if (e.code === 'KeyZ') {
      this.selectBoxSameTypeHeld = held;
    } else if (e.code === 'Space') {
      this.selectBoxIdleHeld = held;
      e.preventDefault();
    }
  }

  private clearHeldSelectBoxModifiers(): void {
    this.selectBoxSameTypeHeld = false;
    this.selectBoxIdleHeld = false;
  }

  private resolveSelectionModifiers(e: MouseEvent): {
    additive: boolean;
    subtractive: boolean;
    options: ScreenRectSelectionOptions;
  } {
    const subtractive = e.ctrlKey || e.metaKey;
    return {
      additive: e.shiftKey && !subtractive,
      subtractive,
      options: {
        includeBuildingsWithUnits: e.shiftKey,
        mobileOnly: e.altKey,
        idleOnly: this.selectBoxIdleHeld,
        sameTypeOnly: this.selectBoxSameTypeHeld,
        previousSelection: this.getCurrentSelectedEntities(),
      },
    };
  }

  /** Fire a one-shot scan sweep at the last-known hover position
   *  (FOW-14). Reads the last-known hover client point, raycasts to the ground, then
   *  enqueues a 'scan' command — the authoritative side spawns a
   *  short-lived vision pulse there. No mode toggle: press once, the
   *  sweep happens, no further state to manage. */
  private enqueueScanAtCursor(): void {
    if (!this.hoverState.hasFiniteClientPoint()) return;
    const world = this.picker.raycastGround(this.hoverState.lastClientX, this.hoverState.lastClientY);
    if (!world) return;
    this.localCommandQueue.enqueue({
      type: 'scan',
      tick: this.context.getTick(),
      targetX: world.x,
      targetY: world.y,
    });
  }

  private selectActiveCommander(additive: boolean): void {
    const commander = this.entitySource
      .getUnitsByPlayer(this.context.activePlayerId)
      .find(isCommander);
    if (!commander) return;
    this.enqueueSelection([commander.id], additive);
  }

  private enqueueSelection(entityIds: EntityId[], additive: boolean): void {
    if (entityIds.length === 0) return;
    this.rememberPreviousSelection(entityIds, additive);
    this.localCommandQueue.enqueue({
      type: 'select',
      tick: this.context.getTick(),
      entityIds,
      additive,
    });
  }

  private enqueueClearSelection(): void {
    this.rememberPreviousSelection([], false);
    this.localCommandQueue.enqueue({
      type: 'clearSelection',
      tick: this.context.getTick(),
    });
  }

  private deselectEntityIds(entityIds: readonly EntityId[]): void {
    if (entityIds.length === 0) return;
    const idsToRemove = new Set(entityIds);
    const currentIds = this.getCurrentSelectedEntityIds();
    const remainingIds: EntityId[] = [];
    for (let i = 0; i < currentIds.length; i++) {
      const id = currentIds[i];
      if (!idsToRemove.has(id)) remainingIds.push(id);
    }
    if (remainingIds.length === currentIds.length) return;
    if (remainingIds.length === 0) {
      this.enqueueClearSelection();
      return;
    }
    this.enqueueSelection(remainingIds, false);
  }

  private rememberPreviousSelection(nextEntityIds: readonly EntityId[], additive: boolean): void {
    const currentIds = this.getCurrentSelectedEntityIds();
    if (currentIds.length === 0) return;
    if (!additive && sameEntityIdSet(currentIds, nextEntityIds)) return;
    this.previousSelectionIds = currentIds;
  }

  private getCurrentSelectedEntityIds(): EntityId[] {
    const entityIds: EntityId[] = [];
    const selectedUnits = this.entitySource.getSelectedUnits();
    for (let i = 0; i < selectedUnits.length; i++) {
      if (this.isSelectableByActivePlayer(selectedUnits[i])) entityIds.push(selectedUnits[i].id);
    }
    const selectedStatic = this.entitySource.getSelectedBuildings();
    for (let i = 0; i < selectedStatic.length; i++) {
      if (this.isSelectableByActivePlayer(selectedStatic[i])) entityIds.push(selectedStatic[i].id);
    }
    return entityIds;
  }

  private getCurrentSelectedEntities(): Entity[] {
    const entities: Entity[] = [];
    const selectedUnits = this.entitySource.getSelectedUnits();
    for (let i = 0; i < selectedUnits.length; i++) {
      if (this.isSelectableByActivePlayer(selectedUnits[i])) entities.push(selectedUnits[i]);
    }
    const selectedStatic = this.entitySource.getSelectedBuildings();
    for (let i = 0; i < selectedStatic.length; i++) {
      if (this.isSelectableByActivePlayer(selectedStatic[i])) entities.push(selectedStatic[i]);
    }
    return entities;
  }

  private getLiveEntityIds(entityIds: readonly EntityId[]): EntityId[] {
    const out: EntityId[] = [];
    const seen = new Set<EntityId>();
    for (let i = 0; i < entityIds.length; i++) {
      const id = entityIds[i];
      if (seen.has(id)) continue;
      seen.add(id);
      const entity = this.entitySource.getEntity(id);
      if (entity && this.isSelectableByActivePlayer(entity)) out.push(id);
    }
    return out;
  }

  setEntitySource(source: EntitySource): void {
    this.entitySource = source;
    this.previousSelectionIds = [];
    this.loopSelectionIds = [];
    this.loopSelectionCursor = -1;
    this.controlGroups.setSource(source);
    this.selectedCommands.setSource(source);
  }

  private clearHoveredEntities(): void {
    this.hoverState.clearTargets();
  }

  private updateHoveredEntity(clientX: number, clientY: number): void {
    this.hoverState.update(
      clientX,
      clientY,
      (targetX, targetY) => {
        const world = this.picker.raycastGround(targetX, targetY);
        return world
          ? resolveInput3DHoverTargets(
            this.entitySource,
            this.context.activePlayerId,
            world.x,
            world.y,
            SELECTABLE_GROUND_MIN_UNIT_RADIUS,
          )
          : { hovered: null, selectable: null };
      },
    );
  }

  private handleMouseDown(e: MouseEvent): void {
    // Button 0 = left (select / mode-click), Button 2 = right
    // (command / cancel), Button 1 (middle) is handled by OrbitCamera.
    if (this.modeClicks.handleMouseDown(e)) return;

    if (e.button === 0) {
      e.preventDefault();
      this.selectionDrag.begin(e.clientX, e.clientY);
      this.applyCursor('select');
    } else if (e.button === 2) {
      e.preventDefault();
      this.rightDrag.handleMouseDown(e);
    }
  }

  private handleMouseMove(e: MouseEvent): void {
    if (
      this.leftDown ||
      this.rightDrag.active ||
      this.modeClicks.active
    ) {
      this.clearHoveredEntities();
    } else if (!this.hoverState.hasClientPoint(e.clientX, e.clientY)) {
      this.updateHoveredEntity(e.clientX, e.clientY);
    }

    if (this.modeClicks.handleMouseMove(e)) return;

    if (this.leftDown) {
      this.applyCursor('select');
      this.selectionDrag.update(e.clientX, e.clientY, CLICK_DRAG_THRESHOLD_PX, this.picker.canvasRect());
      return;
    }

    if (this.rightDrag.active) {
      this.rightDrag.handleMouseMove(e);
      return;
    }

    this.refreshCursor();
  }

  private handleMouseUp(e: MouseEvent): void {
    if (e.button === 2 && this.rightDrag.active) {
      this.rightDrag.handleMouseUp(e);
      return;
    }
    if (e.button !== 0 || !this.leftDown) return;
    const isClick = this.selectionDrag.isClick(e.clientX, e.clientY, CLICK_DRAG_THRESHOLD_PX);
    const { additive, subtractive, options } = this.resolveSelectionModifiers(e);
    this.selectionDrag.finish();

    if (isClick) {
      // Try exact mesh pick first (cleaner for overlapping units than the
      // distance-based closest-entity fallback).
      const hit = this.picker.raycastEntity(e.clientX, e.clientY);
      if (hit !== null) {
        const ent = this.entitySource.getEntity(hit) ?? null;
        if (
          ent !== null &&
          this.isSelectableByActivePlayer(ent) &&
          entityMatchesScreenRectSelectionOptions(ent, options)
        ) {
          if (subtractive) this.deselectEntityIds([hit]);
          else this.enqueueSelection([hit], additive);
          this.refreshCursor();
          return;
        }
      }
      // Fallback: closest-entity-to-ground-click (e.g., user clicked near
      // a unit but missed the mesh). Matches 2D behavior.
      const world = this.picker.raycastGround(e.clientX, e.clientY);
      if (world) {
        const closest = findClosestSelectableEntityToPoint(
          this.entitySource,
          world.x,
          world.y,
          {
            playerId: this.context.activePlayerId,
            minUnitRadius: SELECTABLE_GROUND_MIN_UNIT_RADIUS,
          },
        );
        if (closest) {
          const ent = this.entitySource.getEntity(closest.id) ?? null;
          if (
            ent !== null &&
            this.isSelectableByActivePlayer(ent) &&
            entityMatchesScreenRectSelectionOptions(ent, options)
          ) {
            if (subtractive) this.deselectEntityIds([closest.id]);
            else this.enqueueSelection([closest.id], additive);
            this.refreshCursor();
            return;
          }
        }
      }
      if (!additive && !subtractive) {
        this.enqueueClearSelection();
      }
      this.refreshCursor();
      return;
    }

    // Drag: screen-space rectangle. Project each candidate entity's world
    // position to screen space and test against the rect. This matches what
    // the user *sees* (even though the corresponding ground-plane region
    // is a trapezoid under a tilted camera).
    const ids = this.picker.selectEntitiesInScreenRect(
      this.entitySource,
      this.context.activePlayerId,
      this.selectionDrag.start,
      this.selectionDrag.end,
      options,
    );
    if (ids.length > 0) {
      if (subtractive) this.deselectEntityIds(ids);
      else this.enqueueSelection(ids, additive);
    } else if (!additive && !subtractive) this.enqueueClearSelection();
    this.refreshCursor();
  }

  /** State shape consumed by the 3D line-drag overlay. Populated
   *  while the user is actively right-dragging; reset when the drag
   *  ends. Points/targets come from the shared accumulator and carry
   *  the click-altitude `z` so the preview lays on the rendered
   *  ground instead of a fixed-height plane. */
  getLineDragState(): Input3DLineDragState {
    return this.rightDrag.getLineDragState();
  }

  destroy(): void {
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onWindowBlur);
    this.canvas.style.cursor = '';
    this.onWaypointModeChange = undefined;
    this.onControlGroupFocus = undefined;
    this.onBuildModeChange = undefined;
    this.onDGunModeChange = undefined;
    this.onRepairAreaModeChange = undefined;
    this.onAttackAreaModeChange = undefined;
    this.onAttackGroundModeChange = undefined;
    this.onGuardModeChange = undefined;
    this.onReclaimModeChange = undefined;
    this.onPingModeChange = undefined;
    this.selectionDrag.destroy();
  }
}

function sameEntityIdSet(a: readonly EntityId[], b: readonly EntityId[]): boolean {
  if (a.length !== b.length) return false;
  const ids = new Set<EntityId>(a);
  for (let i = 0; i < b.length; i++) {
    if (!ids.has(b[i])) return false;
  }
  return true;
}
