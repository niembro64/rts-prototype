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

import * as THREE from 'three';
import type { ThreeApp } from './ThreeApp';
import type { BuildGhost3D } from './BuildGhost3D';
import type { CursorGround, SimGroundPoint } from './CursorGround';
import type { CommandQueue } from '../sim/commands';
import type { InputContext } from '@/types/input';
import type { TerrainBuildabilityGrid, TerrainShape } from '@/types/terrain';
import type { PlayerId, Entity, EntityId, WaypointType, BuildingType } from '../sim/types';
import {
  findClosestSelectableEntityToPoint,
  selectEntitiesInScreenRect,
  SelectionChangeTracker,
  LinePathAccumulator,
  buildAttackAreaCommand,
  buildAttackCommandForTarget,
  buildAttackCommandAt,
  buildRepairAreaCommand,
  buildGuardCommandAt,
  buildGuardCommandForTarget,
  buildLinePathMoveCommand,
  buildRepairCommandAt,
  buildFactoryWaypointCommands,
  handleEscape,
  CommanderModeController,
  getBuildModeBuildingTypeByIndex,
  getDefaultBuildModeBuildingType,
  type BuildPlacementDiagnostics,
  getBuildingPlacementDiagnostics,
  getOccupiedBuildingCells,
  getSnappedBuildPosition,
} from '../input/helpers';
import { CLICK_DRAG_THRESHOLD_PX } from '../input/constants';
import { getCommandCursorStyle, type CommandCursorKind } from '../input/CommandCursors';
import { isWaterAt } from '../sim/Terrain';
import { generateMetalDeposits, type MetalDeposit } from '../../metalDepositConfig';
import { getBuildingVisualCenterZ } from '../sim/buildingAnchors';
import { isCommander } from '../sim/combat/combatUtils';
import { GAME_DIAGNOSTICS, debugLog } from '../diagnostics';

const HOVER_RAYCAST_INTERVAL_MS = 50;
const SELECTABLE_GROUND_MIN_UNIT_RADIUS = 8;
const CONTROL_GROUP_COUNT = 9;
const REPAIR_AREA_RADIUS = 220;
const ATTACK_AREA_RADIUS = 300;

function controlGroupIndexForKey(e: KeyboardEvent): number {
  const codeMatch = /^Digit([1-9])$/.exec(e.code);
  if (codeMatch) return Number(codeMatch[1]) - 1;
  return /^[1-9]$/.test(e.key) ? Number(e.key) - 1 : -1;
}

/** Approximate world-space vertical center for box-select projection,
 *  picked per entity kind so the screen-projected point lands near
 *  the visible body. Keep these in rough lockstep with Render3DEntities
 *  chassis/turret heights — exact values don't matter, but "ground
 *  plane" (0) for a unit would project far below the visible sprite.
 *  Tune with the 3D renderer, not guess-and-commit. */
function selectionCenterY(entity: Entity): number {
  // Visual center in three.js Y. The entity's transform.z is its
  // current sim altitude (sphere center for units, vertical center
  // for buildings) — already terrain-aware, so for box selection
  // we just project at that altitude. Constants like the old
  // hand-tuned 8/14/3 assumed flat ground at z=0 and silently
  // missed any unit standing on a raised cube.
  return entity.building ? getBuildingVisualCenterZ(entity) : entity.transform.z;
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
  private threeApp: ThreeApp;
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

  // Shared commander-mode state machine (build + D-gun). The 2D
  // BuildingPlacementController owns one of these too so the two
  // renderers can't drift on mode entry/exit semantics. Click
  // dispatch while a mode is active is handled below in
  // handleLeftMouseDown.
  private mode = new CommanderModeController();
  public onBuildModeChange?: (type: BuildingType | null) => void;
  public onDGunModeChange?: (active: boolean) => void;
  public onRepairAreaModeChange?: (active: boolean) => void;
  public onAttackAreaModeChange?: (active: boolean) => void;
  public onGuardModeChange?: (active: boolean) => void;
  private repairAreaMode = false;
  private attackAreaMode = false;
  private guardMode = false;
  private hoveredEntityId: EntityId | null = null;
  private hoveredSelectableEntityId: EntityId | null = null;
  private lastHoverRaycastMs = 0;
  private lastHoverClientX = Number.NaN;
  private lastHoverClientY = Number.NaN;
  private buildGhostValidationKey = '';
  private buildGhostCanPlace = false;
  private buildGhostDiagnostics: BuildPlacementDiagnostics | undefined;
  private buildOccupancyVersion = '';
  private buildOccupiedCells: ReadonlySet<string> | undefined;
  private appliedCursor: CommandCursorKind = 'default';

  // Optional preview renderer driven on mouse-move-in-build-mode;
  // scene injects one via setBuildGhost. Stays null in the demo /
  // headless case, where no in-world preview is shown.
  private buildGhost: BuildGhost3D | null = null;

  // Map bounds feed the client-side placement validator (same pattern
  // as 2D BuildingPlacementController). Infinity until setMapBounds
  // is called, so an un-wired scene shows green ghosts everywhere.
  private mapWidth = Infinity;
  private mapHeight = Infinity;

  // Cached deposit list — derived deterministically from map size, so
  // the client can re-generate it locally without a network round-trip.
  // Used by the build ghost validator to highlight metal resource cells
  // and preview extractor coverage/yield.
  private metalDeposits: ReadonlyArray<MetalDeposit> = [];

  // Drag state (screen coords only — box select is screen-space)
  private leftDown = false;
  private dragStartScreen = { x: 0, y: 0 };
  private dragEndScreen = { x: 0, y: 0 };

  // Right-drag line-path state. The accumulator owns the points +
  // per-unit target list; both 2D and 3D share the same append /
  // recompute logic via LinePathAccumulator.
  private rightDown = false;
  private linePath = new LinePathAccumulator();

  // Visual selection rectangle overlay (CSS div over the canvas)
  private marquee: HTMLDivElement;

  /** Shared cursor → 3D ground picker. Single canonical source of
   *  truth for every command-point in this manager — passed in by
   *  the scene so the camera and the input manager hit the same
   *  rendered terrain mesh through the same raycaster. */
  private cursorGround: CursorGround;
  /** Local raycaster for ENTITY picking (not ground picking) — runs
   *  against the world group recursively to find unit / building
   *  meshes. The CursorGround service is exclusively for terrain
   *  hits; this raycaster handles "which entity did I click on?". */
  private raycaster = new THREE.Raycaster();
  // Reusable scratch vector for projecting entities in selectEntitiesInScreenRect.
  // One allocation for the lifetime of the manager keeps the hot loop alloc-free.
  private _selectV = new THREE.Vector3();
  private _ndc = new THREE.Vector2();
  private _selectedFactoriesScratch: Entity[] = [];
  // Resets waypoint mode back to 'move' when the owned-selected set
  // changes — matches the 2D SelectionController's rule so squads
  // don't accidentally inherit 'fight'/'patrol' from a prior group.
  private selectionChangeTracker = new SelectionChangeTracker();
  private controlGroups: EntityId[][] = Array.from({ length: CONTROL_GROUP_COUNT }, () => []);

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
    this.threeApp = threeApp;
    this.canvas = threeApp.renderer.domElement;
    this.context = context;
    this.entitySource = entitySource;
    this.localCommandQueue = localCommandQueue;
    this.cursorGround = cursorGround;

    // Selection marquee overlay
    this.marquee = document.createElement('div');
    Object.assign(this.marquee.style, {
      position: 'absolute',
      border: '1px solid #9fc8ff',
      background: 'rgba(120, 170, 255, 0.15)',
      pointerEvents: 'none',
      display: 'none',
      zIndex: '5',
    });
    const parent = this.canvas.parentElement;
    if (parent) {
      if (getComputedStyle(parent).position === 'static') {
        parent.style.position = 'relative';
      }
      parent.appendChild(this.marquee);
    }

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
    this.mode.onBuildModeChange = (type) => {
      this.buildGhostValidationKey = '';
      this.buildGhostCanPlace = false;
      this.buildGhostDiagnostics = undefined;
      if (type === null) {
        this.buildGhost?.hide();
      }
      this.refreshCursor();
      this.onBuildModeChange?.(type);
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
    terrainCenter: TerrainShape = 'valley',
  ): void {
    this.mapWidth = width;
    this.mapHeight = height;
    this.metalDeposits = generateMetalDeposits(width, height, playerCount, terrainCenter);
  }

  getHoveredEntity(): Entity | null {
    return this.hoveredEntityId !== null
      ? this.entitySource.getEntity(this.hoveredEntityId) ?? null
      : null;
  }

  setWaypointMode(mode: WaypointType): void {
    this.exitRepairAreaMode();
    this.exitAttackAreaMode();
    this.exitGuardMode();
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
    this.exitRepairAreaMode();
    this.exitAttackAreaMode();
    this.exitGuardMode();
    this.setWaypointMode('move');
    this.clearHoveredEntities();
    this.refreshCursor();
  }

  /** Enter build mode with a building type. Called from the UI
   *  (scene.startBuildMode forwards to here). Next left-click on the
   *  ground will issue a startBuild command for the selected
   *  commander. */
  setBuildMode(type: BuildingType): void {
    this.exitRepairAreaMode();
    this.exitAttackAreaMode();
    this.exitGuardMode();
    this.mode.enterBuildMode(type);
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
    this.exitRepairAreaMode();
    this.exitAttackAreaMode();
    this.exitGuardMode();
    this.mode.toggleDGunMode();
  }

  stopSelectedUnits(): void {
    this.enqueueStopCommand();
  }

  toggleSelectedJump(): void {
    this.enqueueSetJumpEnabledCommand();
  }

  toggleSelectedFire(): void {
    this.enqueueSetFireEnabledCommand();
  }

  toggleAttackAreaMode(): void {
    if (this.attackAreaMode) {
      this.exitAttackAreaMode();
      return;
    }
    if (this.entitySource.getSelectedUnits().length === 0) return;
    this.mode.exitBuildMode();
    this.mode.exitDGunMode();
    this.exitRepairAreaMode();
    this.exitGuardMode();
    this.attackAreaMode = true;
    this.refreshCursor();
    this.onAttackAreaModeChange?.(true);
  }

  toggleGuardMode(): void {
    if (this.guardMode) {
      this.exitGuardMode();
      return;
    }
    if (this.entitySource.getSelectedUnits().length === 0) return;
    this.mode.exitBuildMode();
    this.mode.exitDGunMode();
    this.exitRepairAreaMode();
    this.exitAttackAreaMode();
    this.guardMode = true;
    this.refreshCursor();
    this.onGuardModeChange?.(true);
  }

  toggleRepairAreaMode(): void {
    if (this.repairAreaMode) {
      this.exitRepairAreaMode();
      return;
    }
    if (!this.hasSelectedCommander()) return;
    this.mode.exitBuildMode();
    this.mode.exitDGunMode();
    this.exitAttackAreaMode();
    this.exitGuardMode();
    this.repairAreaMode = true;
    this.refreshCursor();
    this.onRepairAreaModeChange?.(true);
  }

  storeControlGroupSlot(index: number): void {
    if (index < 0 || index >= CONTROL_GROUP_COUNT) return;
    const ids = this.getSelectedGroupEntityIds();
    if (ids.length === 0) return;
    this.controlGroups[index] = ids;
    this.emitControlGroupsChange();
  }

  recallControlGroupSlot(index: number, additive: boolean): boolean {
    if (index < 0 || index >= CONTROL_GROUP_COUNT) return false;
    const group = this.controlGroups[index];
    if (group.length === 0) return false;

    const entityIds: EntityId[] = [];
    for (let i = 0; i < group.length; i++) {
      const entity = this.entitySource.getEntity(group[i]) ?? null;
      if (this.isSelectableByActivePlayer(entity)) entityIds.push(group[i]);
    }

    if (entityIds.length === 0) {
      group.length = 0;
      this.emitControlGroupsChange();
      return true;
    }

    if (entityIds.length !== group.length) {
      this.controlGroups[index] = entityIds.slice();
      this.emitControlGroupsChange();
    }
    this.localCommandQueue.enqueue({
      type: 'select',
      tick: this.context.getTick(),
      entityIds,
      additive,
    });
    return true;
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

  /** True while the next left-click will issue a guard command. */
  isInGuardMode(): boolean {
    return this.guardMode;
  }

  private exitRepairAreaMode(): void {
    if (!this.repairAreaMode) return;
    this.repairAreaMode = false;
    this.refreshCursor();
    this.onRepairAreaModeChange?.(false);
  }

  private exitAttackAreaMode(): void {
    if (!this.attackAreaMode) return;
    this.attackAreaMode = false;
    this.refreshCursor();
    this.onAttackAreaModeChange?.(false);
  }

  private exitGuardMode(): void {
    if (!this.guardMode) return;
    this.guardMode = false;
    this.refreshCursor();
    this.onGuardModeChange?.(false);
  }

  private hasSelectedCommander(): boolean {
    return this.entitySource.getSelectedUnits().some(isCommander);
  }

  private getSelectedCommander(): Entity | null {
    return (
      this.entitySource.getSelectedUnits().find(isCommander) ?? null
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
      return !!entity.buildable &&
        !entity.buildable.isComplete &&
        !entity.buildable.isGhost;
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
      return this.buildGhostDiagnostics
        ? (this.buildGhostDiagnostics.canPlace ? 'build' : 'blocked')
        : 'build';
    }
    if (this.mode.isInDGunMode) return 'dgun';
    if (this.repairAreaMode) return 'repair';
    if (this.attackAreaMode) return 'attack';
    if (this.guardMode) return 'guard';
    if (this.leftDown) return 'select';
    if (this.rightDown) return this.waypointCursorKind();

    const hovered = this.hoveredEntityId !== null
      ? this.entitySource.getEntity(this.hoveredEntityId) ?? null
      : null;
    if (this.isRepairableBySelectedCommander(hovered)) return 'repair';
    if (this.isAttackableBySelectedUnits(hovered)) return 'attack';
    const selectableHovered = this.hoveredSelectableEntityId !== null
      ? this.entitySource.getEntity(this.hoveredSelectableEntityId) ?? null
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
    if (this.repairAreaMode && !this.hasSelectedCommander()) {
      this.exitRepairAreaMode();
    }
    if (this.attackAreaMode && this.entitySource.getSelectedUnits().length === 0) {
      this.exitAttackAreaMode();
    }
    if (this.guardMode && this.entitySource.getSelectedUnits().length === 0) {
      this.exitGuardMode();
    }
    this.refreshCursor();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.repeat) return;
    // Don't hijack keys when the user is typing in a text input (lobby code, etc.).
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    if (
      tag === 'INPUT' || tag === 'TEXTAREA' ||
      (target && target.isContentEditable)
    ) return;

    const controlGroupIndex = controlGroupIndexForKey(e);
    if (controlGroupIndex >= 0) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.storeControlGroupSlot(controlGroupIndex);
        return;
      }
      if (this.recallControlGroupSlot(controlGroupIndex, e.shiftKey)) {
        e.preventDefault();
        return;
      }
    }

    // Mirror the command hotkeys one-for-one. M/F/H switch waypoint mode;
    // S stops selected units; J toggles jump permission; E toggles fire permission;
    // A toggles area attack; G toggles guard; R toggles area repair; B/number/D drive the commander mode state machine;
    // Escape runs the shared cancel-mode-or-clear-selection convention.
    const numericBuildHotkey = /^[1-9]$/.test(e.key) ? Number(e.key) - 1 : -1;
    if (numericBuildHotkey >= 0) {
      const buildingType = getBuildModeBuildingTypeByIndex(numericBuildHotkey);
      if (buildingType && (this.mode.isInBuildMode || this.hasSelectedCommander())) {
        this.exitRepairAreaMode();
        this.exitAttackAreaMode();
        this.exitGuardMode();
        this.mode.enterBuildMode(buildingType);
      }
      return;
    }

    switch (e.key.toLowerCase()) {
      case 'm': this.setWaypointMode('move'); break;
      case 'f': this.setWaypointMode('fight'); break;
      case 'h': this.setWaypointMode('patrol'); break;
      case 's':
        this.enqueueStopCommand();
        break;
      case 'j':
        this.enqueueSetJumpEnabledCommand();
        break;
      case 'e':
        this.enqueueSetFireEnabledCommand();
        break;
      case 'a':
        this.toggleAttackAreaMode();
        break;
      case 'g':
        this.toggleGuardMode();
        break;
      case 'r':
        this.toggleRepairAreaMode();
        break;
      case 'b':
        if (!this.hasSelectedCommander()) break;
        this.exitRepairAreaMode();
        this.exitAttackAreaMode();
        this.exitGuardMode();
        if (!this.mode.isInBuildMode) this.mode.enterBuildMode(getDefaultBuildModeBuildingType());
        else this.mode.cycleBuildingType();
        break;
      case 'd':
        this.toggleDGunMode();
        break;
      case 'escape':
        handleEscape(
          [
            { isActive: () => this.mode.isInBuildMode, cancel: () => this.mode.exitBuildMode() },
            { isActive: () => this.mode.isInDGunMode, cancel: () => this.mode.exitDGunMode() },
            { isActive: () => this.repairAreaMode, cancel: () => this.exitRepairAreaMode() },
            { isActive: () => this.attackAreaMode, cancel: () => this.exitAttackAreaMode() },
            { isActive: () => this.guardMode, cancel: () => this.exitGuardMode() },
          ],
          this.localCommandQueue,
          this.context.getTick(),
        );
        break;
    }
  }

  private getSelectedGroupEntityIds(): EntityId[] {
    const entityIds: EntityId[] = [];
    const selectedUnits = this.entitySource.getSelectedUnits();
    for (let i = 0; i < selectedUnits.length; i++) entityIds.push(selectedUnits[i].id);
    const selectedBuildings = this.entitySource.getSelectedBuildings();
    for (let i = 0; i < selectedBuildings.length; i++) entityIds.push(selectedBuildings[i].id);
    return entityIds;
  }

  private emitControlGroupsChange(): void {
    this.onControlGroupsChange?.(this.controlGroups.map((group) => group.slice()));
  }

  private enqueueStopCommand(): void {
    const selectedUnits = this.entitySource.getSelectedUnits();
    if (selectedUnits.length === 0) return;
    const entityIds: EntityId[] = [];
    for (let i = 0; i < selectedUnits.length; i++) entityIds.push(selectedUnits[i].id);
    this.localCommandQueue.enqueue({
      type: 'stop',
      tick: this.context.getTick(),
      entityIds,
    });
  }

  private enqueueSetJumpEnabledCommand(): void {
    const selectedUnits = this.entitySource.getSelectedUnits();
    if (selectedUnits.length === 0) return;
    const entityIds: EntityId[] = [];
    let allEnabled = true;
    for (let i = 0; i < selectedUnits.length; i++) {
      const unit = selectedUnits[i];
      if (!unit.unit?.jump) continue;
      entityIds.push(unit.id);
      if (unit.unit.jump.enabled === false) allEnabled = false;
    }
    if (entityIds.length === 0) return;
    this.localCommandQueue.enqueue({
      type: 'setJumpEnabled',
      tick: this.context.getTick(),
      entityIds,
      enabled: !allEnabled,
    });
  }

  private enqueueSetFireEnabledCommand(): void {
    const selectedUnits = this.entitySource.getSelectedUnits();
    if (selectedUnits.length === 0) return;
    const entityIds: EntityId[] = [];
    let allEnabled = true;
    for (let i = 0; i < selectedUnits.length; i++) {
      const unit = selectedUnits[i];
      if (!unit.combat || unit.combat.turrets.length === 0) continue;
      entityIds.push(unit.id);
      if (unit.combat.fireEnabled === false) allEnabled = false;
    }
    if (entityIds.length === 0) return;
    this.localCommandQueue.enqueue({
      type: 'setFireEnabled',
      tick: this.context.getTick(),
      entityIds,
      enabled: !allEnabled,
    });
  }

  setEntitySource(source: EntitySource): void {
    this.entitySource = source;
  }

  private canvasRect(): DOMRect {
    return this.canvas.getBoundingClientRect();
  }

  /** Convert client mouse coords to Normalized Device Coords ((-1,1) centered) */
  private toNDC(clientX: number, clientY: number): THREE.Vector2 {
    const rect = this.canvasRect();
    return this._ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  /** Cast a ray from the camera through the mouse position. */
  private castRay(clientX: number, clientY: number): void {
    const ndc = this.toNDC(clientX, clientY);
    this.raycaster.setFromCamera(ndc, this.threeApp.camera);
  }

  /** Cursor → 3D ground point on the actual rendered terrain.
   *  Returns sim coords {x, y, z} where (x, y) is the horizontal
   *  XY of the hit and z is the terrain altitude there. Goes
   *  through the shared CursorGround service so this manager and
   *  the orbit camera use the SAME raycast against the SAME mesh.
   *  Returns null if the cursor's ray misses the terrain (cursor
   *  over the sky / past the map edge / terrain not yet built);
   *  every command call site that uses this guards on null and
   *  drops the command in that case. */
  private raycastGround(clientX: number, clientY: number): SimGroundPoint | null {
    return this.cursorGround.pickSim(clientX, clientY);
  }

  /** Raycast against entity meshes in the world group. Returns closest hit's entityId. */
  private raycastEntity(clientX: number, clientY: number): EntityId | null {
    const rect = this.canvasRect();
    if (
      clientX < rect.left ||
      clientX > rect.right ||
      clientY < rect.top ||
      clientY > rect.bottom
    ) {
      return null;
    }
    this.castRay(clientX, clientY);
    const hits = this.raycaster.intersectObject(this.threeApp.world, true);
    for (const hit of hits) {
      let obj: THREE.Object3D | null = hit.object;
      while (obj && obj.userData.entityId === undefined) obj = obj.parent;
      if (obj && obj.userData.entityId !== undefined) {
        return obj.userData.entityId as EntityId;
      }
    }
    return null;
  }

  /** Cursor hover serves two purposes: command affordances can target
   *  any live enemy/friendly entity, but the select cursor must match
   *  the actual left-click selection rules for owned entities. */
  private resolveHoverTargets(
    clientX: number,
    clientY: number,
  ): { hovered: EntityId | null; selectable: EntityId | null } {
    let hovered: EntityId | null = null;
    let selectable: EntityId | null = null;

    const world = this.raycastGround(clientX, clientY);
    if (!world) return { hovered, selectable };

    const options = { minUnitRadius: SELECTABLE_GROUND_MIN_UNIT_RADIUS };
    if (hovered === null) {
      hovered = findClosestSelectableEntityToPoint(
        this.entitySource,
        world.x,
        world.y,
        options,
      )?.id ?? null;
    }
    if (selectable === null) {
      selectable = findClosestSelectableEntityToPoint(
        this.entitySource,
        world.x,
        world.y,
        {
          ...options,
          playerId: this.context.activePlayerId,
        },
      )?.id ?? null;
    }
    return { hovered, selectable };
  }

  private clearHoveredEntities(): void {
    this.hoveredEntityId = null;
    this.hoveredSelectableEntityId = null;
  }

  private updateHoveredEntity(clientX: number, clientY: number): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this.lastHoverRaycastMs < HOVER_RAYCAST_INTERVAL_MS) return;
    this.lastHoverRaycastMs = now;
    this.lastHoverClientX = clientX;
    this.lastHoverClientY = clientY;
    const targets = this.resolveHoverTargets(clientX, clientY);
    this.hoveredEntityId = targets.hovered;
    this.hoveredSelectableEntityId = targets.selectable;
  }

  private handleMouseDown(e: MouseEvent): void {
    // Button 0 = left (select / mode-click), Button 2 = right
    // (command / cancel), Button 1 (middle) is handled by OrbitCamera.
    //
    // While a commander mode is active, left-click commits that
    // mode's action (place building / fire D-gun / area repair / area attack / guard) and right-click
    // cancels the mode — mirrors the 2D BuildingPlacementController.
    if (this.mode.isInBuildMode || this.mode.isInDGunMode || this.repairAreaMode || this.attackAreaMode || this.guardMode) {
      e.preventDefault();
      if (e.button === 0) {
        if (this.mode.isInBuildMode) this.handleBuildClick(e);
        else if (this.mode.isInDGunMode) this.handleDGunClick(e);
        else if (this.repairAreaMode) this.handleRepairAreaClick(e);
        else if (this.attackAreaMode) this.handleAttackAreaClick(e);
        else this.handleGuardClick(e);
      } else if (e.button === 2) {
        if (this.mode.isInBuildMode) this.mode.exitBuildMode();
        else if (this.mode.isInDGunMode) this.mode.exitDGunMode();
        else if (this.repairAreaMode) this.exitRepairAreaMode();
        else if (this.attackAreaMode) this.exitAttackAreaMode();
        else this.exitGuardMode();
      }
      return;
    }

    if (e.button === 0) {
      e.preventDefault();
      this.leftDown = true;
      this.dragStartScreen = { x: e.clientX, y: e.clientY };
      this.dragEndScreen = { x: e.clientX, y: e.clientY };
      this.applyCursor('select');
    } else if (e.button === 2) {
      e.preventDefault();
      this.handleRightMouseDown(e);
    }
  }

  /** Fire a startBuild command for the selected commander at the
   *  snapped grid position under the cursor. Stays in build mode if
   *  shift is held (lets the user place multiple of the same type). */
  private handleBuildClick(e: MouseEvent): void {
    const commander = this.getSelectedCommander();
    if (!commander) {
      // Commander got deselected mid-placement — drop build mode.
      this.mode.exitBuildMode();
      return;
    }
    const world = this.raycastGround(e.clientX, e.clientY);
    if (!world) return;
    const buildType = this.mode.buildingType;
    if (buildType === null) return;
    const diagnostics = this.validateBuildPlacement(buildType, world.x, world.y);
    this.applyCursor(diagnostics.canPlace ? 'build' : 'blocked');
    if (this.buildGhost) {
      this.buildGhost.setTarget(
        buildType, world.x, world.y,
        commander,
        diagnostics.canPlace,
        diagnostics,
      );
    }
    if (!diagnostics.canPlace) {
      debugLog(GAME_DIAGNOSTICS.commandPlans, 'Blocked invalid build placement', {
        buildingType: buildType,
        reason: diagnostics.failureReason,
        metalFraction: diagnostics.metalFraction,
      });
      return;
    }
    const cmd = this.mode.buildStartBuildCommand(
      commander, world.x, world.y,
      this.context.getTick(), e.shiftKey,
    );
    if (!cmd) return;
    this.localCommandQueue.enqueue(cmd);

    // Shift = keep placing same building type; no-shift = exit build mode.
    if (!e.shiftKey) this.mode.exitBuildMode();
  }

  private validateBuildPlacement(
    buildType: BuildingType,
    worldX: number,
    worldY: number,
  ): BuildPlacementDiagnostics {
    const snapped = getSnappedBuildPosition(worldX, worldY, buildType);
    const buildings = this.entitySource.getBuildings();
    const entitySetVersion = this.entitySource.getEntitySetVersion?.() ?? buildings.length;
    const terrainBuildabilityGrid = this.entitySource.getTerrainBuildabilityGrid?.() ?? null;
    const occupancyVersion = `${entitySetVersion}`;
    if (occupancyVersion !== this.buildOccupancyVersion || !this.buildOccupiedCells) {
      this.buildOccupancyVersion = occupancyVersion;
      this.buildOccupiedCells = getOccupiedBuildingCells(buildings);
    }
    const validationKey = [
      buildType,
      snapped.gridX,
      snapped.gridY,
      this.mapWidth,
      this.mapHeight,
      entitySetVersion,
      terrainBuildabilityGrid?.version ?? 0,
      terrainBuildabilityGrid?.configKey ?? '',
    ].join(':');
    if (validationKey !== this.buildGhostValidationKey || !this.buildGhostDiagnostics) {
      this.buildGhostValidationKey = validationKey;
      this.buildGhostDiagnostics = getBuildingPlacementDiagnostics(
        buildType, snapped.x, snapped.y,
        this.mapWidth, this.mapHeight,
        buildings,
        this.metalDeposits,
        this.buildOccupiedCells,
        terrainBuildabilityGrid,
      );
      this.buildGhostCanPlace = this.buildGhostDiagnostics.canPlace;
    }
    return this.buildGhostDiagnostics;
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
    const world = this.raycastGround(e.clientX, e.clientY);
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
    const world = this.raycastGround(e.clientX, e.clientY);
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
    const world = this.raycastGround(e.clientX, e.clientY);
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

  private handleGuardClick(e: MouseEvent): void {
    const selectedUnits = this.entitySource.getSelectedUnits();
    if (selectedUnits.length === 0) {
      this.exitGuardMode();
      return;
    }
    const tick = this.context.getTick();
    const entityHitId = this.raycastEntity(e.clientX, e.clientY);
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

    const world = this.raycastGround(e.clientX, e.clientY);
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

  private handleMouseMove(e: MouseEvent): void {
    if (this.leftDown || this.rightDown || this.mode.isInBuildMode || this.mode.isInDGunMode || this.repairAreaMode || this.attackAreaMode || this.guardMode) {
      this.clearHoveredEntities();
    } else if (this.lastHoverClientX !== e.clientX || this.lastHoverClientY !== e.clientY) {
      this.updateHoveredEntity(e.clientX, e.clientY);
    }

    // Live build-ghost preview — only while in build mode. Cursor
    // feedback still works in headless/no-ghost cases.
    const buildType = this.mode.buildingType;
    if (buildType !== null) {
      const world = this.raycastGround(e.clientX, e.clientY);
      if (world) {
        const diagnostics = this.validateBuildPlacement(buildType, world.x, world.y);
        this.applyCursor(diagnostics.canPlace ? 'build' : 'blocked');
        if (this.buildGhost) {
          this.buildGhost.setTarget(
            buildType, world.x, world.y,
            this.getSelectedCommander(),
            this.buildGhostCanPlace,
            diagnostics,
          );
        }
      } else {
        this.buildGhostDiagnostics = undefined;
        this.applyCursor('blocked');
      }
      return;
    }

    if (this.attackAreaMode) {
      this.applyCursor('attack');
      return;
    }

    if (this.guardMode) {
      this.applyCursor('guard');
      return;
    }

    if (this.repairAreaMode) {
      this.applyCursor('repair');
      return;
    }

    if (this.leftDown) {
      this.applyCursor('select');
      this.dragEndScreen = { x: e.clientX, y: e.clientY };
      const dx = e.clientX - this.dragStartScreen.x;
      const dy = e.clientY - this.dragStartScreen.y;
      const dist = Math.hypot(dx, dy);
      if (dist >= CLICK_DRAG_THRESHOLD_PX) {
        this.showMarquee();
      }
      return;
    }

    if (this.rightDown) {
      this.applyCursor(this.waypointCursorKind());
      // Record points along the right-drag path so units can spread
      // along a line. The accumulator drops near-duplicate samples
      // and recomputes per-unit targets on append; we also force a
      // recompute here so the preview stays live between appends.
      const world = this.raycastGround(e.clientX, e.clientY);
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
    this.leftDown = false;
    this.hideMarquee();

    const dx = e.clientX - this.dragStartScreen.x;
    const dy = e.clientY - this.dragStartScreen.y;
    const isClick = Math.hypot(dx, dy) < CLICK_DRAG_THRESHOLD_PX;
    const additive = e.shiftKey;

    if (isClick) {
      // Try exact mesh pick first (cleaner for overlapping units than the
      // distance-based closest-entity fallback).
      const hit = this.raycastEntity(e.clientX, e.clientY);
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
      const world = this.raycastGround(e.clientX, e.clientY);
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
    const ids = this.selectEntitiesInScreenRect(
      this.dragStartScreen,
      this.dragEndScreen,
    );
    this.localCommandQueue.enqueue({
      type: 'select',
      tick: this.context.getTick(),
      entityIds: ids,
      additive,
    });
    this.refreshCursor();
  }

  /** Delegates to the shared box-select helper. The renderer-specific
   *  bit is just the projector: take a world (x, y=10, z) point,
   *  run it through THREE's Vector3.project to get NDC, then convert
   *  NDC → viewport pixels. `behind` is set when NDC z ≥ 1 so the
   *  shared helper skips entities behind the camera. */
  private selectEntitiesInScreenRect(
    a: { x: number; y: number },
    b: { x: number; y: number },
  ): EntityId[] {
    const rect = this.canvasRect();
    const cam = this.threeApp.camera;
    const v = this._selectV; // reused scratch Vec3 (see field init)
    return selectEntitiesInScreenRect(
      this.entitySource,
      {
        minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
        minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y),
      },
      this.context.activePlayerId,
      (entity, out) => {
        // Pick a vertical center per entity kind so screen projection
        // lands on the visible body, not a magic constant.
        // (If aerial units ever exist, add a case here.)
        const centerY = selectionCenterY(entity);
        v.set(entity.transform.x, centerY, entity.transform.y).project(cam);
        out.x = (v.x * 0.5 + 0.5) * rect.width + rect.left;
        out.y = (-v.y * 0.5 + 0.5) * rect.height + rect.top;
        out.behind = v.z >= 1;
      },
    );
  }

  private handleRightMouseDown(e: MouseEvent): void {
    // Right-click dispatcher, matching the 2D CommandController:
    //   1. selected commander + repair target under cursor → repair
    //   2. selected units + attack target under cursor → attack
    //   3. units selected → start line-path for group move
    //   4. no units, factories selected → start factory-waypoint drag
    const selectedUnits = this.entitySource.getSelectedUnits();
    const tick = this.context.getTick();
    const entityHitId = this.raycastEntity(e.clientX, e.clientY);
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

    const world = this.raycastGround(e.clientX, e.clientY);
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
        b.factory !== undefined &&
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
          const mw = this.mapWidth, mh = this.mapHeight;
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

    // No units: finalize factory waypoints if factories are selected.
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
      const cmds = buildFactoryWaypointCommands(
        factories, finalPoint.x, finalPoint.y,
        this.waypointMode, tick, shiftHeld, finalPoint.z,
      );
      for (const cmd of cmds) this.localCommandQueue.enqueue(cmd);
    }
    this.linePath.reset();
    this.refreshCursor();
  }

  private showMarquee(): void {
    const rect = this.canvasRect();
    const x = Math.min(this.dragStartScreen.x, this.dragEndScreen.x) - rect.left;
    const y = Math.min(this.dragStartScreen.y, this.dragEndScreen.y) - rect.top;
    const w = Math.abs(this.dragStartScreen.x - this.dragEndScreen.x);
    const h = Math.abs(this.dragStartScreen.y - this.dragEndScreen.y);
    this.marquee.style.left = `${x}px`;
    this.marquee.style.top = `${y}px`;
    this.marquee.style.width = `${w}px`;
    this.marquee.style.height = `${h}px`;
    this.marquee.style.display = 'block';
  }

  private hideMarquee(): void {
    this.marquee.style.display = 'none';
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
    this.onGuardModeChange = undefined;
    this.marquee.remove();
  }
}
