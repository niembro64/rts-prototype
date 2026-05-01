// ThreeApp — Three.js application wrapper (parallel to PixiApp, for the 3D PoC).
//
// Sets up a scene, renderer, camera, lights, and a ground plane. Owns the
// render loop and delegates per-frame work to a callback.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { OrbitCamera } from './OrbitCamera';
import { GpuTimerQuery } from '../scenes/helpers/GpuTimerQuery';
import {
  CAMERA_PAN_MULTIPLIER,
  CAMERA_MIN_TERRAIN_CLEARANCE,
  CAMERA_TARGET_TERRAIN_BAND,
  ZOOM_STEP_FRACTION,
  ZOOM_MIN,
  ZOOM_MAX,
} from '../../config';

const MOBILE_PIXEL_RATIO_CAP = 2;
const RENDER_DISABLED_UPDATE_INTERVAL_MS = 200;

function isMobileLikeBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  const uaMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i
    .test(navigator.userAgent);
  const coarsePointer = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;
  return uaMobile || (coarsePointer && (navigator.maxTouchPoints ?? 0) > 0);
}

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
  private _nativePixelRatio = 1;
  private _activePixelRatio = 1;
  private _lastPixelRatioAdjustMs = 0;
  private _dynamicPixelRatioEnabled = true;
  private _lastCssWidth = 0;
  private _lastCssHeight = 0;
  private _environmentTexture: THREE.Texture | null = null;
  private _renderEnabled = true;

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
    const mobileLike = isMobileLikeBrowser();
    this._nativePixelRatio = Math.max(1, window.devicePixelRatio || 1);
    this._dynamicPixelRatioEnabled = !mobileLike;
    this._activePixelRatio = mobileLike
      ? Math.min(this._nativePixelRatio, MOBILE_PIXEL_RATIO_CAP)
      : this._nativePixelRatio;
    this.renderer.setPixelRatio(this._activePixelRatio);
    this.camera = new THREE.PerspectiveCamera(50, width / height, 1, 50000);
    this.resizeRenderer(width, height);
    this.renderer.shadowMap.enabled = false;
    parent.appendChild(this.renderer.domElement);

    // Prebuilt environment map for any PBR (MeshStandardMaterial) meshes in
    // the scene — mirror panels at MED+ LOD become metalness=1 chrome, and
    // `scene.environment` is the cube they reflect. RoomEnvironment ships
    // with three.js and gives a varied lights-and-walls IBL cube; PMREM
    // preprocesses it for the renderer. One-shot cost at scene init; zero
    // per-frame overhead.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const roomEnv = new RoomEnvironment();
    this._environmentTexture = pmrem.fromScene(roomEnv, 0.04).texture;
    this.scene.environment = this._environmentTexture;
    roomEnv.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const m = obj as THREE.Mesh;
        if ('dispose' in (m.geometry ?? {})) m.geometry.dispose();
        const material = m.material;
        if (Array.isArray(material)) {
          for (const mat of material) mat.dispose();
        } else {
          material?.dispose();
        }
      }
    });
    pmrem.dispose();

    // The 3D equivalent of "zoom=1" is a distance that shows roughly the same
    // region of the map as the 2D camera at its default zoom. Min/max distance
    // are derived from ZOOM_MIN/ZOOM_MAX so "zoomed in" / "zoomed out" bounds
    // match the 2D limits.
    const baseDistance = Math.max(mapWidth, mapHeight) * 0.35;
    this.orbit = new OrbitCamera(this.camera, this.renderer.domElement, {
      minDistance: baseDistance / ZOOM_MAX,
      maxDistance: baseDistance / ZOOM_MIN,
      zoomStepFraction: ZOOM_STEP_FRACTION,
      panMultiplier: CAMERA_PAN_MULTIPLIER,
      minTerrainClearance: CAMERA_MIN_TERRAIN_CLEARANCE,
      targetTerrainBand: CAMERA_TARGET_TERRAIN_BAND,
    });
    // Center on map, pulled in for a useful RTS default view
    this.orbit.setState({
      targetX: mapWidth / 2,
      targetY: 0,
      targetZ: mapHeight / 2,
      distance: baseDistance,
      yaw: this.orbit.yaw,
      pitch: Math.PI * 0.28,
    });

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this.scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xffffff, 0.85);
    sun.position.set(mapWidth * 0.5, 3000, mapHeight * 0.2);
    sun.target.position.set(mapWidth * 0.5, 0, mapHeight * 0.5);
    this.scene.add(sun);
    this.scene.add(sun.target);

    // No standalone ground slab — the mana cubes ARE the world's
    // mass. CaptureTileRenderer3D extends each tile cube far below
    // y=0 (see CUBE_FLOOR_Y) so the side walls read as the substrate
    // / "earth" of the map when viewed from oblique angles. This
    // keeps a single source of truth for the ground surface (the
    // terrain heightmap drives the cubes) and avoids z-fighting
    // between a separate slab and the cube floors.
    void backgroundColor;

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
          this.resizeRenderer(w, h);
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

  setRenderEnabled(enabled: boolean): void {
    this._renderEnabled = enabled;
  }

  isRenderEnabled(): boolean {
    return this._renderEnabled;
  }

  start(): void {
    if (this._running) return;
    this._running = true;
    this._lastTime = performance.now();
    const tick = (now: number) => {
      if (!this._running) return;
      const delta = now - this._lastTime;
      if (!this._renderEnabled && delta < RENDER_DISABLED_UPDATE_INTERVAL_MS) {
        this._rafId = requestAnimationFrame(tick);
        return;
      }
      this._lastTime = now;
      if (this._updateCallback) this._updateCallback(now, delta);
      if (this._renderEnabled) {
        // Wrap the render call so the GPU timer captures true draw-time
        // (only the render; update-callback work is CPU-side).
        this.gpuTimer.begin();
        this.renderer.render(this.scene, this.camera);
        this.gpuTimer.end();
        // Poll results from any queries that resolved during this frame —
        // results arrive 2-3 frames after the begin/end pair, so `getGpuMs()`
        // always reflects slightly stale data (acceptable for a UI readout).
        this.gpuTimer.poll();
        this.adjustPixelRatio(now, delta);
      }
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  private adjustPixelRatio(now: number, frameDeltaMs: number): void {
    // Mobile browsers, especially Edge/Chromium shells on high-DPR
    // phones, can visibly flash the entire WebGL canvas when the
    // backing buffer is reallocated by setPixelRatio()+setSize(). Keep
    // mobile DPR stable; desktop keeps the adaptive quality loop.
    if (!this._dynamicPixelRatioEnabled) return;
    if (this._nativePixelRatio <= 1) return;
    if (now - this._lastPixelRatioAdjustMs < 750) return;

    const gpuMs = this.gpuTimer.getGpuMs();
    const hasGpuMs = this.gpuTimer.isSupported() && gpuMs > 0;
    const overloaded = hasGpuMs ? gpuMs > 18 : frameDeltaMs > 24;
    const comfortable = hasGpuMs ? gpuMs < 10 : frameDeltaMs < 15;
    let next = this._activePixelRatio;
    if (overloaded) {
      next = Math.max(1, this._activePixelRatio - 0.25);
    } else if (comfortable) {
      next = Math.min(this._nativePixelRatio, this._activePixelRatio + 0.25);
    }
    if (Math.abs(next - this._activePixelRatio) < 0.01) return;

    this._activePixelRatio = next;
    this._lastPixelRatioAdjustMs = now;
    this.renderer.setPixelRatio(this._activePixelRatio);
    const canvas = this.renderer.domElement;
    this.resizeRenderer(canvas.clientWidth, canvas.clientHeight, false, true);
  }

  private resizeRenderer(
    width: number,
    height: number,
    updateStyle = true,
    force = false,
  ): void {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (!force && w === this._lastCssWidth && h === this._lastCssHeight) return;
    this._lastCssWidth = w;
    this._lastCssHeight = h;
    this.renderer.setSize(w, h, updateStyle);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
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
    this.scene.environment = null;
    this._environmentTexture?.dispose();
    this._environmentTexture = null;
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
  }
}
