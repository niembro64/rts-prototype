// RtsScene3D — 3D equivalent of RtsScene.
//
// Implements the same public API surface (callbacks + methods) so PhaserCanvas.vue
// can drive it interchangeably with the 2D scene. Internally it uses ThreeApp and
// Render3DEntities instead of Pixi graphics, and currently has no selection/input
// (view-only). Selection/commands will be added in a later pass.

import type { ClientViewState } from '../network/ClientViewState';
import type { SceneCameraState } from '@/types/game';
import { SnapshotBuffer } from './helpers/SnapshotBuffer';
import {
  buildSelectionInfo,
  buildEconomyInfo,
  buildMinimapData,
} from './helpers';
import type { EconomyInfo, MinimapData } from './helpers';
import { EmaTracker } from './helpers/EmaTracker';
import { EmaMsTracker } from './helpers/EmaMsTracker';
import { LongtaskTracker } from './helpers/LongtaskTracker';
import { ThreeApp } from '../render3d/ThreeApp';
import { Render3DEntities } from '../render3d/Render3DEntities';
import { Input3DManager } from '../render3d/Input3DManager';
import { BeamRenderer3D } from '../render3d/BeamRenderer3D';
import { ForceFieldRenderer3D } from '../render3d/ForceFieldRenderer3D';
import { CaptureTileRenderer3D } from '../render3d/CaptureTileRenderer3D';
import { RenderScope3D } from '../render3d/RenderScope3D';
import { Explosion3D } from '../render3d/Explosion3D';
import { Debris3D } from '../render3d/Debris3D';
import { BurnMark3D } from '../render3d/BurnMark3D';
import { LineDrag3D } from '../render3d/LineDrag3D';
import { AudioEventScheduler } from './helpers/AudioEventScheduler';
import type { NetworkServerSnapshotSimEvent } from '../network/NetworkTypes';
import { getAudioSmoothing, getBottomBarsHeight } from '@/clientBarConfig';
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
  /** Per-frame world-XZ visibility rect driven by the PLAYER CLIENT
   *  `RENDER: WIN/PAD/ALL` toggle. Shared across all per-entity hot
   *  loops so off-scope entities can skip transform/animation updates. */
  private renderScope = new RenderScope3D();
  private burnMarkRenderer!: BurnMark3D;
  private lineDragRenderer!: LineDrag3D;
  private audioScheduler = new AudioEventScheduler();
  private lastEffectsTickMs = 0;
  private inputManager: Input3DManager | null = null;
  private gameConnection!: GameConnection;
  private snapshotBuffer = new SnapshotBuffer();
  private localCommandQueue = new CommandQueue();
  private currentWaypointMode: WaypointType = 'move';
  // Mirrors Input3DManager.buildType so the SelectionPanel's "SOLAR /
  // FACTORY" chip stays accurate (scene.updateSelectionInfo reads it).
  private currentBuildType: BuildingType | null = null;
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
    // Keep scene's waypointMode in lockstep with the InputManager so the
    // SelectionPanel reflects the active mode when M/F/H hotkeys fire.
    this.inputManager.onWaypointModeChange = (mode) => {
      this.currentWaypointMode = mode;
      this.selectionDirty = true;
    };
    // Keep isBuildMode + selectedBuildingType in lockstep so the
    // SelectionPanel shows the active build / cancel chip correctly.
    this.inputManager.onBuildModeChange = (type) => {
      this.currentBuildType = type;
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

      // First-snapshot camera centering for the player's commander
      if (!this.hasCenteredCamera && !this.backgroundMode) {
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
    // Refresh the shared visibility scope once per frame so every per-
    // entity hot loop below can early-out on off-screen entities without
    // re-querying camera state or getRenderMode().
    this.renderScope.refresh(
      this.threeApp.orbit.target.x,
      this.threeApp.orbit.target.z,
      this._visibleHalfWidth(),
      this._visibleHalfHeight(),
    );
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

    // UI updates — throttled like RtsScene
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
      this.threeApp.orbit.setTarget(
        commander.transform.x,
        0,
        commander.transform.y,
      );
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
    // build/waypoint flags so the panel's mode chips stay in sync.
    // (D-gun isn't implemented yet in 3D; left false so the chip
    // disappears rather than showing an always-off state.)
    const inputState = {
      waypointMode: this.currentWaypointMode,
      isBuildMode: this.currentBuildType !== null,
      selectedBuildingType: this.currentBuildType,
      isDGunMode: false,
    } as const;
    this.onSelectionChange(
      buildSelectionInfo(this.entitySourceAdapter, inputState as any),
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
    const cam = this.cameras.main;
    this.onMinimapUpdate(
      buildMinimapData(
        this.entitySourceAdapter,
        this.mapWidth,
        this.mapHeight,
        cam.scrollX,
        cam.scrollY,
        cam.width / cam.zoom,
        cam.height / cam.zoom,
      ),
    );
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
  // Build / D-gun / factory queueing are not yet implemented in 3D.
  // They're kept as no-ops so the 2D UI surface stays source-compatible.
  /** Enter build mode — forwards to Input3DManager which handles the
   *  left-click-places-building / right-click-cancels flow. */
  public startBuildMode(buildingType: BuildingType): void {
    this.inputManager?.setBuildMode(buildingType);
  }

  public cancelBuildMode(): void {
    this.inputManager?.cancelBuildMode();
  }
  public toggleDGunMode(): void {}
  public queueFactoryUnit(_factoryId: number, _unitId: string): void {}
  public cancelFactoryQueueItem(_factoryId: number, _index: number): void {}

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
    this.onGameOverUI = undefined;
    this.onGameRestart = undefined;
    this.onCombatStatsUpdate = undefined;
    this.onServerMetaUpdate = undefined;
  }
}
