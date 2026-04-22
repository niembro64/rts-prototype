// RtsScene3D — 3D equivalent of RtsScene.
//
// Implements the same public API surface (callbacks + methods) so PhaserCanvas.vue
// can drive it interchangeably with the 2D scene. Internally it uses ThreeApp and
// Render3DEntities instead of Pixi graphics, and currently has no selection/input
// (view-only). Selection/commands will be added in a later pass.

import { ClientViewState } from '../network/ClientViewState';
import { SnapshotBuffer } from './helpers/SnapshotBuffer';
import {
  buildSelectionInfo,
  buildEconomyInfo,
  buildMinimapData,
} from './helpers';
import type { EconomyInfo, MinimapData } from './helpers';
import { EmaTracker } from './helpers/EmaTracker';
import { EmaMsTracker } from './helpers/EmaMsTracker';
import { ThreeApp } from '../render3d/ThreeApp';
import { Render3DEntities } from '../render3d/Render3DEntities';
import { Input3DManager } from '../render3d/Input3DManager';
import { CommandQueue, type SelectCommand } from '../sim/commands';

import type { GameConnection } from '../server/GameConnection';
import type {
  NetworkServerSnapshotCombatStats,
  NetworkServerSnapshotMeta,
} from '../network/NetworkTypes';
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
  private inputManager: Input3DManager | null = null;
  private gameConnection!: GameConnection;
  private snapshotBuffer = new SnapshotBuffer();
  private localCommandQueue = new CommandQueue();
  private currentWaypointMode: WaypointType = 'move';

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
    this._baseDistance = Math.max(this.mapWidth, this.mapHeight) * 0.35;

    // Seed orbit camera on map center (ThreeApp did this too, but we honor the
    // game vs demo initial-zoom distinction like RtsScene)
    const initialZoom = this.backgroundMode ? ZOOM_INITIAL_DEMO : ZOOM_INITIAL_GAME;
    this.threeApp.orbit.setTarget(this.mapWidth / 2, 0, this.mapHeight / 2);
    this.threeApp.orbit.distance = this._baseDistance / initialZoom;
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
    this.clientViewState = new ClientViewState();

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
    );

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
    this.entityRenderer.update();
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

  private handleGameOver(winnerId: PlayerId): void {
    if (this.isGameOver) return;
    this.isGameOver = true;
    this.onGameOverUI?.(winnerId);
  }

  public updateSelectionInfo(): void {
    if (!this.onSelectionChange) return;
    // Minimal input-state shape so the waypoint-mode indicator reflects the
    // current mode; build/D-gun aren't supported in 3D yet.
    const inputState = {
      waypointMode: this.currentWaypointMode,
      isBuildMode: false,
      selectedBuildingType: null,
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
  public startBuildMode(_buildingType: BuildingType): void {}
  public cancelBuildMode(): void {}
  public toggleDGunMode(): void {}
  public queueFactoryUnit(_factoryId: number, _unitId: string): void {}
  public cancelFactoryQueueItem(_factoryId: number, _index: number): void {}

  public centerCameraOn(x: number, y: number): void {
    this.threeApp.orbit.setTarget(x, 0, y);
  }

  public getFrameTiming(): {
    frameMsAvg: number; frameMsHi: number;
    renderMsAvg: number; renderMsHi: number;
    logicMsAvg: number; logicMsHi: number;
  } {
    return {
      frameMsAvg: this.frameMsTracker.getAvg(),
      frameMsHi: this.frameMsTracker.getHi(),
      renderMsAvg: this.renderMsTracker.getAvg(),
      renderMsHi: this.renderMsTracker.getHi(),
      logicMsAvg: this.logicMsTracker.getAvg(),
      logicMsHi: this.logicMsTracker.getHi(),
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

  public shutdown(): void {
    this.inputManager?.destroy();
    this.inputManager = null;
    this.entityRenderer?.destroy();
    this.gameConnection?.disconnect();
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
