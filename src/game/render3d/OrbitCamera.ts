// OrbitCamera — RTS-style orbit camera controller for Three.js.
//
// Controls:
//   - Scroll wheel        → zoom (dolly along view direction)
//   - Alt + middle drag   → orbit (yaw + pitch)
//   - Middle drag         → pan (slide target on the world ground)
//   - Shift + middle drag → pan (alias)
//
// Architecture: every input that changes the camera (wheel, pan drag,
// orbit drag) writes into a single TO-STATE — `(toDistance,
// toTargetX, toTargetZ)` plus `yaw / pitch` for orbit — that
// represents wherever the camera is heading. The rendered state
// (`distance`, `target.x`, `target.z`) lerps toward the to-state
// every frame via standard EMA: `alpha = 1 − exp(−dt / tau)`. When
// tau == 0 (snap mode) inputs apply directly to the rendered state.
// Both pan and zoom feed the same to-state, so they animate together
// without fighting each other — a wheel zoom mid-pan-drag produces
// one continuous eased motion to the combined destination.
//
// Cursor pinning is 3D-accurate when a `getCursorWorldPoint` callback
// is supplied: the scene raycasts the actual rendered geometry
// (terrain, etc.) instead of a flat y=0 plane, so wheel zoom anchors
// at the real point under the cursor and pan drag uses the cursor's
// actual world depth to compute world-per-pixel — meaning the world
// point under the cursor at drag-start follows the cursor exactly,
// regardless of terrain elevation under it.

import * as THREE from 'three';

export type OrbitCameraOptions = {
  minDistance?: number;
  maxDistance?: number;
  minPitch?: number;
  maxPitch?: number;
  /** Per-wheel-tick multiplier (distance is divided on zoom-in, multiplied on
   *  zoom-out). Matches the 2D camera's ZOOM_FACTOR behavior. */
  zoomStepFactor?: number;
  rotateSpeed?: number;
  /** Multiplier applied on top of world-per-pixel when panning. Matches the
   *  2D CAMERA_PAN_MULTIPLIER so pan feel is consistent across renderers. */
  panMultiplier?: number;
  /** Maximum drag distance (screen pixels) for full pan-arrow intensity. */
  arrowDragMaxDist?: number;
  /** Fired during drag-pan so a shared HUD overlay (pan arrow) can render.
   *  direction is a unit vector (screen space); intensity ∈ [0, 1]. */
  onPanState?: (dirX: number, dirY: number, intensity: number) => void;
  /** OPTIONAL 3D cursor picker — if set, the orbit camera uses real
   *  raycasting against the scene to find the world point under the
   *  cursor. Used for both wheel zoom-to-cursor and pan-around-cursor.
   *  When unset, we fall back to a flat y=0 plane projection. */
  getCursorWorldPoint?: (clientX: number, clientY: number) => THREE.Vector3 | null;
};

export class OrbitCamera {
  public camera: THREE.PerspectiveCamera;

  // RENDERED state — what the camera is at right now. Read by `apply()`
  // to position the THREE camera.
  public target = new THREE.Vector3(0, 0, 0);
  public distance = 1500;
  /** Yaw (rotation around world-Y), radians. */
  public yaw = 0;
  /** Pitch (tilt from vertical), radians. 0 = straight down, PI/2 = horizontal. */
  public pitch = Math.PI * 0.25;

  // TO state — what the camera is heading toward. Inputs (wheel, pan
  // drag, setTarget) write here; tick() lerps the rendered state
  // toward it. In snap mode (tau == 0) inputs also apply directly.
  private toDistance = 1500;
  private toTargetX = 0;
  private toTargetZ = 0;

  /** EMA time-constant in seconds. 0 disables smoothing (snap mode).
   *  After tau seconds the rendered state is ~63% of the way to the
   *  to-state; after 3·tau ~95%. */
  public smoothTauSec = 0;

  private minDistance: number;
  private maxDistance: number;
  private minPitch: number;
  private maxPitch: number;
  private zoomStepFactor: number;
  private rotateSpeed: number;
  private panMultiplier: number;
  private arrowDragMaxDist: number;
  private onPanState?: (dirX: number, dirY: number, intensity: number) => void;
  private getCursorWorldPoint?: (clientX: number, clientY: number) => THREE.Vector3 | null;

  // Tracks drag origin in screen pixels so we can emit pan-arrow state.
  private dragOriginScreen = { x: 0, y: 0 };

  private dragMode: 'none' | 'orbit' | 'pan' = 'none';
  private lastMouseX = 0;
  private lastMouseY = 0;

  /** Distance from camera to the cursor's 3D anchor point at the
   *  moment a pan drag started. Used to compute world-per-pixel
   *  during the drag so the cursor's anchor world-point tracks the
   *  cursor exactly, regardless of camera tilt or terrain elevation
   *  at the cursor. Falls back to `this.distance` if the cursor
   *  picker returns null. */
  private panAnchorDistance = 0;

  // Reusable scratch objects so the wheel handler does no per-event
  // allocations (zoom is the highest-frequency input on a trackpad).
  private _zoomNdc = new THREE.Vector3();
  private _zoomGroundOut = new THREE.Vector3();

  private canvas: HTMLElement;
  private onWheel: (e: WheelEvent) => void;
  private onMouseDown: (e: MouseEvent) => void;
  private onMouseMove: (e: MouseEvent) => void;
  private onMouseUp: (e: MouseEvent) => void;
  private onContextMenu: (e: MouseEvent) => void;

  constructor(
    camera: THREE.PerspectiveCamera,
    canvas: HTMLElement,
    opts: OrbitCameraOptions = {},
  ) {
    this.camera = camera;
    this.canvas = canvas;
    this.minDistance = opts.minDistance ?? 100;
    this.maxDistance = opts.maxDistance ?? 8000;
    this.minPitch = opts.minPitch ?? 0.05;
    this.maxPitch = opts.maxPitch ?? Math.PI * 0.49;
    this.zoomStepFactor = opts.zoomStepFactor ?? 1 + 1 / 8;
    this.rotateSpeed = opts.rotateSpeed ?? 0.005;
    this.panMultiplier = opts.panMultiplier ?? 1.0;
    this.arrowDragMaxDist = opts.arrowDragMaxDist ?? 100;
    this.onPanState = opts.onPanState;
    this.getCursorWorldPoint = opts.getCursorWorldPoint;

    this.toDistance = this.distance;
    this.toTargetX = this.target.x;
    this.toTargetZ = this.target.z;

    this.onWheel = (e) => {
      e.preventDefault();
      // Per-wheel-tick discrete step, sign-only.
      //   scroll up   (deltaY < 0)  → zoom in
      //   scroll down (deltaY > 0)  → zoom out
      if (e.deltaY === 0) return;

      const factor = e.deltaY > 0 ? this.zoomStepFactor : 1 / this.zoomStepFactor;
      const newToDistance = Math.min(
        this.maxDistance,
        Math.max(this.minDistance, this.toDistance * factor),
      );
      if (newToDistance === this.toDistance) return; // already at clamp

      // Zoom-to-cursor: capture the world point under the cursor
      // BEFORE the dolly (sampled against the to-state — i.e. where
      // the camera is heading, so chained scrolls compound), change
      // the to-distance, sample AFTER, shift the to-target so the
      // SAME world point lands under the SAME pixel after the eased
      // dolly completes. We temporarily push the to-state into the
      // rendered camera to do the projection math, then restore
      // (rendered-state-restoration matters when smoothing is on so
      // the camera doesn't visually jump).
      const renderedDist = this.distance;
      const renderedTargetX = this.target.x;
      const renderedTargetZ = this.target.z;
      this.distance = this.toDistance;
      this.target.x = this.toTargetX;
      this.target.z = this.toTargetZ;
      this.apply();

      const beforeRaw = this._cursorWorldPoint(e.clientX, e.clientY);
      let beforeX = 0;
      let beforeZ = 0;
      let haveBefore = false;
      if (beforeRaw) {
        beforeX = beforeRaw.x;
        beforeZ = beforeRaw.z;
        haveBefore = true;
      }

      this.distance = newToDistance;
      this.apply();
      let afterX = 0;
      let afterZ = 0;
      let haveAfter = false;
      if (haveBefore) {
        const afterRaw = this._cursorWorldPoint(e.clientX, e.clientY);
        if (afterRaw) {
          afterX = afterRaw.x;
          afterZ = afterRaw.z;
          haveAfter = true;
        }
      }

      // Build the new to-state: distance changed, target shifted by
      // (before − after) so the cursor pin holds.
      this.toDistance = newToDistance;
      if (haveBefore && haveAfter) {
        this.toTargetX += beforeX - afterX;
        this.toTargetZ += beforeZ - afterZ;
      }

      // Restore rendered state (or, in snap mode, leave at to-state).
      if (this.smoothTauSec > 0) {
        this.distance = renderedDist;
        this.target.x = renderedTargetX;
        this.target.z = renderedTargetZ;
        this.apply();
      } else {
        this.distance = this.toDistance;
        this.target.x = this.toTargetX;
        this.target.z = this.toTargetZ;
        this.apply();
      }
    };

    this.onMouseDown = (e) => {
      // Middle mouse button = camera control
      if (e.button !== 1) return;
      e.preventDefault();
      this.dragMode = e.altKey ? 'orbit' : 'pan';
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
      this.dragOriginScreen = { x: e.clientX, y: e.clientY };
      if (this.dragMode === 'pan') {
        // Capture the cursor's 3D anchor distance so the drag's
        // world-per-pixel scaling is accurate to terrain depth, not
        // to the orbit target's depth. The result: the world point
        // under the cursor at drag-start tracks the cursor exactly
        // through the entire drag.
        const hit = this._cursorWorldPoint(e.clientX, e.clientY);
        if (hit) {
          const cdx = this.camera.position.x - hit.x;
          const cdy = this.camera.position.y - hit.y;
          const cdz = this.camera.position.z - hit.z;
          this.panAnchorDistance = Math.hypot(cdx, cdy, cdz);
        } else {
          this.panAnchorDistance = this.distance;
        }
      }
    };

    this.onMouseMove = (e) => {
      if (this.dragMode === 'none') return;
      const dx = e.clientX - this.lastMouseX;
      const dy = e.clientY - this.lastMouseY;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;

      // Emit pan-state to the shared HUD overlay (drag-pan arrow).
      if (this.dragMode === 'pan' && this.onPanState) {
        const totalDx = e.clientX - this.dragOriginScreen.x;
        const totalDy = e.clientY - this.dragOriginScreen.y;
        const dist = Math.hypot(totalDx, totalDy);
        if (dist > 0) {
          this.onPanState(
            totalDx / dist,
            totalDy / dist,
            Math.min(dist / this.arrowDragMaxDist, 1),
          );
        }
      }

      if (this.dragMode === 'orbit') {
        // Orbit (yaw / pitch) is applied directly to the rendered
        // values — no EMA — because orbit changes the rendering
        // basis vectors and any in-flight pan / zoom animations
        // computed against the OLD basis would be subtly wrong.
        // Drag up → camera tilts up; drag down → camera tilts down
        // (Blender / Maya / Unity convention).
        this.yaw -= dx * this.rotateSpeed;
        this.pitch += dy * this.rotateSpeed;
        this.pitch = Math.min(this.maxPitch, Math.max(this.minPitch, this.pitch));
        this.apply();
      } else if (this.dragMode === 'pan') {
        // World-per-pixel at the cursor's 3D anchor depth — the
        // depth of whatever the cursor was over at drag-start.
        // Using this depth (instead of the orbit-target depth)
        // makes the cursor's world anchor track the cursor exactly
        // even on tilted views or hilly terrain.
        const vFovRad = (this.camera.fov * Math.PI) / 180;
        const worldPerPixel =
          (2 * Math.tan(vFovRad / 2) * this.panAnchorDistance) / this.canvas.clientHeight;
        const scale = worldPerPixel * this.panMultiplier;
        // Right + forward vectors at current yaw, on the ground plane.
        // Y (forward) is inverted vs X so vertical drag matches the
        // 2D camera's direction (drag down → camera moves south).
        const rx = Math.cos(this.yaw);
        const rz = Math.sin(this.yaw);
        const fx = Math.sin(this.yaw);
        const fz = -Math.cos(this.yaw);
        this.toTargetX -= dx * scale * rx - dy * scale * fx;
        this.toTargetZ -= dx * scale * rz - dy * scale * fz;
        if (this.smoothTauSec === 0) {
          this.target.x = this.toTargetX;
          this.target.z = this.toTargetZ;
          this.apply();
        }
      }
    };

    this.onMouseUp = (e) => {
      if (e.button !== 1) return;
      this.dragMode = 'none';
      this.onPanState?.(0, 0, 0);
    };

    this.onContextMenu = (e) => {
      e.preventDefault();
    };

    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    canvas.addEventListener('contextmenu', this.onContextMenu);

    this.apply();
  }

  /** Cursor → world position. Uses the user-supplied 3D raycaster
   *  callback if present; otherwise falls back to a y=0 plane
   *  projection (which is correct for flat ground but misses the
   *  actual surface elevation when terrain is hilly). */
  private _cursorWorldPoint(clientX: number, clientY: number): THREE.Vector3 | null {
    if (this.getCursorWorldPoint) {
      // The picker may return the same scratch Vector3 across calls;
      // the wheel handler captures coordinates as numbers (`beforeX`
      // / `beforeZ` etc.) so a shared reference is fine.
      return this.getCursorWorldPoint(clientX, clientY);
    }
    return this._cursorWorldPointGroundPlane(clientX, clientY, this._zoomGroundOut);
  }

  /** Fallback: project screen-space cursor onto the y=0 ground
   *  plane. Used only when `getCursorWorldPoint` is not installed. */
  private _cursorWorldPointGroundPlane(
    clientX: number,
    clientY: number,
    out: THREE.Vector3,
  ): THREE.Vector3 | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((clientY - rect.top) / rect.height) * 2 - 1);
    this._zoomNdc.set(ndcX, ndcY, 0.5).unproject(this.camera);
    const dirX = this._zoomNdc.x - this.camera.position.x;
    const dirY = this._zoomNdc.y - this.camera.position.y;
    const dirZ = this._zoomNdc.z - this.camera.position.z;
    if (Math.abs(dirY) < 1e-6) return null;
    const t = -this.camera.position.y / dirY;
    if (t < 0) return null; // intersection is behind the camera
    out.set(
      this.camera.position.x + t * dirX,
      0,
      this.camera.position.z + t * dirZ,
    );
    return out;
  }

  /** Recompute camera position from target + yaw + pitch + distance. */
  apply(): void {
    const sinP = Math.sin(this.pitch);
    const cosP = Math.cos(this.pitch);
    const x = this.target.x + this.distance * sinP * Math.sin(this.yaw);
    const y = this.target.y + this.distance * cosP;
    const z = this.target.z + this.distance * sinP * -Math.cos(this.yaw);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(this.target);
  }

  /** Set orbit target (and the to-target) without changing
   *  distance/yaw/pitch. Useful for explicit camera centers — e.g.
   *  centerCameraOnCommander — that should NOT animate via EMA
   *  (they're meant to be hard cuts). */
  setTarget(x: number, y: number, z: number): void {
    this.target.set(x, y, z);
    this.toTargetX = x;
    this.toTargetZ = z;
    this.apply();
  }

  /** Set the EMA time-constant in seconds for smooth zoom + pan.
   *  0 = snap (each input applies instantly, original behavior).
   *  Any positive value enables exponential smoothing of all
   *  to-state changes (zoom dolly + pan target shift) at that
   *  time-constant. Idempotent. Setting to 0 mid-animation jumps
   *  the rendered state to the to-state so it doesn't look frozen. */
  setSmoothTau(seconds: number): void {
    const clamped = Math.max(0, seconds);
    if (this.smoothTauSec === clamped) return;
    this.smoothTauSec = clamped;
    if (clamped === 0) {
      this.distance = this.toDistance;
      this.target.x = this.toTargetX;
      this.target.z = this.toTargetZ;
      this.apply();
    }
  }

  /** Per-frame integration step. Lerps the rendered state toward
   *  the to-state via EMA: alpha = 1 − exp(−dt / tau). Cheap no-op
   *  when tau is 0 or already converged. */
  tick(dtSec: number): void {
    if (this.smoothTauSec <= 0) return;
    const dDist = this.toDistance - this.distance;
    const dX = this.toTargetX - this.target.x;
    const dZ = this.toTargetZ - this.target.z;
    // Settled — snap to exact and stop spinning the integrator.
    if (
      Math.abs(dDist) < 1e-3 &&
      Math.abs(dX) < 1e-3 &&
      Math.abs(dZ) < 1e-3
    ) {
      if (dDist !== 0 || dX !== 0 || dZ !== 0) {
        this.distance = this.toDistance;
        this.target.x = this.toTargetX;
        this.target.z = this.toTargetZ;
        this.apply();
      }
      return;
    }
    const alpha = 1 - Math.exp(-dtSec / this.smoothTauSec);
    this.distance += dDist * alpha;
    this.target.x += dX * alpha;
    this.target.z += dZ * alpha;
    this.apply();
  }

  /** Install / replace the 3D cursor picker callback. The scene calls
   *  this once it has its terrain mesh ready; the orbit camera then
   *  uses the picker for all zoom + pan cursor pinning. */
  setCursorPicker(
    cb: ((clientX: number, clientY: number) => THREE.Vector3 | null) | undefined,
  ): void {
    this.getCursorWorldPoint = cb;
  }

  /** Register a callback for drag-pan state (used by the shared HUD overlay). */
  setOnPanState(
    cb: ((dirX: number, dirY: number, intensity: number) => void) | undefined,
  ): void {
    this.onPanState = cb;
  }

  destroy(): void {
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
  }
}
