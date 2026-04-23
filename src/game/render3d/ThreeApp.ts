// ThreeApp — Three.js application wrapper (parallel to PixiApp, for the 3D PoC).
//
// Sets up a scene, renderer, camera, lights, and a ground plane. Owns the
// render loop and delegates per-frame work to a callback.

import * as THREE from 'three';
import { OrbitCamera } from './OrbitCamera';
import { GpuTimerQuery } from '../scenes/helpers/GpuTimerQuery';
import {
  CAMERA_PAN_MULTIPLIER,
  ZOOM_FACTOR,
  ZOOM_MIN,
  ZOOM_MAX,
  EDGE_SCROLL,
} from '../../config';

export class ThreeApp {
  public renderer: THREE.WebGLRenderer;
  public scene: THREE.Scene;
  public camera: THREE.PerspectiveCamera;
  public orbit: OrbitCamera;
  /** Container holding all game entities (units, buildings, projectiles). */
  public world: THREE.Group;
  /** Real GPU execution time per frame via EXT_disjoint_timer_query_webgl2.
   *  Results are async (available 2-3 frames after the render call). On
   *  browsers without the extension (Safari), isSupported() returns false
   *  and callers should fall back to CPU-side renderMs. */
  public gpuTimer: GpuTimerQuery;

  private _updateCallback: ((time: number, delta: number) => void) | null = null;
  private _lastTime = 0;
  private _running = false;
  private _rafId = 0;
  private _resizeObserver: ResizeObserver;

  constructor(
    parent: HTMLElement,
    width: number,
    height: number,
    mapWidth: number,
    mapHeight: number,
    backgroundColor: string,
  ) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(backgroundColor);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = false;
    parent.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(50, width / height, 1, 50000);

    // The 3D equivalent of "zoom=1" is a distance that shows roughly the same
    // region of the map as the 2D camera at its default zoom. Min/max distance
    // are derived from ZOOM_MIN/ZOOM_MAX so "zoomed in" / "zoomed out" bounds
    // match the 2D limits.
    const baseDistance = Math.max(mapWidth, mapHeight) * 0.35;
    this.orbit = new OrbitCamera(this.camera, this.renderer.domElement, {
      minDistance: baseDistance / ZOOM_MAX,
      maxDistance: baseDistance / ZOOM_MIN,
      zoomStepFactor: ZOOM_FACTOR,
      panMultiplier: CAMERA_PAN_MULTIPLIER,
      arrowDragMaxDist: EDGE_SCROLL.arrowDragMaxDist,
    });
    // Center on map, pulled in for a useful RTS default view
    this.orbit.setTarget(mapWidth / 2, 0, mapHeight / 2);
    this.orbit.distance = baseDistance;
    this.orbit.pitch = Math.PI * 0.28;
    this.orbit.apply();

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this.scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xffffff, 0.85);
    sun.position.set(mapWidth * 0.5, 3000, mapHeight * 0.2);
    sun.target.position.set(mapWidth * 0.5, 0, mapHeight * 0.5);
    this.scene.add(sun);
    this.scene.add(sun.target);

    // Ground slab — a thick box so the world clearly reads as a solid piece
    // of terrain when viewed from an oblique camera. Top surface sits at
    // y=-GROUND_GAP, i.e. just below the tile layer which is at y=0. Units
    // and buildings play ON the tiles (y=0), not under them.
    // Color matches the 2D MAP_BG_COLOR (via the backgroundColor arg) so the
    // exposed sides of the slab read as earth around the playable surface.
    const GROUND_DEPTH = 320;
    const GROUND_GAP = 4; // vertical separation between slab top and tiles
    const groundGeom = new THREE.BoxGeometry(mapWidth, GROUND_DEPTH, mapHeight);
    const groundMat = new THREE.MeshLambertMaterial({
      color: new THREE.Color(backgroundColor),
    });
    const ground = new THREE.Mesh(groundGeom, groundMat);
    ground.position.set(
      mapWidth / 2,
      -GROUND_GAP - GROUND_DEPTH / 2,
      mapHeight / 2,
    );
    this.scene.add(ground);

    // No grid lines on the floor — matches 2D, where MAP_GRID_COLOR equals
    // MAP_BG_COLOR at low alpha (effectively invisible). The only color that
    // paints the floor is the capture-tile / flag-ownership overlay.

    // Map boundary outline — sits just above the tile layer (which is at y=0)
    // so it traces the playable edge without z-fighting the tiles.
    const BOUNDS_Y = 0.5;
    const boundsGeom = new THREE.BufferGeometry();
    const boundsVerts = new Float32Array([
      0, BOUNDS_Y, 0,  mapWidth, BOUNDS_Y, 0,
      mapWidth, BOUNDS_Y, 0,  mapWidth, BOUNDS_Y, mapHeight,
      mapWidth, BOUNDS_Y, mapHeight,  0, BOUNDS_Y, mapHeight,
      0, BOUNDS_Y, mapHeight,  0, BOUNDS_Y, 0,
    ]);
    boundsGeom.setAttribute('position', new THREE.BufferAttribute(boundsVerts, 3));
    // Match the 2D drawGrid boundary stroke color (0x4444aa).
    const boundsMat = new THREE.LineBasicMaterial({ color: 0x4444aa });
    const bounds = new THREE.LineSegments(boundsGeom, boundsMat);
    this.scene.add(bounds);

    // World group for entities
    this.world = new THREE.Group();
    this.scene.add(this.world);

    // Real-GPU-time telemetry. No-op on browsers without the extension
    // (the GpuTimerQuery constructor probes and records isSupported()).
    this.gpuTimer = new GpuTimerQuery(this.renderer.getContext());

    this._resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width: w, height: h } = entry.contentRect;
        if (w > 0 && h > 0) {
          this.renderer.setSize(w, h);
          this.camera.aspect = w / h;
          this.camera.updateProjectionMatrix();
        }
      }
    });
    this._resizeObserver.observe(parent);
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  onUpdate(callback: (time: number, delta: number) => void): void {
    this._updateCallback = callback;
  }

  start(): void {
    if (this._running) return;
    this._running = true;
    this._lastTime = performance.now();
    const tick = (now: number) => {
      if (!this._running) return;
      const delta = now - this._lastTime;
      this._lastTime = now;
      if (this._updateCallback) this._updateCallback(now, delta);
      // Wrap the render call so the GPU timer captures true draw-time
      // (only the render; update-callback work is CPU-side).
      this.gpuTimer.begin();
      this.renderer.render(this.scene, this.camera);
      this.gpuTimer.end();
      // Poll results from any queries that resolved during this frame —
      // results arrive 2-3 frames after the begin/end pair, so `getGpuMs()`
      // always reflects slightly stale data (acceptable for a UI readout).
      this.gpuTimer.poll();
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    this._running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
  }

  destroy(): void {
    this.stop();
    this.orbit.destroy();
    this._resizeObserver.disconnect();
    this.gpuTimer.destroy();
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
  }
}
