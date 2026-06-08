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
import type { CursorGround, SimGroundPoint } from './CursorGround';
import type { CommandQueue } from '../sim/commands';
import type { InputContext } from '@/types/input';
import type { TerrainBuildabilityGrid } from '@/types/terrain';
import type { PlayerId, Entity, EntityId, WaypointType, BuildingBlueprintId } from '../sim/types';
import {
  findClosestSelectableEntityToPoint,
  SelectionChangeTracker,
  LinePathAccumulator,
  buildAttackAreaCommand,
  buildAttackCommandForTarget,
  buildAttackCommandAt,
  buildAttackGroundCommand,
  buildRepairAreaCommand,
  buildGuardCommandAt,
  buildGuardCommandForTarget,
  buildReclaimCommandAt,
  buildReclaimCommandForTarget,
  buildLinePathMoveCommand,
  buildRepairCommandAt,
  buildFactoryRallyCommands,
  CommanderModeController,
  InputControlGroups,
  InputSelectedCommands,
} from '../input/helpers';
import { CLICK_DRAG_THRESHOLD_PX } from '../input/constants';
import { getCommandCursorStyle, type CommandCursorKind } from '../input/CommandCursors';
import { isWaterAt } from '../sim/Terrain';
import { isBuildInProgress } from '../sim/buildableHelpers';
import { isCommander } from '../sim/combat/combatUtils';
import { GAME_DIAGNOSTICS, debugLog } from '../diagnostics';
import { Input3DSpecialModes, type Input3DSpecialMode } from './Input3DSpecialModes';
import { Input3DBuildPlacementState } from './Input3DBuildPlacementState';
import { Input3DHoverState, resolveInput3DHoverTargets } from './Input3DHoverState';
import { Input3DSelectionDragState } from './Input3DSelectionDragState';
import { Input3DKeyboardController } from './Input3DKeyboardController';
import { Input3DPicker } from './Input3DPicker';

const SELECTABLE_GROUND_MIN_UNIT_RADIUS = 8;
const REPAIR_AREA_RADIUS = 220;
const ATTACK_AREA_RADIUS = 300;

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

  // Shared build / commander-special state machine. The 2D
  // BuildingPlacementController owns one of these too so the two
  // renderers can't drift on mode entry/exit semantics. Click
  // dispatch while a mode is active is handled below in
  // handleLeftMouseDown.
  private mode = new CommanderModeController();
  public onBuildModeChange?: (buildingBlueprintId: BuildingBlueprintId | null) => void;
  public onDGunModeChange?: (active: boolean) => void;
  public onRepairAreaModeChange?: (active: boolean) => void;
  public onAttackAreaModeChange?: (active: boolean) => void;
  public onAttackGroundModeChange?: (active: boolean) => void;
  public onGuardModeChange?: (active: boolean) => void;
  public onReclaimModeChange?: (active: boolean) => void;
  public onPingModeChange?: (active: boolean) => void;
  public onTowerTargetModeChange?: (active: boolean) => void;
  private specialModes: Input3DSpecialModes;
  private hoverState = new Input3DHoverState();
  private buildPlacement = new Input3DBuildPlacementState();
  private appliedCursor: CommandCursorKind = 'default';

  // Optional preview renderer driven on mouse-move-in-build-mode;
  // scene injects one via setBuildGhost. Stays null in the demo /
  // headless case, where no in-world preview is shown.
  private buildGhost: BuildGhost3D | null = null;

  // Drag state (screen coords only — box select is screen-space)
  private selectionDrag: Input3DSelectionDragState;

  // Right-drag line-path state. The accumulator owns the points +
  // per-unit target list; both 2D and 3D share the same append /
  // recompute logic via LinePathAccumulator.
  private rightDown = false;
  private linePath = new LinePathAccumulator();

  /** Shared cursor/entity picker. Single canonical source of truth
   *  for every command point in this manager, with entity raycasts
   *  and screen-rectangle selection kept out of command dispatch. */
  private picker: Input3DPicker;
  private _selectedFactoriesScratch: Entity[] = [];
  // Resets waypoint mode back to 'move' when the owned-selected set
  // changes — matches the 2D SelectionController's rule so squads
  // don't accidentally inherit 'fight'/'patrol' from a prior group.
  private selectionChangeTracker = new SelectionChangeTracker();
  private controlGroups: InputControlGroups;
  private selectedCommands: InputSelectedCommands;
  private keyboard: Input3DKeyboardController;

  // DOM handlers bound once for add/remove
  private onMouseDown: (e: MouseEvent) => void;
  private onMouseMove: (e: MouseEvent) => void;
  private onMouseUp: (e: MouseEvent) => void;
  private onKeyDown: (e: KeyboardEvent) => void;

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
      (entityIds, additive) => {
        this.localCommandQueue.enqueue({
          type: 'select',
          tick: this.context.getTick(),
          entityIds,
          additive,
        });
      },
    );
    this.controlGroups.onChange = (groups) => this.onControlGroupsChange?.(groups);
    this.selectedCommands = new InputSelectedCommands(
      entitySource,
      localCommandQueue,
      () => this.context.getTick(),
    );
    this.keyboard = new Input3DKeyboardController({
      mode: this.mode,
      commandQueue: this.localCommandQueue,
      getTick: () => this.context.getTick(),
      setWaypointMode: (mode) => this.setWaypointMode(mode),
      storeControlGroupSlot: (index) => this.storeControlGroupSlot(index),
      recallControlGroupSlot: (index, additive) => this.recallControlGroupSlot(index, additive),
      hasSelectedBuilder: () => this.hasSelectedBuilder(),
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
      toggleAttackAreaMode: () => this.toggleAttackAreaMode(),
      toggleAttackGroundMode: () => this.toggleAttackGroundMode(),
      toggleGuardMode: () => this.toggleGuardMode(),
      toggleReclaimMode: () => this.toggleReclaimMode(),
      toggleRepairAreaMode: () => this.toggleRepairAreaMode(),
      togglePingMode: () => this.togglePingMode(),
      toggleDGunMode: () => this.toggleDGunMode(),
      enqueueScanAtCursor: () => this.enqueueScanAtCursor(),
      selectActiveCommander: (additive) => this.selectActiveCommander(additive),
      isRepairAreaMode: () => this.repairAreaMode,
      isAttackAreaMode: () => this.attackAreaMode,
      isAttackGroundMode: () => this.attackGroundMode,
      isGuardMode: () => this.guardMode,
      isReclaimMode: () => this.reclaimMode,
      isPingMode: () => this.pingMode,
      isTowerTargetMode: () => this.towerTargetMode,
      exitRepairAreaMode: () => this.exitRepairAreaMode(),
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

    this.canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('keydown', this.onKeyDown);

    // Forward shared mode events to the scene's UI callbacks; also
    // hide the build ghost whenever build mode exits.
    this.mode.onBuildModeChange = (buildingBlueprintId) => {
      this.buildPlacement.reset();
      if (buildingBlueprintId === null) {
        this.buildGhost?.hide();
      }
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
    this.buildGhost = ghost;
    if (!ghost) return;
    // If the user is already in build mode (e.g. after a scene
    // restart), nothing will show until they move the cursor. That's
    // acceptable — mirrors the 2D ghost's "drawn from state, updated
    // each move" lifecycle.
  }

  /** Scene hook — feeds the client-side placement validator so the
   *  build ghost turns red at the map edge or when overlapping an
   *  existing building. */
  setMapBounds(
    width: number,
    height: number,
    playerCount: number,
  ): void {
    this.buildPlacement.setMapBounds(width, height, playerCount);
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
    this.localCommandQueue.enqueue({
      type: 'select',
      tick: this.context.getTick(),
      entityIds,
      additive: false,
    });
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

  recallControlGroupSlot(index: number, additive: boolean): boolean {
    return this.controlGroups.recallSlot(index, additive);
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
    if (this.getSelectedTowers().length === 0) return;
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

  private getSelectedTowers(): Entity[] {
    return this.selectedCommands.selectedTowers();
  }

  private handleTowerTargetClick(e: MouseEvent): void {
    const entityHitId = this.picker.raycastEntity(e.clientX, e.clientY);
    if (entityHitId === null) return;
    // Lock-on selection: anything with an ID is a candidate (per
    // design_philosophy.html). The turret's exclusion mask decides
    // whether the lock is honored — JS just routes the click.
    this.selectedCommands.setTowerTarget(entityHitId);
    if (!e.shiftKey) this.exitTowerTargetMode();
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
    if (this.mode.isInBuildMode) {
      return this.buildPlacement.diagnostics
        ? (this.buildPlacement.diagnostics.canPlace ? 'build' : 'blocked')
        : 'build';
    }
    if (this.mode.isInDGunMode) return 'dgun';
    if (this.repairAreaMode) return 'repair';
    if (this.attackAreaMode) return 'attack';
    if (this.attackGroundMode) return 'attack';
    if (this.guardMode) return 'guard';
    if (this.reclaimMode) return 'reclaim';
    if (this.pingMode) return 'ping';
    if (this.towerTargetMode) return 'attack';
    if (this.leftDown) return 'select';
    if (this.rightDown) return this.waypointCursorKind();

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
    if (this.getSelectedFactories().length > 0) return 'factoryWaypoint';
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
    if (this.towerTargetMode && this.getSelectedTowers().length === 0) {
      this.exitTowerTargetMode();
    }
    this.refreshCursor();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    this.keyboard.handleKeyDown(e);
  }

  private enqueuePingCommand(world: SimGroundPoint): void {
    this.localCommandQueue.enqueue({
      type: 'ping',
      tick: this.context.getTick(),
      targetX: world.x,
      targetY: world.y,
      targetZ: world.z,
    });
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
    this.localCommandQueue.enqueue({
      type: 'select',
      tick: this.context.getTick(),
      entityIds: [commander.id],
      additive,
    });
  }

  setEntitySource(source: EntitySource): void {
    this.entitySource = source;
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
    //
    // While a commander mode is active, left-click commits that
    // mode's action (place building / fire D-gun / area repair / area attack / attack-ground / guard / reclaim / ping) and right-click
    // cancels the mode — mirrors the 2D BuildingPlacementController.
    if (
      this.mode.isInBuildMode ||
      this.mode.isInDGunMode ||
      this.repairAreaMode ||
      this.attackAreaMode ||
      this.attackGroundMode ||
      this.guardMode ||
      this.reclaimMode ||
      this.pingMode ||
      this.towerTargetMode
    ) {
      e.preventDefault();
      if (e.button === 0) {
        if (this.mode.isInBuildMode) this.handleBuildClick(e);
        else if (this.mode.isInDGunMode) this.handleDGunClick(e);
        else if (this.repairAreaMode) this.handleRepairAreaClick(e);
        else if (this.attackAreaMode) this.handleAttackAreaClick(e);
        else if (this.attackGroundMode) this.handleAttackGroundClick(e);
        else if (this.guardMode) this.handleGuardClick(e);
        else if (this.reclaimMode) this.handleReclaimClick(e);
        else if (this.towerTargetMode) this.handleTowerTargetClick(e);
        else this.handlePingClick(e);
      } else if (e.button === 2) {
        if (this.mode.isInBuildMode) this.mode.exitBuildMode();
        else if (this.mode.isInDGunMode) this.mode.exitDGunMode();
        else if (this.repairAreaMode) this.exitRepairAreaMode();
        else if (this.attackAreaMode) this.exitAttackAreaMode();
        else if (this.attackGroundMode) this.exitAttackGroundMode();
        else if (this.guardMode) this.exitGuardMode();
        else if (this.reclaimMode) this.exitReclaimMode();
        else if (this.towerTargetMode) this.exitTowerTargetMode();
        else this.exitPingMode();
      }
      return;
    }

    if (e.button === 0) {
      e.preventDefault();
      this.selectionDrag.begin(e.clientX, e.clientY);
      this.applyCursor('select');
    } else if (e.button === 2) {
      e.preventDefault();
      this.handleRightMouseDown(e);
    }
  }

  /** Fire a startBuild command for the selected builder at the
   *  snapped grid position under the cursor. Stays in build mode if
   *  shift is held (lets the user place multiple of the same buildingBlueprintId). */
  private handleBuildClick(e: MouseEvent): void {
    const builder = this.getSelectedBuilder();
    if (!builder) {
      // Builder got deselected mid-placement — drop build mode.
      this.mode.exitBuildMode();
      return;
    }
    const world = this.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    const buildingBlueprintId = this.mode.buildingBlueprintId;
    if (buildingBlueprintId === null) return;
    const diagnostics = this.validateBuildPlacement(buildingBlueprintId, world.x, world.y);
    this.applyCursor(diagnostics.canPlace ? 'build' : 'blocked');
    if (this.buildGhost) {
      this.buildGhost.setTarget(
        buildingBlueprintId, world.x, world.y,
        builder,
        diagnostics.canPlace,
        diagnostics,
      );
    }
    if (!diagnostics.canPlace) {
      debugLog(GAME_DIAGNOSTICS.commandPlans, 'Blocked invalid build placement', {
        buildingBlueprintId,
        reason: diagnostics.failureReason,
        metalFraction: diagnostics.metalFraction,
      });
      return;
    }
    const cmd = this.mode.buildStartBuildCommand(
      builder, world.x, world.y,
      this.context.getTick(), e.shiftKey,
    );
    if (!cmd) return;
    this.localCommandQueue.enqueue(cmd);

    // Shift = keep placing same building blueprint; no-shift = exit build mode.
    if (!e.shiftKey) this.mode.exitBuildMode();
  }

  private validateBuildPlacement(
    buildingBlueprintId: BuildingBlueprintId,
    worldX: number,
    worldY: number,
  ) {
    return this.buildPlacement.validate(buildingBlueprintId, worldX, worldY, this.entitySource);
  }

  /** Fire the D-gun at the clicked ground point. Stays in D-gun
   *  mode for rapid firing — the user exits with the D key, ESC,
   *  right-click, or the UI button. */
  private handleDGunClick(e: MouseEvent): void {
    const commander = this.getSelectedCommander();
    if (!commander) {
      this.mode.exitDGunMode();
      return;
    }
    const world = this.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    const cmd = this.mode.buildFireDGunCommand(
      commander, world.x, world.y, this.context.getTick(), world.z,
    );
    this.localCommandQueue.enqueue(cmd);
  }

  private handleRepairAreaClick(e: MouseEvent): void {
    const commander = this.getSelectedCommander();
    if (!commander) {
      this.exitRepairAreaMode();
      return;
    }
    const world = this.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    const cmd = buildRepairAreaCommand(
      commander,
      world.x,
      world.y,
      REPAIR_AREA_RADIUS,
      this.context.getTick(),
      e.shiftKey,
      world.z,
    );
    if (!cmd) return;
    this.localCommandQueue.enqueue(cmd);
    this.applyCursor('repair');
    if (!e.shiftKey) this.exitRepairAreaMode();
  }

  private handleAttackAreaClick(e: MouseEvent): void {
    const selectedUnits = this.entitySource.getSelectedUnits();
    if (selectedUnits.length === 0) {
      this.exitAttackAreaMode();
      return;
    }
    const world = this.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    const cmd = buildAttackAreaCommand(
      selectedUnits,
      world.x,
      world.y,
      ATTACK_AREA_RADIUS,
      this.context.getTick(),
      e.shiftKey,
      world.z,
    );
    if (!cmd) return;
    this.localCommandQueue.enqueue(cmd);
    this.applyCursor('attack');
    if (!e.shiftKey) this.exitAttackAreaMode();
  }

  private handleAttackGroundClick(e: MouseEvent): void {
    const selectedUnits = this.entitySource.getSelectedUnits();
    if (selectedUnits.length === 0) {
      this.exitAttackGroundMode();
      return;
    }
    const world = this.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    const cmd = buildAttackGroundCommand(
      selectedUnits,
      world.x,
      world.y,
      this.context.getTick(),
      e.shiftKey,
      world.z,
    );
    if (!cmd) return;
    this.localCommandQueue.enqueue(cmd);
    this.applyCursor('attack');
    if (!e.shiftKey) this.exitAttackGroundMode();
  }

  private handlePingClick(e: MouseEvent): void {
    const world = this.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    this.enqueuePingCommand(world);
    this.applyCursor('ping');
    if (!e.shiftKey) this.exitPingMode();
  }

  private handleGuardClick(e: MouseEvent): void {
    const selectedUnits = this.entitySource.getSelectedUnits();
    if (selectedUnits.length === 0) {
      this.exitGuardMode();
      return;
    }
    const tick = this.context.getTick();
    const entityHitId = this.picker.raycastEntity(e.clientX, e.clientY);
    const entityHit = entityHitId !== null
      ? this.entitySource.getEntity(entityHitId)
      : null;

    const meshGuardCmd = buildGuardCommandForTarget(
      entityHit,
      selectedUnits,
      this.context.activePlayerId,
      tick,
      e.shiftKey,
    );
    if (meshGuardCmd) {
      this.localCommandQueue.enqueue(meshGuardCmd);
      this.applyCursor('guard');
      if (!e.shiftKey) this.exitGuardMode();
      return;
    }

    const world = this.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    const guardCmd = buildGuardCommandAt(
      this.entitySource,
      world.x,
      world.y,
      selectedUnits,
      this.context.activePlayerId,
      tick,
      e.shiftKey,
    );
    if (!guardCmd) return;
    this.localCommandQueue.enqueue(guardCmd);
    this.applyCursor('guard');
    if (!e.shiftKey) this.exitGuardMode();
  }

  private handleReclaimClick(e: MouseEvent): void {
    const commander = this.getSelectedCommander();
    if (!commander) {
      this.exitReclaimMode();
      return;
    }
    const tick = this.context.getTick();
    const entityHitId = this.picker.raycastEntity(e.clientX, e.clientY);
    const entityHit = entityHitId !== null
      ? this.entitySource.getEntity(entityHitId)
      : null;

    const meshReclaimCmd = buildReclaimCommandForTarget(
      entityHit,
      commander,
      tick,
      e.shiftKey,
    );
    if (meshReclaimCmd) {
      this.localCommandQueue.enqueue(meshReclaimCmd);
      this.applyCursor('reclaim');
      if (!e.shiftKey) this.exitReclaimMode();
      return;
    }

    const world = this.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    const reclaimCmd = buildReclaimCommandAt(
      this.entitySource,
      world.x,
      world.y,
      commander,
      tick,
      e.shiftKey,
    );
    if (!reclaimCmd) return;
    this.localCommandQueue.enqueue(reclaimCmd);
    this.applyCursor('reclaim');
    if (!e.shiftKey) this.exitReclaimMode();
  }

  private handleMouseMove(e: MouseEvent): void {
    if (
      this.leftDown ||
      this.rightDown ||
      this.mode.isInBuildMode ||
      this.mode.isInDGunMode ||
      this.repairAreaMode ||
      this.attackAreaMode ||
      this.attackGroundMode ||
      this.guardMode ||
      this.reclaimMode ||
      this.pingMode
    ) {
      this.clearHoveredEntities();
    } else if (!this.hoverState.hasClientPoint(e.clientX, e.clientY)) {
      this.updateHoveredEntity(e.clientX, e.clientY);
    }

    // Live build-ghost preview — only while in build mode. Cursor
    // feedback still works in headless/no-ghost cases.
    const buildingBlueprintId = this.mode.buildingBlueprintId;
    if (buildingBlueprintId !== null) {
      const world = this.picker.raycastGround(e.clientX, e.clientY);
      if (world) {
        const diagnostics = this.validateBuildPlacement(buildingBlueprintId, world.x, world.y);
        this.applyCursor(diagnostics.canPlace ? 'build' : 'blocked');
        if (this.buildGhost) {
          this.buildGhost.setTarget(
            buildingBlueprintId, world.x, world.y,
            this.getSelectedBuilder(),
            this.buildPlacement.canPlace,
            diagnostics,
          );
        }
      } else {
        this.buildPlacement.clearDiagnostics();
        this.applyCursor('blocked');
      }
      return;
    }

    if (this.attackAreaMode) {
      this.applyCursor('attack');
      return;
    }

    if (this.attackGroundMode) {
      this.applyCursor('attack');
      return;
    }

    if (this.guardMode) {
      this.applyCursor('guard');
      return;
    }

    if (this.reclaimMode) {
      this.applyCursor('reclaim');
      return;
    }

    if (this.pingMode) {
      this.applyCursor('ping');
      return;
    }

    if (this.repairAreaMode) {
      this.applyCursor('repair');
      return;
    }

    if (this.leftDown) {
      this.applyCursor('select');
      this.selectionDrag.update(e.clientX, e.clientY, CLICK_DRAG_THRESHOLD_PX, this.picker.canvasRect());
      return;
    }

    if (this.rightDown) {
      this.applyCursor(this.waypointCursorKind());
      // Record points along the right-drag path so units can spread
      // along a line. The accumulator drops near-duplicate samples
      // and recomputes per-unit targets on append; we also force a
      // recompute here so the preview stays live between appends.
      const world = this.picker.raycastGround(e.clientX, e.clientY);
      if (!world) return;
      const unitCount = this.entitySource.getSelectedUnits().length;
      this.linePath.append(world.x, world.y, unitCount, world.z);
      this.linePath.recomputeTargets(unitCount);
      return;
    }

    this.refreshCursor();
  }

  private handleMouseUp(e: MouseEvent): void {
    if (e.button === 2 && this.rightDown) {
      this.handleRightMouseUp(e);
      return;
    }
    if (e.button !== 0 || !this.leftDown) return;
    const isClick = this.selectionDrag.isClick(e.clientX, e.clientY, CLICK_DRAG_THRESHOLD_PX);
    const additive = e.shiftKey;
    this.selectionDrag.finish();

    if (isClick) {
      // Try exact mesh pick first (cleaner for overlapping units than the
      // distance-based closest-entity fallback).
      const hit = this.picker.raycastEntity(e.clientX, e.clientY);
      if (hit !== null) {
        const ent = this.entitySource.getEntity(hit) ?? null;
        if (this.isSelectableByActivePlayer(ent)) {
          this.localCommandQueue.enqueue({
            type: 'select',
            tick: this.context.getTick(),
            entityIds: [hit],
            additive,
          });
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
          this.localCommandQueue.enqueue({
            type: 'select',
            tick: this.context.getTick(),
            entityIds: [closest.id],
            additive,
          });
          this.refreshCursor();
          return;
        }
      }
      if (!additive) {
        this.localCommandQueue.enqueue({
          type: 'clearSelection',
          tick: this.context.getTick(),
        });
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
    );
    this.localCommandQueue.enqueue({
      type: 'select',
      tick: this.context.getTick(),
      entityIds: ids,
      additive,
    });
    this.refreshCursor();
  }

  private handleRightMouseDown(e: MouseEvent): void {
    // Right-click dispatcher, matching the 2D CommandController:
    //   1. selected commander + repair target under cursor → repair
    //   2. selected units + attack target under cursor → attack
    //   3. units selected → start line-path for group move
    //   4. no units, factories selected → start factory-waypoint drag
    const selectedUnits = this.entitySource.getSelectedUnits();
    const tick = this.context.getTick();
    const entityHitId = this.picker.raycastEntity(e.clientX, e.clientY);
    const entityHit = entityHitId !== null
      ? this.entitySource.getEntity(entityHitId)
      : null;

    // Prefer exact 3D mesh hits for direct attack. Buildings are tall
    // meshes, so the terrain point under the cursor can land outside
    // their footprint even though the player clearly clicked the
    // building itself.
    const meshAttackCmd = buildAttackCommandForTarget(
      entityHit,
      selectedUnits,
      this.context.activePlayerId,
      tick,
      e.shiftKey,
    );
    if (meshAttackCmd) {
      debugLog(
        GAME_DIAGNOSTICS.commandPlans,
        '[click] attack-mesh: hit target #%d, %d unit(s)',
        meshAttackCmd.targetId, selectedUnits.length,
      );
      this.applyCursor('attack');
      this.localCommandQueue.enqueue(meshAttackCmd);
      return;
    }

    const world = this.picker.raycastGround(e.clientX, e.clientY);
    if (!world) return;

    const repairCmd = buildRepairCommandAt(
      this.entitySource,
      world.x, world.y,
      this.getSelectedCommander(),
      tick,
      e.shiftKey,
    );
    if (repairCmd) {
      debugLog(
        GAME_DIAGNOSTICS.commandPlans,
        '[click] repair: clicked at (%d, %d, %d) → target #%d',
        Math.round(world.x), Math.round(world.y), Math.round(world.z),
        repairCmd.targetId,
      );
      this.applyCursor('repair');
      this.localCommandQueue.enqueue(repairCmd);
      return;
    }

    if (selectedUnits.length > 0) {
      // Attack target under cursor → attack command (skips line-path drawing).
      const attackCmd = buildAttackCommandAt(
        this.entitySource,
        world.x, world.y,
        selectedUnits,
        this.context.activePlayerId,
        tick,
        e.shiftKey,
      );
      if (attackCmd) {
        debugLog(
          GAME_DIAGNOSTICS.commandPlans,
          '[click] attack: clicked at (%d, %d, %d) → target #%d, %d unit(s)',
          Math.round(world.x), Math.round(world.y), Math.round(world.z),
          attackCmd.targetId, selectedUnits.length,
        );
        this.applyCursor('attack');
        this.localCommandQueue.enqueue(attackCmd);
        return;
      }
      // Start drawing a line path of waypoints. The single-click case
      // (mouse goes up before any drag motion) finalises this as a
      // group-move to the click point — so log the click here so we
      // see both endpoints of any drag the user does.
      debugLog(
        GAME_DIAGNOSTICS.commandPlans,
        '[click] move-start: clicked at (%d, %d, %d), %d unit(s) selected',
        Math.round(world.x), Math.round(world.y), Math.round(world.z),
        selectedUnits.length,
      );
      this.rightDown = true;
      this.applyCursor(this.waypointCursorKind());
      this.linePath.start(world.x, world.y, selectedUnits.length, world.z);
      return;
    }

    // No units — fall through to factory waypoint mode if the user
    // has a factory selected. The single placed point IS the target
    // (no distribution), so seed the accumulator with a fixed target.
    const factories = this.getSelectedFactories();
    if (factories.length > 0) {
      debugLog(
        GAME_DIAGNOSTICS.commandPlans,
        '[click] factory-waypoint-start: clicked at (%d, %d, %d), %d factory(s) selected',
        Math.round(world.x), Math.round(world.y), Math.round(world.z),
        factories.length,
      );
      this.rightDown = true;
      this.applyCursor('factoryWaypoint');
      this.linePath.startWithFixedTarget(world.x, world.y, world.z);
    }
  }

  private getSelectedFactories(): Entity[] {
    const out = this._selectedFactoriesScratch;
    out.length = 0;
    const selectedBuildings = this.entitySource.getSelectedBuildings();
    for (let i = 0; i < selectedBuildings.length; i++) {
      const b = selectedBuildings[i];
      if (
        b.factory !== null &&
        b.ownership?.playerId === this.context.activePlayerId
      ) {
        out.push(b);
      }
    }
    return out;
  }

  /** State shape consumed by the 3D line-drag overlay. Populated
   *  while the user is actively right-dragging; reset when the drag
   *  ends. Points/targets come from the shared accumulator and carry
   *  the click-altitude `z` so the preview lays on the rendered
   *  ground instead of a fixed-height plane. */
  getLineDragState(): {
    active: boolean;
    points: ReadonlyArray<{ x: number; y: number; z?: number }>;
    targets: ReadonlyArray<{ x: number; y: number; z?: number }>;
    mode: WaypointType;
  } {
    return {
      active: this.rightDown,
      points: this.linePath.points,
      targets: this.linePath.targets,
      mode: this.waypointMode,
    };
  }

  private handleRightMouseUp(e: MouseEvent): void {
    this.rightDown = false;
    const selectedUnits = this.entitySource.getSelectedUnits();
    const points = this.linePath.points;
    const shiftHeld = e.shiftKey;
    const tick = this.context.getTick();

    if (selectedUnits.length > 0 && points.length > 0) {
      const finalPoint = points[points.length - 1];
      // Commander ending the path on a repairable target → repair.
      const repairCmd = buildRepairCommandAt(
        this.entitySource,
        finalPoint.x, finalPoint.y,
        this.getSelectedCommander(),
        tick, shiftHeld,
      );
      if (repairCmd) {
        debugLog(
          GAME_DIAGNOSTICS.commandPlans,
          '[click] repair-on-release: released at (%d, %d, %d) → target #%d',
          Math.round(finalPoint.x), Math.round(finalPoint.y),
          finalPoint.z !== undefined ? Math.round(finalPoint.z) : -1,
          repairCmd.targetId,
        );
        this.localCommandQueue.enqueue(repairCmd);
        this.linePath.reset();
        this.refreshCursor();
        return;
      }
      const moveCmd = buildLinePathMoveCommand(
        this.linePath, selectedUnits, this.waypointMode, tick, shiftHeld,
      );
      if (moveCmd) {
        if (GAME_DIAGNOSTICS.commandPlans) {
          const mw = this.buildPlacement.width, mh = this.buildPlacement.height;
          const canSampleWet = isFinite(mw) && isFinite(mh);
          const finalWet = canSampleWet
            ? isWaterAt(finalPoint.x, finalPoint.y, mw, mh)
            : null;
          debugLog(
            true,
            '[click] move: released at (%d, %d, %d) wet=%s, %d unit(s), %d drag sample(s), waypointType=%s',
            Math.round(finalPoint.x), Math.round(finalPoint.y),
            finalPoint.z !== undefined ? Math.round(finalPoint.z) : -1,
            finalWet,
            selectedUnits.length, points.length, moveCmd.waypointType,
          );
          // Each unit's CURRENT position + wet flag, so we can replay the
          // exact pathfinder query offline.
          for (let i = 0; i < selectedUnits.length; i++) {
            const u = selectedUnits[i];
            const ux = u.transform.x;
            const uy = u.transform.y;
            const uz = u.transform.z;
            const uWet = canSampleWet ? isWaterAt(ux, uy, mw, mh) : null;
            const tgt = moveCmd.individualTargets?.[i];
            debugLog(
              true,
              '  [click]   unit #%d at (%d, %d, %d) wet=%s%s',
              u.id,
              Math.round(ux), Math.round(uy), Math.round(uz),
              uWet,
              tgt
                ? ` → (${Math.round(tgt.x)}, ${Math.round(tgt.y)}, ${tgt.z !== undefined ? Math.round(tgt.z) : -1})`
                : ` → (${Math.round(finalPoint.x)}, ${Math.round(finalPoint.y)}, ${finalPoint.z !== undefined ? Math.round(finalPoint.z) : -1})`,
            );
          }
        }
        this.localCommandQueue.enqueue(moveCmd);
      }
      this.linePath.reset();
      this.refreshCursor();
      return;
    }

    // No units: set a factory rally point if factories are selected.
    const factories = this.getSelectedFactories();
    if (factories.length > 0 && points.length > 0) {
      const finalPoint = points[points.length - 1];
      debugLog(
        GAME_DIAGNOSTICS.commandPlans,
        '[click] factory-waypoint: released at (%d, %d, %d), %d factory(s)',
        Math.round(finalPoint.x), Math.round(finalPoint.y),
        finalPoint.z !== undefined ? Math.round(finalPoint.z) : -1,
        factories.length,
      );
      const cmds = buildFactoryRallyCommands(
        factories, finalPoint.x, finalPoint.y,
        this.waypointMode, tick, finalPoint.z,
      );
      for (const cmd of cmds) this.localCommandQueue.enqueue(cmd);
    }
    this.linePath.reset();
    this.refreshCursor();
  }

  destroy(): void {
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('keydown', this.onKeyDown);
    this.canvas.style.cursor = '';
    this.onWaypointModeChange = undefined;
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
