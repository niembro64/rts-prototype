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
import type { CommandQueue } from '../sim/commands';
import type { GameConnection } from '../server/GameConnection';
import type { InputContext } from '@/types/input';
import type { PlayerId, Entity, EntityId, WaypointType, BuildingType } from '../sim/types';
import {
  findClosestUnitToPoint,
  findClosestBuildingToPoint,
  findAttackTargetAt,
  getPathLength,
  calculateLinePathTargets,
  assignUnitsToTargets,
  getSnappedBuildPosition,
} from '../input/helpers';
import type { StartBuildCommand, WaypointTarget } from '../sim/commands';

type LinePoint = { x: number; y: number };
const LINE_PATH_SEGMENT_MIN = 10;     // min world distance to record a new path point
const LINE_PATH_MIN_LENGTH = 20;      // path shorter than this = treated as a click

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

const DRAG_PIXEL_THRESHOLD = 5;

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

  // Build-mode state. `buildType` is null when not in build mode.
  //   - left-click a ground point while in build mode → emit startBuild
  //     with the snapped grid position of the selected commander.
  //   - right-click or Escape → cancel build mode.
  //   - shift-click → keep build mode active after placing (ghost stays).
  // Fires through onBuildModeChange so RtsScene3D can sync the
  // SelectionPanel's `isBuildMode` + `selectedBuildingType` chips.
  private buildType: BuildingType | null = null;
  public onBuildModeChange?: (type: BuildingType | null) => void;

  // Drag state (screen coords only — box select is screen-space)
  private leftDown = false;
  private dragStartScreen = { x: 0, y: 0 };
  private dragEndScreen = { x: 0, y: 0 };

  // Right-drag line-path state (world coords, same shape the 2D path uses).
  private rightDown = false;
  private linePathPoints: LinePoint[] = [];
  // Per-unit assigned targets along the drawn path. Recomputed each mousemove
  // so the preview overlay can draw current distribution dots while dragging
  // (mirrors the 2D renderer reading state.linePathTargets every frame).
  private linePathTargets: LinePoint[] = [];

  // Visual selection rectangle overlay (CSS div over the canvas)
  private marquee: HTMLDivElement;

  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

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
    if (this.buildType === type) return;
    this.buildType = type;
    this.onBuildModeChange?.(type);
  }

  /** Exit build mode (from UI or internal flow). No-op if not in build mode. */
  cancelBuildMode(): void {
    if (this.buildType === null) return;
    this.buildType = null;
    this.onBuildModeChange?.(null);
  }

  /** True if build mode is currently active. */
  isInBuildMode(): boolean {
    return this.buildType !== null;
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

    // Mirror InputManager.setupModeHotkeys (2D path): M/F/H switch waypoint mode.
    switch (e.key.toLowerCase()) {
      case 'm': this.setWaypointMode('move'); break;
      case 'f': this.setWaypointMode('fight'); break;
      case 'h': this.setWaypointMode('patrol'); break;
      case 'escape': {
        // Priority: cancel an active mode first (build); fall through to
        // clearing selection only if no mode was active. Mirrors the 2D
        // BuildingPlacementController's ESC handler.
        if (this.buildType !== null) {
          this.cancelBuildMode();
          break;
        }
        this.localCommandQueue.enqueue({
          type: 'clearSelection',
          tick: this.context.getTick(),
        });
        break;
      }
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
    // Button 0 = left (select), Button 2 = right (command). Middle (1) is
    // handled by OrbitCamera for pan/orbit.
    //
    // In build mode the left button DOESN'T start a selection drag; it
    // commits the building at the clicked ground point. Right button
    // cancels build mode entirely (matches 2D's BuildingPlacementController
    // where right-click is a universal "cancel current mode").
    if (this.buildType !== null) {
      e.preventDefault();
      if (e.button === 0) {
        this.handleBuildClick(e);
      } else if (e.button === 2) {
        this.cancelBuildMode();
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
    if (this.buildType === null) return;
    const commander = this.entitySource
      .getSelectedUnits()
      .find((u) => u.commander !== undefined);
    if (!commander) {
      // Commander got deselected mid-placement — drop build mode.
      this.cancelBuildMode();
      return;
    }
    const world = this.raycastGround(e.clientX, e.clientY);
    if (!world) return;

    const snapped = getSnappedBuildPosition(world.x, world.y, this.buildType);
    const command: StartBuildCommand = {
      type: 'startBuild',
      tick: this.context.getTick(),
      builderId: commander.id,
      buildingType: this.buildType,
      gridX: snapped.gridX,
      gridY: snapped.gridY,
      queue: e.shiftKey,
    };
    this.localCommandQueue.enqueue(command);

    // Shift = keep placing same building type; no-shift = exit build mode.
    if (!e.shiftKey) this.cancelBuildMode();
  }

  private handleMouseMove(e: MouseEvent): void {
    if (this.leftDown) {
      this.dragEndScreen = { x: e.clientX, y: e.clientY };
      const dx = e.clientX - this.dragStartScreen.x;
      const dy = e.clientY - this.dragStartScreen.y;
      const dist = Math.hypot(dx, dy);
      if (dist >= DRAG_PIXEL_THRESHOLD) {
        this.showMarquee();
      }
      return;
    }

    if (this.rightDown) {
      // Record points along the right-drag path so units can spread along a line.
      const world = this.raycastGround(e.clientX, e.clientY);
      if (!world) return;
      const last = this.linePathPoints[this.linePathPoints.length - 1];
      if (!last || Math.hypot(world.x - last.x, world.y - last.y) >= LINE_PATH_SEGMENT_MIN) {
        this.linePathPoints.push({ x: world.x, y: world.y });
      }
      // Recompute per-unit target distribution so the preview overlay can
      // draw dots at the current assignment each frame, even if the cursor
      // is between recorded points.
      const selectedUnits = this.entitySource.getSelectedUnits();
      if (selectedUnits.length > 0 && this.linePathPoints.length > 0) {
        this.linePathTargets = calculateLinePathTargets(
          this.linePathPoints,
          selectedUnits.length,
        );
      } else {
        this.linePathTargets = [];
      }
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
    const isClick = Math.hypot(dx, dy) < DRAG_PIXEL_THRESHOLD;
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

  private selectEntitiesInScreenRect(
    a: { x: number; y: number },
    b: { x: number; y: number },
  ): EntityId[] {
    const rect = this.canvasRect();
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    const pid = this.context.activePlayerId;
    const ids: EntityId[] = [];
    const cam = this.threeApp.camera;
    const v = new THREE.Vector3();

    const pushIfInRect = (x: number, y: number, z: number, id: EntityId) => {
      v.set(x, y, z).project(cam);
      // NDC → screen px (relative to viewport)
      const sx = (v.x * 0.5 + 0.5) * rect.width + rect.left;
      const sy = (-v.y * 0.5 + 0.5) * rect.height + rect.top;
      // Reject points behind the camera (z > 1 after project means behind)
      if (v.z >= 1) return;
      if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) ids.push(id);
    };

    // Prefer units; only fall through to buildings if no units hit (matches
    // performSelection's precedence rule).
    for (const u of this.entitySource.getUnits()) {
      if (u.ownership?.playerId !== pid) continue;
      pushIfInRect(u.transform.x, 10, u.transform.y, u.id);
    }
    if (ids.length > 0) return ids;

    for (const b2 of this.entitySource.getBuildings()) {
      if (b2.ownership?.playerId !== pid) continue;
      pushIfInRect(b2.transform.x, 10, b2.transform.y, b2.id);
    }
    return ids;
  }

  private handleRightMouseDown(e: MouseEvent): void {
    // Right-click only triggers commands if any selection is present. Mirrors
    // CommandController.handleRightClickDown from the 2D path — attack target
    // takes priority; otherwise we start drawing a line path that becomes a
    // per-unit move on release.
    const selectedUnits = this.entitySource.getSelectedUnits();
    if (selectedUnits.length === 0) return;

    // Attack target under cursor → attack command (skips line-path drawing).
    const world = this.raycastGround(e.clientX, e.clientY);
    if (!world) return;

    const attackTarget = findAttackTargetAt(
      this.entitySource,
      world.x,
      world.y,
      this.context.activePlayerId,
    );
    if (attackTarget) {
      this.gameConnection.sendCommand({
        type: 'attack',
        tick: this.context.getTick(),
        entityIds: selectedUnits.map((u) => u.id),
        targetId: attackTarget.id,
        queue: e.shiftKey,
      });
      return;
    }

    // Start drawing a line path of waypoints.
    this.rightDown = true;
    this.linePathPoints = [{ x: world.x, y: world.y }];
    this.linePathTargets = [];
  }

  /**
   * State shape consumed by the 3D line-drag overlay. Populated while the
   * user is actively right-dragging; reset when the drag ends.
   */
  getLineDragState(): {
    active: boolean;
    points: ReadonlyArray<{ x: number; y: number }>;
    targets: ReadonlyArray<{ x: number; y: number }>;
    mode: WaypointType;
  } {
    return {
      active: this.rightDown,
      points: this.linePathPoints,
      targets: this.linePathTargets,
      mode: this.waypointMode,
    };
  }

  private handleRightMouseUp(e: MouseEvent): void {
    this.rightDown = false;
    const selectedUnits = this.entitySource.getSelectedUnits();
    if (selectedUnits.length === 0 || this.linePathPoints.length === 0) {
      this.linePathPoints.length = 0;
    this.linePathTargets.length = 0;
      return;
    }

    const shiftHeld = e.shiftKey;
    const mode = this.waypointMode;
    const pathLen = getPathLength(this.linePathPoints);
    const finalPoint = this.linePathPoints[this.linePathPoints.length - 1];

    if (pathLen < LINE_PATH_MIN_LENGTH) {
      // Short path = single-point group move. Matches the 2D fallback
      // (pathLength < 20 → group move to the final point).
      this.gameConnection.sendCommand({
        type: 'move',
        tick: this.context.getTick(),
        entityIds: selectedUnits.map((u) => u.id),
        targetX: finalPoint.x,
        targetY: finalPoint.y,
        waypointType: mode,
        queue: shiftHeld,
      });
      this.linePathPoints.length = 0;
    this.linePathTargets.length = 0;
      return;
    }

    // Spread units along the drawn line using the shared 2D helpers so the
    // per-unit assignment matches the 2D path exactly.
    const targets = calculateLinePathTargets(this.linePathPoints, selectedUnits.length);
    const assignments = assignUnitsToTargets(selectedUnits, targets);

    const entityIds: EntityId[] = [];
    const individualTargets: WaypointTarget[] = [];
    for (const unit of selectedUnits) {
      const target = assignments.get(unit.id);
      if (target) {
        entityIds.push(unit.id);
        individualTargets.push({ x: target.x, y: target.y });
      }
    }

    this.gameConnection.sendCommand({
      type: 'move',
      tick: this.context.getTick(),
      entityIds,
      individualTargets,
      waypointType: mode,
      queue: shiftHeld,
    });
    this.linePathPoints.length = 0;
    this.linePathTargets.length = 0;
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
