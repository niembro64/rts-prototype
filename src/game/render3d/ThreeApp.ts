// ThreeApp — Three.js application wrapper.
//
// Sets up a scene, renderer, camera, lights, and a ground plane. Owns the
// render loop and delegates per-frame work to a callback.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  getBrowserRenderRuntimeProfile,
  type BrowserRenderRuntimeProfile,
} from '../../browserRuntime';
import { OrbitCamera } from './OrbitCamera';
import { GpuTimerQuery } from '../scenes/helpers/GpuTimerQuery';
import { installSunLighting } from './SunLighting';
import { configureSpriteTexture } from './threeUtils';
import { WebGlFrameProfiler, type WebGlFrameProfile } from './WebGlFrameProfiler';
import { ZoomTerrainPointsOverlay3D } from './ZoomTerrainPointsOverlay3D';
import {
  acquireMainRendererContext,
  type RendererContextToken,
} from './RendererContextBudget';
import { GAME_DIAGNOSTICS } from '../diagnostics';
import {
  CAMERA_PAN_MULTIPLIER,
  CAMERA_ZOOM_IN_ANCHOR,
  CAMERA_ZOOM_OUT_ANCHOR,
  CAMERA_ROTATE_ANCHOR,
  CAMERA_PAN_ANCHOR,
  CAMERA_FOV_DEGREES,
  CAMERA_MOVEMENT_CONFIG,
  CAMERA_CONSTRAINTS,
  SKY_RENDER_CONFIG,
  ZOOM_MAX,
  ZOOM_MAX_MAP_CENTER_DISTANCE,
  ZOOM_STEP_FRACTION,
  CAMERA_FAR_REFERENCE_DISTANCE_FACTOR,
  CAMERA_ZOOM_DISTANCE_SAMPLING,
} from '../../config';
import { getWaterBoundaryMode, getZoomPointsDebug } from '@/clientBarConfig';
import { WATER_SURFACE_OUTPUT_LINEAR_RGB } from './WaterColor3D';

const RENDER_DISABLED_UPDATE_INTERVAL_MS = 200;
const DYNAMIC_PIXEL_RATIO_FLOOR = 0.75;
// CAMERA_NEAR_PLANE bumped 5 → 50: depth-buffer precision is dominated
// by 1/near, so 10× near gives 10× better precision everywhere. The
// game's units have ~10–20 wu radius, so 50 keeps routine play geometry
// out of the precision-hostile near range.
//
// CAMERA_FAR_PLANE raised 50000 → 100000 so the water plane (which
// extends `HORIZON_RENDER_EXTEND` past every map edge) doesn't get
// clipped at low-pitch / high-altitude views. The bigger far-plane
// is paid for by `logarithmicDepthBuffer: true` on the renderer
// below — log depth distributes precision evenly across the whole
// near→far range, so widening the range is roughly free for
// shoreline z-fight.
const CAMERA_NEAR_PLANE = 50;
const CAMERA_FAR_PLANE = 100000;

function makeSkyGradientTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Unable to create sky gradient texture');
  }
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, SKY_RENDER_CONFIG.topColor);
  gradient.addColorStop(SKY_RENDER_CONFIG.midStop, SKY_RENDER_CONFIG.midColor);
  gradient.addColorStop(1, SKY_RENDER_CONFIG.horizonColor);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  configureSpriteTexture(texture);
  return texture;
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
  public frameProfiler: WebGlFrameProfiler;

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
  private _skyTexture: THREE.Texture | null = null;
  private _visibleSunDisk: THREE.Object3D | null = null;
  private _lastSeaBackgroundEnabled: boolean | null = null;
  private readonly _seaBackgroundColor = new THREE.Color().setRGB(
    WATER_SURFACE_OUTPUT_LINEAR_RGB.r,
    WATER_SURFACE_OUTPUT_LINEAR_RGB.g,
    WATER_SURFACE_OUTPUT_LINEAR_RGB.b,
  );
  private _rendererContextToken: RendererContextToken | null = null;
  private readonly _runtimeProfile: BrowserRenderRuntimeProfile;
  private _renderEnabled = true;
  private _drawSuspended = false;
  private _destroyed = false;
  private readonly _zoomTerrainPointsOverlay: ZoomTerrainPointsOverlay3D;

  constructor(
    parent: HTMLElement,
    width: number,
    height: number,
    mapWidth: number,
    mapHeight: number,
    backgroundColor: string,
  ) {
    this.scene = new THREE.Scene();
    this._skyTexture = makeSkyGradientTexture();
    this.scene.background = this._skyTexture;
    this._runtimeProfile = getBrowserRenderRuntimeProfile();

    // `logarithmicDepthBuffer` was enabled here briefly but had to come
    // off: every custom THREE.ShaderMaterial in this codebase (beams,
    // explosions, shields, smoke trails, spray, ...) writes
    // linear-space gl_FragDepth, while the log-depth framebuffer
    // expects log-space depth, so all of those effects depth-tested
    // against the wrong reference and disappeared. Re-enabling log-z
    // would require patching each of those shaders to include
    // Three's <logdepthbuf_*> chunks; for now the linear-z precision
    // is good enough for shoreline z-fight given the bumped near
    // plane (5 → 50 below, ~10× precision win at distance) and the
    // pure-units water polygon offset.
    this.renderer = new THREE.WebGLRenderer({
      alpha: false,
      antialias: this._runtimeProfile.antialias,
      depth: true,
      failIfMajorPerformanceCaveat: false,
      precision: this._runtimeProfile.precision,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: this._runtimeProfile.powerPreference,
      stencil: false,
    });
    this._rendererContextToken = acquireMainRendererContext('ThreeApp', this);
    // Three.js checks program/shader info logs on first use by default.
    // Driver log reads are synchronous and can dwarf the actual render frame;
    // keep them opt-in for shader debugging.
    this.renderer.debug.checkShaderErrors = GAME_DIAGNOSTICS.shaderErrorChecks;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = this._runtimeProfile.highQualityToneMapping
      ? THREE.ACESFilmicToneMapping
      : THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this._nativePixelRatio = Math.max(1, window.devicePixelRatio || 1);
    this._dynamicPixelRatioEnabled = this._runtimeProfile.dynamicPixelRatio;
    this._activePixelRatio = Math.min(
      this._nativePixelRatio,
      this._runtimeProfile.pixelRatioCap,
    );
    this.renderer.setPixelRatio(this._activePixelRatio);
    this.camera = new THREE.PerspectiveCamera(
      CAMERA_FOV_DEGREES,
      width / height,
      CAMERA_NEAR_PLANE,
      CAMERA_FAR_PLANE,
    );
    this.resizeRenderer(width, height);
    this.renderer.shadowMap.enabled = false;
    parent.appendChild(this.renderer.domElement);

    // Prebuilt environment map for any PBR (MeshStandardMaterial) meshes in
    // the scene — shield panels use a chrome variant and metal
    // extractor blades use shiny-gray metal; `scene.environment` is
    // the cube they reflect. RoomEnvironment ships
    // with three.js and gives a varied lights-and-walls IBL cube; PMREM
    // preprocesses it for the renderer. One-shot cost at scene init; zero
    // per-frame overhead.
    // Mobile WebKit has limited GPU-process headroom during startup, so
    // avoid the PMREM render-target burst on mobile-like browsers.
    if (this._runtimeProfile.environmentLighting) {
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
    }

    // The 3D equivalent of "zoom=1" is a distance that shows roughly the same
    // region of the map as the 2D camera at its default zoom.
    const baseDistance = Math.max(mapWidth, mapHeight) * 0.35;
    const minDistance =
      CAMERA_CONSTRAINTS.zoomInLimit === 'zoom-max'
        ? baseDistance / Math.max(1e-6, ZOOM_MAX)
        : undefined;
    this.orbit = new OrbitCamera(this.camera, this.renderer.domElement, {
      minDistance,
      maxCameraDistanceFromOrigin: ZOOM_MAX_MAP_CENTER_DISTANCE,
      cameraDistanceOrigin: { x: mapWidth / 2, y: 0, z: mapHeight / 2 },
      farReferenceDistance: baseDistance * CAMERA_FAR_REFERENCE_DISTANCE_FACTOR,
      zoomStepFraction: ZOOM_STEP_FRACTION,
      zoomDistanceSampling: CAMERA_ZOOM_DISTANCE_SAMPLING,
      movementConfig: CAMERA_MOVEMENT_CONFIG,
      panMultiplier: CAMERA_PAN_MULTIPLIER,
      zoomInAnchor: CAMERA_ZOOM_IN_ANCHOR,
      zoomOutAnchor: CAMERA_ZOOM_OUT_ANCHOR,
      rotateAnchor: CAMERA_ROTATE_ANCHOR,
      panAnchor: CAMERA_PAN_ANCHOR,
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

    installSunLighting(this.scene, mapWidth, mapHeight);
    this._visibleSunDisk = this.scene.getObjectByName('VisibleSunDisk') ?? null;
    this.syncWaterBoundaryPresentation();

    // No standalone ground slab — the land tiles ARE the world's
    // mass. TerrainTileRenderer3D extends each tile cube far below
    // y=0 (see CUBE_FLOOR_Y) so the side walls read as the substrate
    // / "earth" of the map when viewed from oblique angles. This
    // keeps a single source of truth for the ground surface (the
    // terrain heightmap drives the cubes) and avoids z-fighting
    // between a separate slab and the cube floors.
    void backgroundColor;

    // World group for entities
    this.world = new THREE.Group();
    this.scene.add(this.world);
    this._zoomTerrainPointsOverlay = new ZoomTerrainPointsOverlay3D(
      this.world,
      this.orbit,
      CAMERA_ZOOM_DISTANCE_SAMPLING,
    );

    const gl = this.renderer.getContext();
    // Real-GPU-time telemetry. No-op on browsers without the extension
    // (the GpuTimerQuery constructor probes and records isSupported()).
    this.gpuTimer = new GpuTimerQuery(gl);
    this.frameProfiler = new WebGlFrameProfiler(gl, GAME_DIAGNOSTICS.webglBufferUploads);

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

  getRenderRuntimeTelemetry(): {
    runtimeProfile: BrowserRenderRuntimeProfile['label'];
    nativePixelRatio: number;
    activePixelRatio: number;
    dynamicPixelRatioEnabled: boolean;
  } {
    return {
      runtimeProfile: this._runtimeProfile.label,
      nativePixelRatio: this._nativePixelRatio,
      activePixelRatio: this._activePixelRatio,
      dynamicPixelRatioEnabled: this._dynamicPixelRatioEnabled,
    };
  }

  getWebGlFrameProfile(): WebGlFrameProfile {
    return this.frameProfiler.getLatest();
  }

  setDrawSuspended(suspended: boolean): void {
    this._drawSuspended = suspended;
  }

  setCameraFovDegrees(fovDegrees: number): void {
    const next = Math.min(179, Math.max(1, fovDegrees));
    if (Math.abs(this.camera.fov - next) < 0.001) return;
    this.camera.fov = next;
    this.camera.updateProjectionMatrix();
  }

  /** Force every material currently in the scene to create its shader program
   *  during warmup instead of on the first visible frame. */
  precompileShaders(): void {
    this.renderer.compile(this.scene, this.camera);
  }

  async precompileShadersAsync(): Promise<void> {
    // Three's compileAsync() can throw from an internal polling timeout when
    // a material does not receive currentProgram. Keep warmup under our own
    // error handling instead of relying on that uncaught async path.
    this.precompileShaders();
  }

  private syncWaterBoundaryPresentation(): void {
    const seaBackgroundEnabled = getWaterBoundaryMode() === 'floating-square-sea';
    if (this._lastSeaBackgroundEnabled !== seaBackgroundEnabled) {
      this._lastSeaBackgroundEnabled = seaBackgroundEnabled;
      this.scene.background = seaBackgroundEnabled
        ? this._seaBackgroundColor
        : this._skyTexture;
    }
    if (!this._visibleSunDisk) {
      this._visibleSunDisk = this.scene.getObjectByName('VisibleSunDisk') ?? null;
    }
    if (this._visibleSunDisk) {
      this._visibleSunDisk.visible = !seaBackgroundEnabled;
    }
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
      if (this._renderEnabled && !this._drawSuspended) {
        this.syncWaterBoundaryPresentation();
        this._zoomTerrainPointsOverlay.update(now, getZoomPointsDebug());
        // Wrap the render call so the GPU timer captures true draw-time
        // (only the render; update-callback work is CPU-side).
        this.frameProfiler.beginFrame();
        this.gpuTimer.begin();
        const renderStart = performance.now();
        this.renderer.render(this.scene, this.camera);
        const rendererRenderMs = performance.now() - renderStart;
        this.gpuTimer.end();
        this.frameProfiler.endFrame(this.renderer, rendererRenderMs);
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
    // Some runtimes visibly flash the WebGL canvas when the backing
    // buffer is reallocated by setPixelRatio()+setSize(). Those profiles
    // keep DPR stable; browser desktop keeps the adaptive quality loop.
    if (!this._dynamicPixelRatioEnabled) return;
    if (now - this._lastPixelRatioAdjustMs < 750) return;

    const gpuMs = this.gpuTimer.getGpuMs();
    const hasGpuMs = this.gpuTimer.isSupported() && gpuMs > 0;
    const overloaded = hasGpuMs ? gpuMs > 16 : frameDeltaMs > 22;
    const comfortable = hasGpuMs ? gpuMs < 9 : frameDeltaMs < 14;
    let next = this._activePixelRatio;
    if (overloaded) {
      next = Math.max(DYNAMIC_PIXEL_RATIO_FLOOR, this._activePixelRatio - 0.25);
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
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = 0;
    }
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this.stop();
    this._updateCallback = null;
    this._zoomTerrainPointsOverlay.destroy();
    this.orbit.destroy();
    this._resizeObserver.disconnect();
    this.gpuTimer.destroy();
    this.frameProfiler.destroy();
    this.scene.environment = null;
    this.scene.background = null;
    this._environmentTexture?.dispose();
    this._environmentTexture = null;
    this._skyTexture?.dispose();
    this._skyTexture = null;
    this.renderer.renderLists.dispose();
    this.renderer.forceContextLoss();
    this.renderer.dispose();
    this._rendererContextToken?.release();
    this._rendererContextToken = null;
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
  }
}
