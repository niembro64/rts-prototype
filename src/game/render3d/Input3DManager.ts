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
// Mouse positions are raycast against a Y=0 ground plane to get world (x, z)
// coords, which are mapped to sim (x, y).

import * as THREE from 'three';
import type { ThreeApp } from './ThreeApp';
import type { BuildGhost3D } from './BuildGhost3D';
import type { CommandQueue } from '../sim/commands';
import type { GameConnection } from '../server/GameConnection';
import type { InputContext } from '@/types/input';
import type { PlayerId, Entity, EntityId, WaypointType, BuildingType } from '../sim/types';
import {
  findClosestUnitToPoint,
  findClosestBuildingToPoint,
  selectEntitiesInScreenRect,
  SelectionChangeTracker,
  LinePathAccumulator,
  buildAttackCommandAt,
  buildLinePathMoveCommand,
  buildRepairCommandAt,
  buildFactoryWaypointCommands,
  handleEscape,
  CommanderModeController,
} from '../input/helpers';
import { CLICK_DRAG_THRESHOLD_PX } from '../input/constants';

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
};

export class Input3DManager {
  private threeApp: ThreeApp;
  private canvas: HTMLCanvasElement;
  private context: InputContext;
  private entitySource: EntitySource;
  private localCommandQueue: CommandQueue;
  private gameConnection: GameConnection;

  // Current waypoint mode (move/fight/patrol) — driven by UI or M/F/H hotkeys.
  private waypointMode: WaypointType = 'move';
  // Fires when the mode changes (from hotkey or setter). RtsScene3D hooks this
  // to refresh the selection panel so the active mode chip stays in sync.
  public onWaypointModeChange?: (mode: WaypointType) => void;

  // Shared commander-mode state machine (build + D-gun). The 2D
  // BuildingPlacementController owns one of these too so the two
  // renderers can't drift on mode entry/exit semantics. Click
  // dispatch while a mode is active is handled below in
  // handleLeftMouseDown.
  private mode = new CommanderModeController();
  public onBuildModeChange?: (type: BuildingType | null) => void;
  public onDGunModeChange?: (active: boolean) => void;

  // Optional preview renderer driven on mouse-move-in-build-mode;
  // scene injects one via setBuildGhost. Stays null in the demo /
  // headless case, where no in-world preview is shown.
  private buildGhost: BuildGhost3D | null = null;

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

  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  // Reusable scratch vector for projecting entities in selectEntitiesInScreenRect.
  // One allocation for the lifetime of the manager keeps the hot loop alloc-free.
  private _selectV = new THREE.Vector3();
  // Resets waypoint mode back to 'move' when the owned-selected set
  // changes — matches the 2D SelectionController's rule so squads
  // don't accidentally inherit 'fight'/'patrol' from a prior group.
  private selectionChangeTracker = new SelectionChangeTracker();

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
    gameConnection: GameConnection,
  ) {
    this.threeApp = threeApp;
    this.canvas = threeApp.renderer.domElement;
    this.context = context;
    this.entitySource = entitySource;
    this.localCommandQueue = localCommandQueue;
    this.gameConnection = gameConnection;

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
      if (type === null) this.buildGhost?.hide();
      this.onBuildModeChange?.(type);
    };
    this.mode.onDGunModeChange = (active) => this.onDGunModeChange?.(active);
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

  setWaypointMode(mode: WaypointType): void {
    if (this.waypointMode === mode) return;
    this.waypointMode = mode;
    this.onWaypointModeChange?.(mode);
  }

  /** Enter build mode with a building type. Called from the UI
   *  (scene.startBuildMode forwards to here). Next left-click on the
   *  ground will issue a startBuild command for the selected
   *  commander. */
  setBuildMode(type: BuildingType): void {
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
    if (this.hasSelectedCommander()) this.mode.toggleDGunMode();
  }

  /** True if D-gun mode is currently active. */
  isInDGunMode(): boolean {
    return this.mode.isInDGunMode;
  }

  private hasSelectedCommander(): boolean {
    return this.entitySource.getSelectedUnits().some(
      (e) => e.commander !== undefined,
    );
  }

  private getSelectedCommander(): Entity | null {
    return (
      this.entitySource.getSelectedUnits().find(
        (e) => e.commander !== undefined,
      ) ?? null
    );
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

    // Mirror the 2D hotkeys one-for-one. M/F/H switch waypoint mode;
    // B/1/2/D drive the commander mode state machine; Escape runs
    // the shared cancel-mode-or-clear-selection convention.
    switch (e.key.toLowerCase()) {
      case 'm': this.setWaypointMode('move'); break;
      case 'f': this.setWaypointMode('fight'); break;
      case 'h': this.setWaypointMode('patrol'); break;
      case 'b':
        if (!this.hasSelectedCommander()) break;
        if (!this.mode.isInBuildMode) this.mode.enterBuildMode('solar');
        else this.mode.cycleBuildingType();
        break;
      case '1':
        if (this.mode.isInBuildMode || this.hasSelectedCommander()) {
          this.mode.enterBuildMode('solar');
        }
        break;
      case '2':
        if (this.mode.isInBuildMode || this.hasSelectedCommander()) {
          this.mode.enterBuildMode('factory');
        }
        break;
      case 'd':
        if (this.hasSelectedCommander()) this.mode.toggleDGunMode();
        break;
      case 'escape':
        handleEscape(
          [
            { isActive: () => this.mode.isInBuildMode, cancel: () => this.mode.exitBuildMode() },
            { isActive: () => this.mode.isInDGunMode, cancel: () => this.mode.exitDGunMode() },
          ],
          this.localCommandQueue,
          this.context.getTick(),
        );
        break;
    }
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
    return new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  /** Cast a ray from the camera through the mouse position. */
  private castRay(clientX: number, clientY: number): void {
    const ndc = this.toNDC(clientX, clientY);
    this.raycaster.setFromCamera(ndc, this.threeApp.camera);
  }

  /** Intersect the ground plane (y=0) and return world (x, z).
   *  Returns null if the ray is parallel or misses (should not happen for a
   *  downward-tilted camera). */
  private raycastGround(clientX: number, clientY: number): { x: number; y: number } | null {
    this.castRay(clientX, clientY);
    const hit = new THREE.Vector3();
    const ok = this.raycaster.ray.intersectPlane(this.groundPlane, hit);
    if (!ok) return null;
    // three (x, z) → sim (x, y)
    return { x: hit.x, y: hit.z };
  }

  /** Raycast against entity meshes in the world group. Returns closest hit's entityId. */
  private raycastEntity(clientX: number, clientY: number): EntityId | null {
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

  private handleMouseDown(e: MouseEvent): void {
    // Button 0 = left (select / mode-click), Button 2 = right
    // (command / cancel), Button 1 (middle) is handled by OrbitCamera.
    //
    // While a commander mode is active, left-click commits that
    // mode's action (place building / fire D-gun) and right-click
    // cancels the mode — mirrors the 2D BuildingPlacementController.
    if (this.mode.isInBuildMode || this.mode.isInDGunMode) {
      e.preventDefault();
      if (e.button === 0) {
        if (this.mode.isInBuildMode) this.handleBuildClick(e);
        else this.handleDGunClick(e);
      } else if (e.button === 2) {
        if (this.mode.isInBuildMode) this.mode.exitBuildMode();
        else this.mode.exitDGunMode();
      }
      return;
    }

    if (e.button === 0) {
      e.preventDefault();
      this.leftDown = true;
      this.dragStartScreen = { x: e.clientX, y: e.clientY };
      this.dragEndScreen = { x: e.clientX, y: e.clientY };
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
    const cmd = this.mode.buildStartBuildCommand(
      commander, world.x, world.y,
      this.context.getTick(), e.shiftKey,
    );
    if (!cmd) return;
    this.localCommandQueue.enqueue(cmd);

    // Shift = keep placing same building type; no-shift = exit build mode.
    if (!e.shiftKey) this.mode.exitBuildMode();
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
      commander, world.x, world.y, this.context.getTick(),
    );
    this.localCommandQueue.enqueue(cmd);
  }

  private handleMouseMove(e: MouseEvent): void {
    // Live build-ghost preview — only while in build mode and the
    // scene provided a ghost renderer.
    const buildType = this.mode.buildingType;
    if (buildType !== null && this.buildGhost) {
      const world = this.raycastGround(e.clientX, e.clientY);
      if (world) {
        this.buildGhost.setTarget(
          buildType, world.x, world.y,
          this.getSelectedCommander(),
        );
      }
    }

    if (this.leftDown) {
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
      // Record points along the right-drag path so units can spread
      // along a line. The accumulator drops near-duplicate samples
      // and recomputes per-unit targets on append; we also force a
      // recompute here so the preview stays live between appends.
      const world = this.raycastGround(e.clientX, e.clientY);
      if (!world) return;
      const unitCount = this.entitySource.getSelectedUnits().length;
      this.linePath.append(world.x, world.y, unitCount);
      this.linePath.recomputeTargets(unitCount);
    }
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
        const ent = this.entitySource.getEntity(hit);
        if (ent && ent.ownership?.playerId === this.context.activePlayerId) {
          this.localCommandQueue.enqueue({
            type: 'select',
            tick: this.context.getTick(),
            entityIds: [hit],
            additive,
          });
          return;
        }
      }
      // Fallback: closest-entity-to-ground-click (e.g., user clicked near
      // a unit but missed the mesh). Matches 2D behavior.
      const world = this.raycastGround(e.clientX, e.clientY);
      if (world) {
        const closestUnit = findClosestUnitToPoint(
          this.entitySource,
          world.x,
          world.y,
          this.context.activePlayerId,
        );
        if (closestUnit) {
          this.localCommandQueue.enqueue({
            type: 'select',
            tick: this.context.getTick(),
            entityIds: [closestUnit.id],
            additive,
          });
          return;
        }
        const closestBuilding = findClosestBuildingToPoint(
          this.entitySource,
          world.x,
          world.y,
          this.context.activePlayerId,
        );
        if (closestBuilding) {
          this.localCommandQueue.enqueue({
            type: 'select',
            tick: this.context.getTick(),
            entityIds: [closestBuilding.id],
            additive,
          });
          return;
        }
      }
      if (!additive) {
        this.localCommandQueue.enqueue({
          type: 'clearSelection',
          tick: this.context.getTick(),
        });
      }
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
      (worldX, worldY, out) => {
        v.set(worldX, 10, worldY).project(cam);
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
    const world = this.raycastGround(e.clientX, e.clientY);
    if (!world) return;

    const repairCmd = buildRepairCommandAt(
      this.entitySource,
      world.x, world.y,
      this.getSelectedCommander(),
      this.context.getTick(),
      e.shiftKey,
    );
    if (repairCmd) {
      this.gameConnection.sendCommand(repairCmd);
      return;
    }

    if (selectedUnits.length > 0) {
      // Attack target under cursor → attack command (skips line-path drawing).
      const attackCmd = buildAttackCommandAt(
        this.entitySource,
        world.x, world.y,
        selectedUnits,
        this.context.activePlayerId,
        this.context.getTick(),
        e.shiftKey,
      );
      if (attackCmd) {
        this.gameConnection.sendCommand(attackCmd);
        return;
      }
      // Start drawing a line path of waypoints.
      this.rightDown = true;
      this.linePath.start(world.x, world.y, selectedUnits.length);
      return;
    }

    // No units — fall through to factory waypoint mode if the user
    // has a factory selected. The single placed point IS the target
    // (no distribution), so seed the accumulator with a fixed target.
    const factories = this.getSelectedFactories();
    if (factories.length > 0) {
      this.rightDown = true;
      this.linePath.startWithFixedTarget(world.x, world.y);
    }
  }

  private getSelectedFactories(): Entity[] {
    return this.entitySource.getSelectedBuildings().filter(
      (b) =>
        b.factory !== undefined &&
        b.ownership?.playerId === this.context.activePlayerId,
    );
  }

  /** State shape consumed by the 3D line-drag overlay. Populated
   *  while the user is actively right-dragging; reset when the drag
   *  ends. Points/targets come from the shared accumulator. */
  getLineDragState(): {
    active: boolean;
    points: ReadonlyArray<{ x: number; y: number }>;
    targets: ReadonlyArray<{ x: number; y: number }>;
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
        this.gameConnection.sendCommand(repairCmd);
        this.linePath.reset();
        return;
      }
      const moveCmd = buildLinePathMoveCommand(
        this.linePath, selectedUnits, this.waypointMode, tick, shiftHeld,
      );
      if (moveCmd) this.gameConnection.sendCommand(moveCmd);
      this.linePath.reset();
      return;
    }

    // No units: finalize factory waypoints if factories are selected.
    const factories = this.getSelectedFactories();
    if (factories.length > 0 && points.length > 0) {
      const finalPoint = points[points.length - 1];
      const cmds = buildFactoryWaypointCommands(
        factories, finalPoint.x, finalPoint.y,
        this.waypointMode, tick, shiftHeld,
      );
      for (const cmd of cmds) this.gameConnection.sendCommand(cmd);
    }
    this.linePath.reset();
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
    this.onWaypointModeChange = undefined;
    this.marquee.remove();
  }
}
