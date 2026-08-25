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
import {
  GroundSilhouetteSunShadow3D,
  installSunLighting,
} from './SunLighting';
import {
  registerLightingTargets,
  unregisterLightingTargets,
} from './RenderLighting3D';
import { configureSpriteTexture } from './threeUtils';
import { registerBackdropTarget } from './presetBackdrops';
import { ParallaxBackdropRenderer3D } from './ParallaxBackdropRenderer3D';
import { registerMapPresetLabelTarget } from './presetMapLabel';
import { MapPresetLabel3D } from './MapPresetLabel3D';
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
  CAMERA_INITIAL_PITCH_RADIANS,
  CAMERA_TRANSITION_MODE,
  CAMERA_TRANSITION_SCOPE,
  CAMERA_MOVEMENT_CONFIG,
  CAMERA_CONSTRAINTS,
  SKY_RENDER_CONFIG,
  ZOOM_MIN_ORBIT_DISTANCE,
  ZOOM_MAX_ORBIT_DISTANCE_MAP_FACTOR,
  ZOOM_STEP_FRACTION,
  ZOOM_TRAVEL_CLAMP_FRACTION,
  CAMERA_FAR_REFERENCE_DISTANCE_FACTOR,
  CAMERA_LOST_TERRAIN_RECOVERY,
  CAMERA_TERRAIN_COLLISION,
  CAMERA_ZOOM_DISTANCE_SAMPLING,
} from '../../config';
import {
  getAaMsaaMode,
  getAaResolutionMode,
  getEntityShadows,
  getWaterBoundaryMode,
  getZoomPointsDebug,
} from '@/clientBarConfig';
import { WATER_SURFACE_OUTPUT_LINEAR_RGB } from './WaterColor3D';

const RENDER_DISABLED_UPDATE_INTERVAL_MS = 200;
const DYNAMIC_PIXEL_RATIO_FLOOR = 0.75;

type ThreeAppFrameComplete = {
  /** CPU wall-clock time spent submitting the WebGL draw for this frame. */
  readonly rendererRenderMs: number;
};
// CAMERA_NEAR_PLANE bumped 5 → 50: depth-buffer precision is dominated
// by 1/near, so 10× near gives 10× better precision everywhere. The
// game's units have ~10–20 wu radius, so 50 keeps routine play geometry
// out of the precision-hostile near range.
//
// CAMERA_FAR_PLANE raised 50000 → 100000 so the water plane (which
// extends `HORIZON_RENDER_EXTEND` past every map edge) doesn't get
// clipped at low-pitch / high-altitude views. The wider range costs
// linear-depth precision at distance (log depth was reverted — see
// the renderer note below); the bumped near plane pays most of that
// back, and the water surface's small pure-units polygon offset
// covers shoreline z-fight (see WaterRenderer3D.ts).
const CAMERA_NEAR_PLANE = 50;
/** Exported so world-extent renderers (water/terrain horizon skirts) can
 *  guarantee they finish inside the clip range instead of visibly ending
 *  mid-skirt at extreme zoom-out. */
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
   *  and callers should fall back to CPU-side renderer-submit time. */
  public gpuTimer: GpuTimerQuery;
  public frameProfiler: WebGlFrameProfiler;

  private _updateCallback: ((time: number, delta: number) => void) | null = null;
  private _frameCompleteCallback: ((frame: ThreeAppFrameComplete) => void) | null = null;
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
  private readonly _parallaxBackdrop: ParallaxBackdropRenderer3D;
  private _unregisterBackdropTarget: (() => void) | null = null;
  private _mapPresetLabel: MapPresetLabel3D | null = null;
  private _unregisterMapPresetLabelTarget: (() => void) | null = null;
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
  /** One-shot callbacks drained right after the WebGL draw, while the
   *  drawing buffer still holds this frame (preserveDrawingBuffer stays
   *  false; same-task reads are the supported way to capture it). */
  private _capturePostRenderCallbacks: Array<(canvas: HTMLCanvasElement) => void> = [];
  private _captureFidelityHold = false;
  // ── Antialias pipeline (CLIENT bar AA group; live, no rebuild) ──
  // MSAA: with a mode other than DEFAULT the scene is drawn into an explicit
  // multisampled offscreen target and presented with a raw fullscreen copy,
  // instead of relying on the sample count the browser granted the context's
  // `antialias: true` hint (usually 4×, and never adjustable after creation).
  /** Multisampled scene target; null while the DEFAULT direct-to-canvas
   *  path is active. */
  private _aaTarget: THREE.WebGLRenderTarget | null = null;
  /** Sample count of the live `_aaTarget` (0 = direct-to-canvas). */
  private _aaActiveSamples = 0;
  private _aaPresentScene: THREE.Scene | null = null;
  private _aaPresentCamera: THREE.OrthographicCamera | null = null;
  private _aaPresentMaterial: THREE.ShaderMaterial | null = null;
  private _aaPresentGeometry: THREE.BufferGeometry | null = null;
  /** True while the RES knob pins an explicit pixel ratio; the adaptive
   *  governor and the capture fidelity hold both stand down when set. */
  private _aaResolutionPinned = false;
  private readonly _aaDrawingBufferSize = new THREE.Vector2();
  private readonly _zoomTerrainPointsOverlay: ZoomTerrainPointsOverlay3D;
  private readonly _groundSunShadows: GroundSilhouetteSunShadow3D;

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
    // The MSAA path draws two render() calls per frame (scene + present).
    // Default info auto-reset would leave only the trivial present pass in
    // renderer.info for the DRAW telemetry, so the tick loop resets info
    // manually once per frame instead.
    this.renderer.info.autoReset = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = this._runtimeProfile.highQualityToneMapping
      ? THREE.ACESFilmicToneMapping
      : THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    // Scene/renderer lighting knobs are driven from the CLIENT bar; register
    // once so the persisted values apply from the first frame.
    registerLightingTargets(this.scene, this.renderer);
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
    this._parallaxBackdrop = new ParallaxBackdropRenderer3D(
      this.scene,
      this.renderer,
      mapWidth,
      mapHeight,
    );
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    parent.appendChild(this.renderer.domElement);

    // Prebuilt RoomEnvironment image-based light for Three's lit Lambert,
    // Phong, and Standard materials. Diffuse terrain/vegetation take its broad
    // irradiance while PBR metal and shield surfaces also take its reflection;
    // unlike the live directional sun, neither path is removed by the shadow
    // map. PMREM preprocesses the cube once at scene init.
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
    const minDistance = CAMERA_CONSTRAINTS.zoomInLimit === 'zoom-max'
      ? ZOOM_MIN_ORBIT_DISTANCE
      : undefined;
    this.orbit = new OrbitCamera(this.camera, this.renderer.domElement, {
      minDistance,
      maxDistance: Math.max(mapWidth, mapHeight) * ZOOM_MAX_ORBIT_DISTANCE_MAP_FACTOR,
      cameraDistanceOrigin: { x: mapWidth / 2, y: 0, z: mapHeight / 2 },
      farReferenceDistance: baseDistance * CAMERA_FAR_REFERENCE_DISTANCE_FACTOR,
      lostTerrainRecovery: CAMERA_LOST_TERRAIN_RECOVERY,
      transitionMode: CAMERA_TRANSITION_MODE,
      transitionScope: CAMERA_TRANSITION_SCOPE,
      minTerrainClearance: CAMERA_TERRAIN_COLLISION.minClearance,
      terrainCollisionMode: CAMERA_TERRAIN_COLLISION.mode,
      zoomStepFraction: ZOOM_STEP_FRACTION,
      zoomTravelClampFraction: ZOOM_TRAVEL_CLAMP_FRACTION,
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
      pitch: CAMERA_INITIAL_PITCH_RADIANS,
    });

    this._groundSunShadows = installSunLighting(this.scene, mapWidth, mapHeight);
    this._visibleSunDisk = this.scene.getObjectByName('VisibleSunDisk') ?? null;
    this.syncWaterBoundaryPresentation();

    // No standalone ground slab — the terrain mesh is the world's top.
    // TerrainTileRenderer3D extends the outer perimeter down by a
    // map-relative depth, so its side walls read as the substrate / "earth"
    // of the map when viewed from oblique angles. This keeps one source of
    // truth for the ground surface and avoids a separate slab that could
    // z-fight with terrain.
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

    this._mapPresetLabel = new MapPresetLabel3D(this.world, mapWidth, mapHeight);

    // Pick up the current preset backdrop + corner caption (and future
    // preset switches). Registered last so the initial layer set / caption
    // never reaches a half-built app.
    this._unregisterBackdropTarget = registerBackdropTarget(this._parallaxBackdrop);
    this._unregisterMapPresetLabelTarget = registerMapPresetLabelTarget(
      this._mapPresetLabel,
    );
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /** Single choke point for the plain clear background and suppression of
   *  the layered preset backdrop. The floating-square sea override wins. */
  private applySceneBackground(): void {
    this.scene.background =
      this._lastSeaBackgroundEnabled === true
        ? this._seaBackgroundColor
        : this._skyTexture;
    this._parallaxBackdrop.setSuppressed(this._lastSeaBackgroundEnabled === true);
  }

  onUpdate(callback: (time: number, delta: number) => void): void {
    this._updateCallback = callback;
  }

  /**
   * Runs after the scene update and any WebGL draw have completed. This is
   * deliberately separate from `onUpdate`: an update callback cannot measure
   * the draw that follows it, so putting frame telemetry there undercounts
   * the work that determines whether the next vsync is missed.
   */
  onFrameComplete(callback: (frame: ThreeAppFrameComplete) => void): void {
    this._frameCompleteCallback = callback;
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
    antialiasSamples: number;
  } {
    return {
      runtimeProfile: this._runtimeProfile.label,
      nativePixelRatio: this._nativePixelRatio,
      activePixelRatio: this._activePixelRatio,
      dynamicPixelRatioEnabled: this._dynamicPixelRatioEnabled && !this._aaResolutionPinned,
      antialiasSamples: this._aaActiveSamples,
    };
  }

  getWebGlFrameProfile(): WebGlFrameProfile {
    return this.frameProfiler.getLatest();
  }

  setDrawSuspended(suspended: boolean): void {
    this._drawSuspended = suspended;
  }

  /** Run `callback` once, immediately after the next completed WebGL draw,
   *  in the same task — the only moment the non-preserved drawing buffer is
   *  guaranteed to hold the frame. Used by clean-frame screenshot capture. */
  requestCapturePostRender(callback: (canvas: HTMLCanvasElement) => void): void {
    this._capturePostRenderCallbacks.push(callback);
  }

  /** While held, capture fidelity is pinned at the profile maximum: the
   *  dynamic pixel-ratio governor is suspended and DPR is raised to
   *  min(native, profile cap), so a recording neither drifts in resolution
   *  mid-clip nor sits at a degraded rung the governor picked earlier. */
  setCaptureFidelityHold(active: boolean): void {
    if (this._captureFidelityHold === active) return;
    this._captureFidelityHold = active;
    if (!active) return;
    // An explicit RES pin already holds a fixed resolution — including one
    // deliberately above the profile cap — so don't drag it back down.
    if (this._aaResolutionPinned) return;
    this.applyPixelRatio(
      Math.min(this._nativePixelRatio, this._runtimeProfile.pixelRatioCap),
    );
  }

  setCameraFovDegrees(fovDegrees: number): void {
    this.orbit.setFovDegrees(fovDegrees);
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
      this.applySceneBackground();
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
      let rendererRenderMs = 0;
      if (this._renderEnabled && !this._drawSuspended) {
        this.syncWaterBoundaryPresentation();
        this._groundSunShadows.sync(
          this.camera,
          this.orbit.target,
          this.orbit.distance,
          getEntityShadows(),
        );
        this._zoomTerrainPointsOverlay.update(now, getZoomPointsDebug());
        // One terrain sample: the caption re-seats itself if the annex's
        // altitude changed under it (a terrain bake landing after the sign).
        this._mapPresetLabel?.update();
        this.syncAntialiasResolution();
        const aaTarget = this.syncAntialiasPipeline();
        // Wrap the render call so the GPU timer captures true draw-time
        // (only the render; update-callback work is CPU-side).
        this.frameProfiler.beginFrame();
        this.gpuTimer.begin();
        const renderStart = performance.now();
        // Manual reset (autoReset is off) so DRAW telemetry covers every
        // pass this frame instead of only the last render() call.
        this.renderer.info.reset();
        if (aaTarget) {
          this.renderer.setRenderTarget(aaTarget);
          this.renderer.render(this.scene, this.camera);
          this.renderer.setRenderTarget(null);
          this.renderer.render(this._aaPresentScene!, this._aaPresentCamera!);
        } else {
          this.renderer.render(this.scene, this.camera);
        }
        rendererRenderMs = performance.now() - renderStart;
        this.gpuTimer.end();
        this.frameProfiler.endFrame(this.renderer, rendererRenderMs);
        // Capture callbacks must run before adjustPixelRatio: a pixel-ratio
        // resize reallocates the drawing buffer and would clear the frame.
        if (this._capturePostRenderCallbacks.length > 0) {
          const callbacks = this._capturePostRenderCallbacks;
          this._capturePostRenderCallbacks = [];
          for (const callback of callbacks) callback(this.renderer.domElement);
        }
        // Poll results from any queries that resolved during this frame —
        // results arrive 2-3 frames after the begin/end pair, so `getGpuMs()`
        // always reflects slightly stale data (acceptable for a UI readout).
        this.gpuTimer.poll();
        this.adjustPixelRatio(now, rendererRenderMs);
      }
      this._frameCompleteCallback?.({ rendererRenderMs });
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  private adjustPixelRatio(now: number, rendererRenderMs: number): void {
    // Some runtimes visibly flash the WebGL canvas when the backing
    // buffer is reallocated by setPixelRatio()+setSize(). Those profiles
    // keep DPR stable; browser desktop keeps the adaptive quality loop.
    if (!this._dynamicPixelRatioEnabled) return;
    // A live capture pins resolution; the governor resumes when it ends.
    if (this._captureFidelityHold) return;
    // An explicit RES pin owns the pixel ratio outright.
    if (this._aaResolutionPinned) return;
    if (now - this._lastPixelRatioAdjustMs < 750) return;

    const gpuMs = this.gpuTimer.getGpuMs();
    const hasGpuMs = this.gpuTimer.isSupported() && gpuMs > 0;
    // RAF delta includes time the browser withheld callbacks. At 20 Hz that
    // is ~33 ms even when the draw is cheap, so using it here needlessly
    // reduces resolution for display/power/browser pacing rather than actual
    // render pressure. A GPU timer is best; render-submit wall time is the
    // least misleading fallback when timer queries are unavailable.
    const renderCostMs = hasGpuMs ? gpuMs : rendererRenderMs;
    const overloaded = renderCostMs > 16;
    const comfortable = renderCostMs < 9;
    this._lastPixelRatioAdjustMs = now;
    let next = this._activePixelRatio;
    if (overloaded) {
      next = Math.max(DYNAMIC_PIXEL_RATIO_FLOOR, this._activePixelRatio - 0.25);
    } else if (comfortable) {
      next = Math.min(this._nativePixelRatio, this._activePixelRatio + 0.25);
    }
    this.applyPixelRatio(next);
  }

  /** Single choke point for pixel-ratio changes: reallocates the drawing
   *  buffer only when the ratio actually moved. */
  private applyPixelRatio(ratio: number): void {
    const next = Math.max(DYNAMIC_PIXEL_RATIO_FLOOR * 0.5, ratio);
    if (Math.abs(next - this._activePixelRatio) < 0.01) return;
    this._activePixelRatio = next;
    this.renderer.setPixelRatio(this._activePixelRatio);
    const canvas = this.renderer.domElement;
    this.resizeRenderer(canvas.clientWidth, canvas.clientHeight, false, true);
  }

  /** RES knob: 'auto' leaves the profile behavior (governor / profile cap)
   *  in charge; a percent pins pixel ratio to native × percent/100 — which
   *  is also how the Tauri/mobile profile caps are deliberately overridden. */
  private syncAntialiasResolution(): void {
    const mode = getAaResolutionMode();
    if (mode === 'auto') {
      if (!this._aaResolutionPinned) return;
      this._aaResolutionPinned = false;
      this.applyPixelRatio(
        Math.min(this._nativePixelRatio, this._runtimeProfile.pixelRatioCap),
      );
      return;
    }
    this._aaResolutionPinned = true;
    this.applyPixelRatio(this._nativePixelRatio * (mode / 100));
  }

  /** MSAA knob: reconcile the offscreen multisampled target against the
   *  requested mode and the current drawing-buffer size. Returns the target
   *  to render into, or null for the DEFAULT direct-to-canvas path. */
  private syncAntialiasPipeline(): THREE.WebGLRenderTarget | null {
    const desiredSamples = this.desiredAntialiasSamples();
    if (desiredSamples <= 0) {
      if (this._aaTarget) {
        this._aaTarget.dispose();
        this._aaTarget = null;
        this._aaActiveSamples = 0;
      }
      return null;
    }
    const size = this.renderer.getDrawingBufferSize(this._aaDrawingBufferSize);
    const width = Math.max(1, Math.floor(size.x));
    const height = Math.max(1, Math.floor(size.y));
    if (this._aaTarget && this._aaActiveSamples !== desiredSamples) {
      this._aaTarget.dispose();
      this._aaTarget = null;
    }
    if (!this._aaTarget) {
      const target = new THREE.WebGLRenderTarget(width, height, {
        samples: desiredSamples,
        // HalfFloat keeps the multisampled renderbuffer and its resolve
        // texture on the same RGBA16F internal format (8-bit sRGB storage
        // would split them into SRGB8_ALPHA8 vs RGBA8 and break the resolve
        // blit) while adding headroom over the canvas's 8 bits.
        type: THREE.HalfFloatType,
        colorSpace: THREE.SRGBColorSpace,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        generateMipmaps: false,
        depthBuffer: true,
        stencilBuffer: false,
      });
      // Three hard-disables per-material tone mapping and the output
      // colorspace encode for ordinary render targets (WebGLRenderer
      // setProgram). This offscreen pass must reproduce the CANVAS pipeline
      // bit-for-bit — built-in materials tone-map and sRGB-encode in-shader,
      // raw ShaderMaterials keep writing their authored values untouched —
      // and the XR-target flag is the supported escape hatch that routes
      // both decisions through this target's texture colorSpace instead.
      // The present pass is then a pure copy with no conversions.
      (target as unknown as { isXRRenderTarget: boolean }).isXRRenderTarget = true;
      this._aaTarget = target;
      this._aaActiveSamples = desiredSamples;
      this.ensureAntialiasPresentPass();
      this._aaPresentMaterial!.uniforms.uSource.value = target.texture;
    } else if (this._aaTarget.width !== width || this._aaTarget.height !== height) {
      this._aaTarget.setSize(width, height);
    }
    return this._aaTarget;
  }

  /** Requested MSAA samples for the offscreen path, clamped to the GPU's
   *  MAX_SAMPLES. 0 = use the DEFAULT direct-to-canvas path. Requires the
   *  float-renderbuffer extension for the RGBA16F multisampled storage. */
  private desiredAntialiasSamples(): number {
    const mode = getAaMsaaMode();
    if (mode === 'default') return 0;
    const maxSamples = this.renderer.capabilities.maxSamples;
    if (maxSamples <= 0) return 0;
    if (
      !this.renderer.extensions.has('EXT_color_buffer_float') &&
      !this.renderer.extensions.has('EXT_color_buffer_half_float')
    ) {
      return 0;
    }
    if (mode === '4x') return Math.min(4, maxSamples);
    if (mode === '8x') return Math.min(8, maxSamples);
    return maxSamples;
  }

  /** Fullscreen-triangle copy of the resolved MSAA color onto the canvas.
   *  Deliberately conversion-free — see the XR-flag note above. */
  private ensureAntialiasPresentPass(): void {
    if (this._aaPresentScene) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]),
        3,
      ),
    );
    const material = new THREE.ShaderMaterial({
      uniforms: { uSource: { value: null } },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = position.xy * 0.5 + 0.5;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uSource;
        varying vec2 vUv;
        void main() {
          gl_FragColor = texture2D(uSource, vUv);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);
    this._aaPresentGeometry = geometry;
    this._aaPresentMaterial = material;
    this._aaPresentScene = scene;
    this._aaPresentCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
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
    this._frameCompleteCallback = null;
    this._capturePostRenderCallbacks = [];
    this._zoomTerrainPointsOverlay.destroy();
    this.orbit.destroy();
    this._resizeObserver.disconnect();
    this.gpuTimer.destroy();
    this.frameProfiler.destroy();
    this._unregisterBackdropTarget?.();
    this._unregisterBackdropTarget = null;
    this._parallaxBackdrop.destroy();
    this._unregisterMapPresetLabelTarget?.();
    this._unregisterMapPresetLabelTarget = null;
    this._mapPresetLabel?.destroy();
    this._mapPresetLabel = null;
    this._groundSunShadows.destroy();
    this._aaTarget?.dispose();
    this._aaTarget = null;
    this._aaActiveSamples = 0;
    this._aaPresentGeometry?.dispose();
    this._aaPresentGeometry = null;
    this._aaPresentMaterial?.dispose();
    this._aaPresentMaterial = null;
    this._aaPresentScene = null;
    this._aaPresentCamera = null;
    unregisterLightingTargets(this.scene, this.renderer);
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
