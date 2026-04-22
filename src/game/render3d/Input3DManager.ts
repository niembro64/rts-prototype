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
import type { PlayerId, Entity, EntityId, WaypointType } from '../sim/types';
import { performSelection } from '../input/helpers';

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

  // Current waypoint mode (move/fight/patrol) — driven by UI hotkey
  private waypointMode: WaypointType = 'move';

  // Drag state
  private leftDown = false;
  private dragStartScreen = { x: 0, y: 0 };
  private dragEndScreen = { x: 0, y: 0 };
  private dragStartWorld: { x: number; y: number } | null = null;

  // Visual selection rectangle overlay (CSS div over the canvas)
  private marquee: HTMLDivElement;

  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  // DOM handlers bound once for add/remove
  private onMouseDown: (e: MouseEvent) => void;
  private onMouseMove: (e: MouseEvent) => void;
  private onMouseUp: (e: MouseEvent) => void;

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

    this.canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
  }

  setWaypointMode(mode: WaypointType): void {
    this.waypointMode = mode;
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
    if (e.button === 0) {
      e.preventDefault();
      this.leftDown = true;
      this.dragStartScreen = { x: e.clientX, y: e.clientY };
      this.dragEndScreen = { x: e.clientX, y: e.clientY };
      const w = this.raycastGround(e.clientX, e.clientY);
      this.dragStartWorld = w;
    } else if (e.button === 2) {
      e.preventDefault();
      this.handleRightClick(e);
    }
  }

  private handleMouseMove(e: MouseEvent): void {
    if (!this.leftDown) return;
    this.dragEndScreen = { x: e.clientX, y: e.clientY };

    const dx = e.clientX - this.dragStartScreen.x;
    const dy = e.clientY - this.dragStartScreen.y;
    const dist = Math.hypot(dx, dy);
    if (dist >= DRAG_PIXEL_THRESHOLD) {
      this.showMarquee();
    }
  }

  private handleMouseUp(e: MouseEvent): void {
    if (e.button !== 0 || !this.leftDown) return;
    this.leftDown = false;
    this.hideMarquee();

    const endWorld = this.raycastGround(e.clientX, e.clientY);
    if (!this.dragStartWorld || !endWorld) return;

    const dx = e.clientX - this.dragStartScreen.x;
    const dy = e.clientY - this.dragStartScreen.y;
    const isClick = Math.hypot(dx, dy) < DRAG_PIXEL_THRESHOLD;
    const additive = e.shiftKey;

    if (isClick) {
      // Try exact mesh pick first (cleaner for overlapping units than the
      // distance-based closest-entity fallback in performSelection).
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
      // Click on empty ground → clear selection (unless additive)
      if (!additive) {
        this.localCommandQueue.enqueue({
          type: 'clearSelection',
          tick: this.context.getTick(),
        });
      }
      return;
    }

    // Drag: world-space box select using the shared helper (projects through
    // the ground plane — the screen-rect becomes a world-space quad, but on
    // a flat ground with a moderate pitch this is visually close enough for
    // a PoC. True screen-space box select is a later refinement.)
    const result = performSelection(
      this.entitySource,
      this.dragStartWorld.x,
      this.dragStartWorld.y,
      endWorld.x,
      endWorld.y,
      this.context.activePlayerId,
    );
    this.localCommandQueue.enqueue({
      type: 'select',
      tick: this.context.getTick(),
      entityIds: result.entityIds,
      additive,
    });
  }

  private handleRightClick(e: MouseEvent): void {
    const ground = this.raycastGround(e.clientX, e.clientY);
    if (!ground) return;

    const selectedUnits = this.entitySource.getSelectedUnits();
    if (selectedUnits.length === 0) return;

    const entityIds = selectedUnits.map((u) => u.id);
    const mode = e.shiftKey ? this.waypointMode : this.waypointMode;

    this.gameConnection.sendCommand({
      type: 'move',
      tick: this.context.getTick(),
      entityIds,
      targetX: ground.x,
      targetY: ground.y,
      waypointType: mode,
      queue: e.shiftKey,
    });
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
    this.marquee.remove();
  }
}
