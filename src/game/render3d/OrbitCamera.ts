// OrbitCamera — RTS-style orbit camera controller for Three.js.
//
// Controls:
//   - Scroll wheel        → zoom (dolly along view direction)
//   - Alt + middle drag   → orbit (yaw + pitch)
//   - Middle drag         → pan (slide target on the world ground)
//   - Ctrl + middle drag  → height pan (left/right on ground, up/down in world height)
//   - Shift held          → fine camera control (1/10 movement)
//   - Touch 1 finger      → pan
//   - Touch 2 fingers     → centroid pan + pinch zoom + twist rotate
//
// Architecture: every input that changes the camera (wheel, pan drag,
// orbit drag) writes into a single TO-STATE — `(toDistance,
// toTargetX, toTargetY, toTargetZ)` plus `yaw / pitch` for orbit —
// that represents wherever the camera is heading. The rendered state
// (`distance`, `target.x`, `target.y`, `target.z`) lerps toward the
// to-state every frame via standard EMA: `alpha = 1 − exp(−dt / tau)`.
// When tau == 0 (snap mode) inputs apply directly to the rendered state.
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
import type {
  CameraAnchor,
  CameraAnchorTerrain,
  CameraTerrainCollisionMode,
} from '../../types/camera';

const TOUCH_ROTATE_DEADZONE_RAD = 0.006;
const TOUCH_ROTATE_MAX_DELTA_RAD = 0.35;
const SHIFT_CAMERA_INPUT_SCALE = 0.1;

export type OrbitCameraOptions = {
  /** Closest-approach zoom-in rail. Terrain clearance is resolved
   *  separately as a render-time eye floor that never alters the orbit
   *  state, so there is no zoom-OUT rail and the zoom limits stay
   *  absolute (history-independent). */
  minDistance?: number;
  /** Reference far distance for HUD fade scaling — NOT a zoom-out cap.
   *  The camera can dolly past it freely; HUD elements key off this so
   *  the fade window tracks map size. */
  farReferenceDistance?: number;
  minPitch?: number;
  maxPitch?: number;
  /** Per-wheel-tick zoom fraction. Each scroll-IN moves the
   *  camera this fraction of the way toward the cursor's actual
   *  rendered ground point (raycast against the scene); scroll-
   *  OUT applies the inverse factor 1/(1−f) so paired in/out
   *  ticks cancel exactly. Distance and target both scale by the
   *  same factor, which keeps the cursor pixel pinned to its
   *  world point through the move. */
  zoomStepFraction?: number;
  rotateSpeed?: number;
  /** Multiplier applied on top of world-per-pixel when panning. Matches the
   *  2D CAMERA_PAN_MULTIPLIER so pan feel is consistent across renderers. */
  panMultiplier?: number;
  /** OPTIONAL 3D cursor picker — if set, the orbit camera uses real
   *  raycasting against the scene to find the configured world anchor.
   *  Used for wheel zoom, orbit pivots, and pan grab-depth capture. */
  getCursorWorldPoint?: (
    clientX: number,
    clientY: number,
    terrainMode: CameraAnchorTerrain,
  ) => THREE.Vector3 | null;
  /** OPTIONAL terrain-height sampler — if set, the orbit camera
   *  resolves a small 3D clearance sphere against nearby terrain
   *  normals so it cannot dip into hills or clip sideways into
   *  steep terrain. */
  getTerrainHeight?: (x: number, z: number) => number;
  /** Minimum 3D gap between the camera and nearby terrain. */
  minTerrainClearance?: number;
  /** How the camera resolves a frame where the eye would dip below
   *  terrain — see CameraTerrainCollisionMode. Defaults to 'raiseEye'. */
  terrainCollisionMode?: CameraTerrainCollisionMode;
  /** Anchor pair for SCROLL-IN. */
  zoomInAnchor?: CameraAnchor;
  /** Anchor pair for SCROLL-OUT. */
  zoomOutAnchor?: CameraAnchor;
  /** Anchor pair for ALT + middle-click ORBIT. */
  rotateAnchor?: CameraAnchor;
  /** Anchor pair for drag-pan depth capture. */
  panAnchor?: CameraAnchor;
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
  // Y is tracked alongside X/Z because the cursor-pin formula needs
  // to blend target.y toward the cursor world point's altitude every
  // wheel tick — without that, zooming over terrain at any height
  // ≠ target.y drifts the cursor pin vertically by (1-α)·(p0.y -
  // target.y) per scroll, and the drift accumulates until the cursor
  // pin is permanently broken.
  private toDistance = 1500;
  private toTargetX = 0;
  private toTargetY = 0;
  private toTargetZ = 0;

  /** EMA time-constant in seconds. 0 disables smoothing (snap mode).
   *  After tau seconds the rendered state is ~63% of the way to the
   *  to-state; after 3·tau ~95%. */
  public smoothTauSec = 0;

  private minDistance: number;
  /** HUD-fade far reference (see getFarReferenceDistance). Not a clamp. */
  private farReferenceDistance: number;
  private minPitch: number;
  private maxPitch: number;
  private targetMinX = -Infinity;
  private targetMaxX = Infinity;
  private targetMinZ = -Infinity;
  private targetMaxZ = Infinity;
  private zoomStepFraction: number;
  private rotateSpeed: number;
  private panMultiplier: number;
  private getCursorWorldPoint?: (
    clientX: number,
    clientY: number,
    terrainMode: CameraAnchorTerrain,
  ) => THREE.Vector3 | null;
  private getTerrainHeight?: (x: number, z: number) => number;
  /** Minimum 3D gap between the camera and nearby terrain. */
  public minTerrainClearance = 30;
  private terrainCollisionMode: CameraTerrainCollisionMode = 'raiseEye';

  /** Anchor pair for each gesture. The wheel handler reads
   *  `zoomInAnchor` vs `zoomOutAnchor` based on scroll direction so
   *  the two halves of the zoom can use different anchors. Defaults
   *  use cursor for both so paired wheel ticks are inverse. The
   *  orbit drag and touch twist use `rotateAnchor`, and pan uses
   *  `panAnchor` for its grab-depth capture. */
  private zoomInAnchor: CameraAnchor = { screen: 'cursor', terrain: 'terrain-3d-water' };
  private zoomOutAnchor: CameraAnchor = { screen: 'cursor', terrain: 'terrain-3d-water' };
  private rotateAnchor: CameraAnchor = { screen: 'screen-center', terrain: 'terrain-3d-water' };
  private panAnchorMode: CameraAnchor = { screen: 'cursor', terrain: 'terrain-3d-water' };

  private dragMode: 'none' | 'orbit' | 'pan' | 'height-pan' = 'none';
  private lastMouseX = 0;
  private lastMouseY = 0;
  private touchMode: 'none' | 'pan' | 'pinch' = 'none';
  private touchLastCenterX = 0;
  private touchLastCenterY = 0;
  private touchLastDistance = 0;
  private touchLastAngle = 0;
  private previousTouchAction = '';

  /** 3D anchor point captured at drag-start (pan) — the actual
   *  rendered ground point the cursor was over when the user pressed
   *  the middle button. The pan rate is computed using the camera-
   *  to-anchor distance so the pan magnitude is right for the depth
   *  the user grabbed (not the orbit target depth) — bounded at all
   *  camera pitches, no per-pixel anomalies near horizontal views. */
  private panAnchor = new THREE.Vector3();
  private panAnchorValid = false;
  /** Distance from camera to panAnchor at drag-start, used as the
   *  reference depth for worldPerPixel during the pan. Locked at
   *  drag-start so EMA-driven camera motion during the drag doesn't
   *  feed back into the pan rate. */
  private panAnchorDistance = 0;

  /** Rigid-tumble orbit state — preserves camera position AND
   *  orientation at orbit drag-start. Subsequent yaw/pitch deltas
   *  rotate the camera around `orbitPivot` rigidly: pivot stays
   *  exactly where it was on screen, no re-centering snap on the
   *  first frame. After the drag ends, the orbit state (target,
   *  yaw, pitch, distance) is synthesized from the new camera
   *  position so future pan/zoom/apply behave normally. */
  private orbitPivotActive = false;
  private orbitPivot = new THREE.Vector3();
  private orbitStartCamPos = new THREE.Vector3();
  private orbitStartYaw = 0;
  private orbitStartPitch = 0;
  private orbitStartDistance = 0;
  private orbitYawAccum = 0;
  private orbitPitchAccum = 0;

  // Reusable scratch objects so the wheel handler does no per-event
  // allocations (zoom is the highest-frequency input on a trackpad).
  private _orbitOffsetTmp = new THREE.Vector3();
  private _orbitYawQuatTmp = new THREE.Quaternion();
  private _orbitPitchQuatTmp = new THREE.Quaternion();
  private _orbitRightTmp = new THREE.Vector3();
  private _cameraPosTmp = new THREE.Vector3();
  private _cameraLookAtTmp = new THREE.Vector3();
  private static _ORBIT_WORLD_Y = new THREE.Vector3(0, 1, 0);

  private canvas: HTMLElement;
  private onWheel: (e: WheelEvent) => void;
  private onMouseDown: (e: MouseEvent) => void;
  private onMouseMove: (e: MouseEvent) => void;
  private onMouseUp: (e: MouseEvent) => void;
  private onTouchStart: (e: TouchEvent) => void;
  private onTouchMove: (e: TouchEvent) => void;
  private onTouchEnd: (e: TouchEvent) => void;
  private onContextMenu: (e: MouseEvent) => void;

  constructor(
    camera: THREE.PerspectiveCamera,
    canvas: HTMLElement,
    opts: OrbitCameraOptions = {},
  ) {
    this.camera = camera;
    this.canvas = canvas;
    this.minDistance = opts.minDistance ?? 100;
    this.farReferenceDistance = opts.farReferenceDistance ?? 8000;
    this.minPitch = opts.minPitch ?? 0.05;
    this.maxPitch = opts.maxPitch ?? Math.PI * 0.49;
    this.zoomStepFraction = opts.zoomStepFraction ?? 0.125;
    this.rotateSpeed = opts.rotateSpeed ?? 0.005;
    this.panMultiplier = opts.panMultiplier ?? 1.0;
    this.getCursorWorldPoint = opts.getCursorWorldPoint;
    this.getTerrainHeight = opts.getTerrainHeight;
    if (opts.minTerrainClearance !== undefined) {
      this.minTerrainClearance = Math.max(0, opts.minTerrainClearance);
    }
    if (opts.terrainCollisionMode !== undefined) {
      this.terrainCollisionMode = opts.terrainCollisionMode;
    }
    if (opts.zoomInAnchor !== undefined) this.zoomInAnchor = opts.zoomInAnchor;
    if (opts.zoomOutAnchor !== undefined) this.zoomOutAnchor = opts.zoomOutAnchor;
    if (opts.rotateAnchor !== undefined) this.rotateAnchor = opts.rotateAnchor;
    if (opts.panAnchor !== undefined) this.panAnchorMode = opts.panAnchor;

    this.toDistance = this.distance;
    this.toTargetX = this.target.x;
    this.toTargetY = this.target.y;
    this.toTargetZ = this.target.z;
    this.previousTouchAction = canvas.style.touchAction;
    canvas.style.touchAction = 'none';

    this.onWheel = (e) => {
      e.preventDefault();
      //   scroll up   (delta < 0)  → zoom in
      //   scroll down (delta > 0)  → zoom out
      //
      // Browsers commonly remap Shift + wheel into horizontal
      // deltaX scrolling. Treat that as the same wheel gesture so
      // Shift remains fine zoom instead of making zoom appear dead.
      const wheelDelta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      if (wheelDelta === 0) return;

      // Wheel zoom scales distance against the broad distance rails
      // and shifts the target by the same factor around the selected
      // anchor. Terrain never re-solves the wheel factor with a
      // vertical-only altitude rule; zoom destinations are checked
      // with the same 3D clearance approximation used at render time.
      const f = this.zoomStepFraction * this.modifierInputScale(e);
      const zoomingIn = wheelDelta < 0;
      // Each zoom direction still has its own configurable anchor, but
      // the default is cursor for both directions. That keeps paired
      // scroll-in / scroll-out ticks symmetric instead of making a
      // reversal pivot around a different world point.
      const anchor = zoomingIn ? this.zoomInAnchor : this.zoomOutAnchor;
      const factor = zoomingIn ? 1 - f : 1 / (1 - f);
      this.zoomByFactorAt(e.clientX, e.clientY, factor, anchor);
    };

    this.onMouseDown = (e) => {
      // Middle mouse button = camera control
      if (e.button !== 1) return;
      e.preventDefault();
      this.dragMode = e.altKey ? 'orbit' : e.ctrlKey ? 'height-pan' : 'pan';
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
      if (this.dragMode === 'pan' || this.dragMode === 'height-pan') {
        this.capturePanAnchor(e.clientX, e.clientY);
      } else if (this.dragMode === 'orbit') {
        // Capture pivot + start camera position + start yaw/pitch
        // for a RIGID tumble around the cursor's 3D ground point.
        // Nothing about the camera (position, orientation, yaw,
        // pitch) changes at drag-start — the camera stays exactly
        // where it was, looking exactly where it was. Only on
        // subsequent mousemoves do yaw/pitch deltas accumulate and
        // drive a rigid rotation of the camera around the pivot,
        // so the pivot stays anchored on screen but the camera
        // doesn't re-center on it.
        //
        // Pivot location follows `rotateAnchor`: by default the
        // ground point at the SCREEN CENTER (the framed view
        // tumbles around itself), or the ground point under the
        // cursor when configured. Same picker either way — both
        // return null if the chosen point misses geometry, in
        // which case we fall through to the no-pivot orbit branch.
        const hit = this._anchorWorldPoint(e.clientX, e.clientY, this.rotateAnchor);
        if (hit) {
          this.orbitPivot.copy(hit);
          // Make sure the camera position is up-to-date before we
          // capture it as the rigid-rotation reference.
          this.apply();
          this.orbitStartCamPos.copy(this.camera.position);
          this.orbitStartYaw = this.yaw;
          this.orbitStartPitch = this.pitch;
          this.orbitStartDistance = this.distance;
          this.orbitYawAccum = 0;
          this.orbitPitchAccum = 0;
          this.orbitPivotActive = true;
        } else {
          this.orbitPivotActive = false;
        }
      }
    };

    this.onMouseMove = (e) => {
      if (this.dragMode === 'none') return;
      const dx = e.clientX - this.lastMouseX;
      const dy = e.clientY - this.lastMouseY;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;

      if (this.dragMode === 'orbit') {
        const inputScale = this.modifierInputScale(e);
        const scaledDx = dx * inputScale;
        const scaledDy = dy * inputScale;
        // RIGID TUMBLE around the cursor's 3D ground pivot. The
        // total yaw/pitch deltas since drag-start are applied as a
        // single rigid rotation of the camera around `orbitPivot`:
        //
        //   1. Take the start offset (orbitStartCamPos − pivot).
        //   2. Rotate it around world Y by the world-rotation that
        //      corresponds to the yaw delta (= R_y(−Δyaw_value),
        //      since our orbit "yaw" increases as the camera swings
        //      counterclockwise around target → world rotation is
        //      negative-yaw-value).
        //   3. Then rotate it around the new yaw's right axis by
        //      the world-rotation that matches the pitch delta
        //      (= +Δpitch_value around right_world).
        //   4. New camera position = pivot + rotated offset.
        //   5. Camera looks at a SYNTHESIZED target = camera_pos −
        //      distance · dir(newYaw, newPitch). That target sits
        //      on the back-extension of the camera's view direction,
        //      and lookAt(target) reproduces the rigid-rotation
        //      orientation exactly. After drag-end, future pan/zoom
        //      operate on this target naturally.
        //
        // Net result: camera position AND orientation are unchanged
        // when the drag starts (Δ = 0 → R = identity → camera at
        // startCamPos, looking at startTarget). As the user drags,
        // both rotate rigidly around the pivot — pivot stays
        // exactly under the same screen pixel through the whole
        // drag.
        if (this.orbitPivotActive) {
          this.orbitYawAccum -= scaledDx * this.rotateSpeed;
          this.orbitPitchAccum += scaledDy * this.rotateSpeed;
          // Clamp the EFFECTIVE pitch (start + accum) to the orbit
          // range so the camera can't flip upside-down.
          let newPitch = this.orbitStartPitch + this.orbitPitchAccum;
          if (newPitch < this.minPitch) {
            newPitch = this.minPitch;
            this.orbitPitchAccum = newPitch - this.orbitStartPitch;
          } else if (newPitch > this.maxPitch) {
            newPitch = this.maxPitch;
            this.orbitPitchAccum = newPitch - this.orbitStartPitch;
          }
          const newYaw = this.orbitStartYaw + this.orbitYawAccum;

          // Rigid rotation: yaw around world Y, then pitch around
          // the (post-yaw) right axis. Apply to the start offset
          // from pivot; result is the new camera world position.
          this._orbitOffsetTmp.copy(this.orbitStartCamPos).sub(this.orbitPivot);
          // Yaw: world Y by −Δyaw_value (see header comment).
          this._orbitYawQuatTmp.setFromAxisAngle(
            OrbitCamera._ORBIT_WORLD_Y,
            -this.orbitYawAccum,
          );
          this._orbitOffsetTmp.applyQuaternion(this._orbitYawQuatTmp);
          // Pitch axis: right_world at the NEW yaw. For our orbit
          // convention, right_world(yaw) = (−cos(yaw), 0, −sin(yaw)).
          this._orbitRightTmp.set(-Math.cos(newYaw), 0, -Math.sin(newYaw));
          this._orbitPitchQuatTmp.setFromAxisAngle(
            this._orbitRightTmp,
            this.orbitPitchAccum,
          );
          this._orbitOffsetTmp.applyQuaternion(this._orbitPitchQuatTmp);

          // New camera position = pivot + rigid-rotated offset.
          // Synthesize target so that with new yaw/pitch/distance
          // (distance unchanged), apply() produces this same camera
          // position AND lookAt(target) gives the rigid orientation.
          this.yaw = newYaw;
          this.pitch = newPitch;
          // distance stays at orbitStartDistance — rigid rotation
          // preserves camera-to-pivot distance, but our orbit
          // distance is camera-to-target which is what apply() uses.
          this.distance = this.orbitStartDistance;
          this.toDistance = this.orbitStartDistance;
          const cx = this.orbitPivot.x + this._orbitOffsetTmp.x;
          const cy = this.orbitPivot.y + this._orbitOffsetTmp.y;
          const cz = this.orbitPivot.z + this._orbitOffsetTmp.z;
          // dir(yaw, pitch) — the unit vector from target → camera.
          const sinP = Math.sin(this.pitch);
          const cosP = Math.cos(this.pitch);
          const dirX = sinP * Math.sin(this.yaw);
          const dirY = cosP;
          const dirZ = sinP * -Math.cos(this.yaw);
          // target = camera − distance · dir.
          this.target.set(
            cx - this.distance * dirX,
            cy - this.distance * dirY,
            cz - this.distance * dirZ,
          );
          this.toTargetX = this.target.x;
          this.toTargetY = this.target.y;
          this.toTargetZ = this.target.z;
          // apply() will write camera.position = target + d·dir = (cx,cy,cz)
          // and camera.lookAt(target) = lookAt the synthesized point,
          // giving the rigid-rotation orientation.
          this.apply();
        } else {
          // Fallback: no pivot — orbit around the existing target
          // exactly the way the camera always did before this fix.
          this.yaw -= scaledDx * this.rotateSpeed;
          this.pitch += scaledDy * this.rotateSpeed;
          this.pitch = Math.min(this.maxPitch, Math.max(this.minPitch, this.pitch));
          this.apply();
        }
      } else if (this.dragMode === 'pan') {
        const inputScale = this.modifierInputScale(e);
        this.panByScreenDelta(dx * inputScale, dy * inputScale);
      } else if (this.dragMode === 'height-pan') {
        const inputScale = this.modifierInputScale(e);
        this.panHeightByScreenDelta(dx * inputScale, dy * inputScale);
      }
    };

    this.onMouseUp = (e) => {
      if (e.button !== 1) return;
      this.dragMode = 'none';
      this.orbitPivotActive = false;
    };

    this.onTouchStart = (e) => {
      if (e.touches.length === 0) return;
      e.preventDefault();
      this.dragMode = 'none';
      this.orbitPivotActive = false;
      this.beginTouchGesture(e);
    };

    this.onTouchMove = (e) => {
      if (this.touchMode === 'none' || e.touches.length === 0) return;
      e.preventDefault();
      const nextMode = e.touches.length >= 2 ? 'pinch' : 'pan';
      if (nextMode !== this.touchMode) {
        this.beginTouchGesture(e);
        return;
      }

      const center = this.touchCenter(e);
      const dx = center.x - this.touchLastCenterX;
      const dy = center.y - this.touchLastCenterY;
      this.panByTouchScreenDelta(dx, dy);

      if (nextMode === 'pinch') {
        const dist = this.touchDistance(e);
        const angle = this.touchAngle(e);
        if (dist > 1 && this.touchLastDistance > 1) {
          // Fingers apart means zoom in. Clamp the per-event factor
          // so browser event bursts cannot create a jarring snap.
          const factor = Math.min(1.25, Math.max(0.8, this.touchLastDistance / dist));
          this.zoomByFactorAt(center.x, center.y, factor);
        }
        if (Number.isFinite(angle) && Number.isFinite(this.touchLastAngle)) {
          const twist = OrbitCamera.normalizeAngleDelta(angle - this.touchLastAngle);
          if (Math.abs(twist) >= TOUCH_ROTATE_DEADZONE_RAD) {
            const clampedTwist = Math.max(
              -TOUCH_ROTATE_MAX_DELTA_RAD,
              Math.min(TOUCH_ROTATE_MAX_DELTA_RAD, twist),
            );
            // Screen-space clockwise twist should rotate the map clockwise,
            // which is camera-yaw negative in this orbit convention.
            this.rotateYawAroundScreenPoint(center.x, center.y, -clampedTwist);
          }
        }
        this.touchLastDistance = dist;
        this.touchLastAngle = angle;
      }

      this.touchLastCenterX = center.x;
      this.touchLastCenterY = center.y;
    };

    this.onTouchEnd = (e) => {
      e.preventDefault();
      if (e.touches.length === 0) {
        this.touchMode = 'none';
        this.panAnchorValid = false;
        return;
      }
      this.beginTouchGesture(e);
    };

    this.onContextMenu = (e) => {
      e.preventDefault();
    };

    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    canvas.addEventListener('touchstart', this.onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', this.onTouchMove, { passive: false });
    canvas.addEventListener('touchend', this.onTouchEnd, { passive: false });
    canvas.addEventListener('touchcancel', this.onTouchEnd, { passive: false });
    canvas.addEventListener('contextmenu', this.onContextMenu);

    this.apply();
  }

  private applyDestinationIfSnap(): void {
    // Snap mode applies inputs directly to the rendered state.
    // EMA mode leaves the rendered state and lets tick() ease.
    if (this.smoothTauSec !== 0) return;
    this.distance = this.toDistance;
    this.target.x = this.toTargetX;
    this.target.y = this.toTargetY;
    this.target.z = this.toTargetZ;
    this.apply();
  }

  private modifierInputScale(e: Pick<MouseEvent | WheelEvent, 'shiftKey'>): number {
    return e.shiftKey ? SHIFT_CAMERA_INPUT_SCALE : 1;
  }

  private zoomByFactorAt(
    clientX: number,
    clientY: number,
    wantFactor: number,
    anchor?: CameraAnchor,
  ): void {
    if (!Number.isFinite(wantFactor) || wantFactor <= 0 || this.toDistance <= 0) return;
    const p0 = this._anchorWorldPoint(
      clientX,
      clientY,
      anchor ?? (wantFactor < 1 ? this.zoomInAnchor : this.zoomOutAnchor),
    );
    const wantedDistance = this.toDistance * wantFactor;
    // Zoom limits are ABSOLUTE and history-independent: bounded below by
    // the zoom-in rail, unbounded above. Terrain is NEVER allowed to feed
    // back into the dolly distance — it is resolved purely as a render-
    // time eye floor in apply() that leaves the orbit state untouched. So
    // hitting a mountain can't cache a different zoom-in/out limit.
    let nextDistance = Math.max(this.minDistance, wantedDistance);
    if (nextDistance === this.toDistance) return; // already at the zoom-in rail
    const actualFactor = nextDistance / this.toDistance;
    const startTargetX = this.toTargetX;
    const startTargetY = this.toTargetY;
    const startTargetZ = this.toTargetZ;
    let nextTargetX = startTargetX;
    let nextTargetY = startTargetY;
    let nextTargetZ = startTargetZ;
    if (p0) {
      const k = 1 - actualFactor;
      // Blend ALL THREE target axes toward p0 — Y matters because
      // the cursor pin invariant is c'_new = α·c + (1-α)·p0 in 3D,
      // not just XZ. Skipping Y leaves newCamera.y at α·c.y +
      // (1-α)·target.y instead of α·c.y + (1-α)·p0.y, and the
      // cursor pin drifts vertically by (1-α)·(p0.y - target.y)
      // per scroll / pinch whenever the user zooms over terrain at
      // a different height than target.y.
      nextTargetX = actualFactor * startTargetX + k * p0.x;
      nextTargetY = actualFactor * startTargetY + k * p0.y;
      nextTargetZ = actualFactor * startTargetZ + k * p0.z;
    }

    // No terrain clip-test on zoom. The render-time eye floor in apply()
    // lifts the camera over any terrain it would dive into, so the wheel
    // stays smooth instead of stalling near hills, and the orbit state is
    // never rewritten by terrain — zoom limits stay absolute.
    this.toTargetX = nextTargetX;
    this.toTargetY = nextTargetY;
    this.toTargetZ = nextTargetZ;
    this.toDistance = nextDistance;

    this.applyDestinationIfSnap();
  }

  private capturePanAnchor(clientX: number, clientY: number): void {
    // Capture the cursor's 3D ground point + camera-to-anchor
    // distance. The distance is what worldPerPixel keys off during
    // the drag — bounded at every camera pitch (no blowup at
    // near-horizontal views), and accurate to the depth the user
    // actually grabbed.
    const hit = this._anchorWorldPoint(clientX, clientY, this.panAnchorMode);
    if (hit) {
      this.panAnchor.copy(hit);
      const dxh = this.camera.position.x - hit.x;
      const dyh = this.camera.position.y - hit.y;
      const dzh = this.camera.position.z - hit.z;
      this.panAnchorDistance = Math.hypot(dxh, dyh, dzh);
      this.panAnchorValid = true;
    } else {
      this.panAnchorValid = false;
      this.panAnchorDistance = this.distance;
    }
  }

  private panWorldScale(): number {
    const refDist = this.panAnchorValid ? this.panAnchorDistance : this.distance;
    const vFovRad = (this.camera.fov * Math.PI) / 180;
    const worldPerPixel =
      (2 * Math.tan(vFovRad / 2) * refDist) / this.canvas.clientHeight;
    return worldPerPixel * this.panMultiplier;
  }

  private panByScreenDelta(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    // Move-the-camera pan with bounded magnitude: world-per-pixel
    // is keyed to the camera-to-anchor distance captured at
    // drag-start (not the orbit target distance, not the current
    // rendered distance). That gives the right pan rate for the
    // depth the user grabbed, but stays bounded at every camera
    // pitch — no exact-3D plane-raycast blowup when the camera is
    // near horizontal. Drag direction is RTS / 2D-camera convention:
    // cursor drag direction = camera drag direction in world.
    const scale = this.panWorldScale();
    const rx = Math.cos(this.yaw);
    const rz = Math.sin(this.yaw);
    const fx = Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    this.toTargetX -= dx * scale * rx - dy * scale * fx;
    this.toTargetZ -= dx * scale * rz - dy * scale * fz;
    this.applyDestinationIfSnap();
  }

  private panHeightByScreenDelta(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    const scale = this.panWorldScale();
    const rx = Math.cos(this.yaw);
    const rz = Math.sin(this.yaw);
    // Sim calls this vertical axis Z; Three.js stores it as world Y.
    // Dragging up (negative screen Y delta) raises the target.
    this.toTargetX -= dx * scale * rx;
    this.toTargetZ -= dx * scale * rz;
    this.toTargetY -= dy * scale;
    this.applyDestinationIfSnap();
  }

  private panByTouchScreenDelta(dx: number, dy: number): void {
    // Mobile uses the standard map gesture: the world follows the
    // finger. Desktop middle-drag still uses the configured
    // CAMERA_PAN_MULTIPLIER, but touch should feel 1:1, so divide it
    // out before going through the shared pan math.
    const multiplier = this.panMultiplier > 0 ? this.panMultiplier : 1;
    this.panByScreenDelta(-dx / multiplier, -dy / multiplier);
  }

  private rotateYawAroundScreenPoint(clientX: number, clientY: number, yawDelta: number): void {
    if (!Number.isFinite(yawDelta) || yawDelta === 0) return;
    const oldYaw = this.yaw;
    const newYaw = oldYaw + yawDelta;
    const pivot = this._anchorWorldPoint(clientX, clientY, this.rotateAnchor);
    if (!pivot) {
      this.yaw = newYaw;
      this.apply();
      return;
    }

    this.apply();
    const sinP = Math.sin(this.pitch);
    const cosP = Math.cos(this.pitch);
    const oldDirX = sinP * Math.sin(oldYaw);
    const oldDirY = cosP;
    const oldDirZ = sinP * -Math.cos(oldYaw);
    const newDirX = sinP * Math.sin(newYaw);
    const newDirY = cosP;
    const newDirZ = sinP * -Math.cos(newYaw);

    this._orbitYawQuatTmp.setFromAxisAngle(OrbitCamera._ORBIT_WORLD_Y, -yawDelta);

    // Rotate the rendered camera around the configured rotate anchor,
    // then synthesize the target that preserves that new camera pose
    // for the normal orbit state.
    this._orbitOffsetTmp.copy(this.camera.position).sub(pivot);
    this._orbitOffsetTmp.applyQuaternion(this._orbitYawQuatTmp);
    const camX = pivot.x + this._orbitOffsetTmp.x;
    const camY = pivot.y + this._orbitOffsetTmp.y;
    const camZ = pivot.z + this._orbitOffsetTmp.z;
    this.target.set(
      camX - this.distance * newDirX,
      camY - this.distance * newDirY,
      camZ - this.distance * newDirZ,
    );

    // Mirror the same rigid rotation into the smooth destination so
    // pan/zoom easing continues from the rotated endpoint instead of
    // pulling the view back toward the pre-twist heading.
    const toCamX = this.toTargetX + this.toDistance * oldDirX;
    const toCamY = this.toTargetY + this.toDistance * oldDirY;
    const toCamZ = this.toTargetZ + this.toDistance * oldDirZ;
    this._orbitOffsetTmp.set(toCamX - pivot.x, toCamY - pivot.y, toCamZ - pivot.z);
    this._orbitOffsetTmp.applyQuaternion(this._orbitYawQuatTmp);
    const toRotCamX = pivot.x + this._orbitOffsetTmp.x;
    const toRotCamY = pivot.y + this._orbitOffsetTmp.y;
    const toRotCamZ = pivot.z + this._orbitOffsetTmp.z;
    this.toTargetX = toRotCamX - this.toDistance * newDirX;
    this.toTargetY = toRotCamY - this.toDistance * newDirY;
    this.toTargetZ = toRotCamZ - this.toDistance * newDirZ;

    this.yaw = newYaw;
    this.apply();
  }

  private touchCenter(e: TouchEvent): { x: number; y: number } {
    const a = e.touches[0];
    const b = e.touches.length >= 2 ? e.touches[1] : null;
    if (!b) return { x: a.clientX, y: a.clientY };
    return {
      x: (a.clientX + b.clientX) * 0.5,
      y: (a.clientY + b.clientY) * 0.5,
    };
  }

  private touchDistance(e: TouchEvent): number {
    if (e.touches.length < 2) return 0;
    const a = e.touches[0];
    const b = e.touches[1];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  private touchAngle(e: TouchEvent): number {
    if (e.touches.length < 2) return Number.NaN;
    const a = e.touches[0];
    const b = e.touches[1];
    return Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX);
  }

  private static normalizeAngleDelta(delta: number): number {
    return Math.atan2(Math.sin(delta), Math.cos(delta));
  }

  private beginTouchGesture(e: TouchEvent): void {
    const center = this.touchCenter(e);
    this.touchMode = e.touches.length >= 2 ? 'pinch' : 'pan';
    this.touchLastCenterX = center.x;
    this.touchLastCenterY = center.y;
    this.touchLastDistance = this.touchMode === 'pinch' ? this.touchDistance(e) : 0;
    this.touchLastAngle = this.touchMode === 'pinch' ? this.touchAngle(e) : Number.NaN;
    this.capturePanAnchor(center.x, center.y);
  }

  /** Clamp both rendered target and smooth destination target to the
   *  camera's active map bounds. Keeping the two states constrained
   *  together avoids a smoothing tug-of-war at map edges. */
  private constrainTargets(): void {
    if (Number.isFinite(this.targetMinX) || Number.isFinite(this.targetMaxX)) {
      this.target.x = Math.min(this.targetMaxX, Math.max(this.targetMinX, this.target.x));
      this.toTargetX = Math.min(this.targetMaxX, Math.max(this.targetMinX, this.toTargetX));
    }
    if (Number.isFinite(this.targetMinZ) || Number.isFinite(this.targetMaxZ)) {
      this.target.z = Math.min(this.targetMaxZ, Math.max(this.targetMinZ, this.target.z));
      this.toTargetZ = Math.min(this.targetMaxZ, Math.max(this.targetMinZ, this.toTargetZ));
    }
  }

  private _worldPointForScreenPoint(
    clientX: number,
    clientY: number,
    terrainMode: CameraAnchorTerrain,
  ): THREE.Vector3 | null {
    return this.getCursorWorldPoint?.(clientX, clientY, terrainMode) ?? null;
  }

  /** Resolve the gesture's anchor world point from its configured
   *  screen axis and terrain axis. */
  private _anchorWorldPoint(
    clientX: number,
    clientY: number,
    anchor: CameraAnchor,
  ): THREE.Vector3 | null {
    if (anchor.screen === 'cursor') {
      return this._worldPointForScreenPoint(clientX, clientY, anchor.terrain);
    }
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const cx = rect.left + rect.width * 0.5;
    const cy = rect.top + rect.height * 0.5;
    return this._worldPointForScreenPoint(cx, cy, anchor.terrain);
  }

  private cameraPositionForState(
    targetX: number,
    targetY: number,
    targetZ: number,
    distance: number,
    yaw: number,
    pitch: number,
    out: THREE.Vector3,
  ): THREE.Vector3 {
    const sinP = Math.sin(pitch);
    const cosP = Math.cos(pitch);
    out.set(
      targetX + distance * sinP * Math.sin(yaw),
      targetY + distance * cosP,
      targetZ + distance * sinP * -Math.cos(yaw),
    );
    return out;
  }

  /** Largest pitch ≤ the authored pitch (i.e. closest to it, steepening
   *  toward minPitch) at which the eye — held on the orbit sphere at the
   *  given distance — clears terrain by minTerrainClearance.
   *
   *  When the authored pitch already clears, or the sampler returns NaN
   *  (off-map / before terrain loads), the authored pitch is returned
   *  unchanged. Steepening (decreasing pitch toward straight-down) both
   *  raises the eye and pulls its footprint toward the target, so it
   *  trends toward clearing; we march down from the authored pitch to the
   *  first clearing sample, then binary-search the surface. Bottoms out at
   *  minPitch in the degenerate case (target buried in a peak). Pure read
   *  — never mutates camera state. */
  private clearedPitch(
    sample: (x: number, z: number) => number,
    distance: number,
    yaw: number,
    pitch: number,
  ): number {
    const sinYaw = Math.sin(yaw);
    const cosYaw = Math.cos(yaw);
    // clearance(p) = eyeY(p) − (terrain beneath eye(p) + clearance). ≥0
    // clears, <0 penetrates; NaN propagates and counts as clearing via
    // every `!(c < 0)` test below.
    const clearance = (p: number): number => {
      const sinP = Math.sin(p);
      const ex = this.target.x + distance * sinP * sinYaw;
      const ez = this.target.z + distance * sinP * -cosYaw;
      const ey = this.target.y + distance * Math.cos(p);
      return ey - (sample(ex, ez) + this.minTerrainClearance);
    };
    if (!(clearance(pitch) < 0)) return pitch;

    const loP = this.minPitch;
    if (pitch <= loP) return loP;
    const STEPS = 24;
    const step = (pitch - loP) / STEPS;
    let blocked = pitch; // penetrates here (shallower / less steep)
    let cleared = -1;
    for (let i = 1; i <= STEPS; i++) {
      const p = pitch - i * step;
      if (!(clearance(p) < 0)) {
        cleared = p;
        break;
      }
      blocked = p;
    }
    if (cleared < 0) return loP; // even straight-down can't clear

    // Refine between the steeper clearing pitch and the shallower blocked
    // one. lo clears, hi penetrates; converge to the largest (least
    // steepened) pitch that still clears.
    let lo = cleared;
    let hi = blocked;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) * 0.5;
      if (!(clearance(mid) < 0)) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /** Recompute the rendered camera position from the orbit state
   *  (target + yaw + pitch + distance) and aim it at the target.
   *
   *  Terrain clearance is resolved per `terrainCollisionMode`, always as
   *  a pure render-time override that NEVER writes back into the orbit
   *  state — so zoom-in/out limits stay absolute and history-independent
   *  (brushing a mountain cannot cache a different limit), and the camera
   *  always looks at the target:
   *
   *  - 'none'       — render the eye exactly where the orbit state puts
   *                   it; it may pass under the heightfield.
   *  - 'raiseEye'   — lift only the eye's Y to the clearance height. The
   *                   eye keeps its horizontal footprint and leaves the
   *                   orbit sphere (true distance grows, view steepens).
   *                   pos.y = max(naturalY, floorY) is continuous, so
   *                   riding over a ridge has no pop.
   *  - 'clampPitch' — steepen the pitch so the eye stays ON the orbit
   *                   sphere at the stored distance; only the effective
   *                   pitch diverges from the stored pitch.
   *
   *  An earlier version pushed the camera along terrain normals and
   *  recovered yaw / pitch / distance from the adjusted position — which
   *  made the view spin and ratchet its zoom as the camera brushed hills
   *  while panning. Never reintroduce terrain → orbit-state write-back. */
  apply(): void {
    this.constrainTargets();
    // Resolve the sampler once; undefined disables clearance (mode 'none',
    // no sampler installed, or zero clearance).
    const sample =
      this.terrainCollisionMode !== 'none' && this.minTerrainClearance > 0
        ? this.getTerrainHeight
        : undefined;
    // clampPitch resolves BEFORE building the eye (it changes the angle).
    const renderPitch =
      sample && this.terrainCollisionMode === 'clampPitch'
        ? this.clearedPitch(sample, this.distance, this.yaw, this.pitch)
        : this.pitch;
    const pos = this.cameraPositionForState(
      this.target.x,
      this.target.y,
      this.target.z,
      this.distance,
      this.yaw,
      renderPitch,
      this._cameraPosTmp,
    );
    // raiseEye resolves AFTER building the eye (it lifts only Y). NaN-safe:
    // a NaN sample (off-map / before terrain loads) makes the comparison
    // false, so the eye is left where the orbit state put it.
    if (sample && this.terrainCollisionMode === 'raiseEye') {
      const floorY = sample(pos.x, pos.z) + this.minTerrainClearance;
      if (pos.y < floorY) pos.y = floorY;
    }
    this.camera.position.copy(pos);
    this.camera.lookAt(this._cameraLookAtTmp.copy(this.target));
  }

  /** Set orbit target (and the to-target) without changing
   *  distance/yaw/pitch. Useful for explicit camera centers — e.g.
   *  centerCameraOnCommander — that should NOT animate via EMA
   *  (they're meant to be hard cuts). */
  setTarget(x: number, y: number, z: number): void {
    this.target.set(x, y, z);
    this.toTargetX = x;
    this.toTargetY = y;
    this.toTargetZ = z;
    this.apply();
  }

  setDistance(distance: number): void {
    const d = Math.max(this.minDistance, distance);
    this.distance = d;
    this.toDistance = d;
    this.apply();
  }

  /** Far reference distance for HUD fade — keyed to map size so the fade
   *  window scales instead of using a fixed number. This is not a zoom
   *  rail: the camera can dolly past it; HUD elements are just fully
   *  faded by the time it reaches here. */
  getFarReferenceDistance(): number {
    return this.farReferenceDistance;
  }

  setOrbitAngles(yaw: number, pitch: number): void {
    this.yaw = yaw;
    this.pitch = Math.min(this.maxPitch, Math.max(this.minPitch, pitch));
    this.apply();
  }

  setTargetBounds(minX: number, minZ: number, maxX: number, maxZ: number): void {
    this.targetMinX = minX;
    this.targetMaxX = maxX;
    this.targetMinZ = minZ;
    this.targetMaxZ = maxZ;
    this.apply();
  }

  setState(state: {
    targetX: number;
    targetY: number;
    targetZ: number;
    distance: number;
    yaw: number;
    pitch: number;
  }): void {
    this.target.set(state.targetX, state.targetY, state.targetZ);
    this.toTargetX = state.targetX;
    this.toTargetY = state.targetY;
    this.toTargetZ = state.targetZ;
    this.distance = Math.max(this.minDistance, state.distance);
    this.toDistance = this.distance;
    this.yaw = state.yaw;
    this.pitch = Math.min(this.maxPitch, Math.max(this.minPitch, state.pitch));
    this.apply();
  }

  /** Set the EMA time-constant in seconds for smooth zoom + pan.
   *  0 = snap (each input applies instantly, original behavior).
   *  Any positive value enables exponential smoothing of all
   *  to-state changes (zoom dolly + pan target shift) at that
   *  time-constant. Idempotent. Setting to 0 mid-animation snaps
   *  the rendered state to the to-state so it doesn't look frozen. */
  setSmoothTau(seconds: number): void {
    const clamped = Math.max(0, seconds);
    if (this.smoothTauSec === clamped) return;
    this.smoothTauSec = clamped;
    if (clamped === 0) {
      this.distance = this.toDistance;
      this.target.x = this.toTargetX;
      this.target.y = this.toTargetY;
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
    const dY = this.toTargetY - this.target.y;
    const dZ = this.toTargetZ - this.target.z;
    // Settled — snap to exact and stop spinning the integrator.
    if (
      Math.abs(dDist) < 1e-3 &&
      Math.abs(dX) < 1e-3 &&
      Math.abs(dY) < 1e-3 &&
      Math.abs(dZ) < 1e-3
    ) {
      if (dDist !== 0 || dX !== 0 || dY !== 0 || dZ !== 0) {
        this.distance = this.toDistance;
        this.target.x = this.toTargetX;
        this.target.y = this.toTargetY;
        this.target.z = this.toTargetZ;
        this.apply();
      }
      return;
    }
    const alpha = 1 - Math.exp(-dtSec / this.smoothTauSec);
    this.distance += dDist * alpha;
    this.target.x += dX * alpha;
    this.target.y += dY * alpha;
    this.target.z += dZ * alpha;
    this.apply();
  }

  /** Install / replace the 3D cursor picker callback. The scene calls
   *  this once it has its terrain mesh ready; the orbit camera then
   *  uses the picker for all zoom + pan cursor pinning. */
  setCursorPicker(
    cb: ((
      clientX: number,
      clientY: number,
      terrainMode: CameraAnchorTerrain,
    ) => THREE.Vector3 | null) | undefined,
  ): void {
    this.getCursorWorldPoint = cb;
  }

  /** Install / replace the terrain-height sampler. While set, every
   *  apply() resolves the camera against nearby terrain with the
   *  configured 3D clearance. */
  setTerrainSampler(
    cb: ((x: number, z: number) => number) | undefined,
  ): void {
    this.getTerrainHeight = cb;
  }

  destroy(): void {
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.canvas.removeEventListener('touchstart', this.onTouchStart);
    this.canvas.removeEventListener('touchmove', this.onTouchMove);
    this.canvas.removeEventListener('touchend', this.onTouchEnd);
    this.canvas.removeEventListener('touchcancel', this.onTouchEnd);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.canvas.style.touchAction = this.previousTouchAction;
  }
}
