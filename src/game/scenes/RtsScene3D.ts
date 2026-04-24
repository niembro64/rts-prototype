// RtsScene3D — 3D equivalent of RtsScene.
//
// Implements the same public API surface (callbacks + methods) so PhaserCanvas.vue
// can drive it interchangeably with the 2D scene. Internally it uses ThreeApp and
// Render3DEntities instead of Pixi graphics, and currently has no selection/input
// (view-only). Selection/commands will be added in a later pass.

import * as THREE from 'three';
import type { ClientViewState } from '../network/ClientViewState';
import type { SceneCameraState } from '@/types/game';
import { SnapshotBuffer } from './helpers/SnapshotBuffer';
import {
  buildSelectionInfo,
  buildEconomyInfo,
  buildMinimapData,
} from './helpers';
import type { EconomyInfo, MinimapData } from './helpers';
import type { UIInputState } from '@/types/ui';
import { EmaTracker } from './helpers/EmaTracker';
import { EmaMsTracker } from './helpers/EmaMsTracker';
import { LongtaskTracker } from './helpers/LongtaskTracker';
import { ThreeApp } from '../render3d/ThreeApp';
import { Render3DEntities } from '../render3d/Render3DEntities';
import { Input3DManager } from '../render3d/Input3DManager';
import { BeamRenderer3D } from '../render3d/BeamRenderer3D';
import { ForceFieldRenderer3D } from '../render3d/ForceFieldRenderer3D';
import { CaptureTileRenderer3D } from '../render3d/CaptureTileRenderer3D';
import { ViewportFootprint } from '../ViewportFootprint';
import { SprayRenderer3D } from '../render3d/SprayRenderer3D';
import { Explosion3D } from '../render3d/Explosion3D';
import { Debris3D } from '../render3d/Debris3D';
import { BurnMark3D } from '../render3d/BurnMark3D';
import { LineDrag3D } from '../render3d/LineDrag3D';
import { BuildGhost3D } from '../render3d/BuildGhost3D';
import { AudioEventScheduler } from './helpers/AudioEventScheduler';
import type { NetworkServerSnapshotSimEvent } from '../network/NetworkTypes';
import {
  getAudioSmoothing,
  getBottomBarsHeight,
  setCurrentZoom,
} from '@/clientBarConfig';
import { CommandQueue, type SelectCommand } from '../sim/commands';
import { PanArrowOverlay } from '../hud/PanArrowOverlay';
import { HealthBarOverlay } from '../hud/HealthBarOverlay';
import { WaypointOverlay } from '../hud/WaypointOverlay';
import { SelectionLabelOverlay } from '../hud/SelectionLabelOverlay';
import { ThreeWorldProjector } from '../render3d/ThreeWorldProjector';

import type { GameConnection } from '../server/GameConnection';
import type {
  NetworkServerSnapshotCombatStats,
  NetworkServerSnapshotMeta,
} from '../network/NetworkTypes';
import { PLAYER_COLORS } from '../sim/types';
import type {
  Entity,
  EntityId,
  PlayerId,
  WaypointType,
  BuildingType,
} from '../sim/types';

import {
  COMBAT_STATS_SAMPLE_INTERVAL,
  EMA_CONFIG,
  FRAME_TIMING_EMA,
  EMA_INITIAL_VALUES,
  WORLD_PADDING_PERCENT,
  ZOOM_INITIAL_GAME,
  ZOOM_INITIAL_DEMO,
} from '../../config';

export type RtsScene3DConfig = {
  playerIds: PlayerId[];
  localPlayerId: PlayerId;
  gameConnection: GameConnection;
  /** Hoisted up to GameCanvas so state survives a live 2D↔3D renderer
   *  swap without waiting for the next keyframe. If the old scene's
   *  CVS is already populated, the new scene inherits all units,
   *  buildings, projectiles, selection, prediction, etc. with zero
   *  delay. On first boot GameCanvas creates a fresh one. */
  clientViewState: ClientViewState;
  mapWidth: number;
  mapHeight: number;
  backgroundMode: boolean;
};

// Mini "camera" accessor that PhaserCanvas.vue reads for zoom display. We derive
// a Pixi-equivalent zoom number from the 3D orbit distance so UI sliders show a
// consistent value. baseDistance is the default camera distance.
type CameraShim = {
  main: {
    zoom: number;
    scrollX: number;
    scrollY: number;
    width: number;
    height: number;
  };
};

type SceneLifecycle = {
  onRestart(cb: () => void): void;
  restart(): void;
};

export class RtsScene3D {
  private threeApp: ThreeApp;

  private clientViewState!: ClientViewState;
  private entityRenderer!: Render3DEntities;
  private beamRenderer!: BeamRenderer3D;
  private forceFieldRenderer!: ForceFieldRenderer3D;
  private captureTileRenderer!: CaptureTileRenderer3D;
  private explosionRenderer!: Explosion3D;
  private debrisRenderer!: Debris3D;
  /** Per-frame world-XY visibility footprint driven by the PLAYER
   *  CLIENT `RENDER: WIN/PAD/ALL` toggle. Populated each frame from
   *  the same 4 corner raycasts the minimap already uses, so the
   *  cull bounds exactly match what the camera can see on the
   *  ground plane. Shared across all per-entity hot loops + the
   *  minimap. */
  private renderScope = new ViewportFootprint();
  private burnMarkRenderer!: BurnMark3D;
  private lineDragRenderer!: LineDrag3D;
  private buildGhostRenderer!: BuildGhost3D;
  private sprayRenderer!: SprayRenderer3D;
  private audioScheduler = new AudioEventScheduler();
  private lastEffectsTickMs = 0;
  private inputManager: Input3DManager | null = null;
  private gameConnection!: GameConnection;
  private snapshotBuffer = new SnapshotBuffer();
  private localCommandQueue = new CommandQueue();
  private currentWaypointMode: WaypointType = 'move';
  // Mirrors Input3DManager's shared CommanderModeController so the
  // SelectionPanel's "SOLAR / FACTORY / D-GUN" chips stay accurate
  // (scene.updateSelectionInfo reads these each frame).
  private currentBuildType: BuildingType | null = null;
  private currentDGunActive = false;
  private panArrowOverlay: PanArrowOverlay | null = null;
  private healthBarOverlay: HealthBarOverlay | null = null;
  private waypointOverlay: WaypointOverlay | null = null;
  private selectionLabelOverlay: SelectionLabelOverlay | null = null;

  private localPlayerId: PlayerId;
  private playerIds: PlayerId[];
  private mapWidth: number;
  private mapHeight: number;
  private backgroundMode: boolean;

  private isGameOver = false;
  private hasCenteredCamera = false;

  // Performance trackers (mirror RtsScene)
  private fpsTracker = new EmaTracker(EMA_CONFIG.fps, EMA_INITIAL_VALUES.fps);
  private snapTracker = new EmaTracker(EMA_CONFIG.snaps, EMA_INITIAL_VALUES.snaps);
  private frameMsTracker = new EmaMsTracker(FRAME_TIMING_EMA.frameMs, EMA_INITIAL_VALUES.frameMs);
  private renderMsTracker = new EmaMsTracker(FRAME_TIMING_EMA.renderMs, EMA_INITIAL_VALUES.renderMs);
  private logicMsTracker = new EmaMsTracker(FRAME_TIMING_EMA.logicMs, EMA_INITIAL_VALUES.logicMs);
  private longtaskTracker = new LongtaskTracker();

  // Reusable raycaster + ground plane for projecting viewport corners
  // onto the world when building the minimap footprint. Allocated once;
  // every updateMinimapData() reuses them.
  private _minimapRay = new THREE.Raycaster();
  private _minimapGround = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private _minimapNdc = new THREE.Vector2();
  private _minimapHit = new THREE.Vector3();

  // UI update throttling (mirror RtsScene)
  private selectionDirty = true;
  private economyUpdateTimer = 0;
  private minimapUpdateTimer = 0;
  private combatStatsUpdateTimer = 0;
  private readonly ECONOMY_UPDATE_INTERVAL = 100;
  private readonly MINIMAP_UPDATE_INTERVAL = 50;
  private readonly COMBAT_STATS_UPDATE_INTERVAL = COMBAT_STATS_SAMPLE_INTERVAL;

  // Snapshot-arrival tracking for snap-rate EMA
  private lastSnapArrivalMs = 0;

  // Entity source adapter, kept shape-compatible with RtsScene's for UI helpers
  private entitySourceAdapter!: {
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
  private _cachedSelectedUnits: Entity[] = [];
  private _cachedSelectedBuildings: Entity[] = [];
  private _cachedPlayerUnits: Entity[] = [];
  private _cachedPlayerBuildings: Entity[] = [];
  private _cachedPlayerIdForUnits: PlayerId = -1 as PlayerId;
  private _cachedPlayerIdForBuildings: PlayerId = -1 as PlayerId;

  // ── Callback interface matching RtsScene ──
  public onPlayerChange?: (playerId: PlayerId) => void;
  public onSelectionChange?: (info: {
    unitCount: number;
    hasCommander: boolean;
    hasBuilder: boolean;
    hasDGun: boolean;
    hasFactory: boolean;
    factoryId?: number;
    commanderId?: number;
    waypointMode: WaypointType;
    isBuildMode: boolean;
    selectedBuildingType: string | null;
    isDGunMode: boolean;
    factoryQueue?: { unitId: string; label: string }[];
    factoryProgress?: number;
    factoryIsProducing?: boolean;
  }) => void;
  public onEconomyChange?: (info: EconomyInfo) => void;
  public onMinimapUpdate?: (data: MinimapData) => void;
  /** Separate per-frame callback for just the camera footprint quad.
   *  Decoupling this from `onMinimapUpdate` keeps the box animation
   *  smooth even when entity rebuilding is throttled to 20 Hz. */
  public onCameraQuadUpdate?: (
    quad: import('../ViewportFootprint').FootprintQuad,
  ) => void;
  public onGameOverUI?: (winnerId: PlayerId) => void;
  public onGameRestart?: () => void;
  public onCombatStatsUpdate?: (stats: NetworkServerSnapshotCombatStats) => void;
  public onServerMetaUpdate?: (meta: NetworkServerSnapshotMeta) => void;

  // Phaser-compat accessors used by PhaserCanvas.vue
  private _restartCb: (() => void) | null = null;
  public readonly scene: SceneLifecycle = {
    onRestart: (cb: () => void) => { this._restartCb = cb; },
    restart: () => { this._restartCb?.(); },
  };

  // Dynamic camera shim — exposes a zoom-like number derived from the orbit
  // distance so UI (zoom display, minimap viewport) has a consistent axis to read.
  public readonly cameras: CameraShim = {
    main: {
      // Filled by the getters below via Object.defineProperty in constructor
      zoom: 0, scrollX: 0, scrollY: 0, width: 0, height: 0,
    },
  };

  private _baseDistance: number;

  constructor(threeApp: ThreeApp, config: RtsScene3DConfig) {
    this.threeApp = threeApp;
    this.localPlayerId = config.localPlayerId;
    this.playerIds = config.playerIds;
    this.mapWidth = config.mapWidth;
    this.mapHeight = config.mapHeight;
    this.backgroundMode = config.backgroundMode;
    this.gameConnection = config.gameConnection;
    // ClientViewState is owned by GameCanvas so its state (units, buildings,
    // prediction, selection) survives a live 2D↔3D renderer swap.
    this.clientViewState = config.clientViewState;
    this._baseDistance = Math.max(this.mapWidth, this.mapHeight) * 0.35;

    // Seed orbit camera on map center (ThreeApp did this too, but we honor the
    // game vs demo initial-zoom distinction like RtsScene).
    //
    // Default yaw = π so the camera sits on the +Z side of the map looking
    // toward −Z. That puts sim-Y = 0 (the "top" of the map in the 2D view,
    // where red team spawns) at the top of the 3D screen — matching the
    // 2D orientation instead of flipping the board upside-down.
    const initialZoom = this.backgroundMode ? ZOOM_INITIAL_DEMO : ZOOM_INITIAL_GAME;
    this.threeApp.orbit.setTarget(this.mapWidth / 2, 0, this.mapHeight / 2);
    this.threeApp.orbit.distance = this._baseDistance / initialZoom;
    this.threeApp.orbit.yaw = Math.PI;
    this.threeApp.orbit.apply();

    // Redefine cameras.main as live getters bound to orbit + renderer
    Object.defineProperties(this.cameras.main, {
      zoom: {
        get: () => this._baseDistance / this.threeApp.orbit.distance,
      },
      scrollX: {
        get: () => this.threeApp.orbit.target.x - this._visibleHalfWidth(),
      },
      scrollY: {
        get: () => this.threeApp.orbit.target.z - this._visibleHalfHeight(),
      },
      width: { get: () => this.threeApp.renderer.domElement.clientWidth },
      height: { get: () => this.threeApp.renderer.domElement.clientHeight },
    });
  }

  /** Approximate visible world-width at the ground plane (for minimap viewport). */
  private _visibleHalfWidth(): number {
    // perspective view: half-angle * distance, scaled by aspect ratio
    const cam = this.threeApp.camera;
    const vFov = (cam.fov * Math.PI) / 180;
    const halfH = Math.tan(vFov / 2) * this.threeApp.orbit.distance;
    return halfH * cam.aspect;
  }

  private _visibleHalfHeight(): number {
    const cam = this.threeApp.camera;
    const vFov = (cam.fov * Math.PI) / 180;
    return Math.tan(vFov / 2) * this.threeApp.orbit.distance;
  }

  create(): void {
    // this.clientViewState is already set from config (constructor).
    this.entitySourceAdapter = {
      getUnits: () => this.clientViewState.getUnits(),
      getBuildings: () => this.clientViewState.getBuildings(),
      getProjectiles: () => this.clientViewState.getProjectiles(),
      getAllEntities: () => this.clientViewState.getAllEntities(),
      getEntity: (id) => this.clientViewState.getEntity(id),
      getSelectedUnits: () => this._cachedSelectedUnits,
      getSelectedBuildings: () => this._cachedSelectedBuildings,
      getBuildingsByPlayer: (pid) => {
        if (pid !== this._cachedPlayerIdForBuildings) {
          this._cachedPlayerBuildings.length = 0;
          for (const b of this.clientViewState.getBuildings()) {
            if (b.ownership?.playerId === pid) this._cachedPlayerBuildings.push(b);
          }
          this._cachedPlayerIdForBuildings = pid;
        }
        return this._cachedPlayerBuildings;
      },
      getUnitsByPlayer: (pid) => {
        if (pid !== this._cachedPlayerIdForUnits) {
          this._cachedPlayerUnits.length = 0;
          for (const u of this.clientViewState.getUnits()) {
            if (u.ownership?.playerId === pid) this._cachedPlayerUnits.push(u);
          }
          this._cachedPlayerIdForUnits = pid;
        }
        return this._cachedPlayerUnits;
      },
    };

    this.snapshotBuffer.attach(this.gameConnection);

    this.gameConnection.onGameOver((winnerId: PlayerId) => {
      if (!this.isGameOver) this.handleGameOver(winnerId);
    });

    this.entityRenderer = new Render3DEntities(
      this.threeApp.world,
      this.clientViewState,
      this.renderScope,
    );
    this.beamRenderer = new BeamRenderer3D(this.threeApp.world, this.renderScope);
    this.forceFieldRenderer = new ForceFieldRenderer3D(this.threeApp.world, this.renderScope);
    this.captureTileRenderer = new CaptureTileRenderer3D(
      this.threeApp.world,
      this.clientViewState,
      this.mapWidth,
      this.mapHeight,
    );
    this.explosionRenderer = new Explosion3D(this.threeApp.world);
    this.debrisRenderer = new Debris3D(this.threeApp.world);
    this.burnMarkRenderer = new BurnMark3D(this.threeApp.world, this.renderScope);
    this.lineDragRenderer = new LineDrag3D(this.threeApp.world);
    this.buildGhostRenderer = new BuildGhost3D(this.threeApp.world);
    this.sprayRenderer = new SprayRenderer3D(this.threeApp.world);

    // Shared pan-direction arrow (same DOM/SVG overlay the 2D path uses).
    const canvasParent = this.threeApp.canvas.parentElement;
    if (canvasParent) {
      this.panArrowOverlay = new PanArrowOverlay(canvasParent, () => ({
        top: 50,
        bottom: getBottomBarsHeight(),
      }));
      const overlay = this.panArrowOverlay;
      this.threeApp.orbit.setOnPanState(
        (dirX, dirY, intensity) => overlay.set(dirX, dirY, intensity),
      );

      // Shared health-bar + waypoint overlays (same SVG layers the 2D path uses).
      const projector = new ThreeWorldProjector(
        this.threeApp.camera,
        this.threeApp.canvas,
      );
      this.healthBarOverlay = new HealthBarOverlay(canvasParent, projector);
      this.waypointOverlay = new WaypointOverlay(canvasParent, projector);
      this.selectionLabelOverlay = new SelectionLabelOverlay(canvasParent, projector);
    }

    // Wire raycast-based selection + move commands
    this.inputManager = new Input3DManager(
      this.threeApp,
      {
        getTick: () => this.clientViewState.getTick(),
        activePlayerId: this.localPlayerId,
      },
      this.entitySourceAdapter,
      this.localCommandQueue,
      this.gameConnection,
    );
    // Hand the build-ghost renderer to the input manager so it can
    // drive preview updates on mouse-move-in-build-mode (hidden on
    // mode exit via the onBuildModeChange callback below).
    this.inputManager.setBuildGhost(this.buildGhostRenderer);
    // Keep scene's waypointMode in lockstep with the InputManager so the
    // SelectionPanel reflects the active mode when M/F/H hotkeys fire.
    this.inputManager.onWaypointModeChange = (mode) => {
      this.currentWaypointMode = mode;
      this.selectionDirty = true;
    };
    // Keep the SelectionPanel's mode chips (build / D-gun) in sync
    // with the shared CommanderModeController inside Input3DManager.
    this.inputManager.onBuildModeChange = (type) => {
      this.currentBuildType = type;
      this.selectionDirty = true;
    };
    this.inputManager.onDGunModeChange = (active) => {
      this.currentDGunActive = active;
      this.selectionDirty = true;
    };

    // Camera clamping: keep the orbit target inside a padded map region.
    const paddingX = this.mapWidth * WORLD_PADDING_PERCENT;
    const paddingY = this.mapHeight * WORLD_PADDING_PERCENT;
    const minX = -paddingX;
    const minZ = -paddingY;
    const maxX = this.mapWidth + paddingX;
    const maxZ = this.mapHeight + paddingY;
    const originalApply = this.threeApp.orbit.apply.bind(this.threeApp.orbit);
    this.threeApp.orbit.apply = () => {
      this.threeApp.orbit.target.x = Math.min(maxX, Math.max(minX, this.threeApp.orbit.target.x));
      this.threeApp.orbit.target.z = Math.min(maxZ, Math.max(minZ, this.threeApp.orbit.target.z));
      originalApply();
    };
  }

  update(_time: number, delta: number): void {
    const frameStart = performance.now();

    // Per-frame FPS tracker
    if (delta > 0) this.fpsTracker.update(1000 / delta);

    // Drain any audio events whose scheduled playback time has arrived. This
    // runs every frame (not just on snapshot arrival) because scheduled events
    // are staggered across the snapshot interval.
    const nowDrain = performance.now();
    this.audioScheduler.drain(nowDrain, (event) => this.handleSimEvent3D(event));

    // Consume newest snapshot (if any)
    const state = this.snapshotBuffer.consume();
    if (state) {
      this.clientViewState.applyNetworkState(state);

      const now = performance.now();
      if (this.lastSnapArrivalMs > 0) {
        const dt = now - this.lastSnapArrivalMs;
        if (dt > 0) this.snapTracker.update(1000 / dt);
      }
      this.lastSnapArrivalMs = now;

      // Schedule any new SimEvents that came in with this snapshot. Smoothing
      // staggers one-shot events across the snapshot interval; continuous
      // start/stop events fire immediately (handled inside AudioEventScheduler).
      this.audioScheduler.recordSnapshot(now);
      const events = this.clientViewState.getPendingAudioEvents();
      if (events && events.length > 0) {
        this.audioScheduler.schedule(
          events,
          now,
          getAudioSmoothing(),
          (event) => this.handleSimEvent3D(event),
        );
      }

      // Forward server meta to UI
      const serverMeta = this.clientViewState.getServerMeta();
      if (serverMeta && this.onServerMetaUpdate) this.onServerMetaUpdate(serverMeta);

      // Game over
      const winnerId = this.clientViewState.getGameOverWinnerId();
      if (winnerId !== null && !this.isGameOver) this.handleGameOver(winnerId);

      // First-snapshot camera centering for the player's commander —
      // applied in both the real game and the demo so the initial
      // view always frames the seat the user is in. Zoom / distance
      // stays at the ZOOM_INITIAL_DEMO value set in the constructor;
      // centerCameraOnCommander only adjusts target + yaw.
      if (!this.hasCenteredCamera) {
        this.centerCameraOnCommander();
      }

      this.selectionDirty = true;
    }

    // Process local commands — select/clearSelection apply to ClientViewState,
    // everything else gets forwarded to the server via GameConnection
    this.processLocalCommands();

    // Rebuild selected-entity caches after selection commands have been applied
    this._cachedSelectedUnits.length = 0;
    this._cachedSelectedBuildings.length = 0;
    const pid = this.localPlayerId;
    for (const e of this.clientViewState.getUnits()) {
      if (e.selectable?.selected && e.ownership?.playerId === pid) {
        this._cachedSelectedUnits.push(e);
      }
    }
    for (const b of this.clientViewState.getBuildings()) {
      if (b.selectable?.selected && b.ownership?.playerId === pid) {
        this._cachedSelectedBuildings.push(b);
      }
    }

    // Dead-reckon + drift every frame so units animate between snapshots
    this.clientViewState.applyPrediction(delta);

    // Invalidate per-player entity caches (rebuilt lazily by adapter)
    this._cachedPlayerIdForUnits = -1 as PlayerId;
    this._cachedPlayerIdForBuildings = -1 as PlayerId;

    // Render phase
    const renderStart = performance.now();
    // Publish the current zoom to the LOD system so the 'auto' and
    // 'auto-zoom' quality modes can react to the camera's distance.
    // The 2D path does this via setCurrentZoom(camera.zoom); the 3D
    // camera shim's `zoom` accessor already derives a 2D-equivalent
    // zoom from baseDistance / orbit.distance.
    setCurrentZoom(this.cameras.main.zoom);
    // Refresh the shared visibility footprint once per frame so every
    // per-entity hot loop below can early-out on off-screen entities
    // without re-querying camera state or getRenderMode(). The same
    // quad feeds the minimap (see updateMinimapData).
    this._cameraQuad = this.computeCameraQuad();
    this.renderScope.setQuad(this._cameraQuad);
    // Emit the quad every frame — the minimap's camera box reads
    // this directly so it stays pinned to the view regardless of
    // the (throttled) entity-list refresh.
    this.onCameraQuadUpdate?.(this._cameraQuad);
    this.entityRenderer.update();
    this.captureTileRenderer.update();
    const projectiles = this.clientViewState.getProjectiles();
    this.beamRenderer.update(projectiles);
    this.forceFieldRenderer.update(this.clientViewState.getUnits());

    // Effects: explosions / debris integrate their own physics each frame;
    // burn marks sample live beams to trace scorches on the ground. We feed
    // the scheduler's clamped dt so backgrounded tabs don't jump-forward.
    const effectNow = performance.now();
    const effectDt = this.lastEffectsTickMs === 0
      ? 0
      : Math.min(effectNow - this.lastEffectsTickMs, 100);
    this.lastEffectsTickMs = effectNow;
    this.explosionRenderer.update(effectDt);
    this.debrisRenderer.update(effectDt);
    this.burnMarkRenderer.update(projectiles, effectDt);
    // Commander build / heal spray trails — read straight from sim state
    // via ClientViewState, same list the 2D renderer consumes.
    this.sprayRenderer.update(this.clientViewState.getSprayTargets(), effectDt);
    // Per-frame input bookkeeping — currently just the shared
    // SelectionChangeTracker, which resets waypoint mode when the
    // selection changes (matches the 2D path's InputManager.update).
    this.inputManager?.tick();
    // Line-drag preview reads directly from the input manager's live state.
    if (this.inputManager) {
      this.lineDragRenderer.update(this.inputManager.getLineDragState());
    }
    this.healthBarOverlay?.update(
      this.clientViewState.getUnits(),
      this.clientViewState.getBuildings(),
    );
    this.waypointOverlay?.update(
      this._cachedSelectedUnits,
      this._cachedSelectedBuildings,
    );
    this.selectionLabelOverlay?.update(
      this._cachedSelectedUnits,
      this._cachedSelectedBuildings,
    );
    const renderEnd = performance.now();

    // UI updates — throttled like RtsScene. A producing factory's
    // queue/progress changes continuously, so force a selection-info
    // push whenever one is selected — mirrors RtsScene so the
    // SelectionPanel's build progress bar ticks live.
    if (!this.selectionDirty) {
      const hasProducingFactory = this._cachedSelectedBuildings.some(
        (b) => b.factory?.isProducing,
      );
      if (hasProducingFactory) this.selectionDirty = true;
    }
    if (this.selectionDirty) {
      this.updateSelectionInfo();
      this.selectionDirty = false;
    }

    this.economyUpdateTimer += delta;
    if (this.economyUpdateTimer >= this.ECONOMY_UPDATE_INTERVAL) {
      this.economyUpdateTimer = 0;
      this.updateEconomyInfo();
    }

    this.minimapUpdateTimer += delta;
    if (this.minimapUpdateTimer >= this.MINIMAP_UPDATE_INTERVAL) {
      this.minimapUpdateTimer = 0;
      this.updateMinimapData();
    }

    this.combatStatsUpdateTimer += delta;
    if (this.combatStatsUpdateTimer >= this.COMBAT_STATS_UPDATE_INTERVAL) {
      this.combatStatsUpdateTimer = 0;
      const stats = this.clientViewState.getCombatStats();
      if (stats && this.onCombatStatsUpdate) this.onCombatStatsUpdate(stats);
    }

    // Track frame timing
    const frameEnd = performance.now();
    const frameMs = frameEnd - frameStart;
    const renderMs = renderEnd - renderStart;
    const logicMs = frameMs - renderMs;
    this.frameMsTracker.update(frameMs);
    this.renderMsTracker.update(renderMs);
    this.logicMsTracker.update(logicMs);
    this.longtaskTracker.tick();
  }

  private centerCameraOnCommander(): void {
    const units = this.clientViewState.getUnits();
    const commander = units.find(
      (e) => e.commander !== undefined && e.ownership?.playerId === this.localPlayerId,
    );
    if (commander) {
      const cx = commander.transform.x;
      const cz = commander.transform.y;
      this.threeApp.orbit.setTarget(cx, 0, cz);

      // Place the camera "behind" the commander looking toward the map
      // center — natural RTS framing on spawn where the battlefield
      // opens up in front of the unit. Yaw math:
      //
      //   forward vector (commander → center) = normalize(center − pos)
      //   OrbitCamera's yaw=0 convention puts the camera on the -Z side
      //   of the target looking toward +Z. yaw=π flips that. In general
      //   the camera sits at target + distance · (sin(yaw), 0,
      //   -cos(yaw)) and looks back at the target, so for a forward
      //   vector (fx, fz) we want the camera OPPOSITE that vector —
      //   i.e. yaw = atan2(-fx, fz).
      //
      // Commanders spawn in an even circle around the map center
      // (sim/spawn.ts), so this makes every player's first view look
      // the same relative to their own commander regardless of seat.
      const forwardX = this.mapWidth / 2 - cx;
      const forwardZ = this.mapHeight / 2 - cz;
      if (forwardX * forwardX + forwardZ * forwardZ > 1) {
        this.threeApp.orbit.yaw = Math.atan2(-forwardX, forwardZ);
        this.threeApp.orbit.apply();
      }
      this.hasCenteredCamera = true;
    }
  }

  private processLocalCommands(): void {
    const commands = this.localCommandQueue.getAll();
    this.localCommandQueue.clear();
    for (const command of commands) {
      if (command.type === 'select') {
        const sc = command as SelectCommand;
        if (!sc.additive) this.clientViewState.clearSelection();
        for (const id of sc.entityIds) this.clientViewState.selectEntity(id);
        this.selectionDirty = true;
      } else if (command.type === 'clearSelection') {
        this.clientViewState.clearSelection();
        this.selectionDirty = true;
      } else {
        this.gameConnection.sendCommand(command);
      }
    }
  }

  /**
   * Dispatch a SimEvent to the 3D effect renderers. Mirrors the subset of
   * DeathEffectsHandler that is visual (audio is handled separately, or not
   * yet — the 3D view currently leaves audio to the 2D path via shared state).
   *
   * Event types handled:
   *   - 'hit'              → fire explosion at event.pos
   *   - 'projectileExpire' → smaller fire explosion (projectile reached max
   *                          range or hit the ground)
   *   - 'death'            → fire explosion + material debris cluster
   *
   * laserStart/Stop and forceFieldStart/Stop need no visual reaction here —
   * beams are drawn continuously while live projectiles exist, and force-field
   * visuals come from FLAG toggles on their turret state.
   */
  private handleSimEvent3D(event: NetworkServerSnapshotSimEvent): void {
    if (event.type === 'hit') {
      const ctx = event.impactContext;
      // Use the larger of the three radii so big AoE shots pop correctly;
      // fall back to a small constant for beams where the impact context is
      // minimal.
      const r = ctx
        ? Math.max(ctx.collisionRadius, ctx.primaryRadius, ctx.secondaryRadius, 8)
        : 8;
      // Combined impulse vector (sim X/Y → world X/Z): penetration direction
      // dominates because that's the intended "away from attacker" push, with
      // smaller contributions from the projectile's ballistic momentum and
      // the target's own velocity (so a moving target's debris trails).
      // Same three components the 2D DeathEffectsHandler feeds into
      // addExplosion(..., penetrationX, penetrationY, attackerX, attackerY,
      // velocityX, velocityY, ...).
      let mx = 0, mz = 0;
      if (ctx) {
        mx =
          ctx.penetrationDir.x * 120 +
          ctx.projectile.vel.x * 0.3 +
          ctx.entity.vel.x * 0.3;
        mz =
          ctx.penetrationDir.y * 120 +
          ctx.projectile.vel.y * 0.3 +
          ctx.entity.vel.y * 0.3;
      }
      this.explosionRenderer.spawnImpact(event.pos.x, event.pos.y, r, mx, mz);
    } else if (event.type === 'projectileExpire') {
      // Ground / expired-projectile fire — always a small pop, no meaningful
      // momentum (the projectile stopped).
      this.explosionRenderer.spawnImpact(event.pos.x, event.pos.y, 8);
    } else if (event.type === 'death') {
      // Some kill paths (splash, bleed-out, force-field zone damage) emit
      // a death event with no deathContext. Rather than skipping the
      // material explosion entirely, try to reconstruct a minimal context
      // from the entity if it's still in view state; otherwise synthesize
      // a generic fallback so debris still fires.
      let ctx = event.deathContext;
      if (!ctx && event.entityId !== undefined) {
        const ent = this.clientViewState.getEntity(event.entityId);
        if (ent) {
          const pid = ent.ownership?.playerId;
          const tcol =
            pid !== undefined
              ? PLAYER_COLORS[pid]?.primary ?? 0xcccccc
              : 0xcccccc;
          ctx = {
            unitVel: {
              x: ent.unit?.velocityX ?? 0,
              y: ent.unit?.velocityY ?? 0,
            },
            hitDir: { x: 0, y: 0 },
            projectileVel: { x: 0, y: 0 },
            attackMagnitude: 25,
            radius: ent.unit?.unitRadiusCollider.shot ?? 15,
            color: tcol,
            unitType: ent.unit?.unitType,
            rotation: ent.transform.rotation,
          };
        }
      }
      if (!ctx) {
        // Entity already gone and no server-supplied context — synthesize a
        // bare-minimum neutral context so Debris3D's generic-chunks fallback
        // still produces *something* visible. Worse than a real debris
        // burst but better than silence.
        ctx = {
          unitVel: { x: 0, y: 0 },
          hitDir: { x: 0, y: 0 },
          projectileVel: { x: 0, y: 0 },
          attackMagnitude: 25,
          radius: 15,
          color: 0xcccccc,
        };
      }

      // Scale the hit-direction push by the damaging attack's magnitude so
      // a glancing railgun hit kicks debris further than a DoT tick. Clamp
      // to prevent absurd throws at very-high-damage edge cases.
      const attackPush = Math.min(ctx.attackMagnitude * 2, 200);
      const mx =
        ctx.hitDir.x * attackPush +
        ctx.projectileVel.x * 0.3 +
        ctx.unitVel.x * 0.5;
      const mz =
        ctx.hitDir.y * attackPush +
        ctx.projectileVel.y * 0.3 +
        ctx.unitVel.y * 0.5;
      this.explosionRenderer.spawnDeath(
        event.pos.x, event.pos.y,
        Math.max(ctx.radius, 6),
        mx, mz,
      );
      this.debrisRenderer.spawn(event.pos.x, event.pos.y, ctx);
    }
  }

  private handleGameOver(winnerId: PlayerId): void {
    if (this.isGameOver) return;
    this.isGameOver = true;
    this.onGameOverUI?.(winnerId);
  }

  public updateSelectionInfo(): void {
    if (!this.onSelectionChange) return;
    // Input-state mirror for the SelectionPanel UI — reads the live
    // build/waypoint/d-gun flags so the panel's mode chips stay in sync.
    const inputState: UIInputState = {
      waypointMode: this.currentWaypointMode,
      isBuildMode: this.currentBuildType !== null,
      selectedBuildingType: this.currentBuildType,
      isDGunMode: this.currentDGunActive,
    };
    this.onSelectionChange(
      buildSelectionInfo(this.entitySourceAdapter, inputState),
    );
  }

  public updateEconomyInfo(): void {
    if (!this.onEconomyChange) return;
    const serverMeta = this.clientViewState.getServerMeta();
    const maxTotal = serverMeta?.units.max ?? 120;
    const info = buildEconomyInfo(
      this.entitySourceAdapter,
      this.localPlayerId,
      Math.floor(maxTotal / this.playerIds.length),
    );
    if (info) this.onEconomyChange(info);
  }

  public updateMinimapData(): void {
    if (!this.onMinimapUpdate) return;
    // The camera quad is already computed once per frame for the
    // shared ViewportFootprint (scope culling); the minimap just
    // reads it so we don't pay 4× raycasts twice per frame.
    this.onMinimapUpdate(
      buildMinimapData(
        this.entitySourceAdapter,
        this.mapWidth,
        this.mapHeight,
        this._cameraQuad,
      ),
    );
  }

  /** Raycast each of the four NDC viewport corners (±1, ±1) through
   *  the perspective camera onto the y=0 ground plane, returning a
   *  ground-plane quad (TL, TR, BR, BL in screen order). Reused by
   *  the scope footprint and the minimap — called once per frame
   *  in update(). */
  private computeCameraQuad(): [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
  ] {
    return [
      this.cornerOnGround(-1,  1),
      this.cornerOnGround( 1,  1),
      this.cornerOnGround( 1, -1),
      this.cornerOnGround(-1, -1),
    ];
  }

  private _cameraQuad: [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
  ] = [
    { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 },
  ];

  /** Project a viewport corner (in NDC: x,y ∈ [-1,1]) onto the y=0
   *  ground plane. When the corner ray points above the horizon (no
   *  intersection with positive t), fall back to a point far along
   *  the ray's ground-plane projection so the minimap still draws a
   *  non-degenerate quad. */
  private cornerOnGround(ndcX: number, ndcY: number): { x: number; y: number } {
    this._minimapNdc.set(ndcX, ndcY);
    this._minimapRay.setFromCamera(this._minimapNdc, this.threeApp.camera);
    const ray = this._minimapRay.ray;
    // Prefer true ground intersection when the ray actually crosses y=0
    // ahead of the camera (t > 0). For near-horizontal camera pitch the
    // upper corners can point above the horizon — in that case, project
    // the ray's direction onto the XZ plane and step out a big-but-
    // finite distance so the minimap still gets a quad.
    if (ray.intersectPlane(this._minimapGround, this._minimapHit)) {
      return { x: this._minimapHit.x, y: this._minimapHit.z };
    }
    const origin = ray.origin;
    const dir = ray.direction;
    const farT = Math.max(this.mapWidth, this.mapHeight) * 4;
    return {
      x: origin.x + dir.x * farT,
      y: origin.z + dir.z * farT,
    };
  }

  // ── Public methods matching RtsScene's surface ──

  public restartGame(): void {
    this.isGameOver = false;
    this.onGameRestart?.();
    this.scene.restart();
  }

  public switchPlayer(playerId: PlayerId): void {
    this.localPlayerId = playerId;
    this.markSelectionDirty();
    this.onPlayerChange?.(playerId);
  }

  public togglePlayer(): void {
    const currentIndex = this.playerIds.indexOf(this.localPlayerId);
    const nextIndex = (currentIndex + 1) % this.playerIds.length;
    this.switchPlayer(this.playerIds[nextIndex]);
  }

  public getActivePlayer(): PlayerId {
    return this.localPlayerId;
  }

  public markSelectionDirty(): void {
    this.selectionDirty = true;
  }

  public setWaypointMode(mode: WaypointType): void {
    this.currentWaypointMode = mode;
    this.inputManager?.setWaypointMode(mode);
    this.selectionDirty = true;
  }
  /** Enter build mode — forwards to Input3DManager which handles the
   *  left-click-places-building / right-click-cancels flow. */
  public startBuildMode(buildingType: BuildingType): void {
    this.inputManager?.setBuildMode(buildingType);
  }

  public cancelBuildMode(): void {
    this.inputManager?.cancelBuildMode();
  }
  public toggleDGunMode(): void {
    this.inputManager?.toggleDGunMode();
  }
  public queueFactoryUnit(factoryId: number, unitId: string): void {
    // Factory build queue is server-authoritative, so this command
    // goes straight through gameConnection (same path the 2D scene's
    // processLocalCommands forwards it to).
    this.gameConnection.sendCommand({
      type: 'queueUnit',
      tick: this.clientViewState.getTick(),
      factoryId,
      unitId,
    });
  }

  public cancelFactoryQueueItem(factoryId: number, index: number): void {
    this.gameConnection.sendCommand({
      type: 'cancelQueueItem',
      tick: this.clientViewState.getTick(),
      factoryId,
      index,
    });
  }

  public centerCameraOn(x: number, y: number): void {
    this.threeApp.orbit.setTarget(x, 0, y);
  }

  /** Capture the orbit camera's current framing in the portable
   *  `SceneCameraState` shape — 2D-equivalent zoom + the (x, y)
   *  world-space target point. */
  public captureCameraState(): SceneCameraState {
    const orbit = this.threeApp.orbit;
    return {
      x: orbit.target.x,
      y: orbit.target.z,
      zoom: this._baseDistance / orbit.distance,
    };
  }

  /** Apply a captured camera state. Works with states captured from
   *  either renderer — the zoom scalar is in 2D-equivalent units and
   *  maps back to an orbit distance via the scene's base distance. */
  public applyCameraState(state: SceneCameraState): void {
    const orbit = this.threeApp.orbit;
    orbit.setTarget(state.x, 0, state.y);
    orbit.distance = this._baseDistance / Math.max(state.zoom, 0.001);
    orbit.apply();
  }

  public getFrameTiming(): {
    frameMsAvg: number; frameMsHi: number;
    renderMsAvg: number; renderMsHi: number;
    logicMsAvg: number; logicMsHi: number;
    /** Actual GPU execution time (ms) from EXT_disjoint_timer_query_webgl2,
     *  or 0 when the extension isn't available (Safari). Callers should
     *  check `gpuTimerSupported` and fall back to renderMs if false. */
    gpuTimerMs: number;
    gpuTimerSupported: boolean;
    /** Longtask signal — blocked ms per second of wall-clock time. */
    longtaskMsPerSec: number;
    longtaskCountPerSec: number;
    longtaskSupported: boolean;
  } {
    return {
      frameMsAvg: this.frameMsTracker.getAvg(),
      frameMsHi: this.frameMsTracker.getHi(),
      renderMsAvg: this.renderMsTracker.getAvg(),
      renderMsHi: this.renderMsTracker.getHi(),
      logicMsAvg: this.logicMsTracker.getAvg(),
      logicMsHi: this.logicMsTracker.getHi(),
      gpuTimerMs: this.threeApp.gpuTimer.getGpuMs(),
      gpuTimerSupported: this.threeApp.gpuTimer.isSupported(),
      longtaskMsPerSec: this.longtaskTracker.getBlockedMsPerSec(),
      longtaskCountPerSec: this.longtaskTracker.getCountPerSec(),
      longtaskSupported: this.longtaskTracker.isSupported(),
    };
  }

  public getFrameStats(): { avgFps: number; worstFps: number } {
    return {
      avgFps: this.fpsTracker.getAvg(),
      worstFps: this.fpsTracker.getLow(),
    };
  }

  public getSnapshotStats(): { avgRate: number; worstRate: number } {
    return {
      avgRate: this.snapTracker.getAvg(),
      worstRate: this.snapTracker.getLow(),
    };
  }

  /**
   * Tear down the scene. By default disconnects the GameConnection;
   * passing `{ keepConnection: true }` skips the disconnect so a live
   * renderer swap can reuse the same connection across the new scene.
   */
  public shutdown(opts: { keepConnection?: boolean } = {}): void {
    this.inputManager?.destroy();
    this.inputManager = null;
    this.threeApp.orbit.setOnPanState(undefined);
    this.panArrowOverlay?.destroy();
    this.panArrowOverlay = null;
    this.healthBarOverlay?.destroy();
    this.healthBarOverlay = null;
    this.waypointOverlay?.destroy();
    this.waypointOverlay = null;
    this.selectionLabelOverlay?.destroy();
    this.selectionLabelOverlay = null;
    this.entityRenderer?.destroy();
    this.beamRenderer?.destroy();
    this.forceFieldRenderer?.destroy();
    this.captureTileRenderer?.destroy();
    this.explosionRenderer?.destroy();
    this.debrisRenderer?.destroy();
    this.burnMarkRenderer?.destroy();
    this.lineDragRenderer?.destroy();
    this.buildGhostRenderer?.destroy();
    this.sprayRenderer?.destroy();
    this.longtaskTracker.destroy();
    this.audioScheduler.clear();
    if (!opts.keepConnection) {
      this.gameConnection?.disconnect();
    }
    this.snapshotBuffer.clear();
    this.localCommandQueue.clear();
    this.onPlayerChange = undefined;
    this.onSelectionChange = undefined;
    this.onEconomyChange = undefined;
    this.onMinimapUpdate = undefined;
    this.onCameraQuadUpdate = undefined;
    this.onGameOverUI = undefined;
    this.onGameRestart = undefined;
    this.onCombatStatsUpdate = undefined;
    this.onServerMetaUpdate = undefined;
  }
}
