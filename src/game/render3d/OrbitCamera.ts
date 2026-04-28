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

export type OrbitCameraOptions = {
  /** Distance clamps act as safety bounds — the wheel-zoom rail
   *  primarily clamps on `altitudeMin` / `altitudeMax`. Keep
   *  distance clamps generous because at near-horizontal pitch the
   *  resulting altitude depends weakly on distance (cos(pitch) → 0),
   *  so distance is the only thing keeping the orbit math sane. */
  minDistance?: number;
  maxDistance?: number;
  /** Camera altitude clamps (world Y, distance from the y=0 ground
   *  plane). These are what the user actually feels — at altitudeMin
   *  the camera is grazing the surface, at altitudeMax it's a
   *  panoramic overview. Replaces distance as the primary wheel-
   *  zoom rail so the user can't get "stuck on min zoom while close
   *  to the surface" or "stuck on max zoom while far away" — those
   *  states arose because distance and altitude diverged after
   *  cursor-pin shifts and target-y tracking. */
  altitudeMin?: number;
  altitudeMax?: number;
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
   *  raycasting against the scene to find the world point under the
   *  cursor. Used for both wheel zoom-to-cursor and pan-around-cursor.
   *  When unset, we fall back to a flat y=0 plane projection. */
  getCursorWorldPoint?: (clientX: number, clientY: number) => THREE.Vector3 | null;
  /** OPTIONAL terrain-height sampler — if set, the orbit camera
   *  lifts the rendered camera position so it never dips below the
   *  terrain plus `minTerrainClearance`. The clamp runs after the
   *  orbit math computes the position; lookAt(target) is called
   *  after the lift, so the camera keeps the target framed but
   *  glides above terrain when the orbit math would have buried it. */
  getTerrainHeight?: (x: number, z: number) => number;
  /** Minimum world-Y gap between the camera and the terrain
   *  beneath it. Defaults to 30 wu — enough to clear z-fighting and
   *  still let the camera get genuinely close to a hilltop. */
  minTerrainClearance?: number;
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
  private maxDistance: number;
  /** Wheel-zoom altitude clamps (camera world Y, distance from the
   *  y=0 ground plane along its normal). Replaces the previous
   *  distance-based clamps as the primary "you can't zoom further"
   *  rail because altitude is the axis the user actually feels — at
   *  altitudeMin the camera is grazing the surface, at altitudeMax
   *  it's a panoramic overview. Distance clamps stay as safety
   *  bounds (near-horizontal pitch makes altitude weakly dependent
   *  on distance, so a sane distance ceiling protects against
   *  runaway distance when cos(pitch) ≈ 0). */
  public altitudeMin: number;
  public altitudeMax: number;
  private minPitch: number;
  private maxPitch: number;
  private zoomStepFraction: number;
  private rotateSpeed: number;
  private panMultiplier: number;
  private getCursorWorldPoint?: (clientX: number, clientY: number) => THREE.Vector3 | null;
  private getTerrainHeight?: (x: number, z: number) => number;
  /** Minimum gap (world-Y) between the camera and terrain beneath
   *  it. The camera position is lifted in `apply()` whenever its
   *  computed Y would fall below `terrain + this`. */
  public minTerrainClearance = 30;

  private dragMode: 'none' | 'orbit' | 'pan' = 'none';
  private lastMouseX = 0;
  private lastMouseY = 0;

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
   *  exactly where it was on screen, no re-centering jump on the
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
  private _zoomNdc = new THREE.Vector3();
  private _zoomGroundOut = new THREE.Vector3();
  private _orbitOffsetTmp = new THREE.Vector3();
  private _orbitYawQuatTmp = new THREE.Quaternion();
  private _orbitPitchQuatTmp = new THREE.Quaternion();
  private _orbitRightTmp = new THREE.Vector3();
  private static _ORBIT_WORLD_Y = new THREE.Vector3(0, 1, 0);

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
    this.altitudeMin = opts.altitudeMin ?? 50;
    this.altitudeMax = opts.altitudeMax ?? 5000;
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

    this.toDistance = this.distance;
    this.toTargetX = this.target.x;
    this.toTargetY = this.target.y;
    this.toTargetZ = this.target.z;

    this.onWheel = (e) => {
      e.preventDefault();
      //   scroll up   (deltaY < 0)  → zoom in
      //   scroll down (deltaY > 0)  → zoom out
      if (e.deltaY === 0) return;

      // Fraction-toward-cursor zoom:
      //
      //   P0 = the actual rendered ground/water point under the
      //        cursor (raycast against the scene — what the user
      //        sees and is aiming at).
      //   f  = zoomStepFraction. Per scroll-IN tick the camera
      //        moves f of the way toward P0. Scroll-OUT applies
      //        the inverse factor 1/(1−f) so paired in/out ticks
      //        cancel exactly.
      //
      // The orbit math is `camera = target + distance · dir(yaw,
      // pitch)` with yaw/pitch held fixed by wheel input. The clean
      // way to slide the camera by (1−factor)·(P0 − camera) along
      // the cursor ray is to scale BOTH distance AND target by the
      // same factor toward P0:
      //
      //   newDistance = factor · oldDistance
      //   newTarget   = factor · oldTarget + (1 − factor) · P0
      //
      // Plugging back in: newCamera = factor · oldCamera + (1 −
      // factor) · P0, which lies exactly on the camera-to-P0 line
      // (= the cursor ray, since orientation is unchanged). So the
      // cursor pixel keeps mapping to P0 — no anchor drift across
      // tilts or terrain elevation, no plane-vs-mesh raycast
      // mismatch.
      //
      // Without a P0 hit (cursor off-canvas, no terrain beneath)
      // the move falls back to "zoom into the current target" —
      // equivalent to P0 ≡ target, which leaves toTarget unchanged.
      const f = this.zoomStepFraction;
      const wantFactor = e.deltaY > 0 ? 1 / (1 - f) : 1 - f;
      const p0 = this._cursorWorldPoint(e.clientX, e.clientY);

      // Cursor-pin formula: post-zoom camera position is
      //   c' = α · c + (1 − α) · p0
      // where p0 is the world point under the cursor (or the orbit
      // target if the cursor doesn't hit anything). Inverting on the Y
      // axis lets us solve for the α that lands camera.y on a chosen
      // altitude, which is how we clamp.
      //
      // Build "to-state" camera Y from the to-state target + distance:
      //   c.y = target.y + distance · cos(pitch)
      const cosP = Math.cos(this.pitch);
      const cameraY = this.toTargetY + this.toDistance * cosP;
      const anchorY = p0 ? p0.y : this.toTargetY;

      // Clamp on ALTITUDE rather than distance — that's the rail the
      // user feels. With the previous distance clamp + cursor-pin +
      // toTargetY tracking, target.y could drift far enough that
      // camera altitude diverged wildly from `baseDistance / distance`,
      // leaving you "stuck on min zoom while close to the surface" or
      // "stuck on max zoom while far away". Solving for α directly
      // from a target altitude makes those states unreachable.
      let actualFactor = wantFactor;
      const candidateCameraY = actualFactor * cameraY + (1 - actualFactor) * anchorY;
      if (candidateCameraY < this.altitudeMin || candidateCameraY > this.altitudeMax) {
        // Solve α from cursor-pin formula:
        //   target_y = α · cameraY + (1 − α) · anchorY
        //   α = (target_y − anchorY) / (cameraY − anchorY)
        const targetY = candidateCameraY < this.altitudeMin
          ? this.altitudeMin
          : this.altitudeMax;
        const denom = cameraY - anchorY;
        if (Math.abs(denom) > 1e-6) {
          actualFactor = (targetY - anchorY) / denom;
        } else {
          // cameraY ≈ anchorY: any α produces camera.y ≈ anchorY, and
          // anchorY is already outside the altitude band. Bail without
          // moving — there's no α that brings altitude into range.
          return;
        }
      }
      // Distance safety clamp — at near-horizontal pitch (cos pitch
      // → 0) altitude depends weakly on distance, so a runaway
      // distance is possible without hitting altitude bounds. The
      // generous distance clamp catches that without normally
      // triggering.
      const wantedDistance = this.toDistance * actualFactor;
      const newToDistance = Math.min(
        this.maxDistance,
        Math.max(this.minDistance, wantedDistance),
      );
      if (newToDistance === this.toDistance) return; // already at clamp
      // If the distance clamp fired, re-derive actualFactor so the
      // target shift stays in sync — otherwise the cursor pin drifts.
      actualFactor = newToDistance / this.toDistance;

      this.toDistance = newToDistance;
      if (p0) {
        const k = 1 - actualFactor;
        // Blend ALL THREE target axes toward p0 — Y matters because
        // the cursor pin invariant is c'_new = α·c + (1-α)·p0 in 3D,
        // not just XZ. Skipping Y leaves newCamera.y at α·c.y +
        // (1-α)·target.y instead of α·c.y + (1-α)·p0.y, and the
        // cursor pin drifts vertically by (1-α)·(p0.y - target.y)
        // per scroll whenever the user zooms over terrain at a
        // different height than target.y.
        this.toTargetX = actualFactor * this.toTargetX + k * p0.x;
        this.toTargetY = actualFactor * this.toTargetY + k * p0.y;
        this.toTargetZ = actualFactor * this.toTargetZ + k * p0.z;
      }

      // Snap mode applies inputs directly to the rendered state.
      // EMA mode leaves the rendered state and lets tick() ease.
      if (this.smoothTauSec === 0) {
        this.distance = this.toDistance;
        this.target.x = this.toTargetX;
        this.target.y = this.toTargetY;
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
      if (this.dragMode === 'pan') {
        // Capture the cursor's 3D ground point + camera-to-anchor
        // distance. The distance is what worldPerPixel keys off
        // during the drag — bounded at every camera pitch (no
        // blowup at near-horizontal views), and accurate to the
        // depth the user actually grabbed.
        const hit = this._cursorWorldPoint(e.clientX, e.clientY);
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
        const hit = this._cursorWorldPoint(e.clientX, e.clientY);
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
          this.orbitYawAccum -= dx * this.rotateSpeed;
          this.orbitPitchAccum += dy * this.rotateSpeed;
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
          this.yaw -= dx * this.rotateSpeed;
          this.pitch += dy * this.rotateSpeed;
          this.pitch = Math.min(this.maxPitch, Math.max(this.minPitch, this.pitch));
          this.apply();
        }
      } else if (this.dragMode === 'pan') {
        // Move-the-camera pan with bounded magnitude: world-per-pixel
        // is keyed to the camera-to-anchor distance captured at
        // drag-start (not the orbit target distance, not the
        // current rendered distance). That gives the right pan rate
        // for the depth the user grabbed, but stays bounded at
        // every camera pitch — no exact-3D plane-raycast blowup
        // when the camera is near horizontal. Drag direction is
        // RTS / 2D-camera convention: cursor drag direction =
        // camera drag direction in world.
        const refDist = this.panAnchorValid ? this.panAnchorDistance : this.distance;
        const vFovRad = (this.camera.fov * Math.PI) / 180;
        const worldPerPixel =
          (2 * Math.tan(vFovRad / 2) * refDist) / this.canvas.clientHeight;
        const scale = worldPerPixel * this.panMultiplier;
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
      this.orbitPivotActive = false;
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

  /** Cursor → world position. Tries the user-supplied 3D raycaster
   *  first (CursorGround, which hits the terrain tile mesh — the
   *  exact surface the user sees on land). If that misses — cursor
   *  over water / sky / off-map — falls back to a y=0 ground-plane
   *  projection so the wheel handler always has SOME anchor and
   *  the zoom keeps tracking the cursor instead of collapsing to
   *  the orbit target (which the user perceives as "zoom snaps to
   *  the centre of the map"). The plane projection is exact for
   *  flat ground and slightly above the water surface for water
   *  cells — close enough that the cursor stays visually pinned. */
  private _cursorWorldPoint(clientX: number, clientY: number): THREE.Vector3 | null {
    if (this.getCursorWorldPoint) {
      const hit = this.getCursorWorldPoint(clientX, clientY);
      if (hit) return hit;
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

  /** Recompute camera position from target + yaw + pitch + distance.
   *
   *  Terrain clearance: after the orbit math gives a candidate
   *  camera position, we sample the terrain at the camera's XZ and
   *  LIFT the camera so it never sits below `terrain +
   *  minTerrainClearance`. The lookAt(target) below then re-aims the
   *  camera; the result is a smooth "glide above terrain" — the
   *  camera always stays above the surface, even when the user has
   *  pitched it horizontal and the line-of-sight pivot would have
   *  buried it inside a hill. */
  apply(): void {
    const sinP = Math.sin(this.pitch);
    const cosP = Math.cos(this.pitch);
    const x = this.target.x + this.distance * sinP * Math.sin(this.yaw);
    let y = this.target.y + this.distance * cosP;
    const z = this.target.z + this.distance * sinP * -Math.cos(this.yaw);
    if (this.getTerrainHeight) {
      const groundY = this.getTerrainHeight(x, z);
      const minY = groundY + this.minTerrainClearance;
      if (y < minY) y = minY;
    }
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
    this.toTargetY = y;
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
    cb: ((clientX: number, clientY: number) => THREE.Vector3 | null) | undefined,
  ): void {
    this.getCursorWorldPoint = cb;
  }

  /** Install / replace the terrain-height sampler. While set, every
   *  apply() lifts the camera above the local terrain by at least
   *  `minTerrainClearance` — the camera can't dip into geometry. */
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
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
  }
}
