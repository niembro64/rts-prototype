import { SceneShim, BlendModes } from '../SceneShim';
import { GraphicsAdapter } from '../render/Graphics';
import { CommandQueue, type SelectCommand } from '../sim/commands';
import { EntityRenderer } from '../render/renderEntities';
import { InputManager, type InputContext } from '../input/inputBindings';
import {
  PLAYER_COLORS,
  type Entity,
  type PlayerId,
  type EntityId,
  type WaypointType,
} from '../sim/types';
import { getPendingGameConfig, clearPendingGameConfig } from '../createGame';
import type { ClientViewState } from '../network/ClientViewState';
import type { SceneCameraState } from '@/types/game';
import type { GameConnection } from '../server/GameConnection';
import type {
  NetworkServerSnapshotCombatStats,
  NetworkServerSnapshotMeta,
} from '../network/NetworkTypes';

import { audioManager } from '../audio/AudioManager';
import { musicPlayer } from '../audio/MusicPlayer';
import type { SimEvent } from '../sim/combat';
import {
  ZOOM_INITIAL_DEMO,
  ZOOM_INITIAL_GAME,
  WORLD_PADDING_PERCENT,
  MAP_BG_COLOR,
  MAP_OOB_COLOR,
  MAP_CAMERA_BG,
  MAP_GRID_COLOR,
  COMBAT_STATS_SAMPLE_INTERVAL,
  EMA_CONFIG,
  FRAME_TIMING_EMA,
  EMA_INITIAL_VALUES,
} from '../../config';


import {
  getAudioSmoothing,
  getAudioScope,
  getSoundToggle,
  getGridOverlay,
  getGridOverlayIntensity,
} from '@/clientBarConfig';
import { AUDIO } from '../../audioConfig';

// Import helpers
import {
  handleSimEvent,
  buildSelectionInfo,
  buildEconomyInfo,
  buildMinimapData,
} from './helpers';
import type { EconomyInfo, MinimapData } from './helpers';
import { SnapshotBuffer } from './helpers/SnapshotBuffer';
import { EmaTracker } from './helpers/EmaTracker';
import { EmaMsTracker } from './helpers/EmaMsTracker';
import { LongtaskTracker } from './helpers/LongtaskTracker';
import { AudioEventScheduler } from './helpers/AudioEventScheduler';
import { PanArrowOverlay } from '../hud/PanArrowOverlay';
import { HealthBarOverlay } from '../hud/HealthBarOverlay';
import { WaypointOverlay } from '../hud/WaypointOverlay';
import { SelectionLabelOverlay } from '../hud/SelectionLabelOverlay';
import { PixiWorldProjector } from '../render/PixiWorldProjector';
import { getBottomBarsHeight } from '@/clientBarConfig';

// Grid settings
const GRID_SIZE = 50;

export class RtsScene extends SceneShim {
  private clientViewState!: ClientViewState;
  private entityRenderer!: EntityRenderer;
  private inputManager: InputManager | null = null;
  private gameConnection!: GameConnection;
  private localCommandQueue!: CommandQueue;
  private gridGraphics!: GraphicsAdapter;
  private spatialGridGraphics!: GraphicsAdapter;
  private panArrowOverlay: PanArrowOverlay | null = null;
  private healthBarOverlay: HealthBarOverlay | null = null;
  private waypointOverlay: WaypointOverlay | null = null;
  private selectionLabelOverlay: SelectionLabelOverlay | null = null;
  private audioInitialized: boolean = false;
  private isGameOver: boolean = false;

  // Cached entity source adapter — built once in create(), closures read this.localPlayerId
  // so they always use the current player. Avoids 9 closure allocations per call.
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

  // Config values
  private localPlayerId: PlayerId = 1;
  private playerIds: PlayerId[] = [1, 2];
  private mapWidth: number = 6000;
  private mapHeight: number = 6000;

  // Background mode (no input, no UI, endless battle)
  private backgroundMode: boolean = false;

  // Performance tracking (EMA-based, start optimistic so LOD begins at MAX)
  private fpsTracker = new EmaTracker(EMA_CONFIG.fps, EMA_INITIAL_VALUES.fps);
  private snapTracker = new EmaTracker(EMA_CONFIG.snaps, EMA_INITIAL_VALUES.snaps);
  private frameMsTracker = new EmaMsTracker(FRAME_TIMING_EMA.frameMs, EMA_INITIAL_VALUES.frameMs);
  private renderMsTracker = new EmaMsTracker(FRAME_TIMING_EMA.renderMs, EMA_INITIAL_VALUES.renderMs);
  private logicMsTracker = new EmaMsTracker(FRAME_TIMING_EMA.logicMs, EMA_INITIAL_VALUES.logicMs);
  private longtaskTracker = new LongtaskTracker();

  // Snapshot buffering and audio scheduling
  private snapshotBuffer = new SnapshotBuffer();
  private audioScheduler = new AudioEventScheduler();

  // UI update throttling
  private selectionDirty: boolean = true;
  private economyUpdateTimer: number = 0;
  private minimapUpdateTimer: number = 0;
  private readonly ECONOMY_UPDATE_INTERVAL = 100;
  private readonly MINIMAP_UPDATE_INTERVAL = 50;
  private combatStatsUpdateTimer: number = 0;
  private readonly COMBAT_STATS_UPDATE_INTERVAL = COMBAT_STATS_SAMPLE_INTERVAL;
  private lastCameraX: number = 0;
  private lastCameraY: number = 0;
  private lastCameraZoom: number = 0;

  // Camera centering flag (center on first snapshot)
  private hasCenteredCamera: boolean = false;

  // Cached per-frame query results (rebuilt once per frame, returned by adapter)
  private _cachedSelectedUnits: Entity[] = [];
  private _cachedSelectedBuildings: Entity[] = [];
  private _cachedPlayerUnits: Entity[] = [];
  private _cachedPlayerBuildings: Entity[] = [];
  private _cachedPlayerIdForUnits: PlayerId = -1 as PlayerId;
  private _cachedPlayerIdForBuildings: PlayerId = -1 as PlayerId;

  // Callback for UI to know when player changes
  public onPlayerChange?: (playerId: PlayerId) => void;

  // Callback for UI to know when selection changes
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

  // Callback for UI to know when economy changes
  public onEconomyChange?: (info: EconomyInfo) => void;

  // Callback for minimap updates
  public onMinimapUpdate?: (data: MinimapData) => void;
  /** Per-frame callback for just the camera footprint quad. Fires
   *  every render pass so the minimap box stays pinned to the view
   *  even while the entity list is only refreshed at 20 Hz. */
  public onCameraQuadUpdate?: (
    quad: import('../ViewportFootprint').FootprintQuad,
  ) => void;

  // Callback for game over (passes winner ID)
  public onGameOverUI?: (winnerId: PlayerId) => void;

  // Callback for game restart
  public onGameRestart?: () => void;

  // Callback for combat stats updates
  public onCombatStatsUpdate?: (stats: NetworkServerSnapshotCombatStats) => void;

  // Callback for server metadata updates (TPS, snapshot rate, IP, time)
  public onServerMetaUpdate?: (meta: NetworkServerSnapshotMeta) => void;

  constructor() {
    super();
  }

  create(): void {
    // Get configuration from pending config
    const config = getPendingGameConfig();
    if (config) {
      this.localPlayerId = config.localPlayerId;
      this.playerIds = config.playerIds;
      this.backgroundMode = config.backgroundMode;
      this.gameConnection = config.gameConnection;
      // ClientViewState is hoisted up to GameCanvas so its state (entities,
      // prediction, selection) survives a live renderer swap. On initial
      // boot GameCanvas constructs a fresh one.
      this.clientViewState = config.clientViewState;
      this.mapWidth = config.mapWidth;
      this.mapHeight = config.mapHeight;
      clearPendingGameConfig();
    }

    // Build entity source adapter once — closures capture `this` so they always
    // read the current localPlayerId and clientViewState
    this.entitySourceAdapter = {
      getUnits: () => this.clientViewState.getUnits(),
      getBuildings: () => this.clientViewState.getBuildings(),
      getProjectiles: () => this.clientViewState.getProjectiles(),
      getAllEntities: () => this.clientViewState.getAllEntities(),
      getEntity: (id: EntityId) => this.clientViewState.getEntity(id),
      getSelectedUnits: () => this._cachedSelectedUnits,
      getSelectedBuildings: () => this._cachedSelectedBuildings,
      getBuildingsByPlayer: (pid: PlayerId) => {
        if (pid !== this._cachedPlayerIdForBuildings) {
          this._cachedPlayerBuildings.length = 0;
          for (const b of this.clientViewState.getBuildings()) {
            if (b.ownership?.playerId === pid)
              this._cachedPlayerBuildings.push(b);
          }
          this._cachedPlayerIdForBuildings = pid;
        }
        return this._cachedPlayerBuildings;
      },
      getUnitsByPlayer: (pid: PlayerId) => {
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

    // Create local command queue (for selection commands)
    this.localCommandQueue = new CommandQueue();

    // Wire snapshot buffer to gameConnection
    this.snapshotBuffer.attach(this.gameConnection);

    // Wire game over callback
    this.gameConnection.onGameOver((winnerId: PlayerId) => {
      if (!this.isGameOver) {
        this.handleGameOver(winnerId);
      }
    });

    // Setup camera with bounds
    const camera = this.cameras.main;
    camera.setBackgroundColor(MAP_CAMERA_BG);

    const paddingX = this.mapWidth * WORLD_PADDING_PERCENT;
    const paddingY = this.mapHeight * WORLD_PADDING_PERCENT;

    const worldX = -paddingX;
    const worldY = -paddingY;
    const worldWidth = this.mapWidth + paddingX * 2;
    const worldHeight = this.mapHeight + paddingY * 2;
    camera.setBounds(worldX, worldY, worldWidth, worldHeight);

    camera.setZoom(this.backgroundMode ? ZOOM_INITIAL_DEMO : ZOOM_INITIAL_GAME);
    camera.centerOn(this.mapWidth / 2, this.mapHeight / 2);

    // Draw grid background
    this.drawGrid();

    // Create spatial grid overlay graphics (redrawn each frame when grid info is active)
    // Additive blend so overlapping team colors combine naturally
    this.spatialGridGraphics = this.add.graphics();
    this.spatialGridGraphics.setBlendMode(BlendModes.NORMAL);

    // Setup renderer with ClientViewState as source
    this.entityRenderer = new EntityRenderer(this, this.clientViewState);
    this.entityRenderer.setEntitySource(this.clientViewState);

    // Setup input context
    const inputContext: InputContext = {
      getTick: () => this.clientViewState.getTick(),
      activePlayerId: this.localPlayerId,
    };

    this.inputManager = new InputManager(
      this,
      inputContext,
      this.clientViewState,
      this.localCommandQueue,
    );

    // Shared pan-direction arrow (SVG/DOM overlay). Both 2D and 3D scenes
    // create one; the CameraController updates it during drag pan / edge scroll.
    const canvasParent = this.game.canvas.parentElement;
    if (canvasParent) {
      this.panArrowOverlay = new PanArrowOverlay(canvasParent, () => ({
        top: 50,
        bottom: getBottomBarsHeight(),
      }));
      this.inputManager.setPanArrowOverlay(this.panArrowOverlay);

      // Shared health-bar overlay (replaces the 2D in-canvas Pixi bars so
      // both renderers share a single visual style).
      const projector = new PixiWorldProjector(this.cameras.main);
      this.healthBarOverlay = new HealthBarOverlay(canvasParent, projector);
      this.waypointOverlay = new WaypointOverlay(canvasParent, projector);
      this.selectionLabelOverlay = new SelectionLabelOverlay(canvasParent, projector);
    }

    // Initialize audio on first user interaction
    this.input.once('pointerdown', () => {
      if (!this.audioInitialized) {
        audioManager.init();
        musicPlayer.init(
          audioManager.getContext()!,
          audioManager.getMasterGain()!,
        );
        if (getSoundToggle('music')) {
          musicPlayer.start();
        }
        this.audioInitialized = true;
      }
    });

    // Register shutdown handler so scene.restart() triggers cleanup
    this.events.once('shutdown', this.shutdown, this);
  }

  // Center camera on local player's commander from ClientViewState,
  // and rotate the view so the commander's forward (toward map center)
  // points up on screen. Commanders spawn in an even circle around the
  // map center (sim/spawn.ts), so this gives every player the same
  // relative first view regardless of seat.
  private centerCameraOnCommander(): void {
    const units = this.clientViewState.getUnits();
    const commander = units.find(
      (e) =>
        e.commander !== undefined &&
        e.ownership?.playerId === this.localPlayerId,
    );
    if (commander) {
      const cx = commander.transform.x;
      const cy = commander.transform.y;
      // Forward-toward-center vector in world coords.
      const forwardX = this.mapWidth / 2 - cx;
      const forwardY = this.mapHeight / 2 - cy;
      // Desired camera rotation: make the forward vector project to
      // screen-up (0, -1). Our world→screen maps +Y world → +Y screen
      // (down), so "up on screen" is world -Y. We need rotation θ such
      // that rotating (forward_x, forward_y) by -θ lands on (0, -|f|):
      //
      //   atan2(-|f|, 0) - atan2(forward_y, forward_x) = -θ
      //   θ = atan2(forward_y, forward_x) + π/2
      //
      // The π/2 offset converts "forward points to world -Y" to "forward
      // points to world +X" which is the rotation=0 reference.
      if (forwardX * forwardX + forwardY * forwardY > 1) {
        this.cameras.main.rotation =
          Math.atan2(forwardY, forwardX) + Math.PI / 2;
      }
      this.cameras.main.centerOn(cx, cy);
      this.hasCenteredCamera = true;
    }
  }

  // Handle game over (last commander standing)
  private handleGameOver(winnerId: PlayerId): void {
    if (this.isGameOver) return;
    this.isGameOver = true;

    this.onGameOverUI?.(winnerId);

    this.input.keyboard?.once('keydown-R', () => {
      this.restartGame();
    });
  }

  // Restart the game (public so UI can call it)
  public restartGame(): void {
    this.isGameOver = false;
    this.onGameRestart?.();
    this.scene.restart();
  }

  // Switch active player (for single-player mode)
  public switchPlayer(playerId: PlayerId): void {
    this.localPlayerId = playerId;
    if (this.inputManager) {
      this.inputManager.destroy();
    }
    const inputContext: InputContext = {
      getTick: () => this.clientViewState.getTick(),
      activePlayerId: playerId,
    };
    this.inputManager = new InputManager(
      this,
      inputContext,
      this.clientViewState,
      this.localCommandQueue,
    );
    this.inputManager.setPanArrowOverlay(this.panArrowOverlay);
    this.markSelectionDirty();
    this.onPlayerChange?.(playerId);
  }

  // Cycle through all players
  public togglePlayer(): void {
    const currentIndex = this.playerIds.indexOf(this.localPlayerId);
    const nextIndex = (currentIndex + 1) % this.playerIds.length;
    this.switchPlayer(this.playerIds[nextIndex]);
  }

  // Get current active player
  public getActivePlayer(): PlayerId {
    return this.localPlayerId;
  }

  // Mark selection info as needing update
  public markSelectionDirty(): void {
    this.selectionDirty = true;
  }

  // Set waypoint mode via UI
  public setWaypointMode(mode: WaypointType): void {
    this.inputManager?.setWaypointMode(mode);
    this.markSelectionDirty();
  }

  // Start build mode via UI
  public startBuildMode(buildingType: 'solar' | 'factory'): void {
    this.inputManager?.startBuildMode(buildingType);
    this.markSelectionDirty();
  }

  // Cancel build mode via UI
  public cancelBuildMode(): void {
    this.inputManager?.cancelBuildMode();
    this.markSelectionDirty();
  }

  // Toggle D-Gun mode via UI
  public toggleDGunMode(): void {
    this.inputManager?.toggleDGunMode();
    this.markSelectionDirty();
  }

  // Queue unit production via UI
  public queueFactoryUnit(factoryId: number, unitId: string): void {
    this.inputManager?.queueUnitAtFactory(factoryId, unitId);
  }

  // Cancel a queue item at a factory
  public cancelFactoryQueueItem(factoryId: number, index: number): void {
    this.inputManager?.cancelQueueItemAtFactory(factoryId, index);
  }

  // Center camera on a world position (used by minimap click)
  public centerCameraOn(x: number, y: number): void {
    this.cameras.main.centerOn(x, y);
  }

  /** Capture the current camera's world-space framing so a live
   *  renderer swap can restore it on the new scene. See
   *  `SceneCameraState` for the coordinate convention. */
  public captureCameraState(): SceneCameraState {
    const cam = this.cameras.main;
    return {
      x: cam.scrollX + cam.width / 2 / cam.zoom,
      y: cam.scrollY + cam.height / 2 / cam.zoom,
      zoom: cam.zoom,
    };
  }

  /** Apply a previously captured camera state. Safe to call even if
   *  the saved state came from the other renderer — both use the same
   *  simulation-coord framing and a 2D-equivalent zoom scalar. */
  public applyCameraState(state: SceneCameraState): void {
    this.cameras.main.zoom = state.zoom;
    this.cameras.main.centerOn(state.x, state.y);
  }

  // Get current entity source — returns cached adapter (zero allocations per call)
  private getCurrentEntitySource() {
    return this.entitySourceAdapter;
  }

  // Update selection info and notify UI
  public updateSelectionInfo(): void {
    if (!this.onSelectionChange) return;

    const entitySource = this.getCurrentEntitySource();
    const inputState = this.inputManager?.getState();

    this.onSelectionChange(buildSelectionInfo(entitySource, inputState));
  }

  // Update economy info and notify UI
  public updateEconomyInfo(): void {
    if (!this.onEconomyChange) return;

    const entitySource = this.getCurrentEntitySource();
    const serverMeta = this.clientViewState.getServerMeta();
    const maxTotal = serverMeta?.units.max ?? 120;
    const economyInfo = buildEconomyInfo(
      entitySource,
      this.localPlayerId,
      Math.floor(maxTotal / this.playerIds.length),
    );

    if (economyInfo) {
      this.onEconomyChange(economyInfo);
    }
  }

  /** Cached per-frame camera footprint on the ground plane — 4
   *  corners in screen order (TL, TR, BR, BL), sim coords. Updated
   *  at the top of the render pass; consumed by the scope
   *  footprint and the minimap so we never pay the 4 getWorldPoint
   *  calls twice per frame. */
  private _cameraQuad: import('../ViewportFootprint').FootprintQuad = [
    { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 },
  ];

  private computeCameraQuad(): import('../ViewportFootprint').FootprintQuad {
    const cam = this.cameras.main;
    return [
      cam.getWorldPoint(0, 0),
      cam.getWorldPoint(cam.width, 0),
      cam.getWorldPoint(cam.width, cam.height),
      cam.getWorldPoint(0, cam.height),
    ];
  }

  // Update minimap data and notify UI
  public updateMinimapData(): void {
    if (!this.onMinimapUpdate) return;
    this.onMinimapUpdate(
      buildMinimapData(
        this.getCurrentEntitySource(),
        this.mapWidth,
        this.mapHeight,
        this._cameraQuad,
      ),
    );
  }

  // Render capture-the-tile territory overlay — blends team colors per tile
  private renderCaptureOverlay(): void {
    this.spatialGridGraphics.clear();

    const tiles = this.clientViewState.getCaptureTiles();
    const cellSize = this.clientViewState.getCaptureCellSize();
    if (cellSize <= 0 || tiles.length === 0) return;

    const tileColorIntensity = getGridOverlayIntensity();

    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      const worldX = tile.cx * cellSize;
      const worldY = tile.cy * cellSize;

      // Blend all team colors into a single weighted RGB + alpha
      let totalWeight = 0;
      let r = 0, g = 0, b = 0;

      for (const pidStr in tile.heights) {
        const pid = Number(pidStr) as PlayerId;
        const height = tile.heights[pid];
        if (height <= 0) continue;

        const pc = PLAYER_COLORS[pid];
        if (!pc) continue;

        const color = pc.primary;
        const weight = height;
        totalWeight += weight;
        r += ((color >> 16) & 0xFF) * weight;
        g += ((color >> 8) & 0xFF) * weight;
        b += (color & 0xFF) * weight;
      }

      if (totalWeight <= 0) continue;

      // Normalize color by total weight
      const blendedColor = (((r / totalWeight) | 0) << 16)
                         | (((g / totalWeight) | 0) << 8)
                         | ((b / totalWeight) | 0);

      // Alpha scales with the strongest flag on this tile
      let maxHeight = 0;
      for (const pidStr in tile.heights) {
        const h = tile.heights[Number(pidStr)];
        if (h > maxHeight) maxHeight = h;
      }
      const alpha = tileColorIntensity * maxHeight;

      this.spatialGridGraphics.fillStyle(blendedColor, alpha);
      this.spatialGridGraphics.fillRect(worldX, worldY, cellSize, cellSize);
    }
  }

  // Draw the grid background
  private drawGrid(): void {
    this.gridGraphics = this.add.graphics();

    const paddingX = this.mapWidth * WORLD_PADDING_PERCENT;
    const paddingY = this.mapHeight * WORLD_PADDING_PERCENT;

    this.gridGraphics.fillStyle(MAP_OOB_COLOR, 1);
    this.gridGraphics.fillRect(
      -paddingX,
      -paddingY,
      this.mapWidth + paddingX * 2,
      this.mapHeight + paddingY * 2,
    );

    this.gridGraphics.fillStyle(MAP_BG_COLOR, 1);
    this.gridGraphics.fillRect(0, 0, this.mapWidth, this.mapHeight);

    this.gridGraphics.lineStyle(1, MAP_GRID_COLOR, 0.3);

    for (let x = 0; x <= this.mapWidth; x += GRID_SIZE) {
      this.gridGraphics.lineBetween(x, 0, x, this.mapHeight);
    }

    for (let y = 0; y <= this.mapHeight; y += GRID_SIZE) {
      this.gridGraphics.lineBetween(0, y, this.mapWidth, y);
    }

    this.gridGraphics.lineStyle(4, 0x4444aa, 1);
    this.gridGraphics.strokeRect(0, 0, this.mapWidth, this.mapHeight);
  }

  update(_time: number, delta: number): void {
    const frameStart = performance.now();

    // Track FPS via EMA
    if (delta > 0) {
      this.fpsTracker.update(1000 / delta);
    }

    // Drain audio smoothing queue: play any events whose scheduled time has arrived
    const now = performance.now();
    const cam = this.cameras.main;
    this.audioScheduler.drain(now, (event) => {
      handleSimEvent(
        event as SimEvent,
        this.entityRenderer,
        this.audioInitialized,
        cam.worldView,
        cam.zoom,
      );
    });

    // Process buffered snapshot (at most one per frame)
    const state = this.snapshotBuffer.consume();
    if (state) {
      this.clientViewState.applyNetworkState(state);

      // Track snapshot rate (EMA)
      const snapDelta = this.audioScheduler.recordSnapshot(now);
      if (snapDelta > 0) {
        this.snapTracker.update(1000 / snapDelta);
      }

      // Forward server metadata to UI
      const serverMeta = this.clientViewState.getServerMeta();
      if (serverMeta && this.onServerMetaUpdate) {
        this.onServerMetaUpdate(serverMeta);
      }

      // Process audio events
      const audioEvents = this.clientViewState.getPendingAudioEvents();
      if (audioEvents) {
        this.audioScheduler.schedule(
          audioEvents,
          now,
          getAudioSmoothing(),
          (event) => {
            handleSimEvent(
              event as SimEvent,
              this.entityRenderer,
              this.audioInitialized,
              cam.worldView,
              cam.zoom,
            );
          },
        );
      }

      // Check for game over
      const winnerId = this.clientViewState.getGameOverWinnerId();
      if (winnerId !== null && !this.isGameOver) {
        this.handleGameOver(winnerId);
      }

      // Center camera on the controlled player's commander on the
      // first snapshot — same treatment for the real game and the
      // demo, so the lobby view frames the player's seat naturally.
      // (Initial zoom still differs via ZOOM_INITIAL_DEMO; centerOn
      // doesn't touch zoom.)
      if (!this.hasCenteredCamera) {
        this.centerCameraOnCommander();
      }
    }

    // Per-frame viewport check for continuous sounds (beams, force fields)
    // Mute offscreen sounds and dynamically scale volume with zoom
    const continuousSounds = audioManager.getActiveContinuousSounds();
    if (continuousSounds.length > 0) {
      const audioScope = getAudioScope();
      const vp = cam.worldView;
      const zoomVolume = Math.pow(cam.zoom, AUDIO.zoomVolumeExponent);
      for (const [soundId, sourceEntityId] of continuousSounds) {
        const entity = this.clientViewState.getEntity(sourceEntityId);
        if (!entity) {
          // Entity not found (died, out of view) — mute
          audioManager.setContinuousSoundAudible(soundId, false);
          continue;
        }
        const ex = entity.transform.x;
        const ey = entity.transform.y;
        let inScope = true;
        if (audioScope === 'off') {
          inScope = false;
        } else if (audioScope === 'window') {
          inScope = vp.contains(ex, ey);
        } else if (audioScope === 'padded') {
          const padX = vp.width * 0.5;
          const padY = vp.height * 0.5;
          inScope =
            ex >= vp.x - padX &&
            ex <= vp.right + padX &&
            ey >= vp.y - padY &&
            ey <= vp.bottom + padY;
        }
        // 'all' scope: always audible (inScope stays true)
        audioManager.setContinuousSoundAudible(soundId, inScope);
        // Dynamically update volume based on current zoom
        audioManager.updateContinuousSoundZoom(soundId, zoomVolume);
      }
    }

    // Update explosion effects
    this.entityRenderer.updateExplosions(delta);

    // Update all locomotion (legs, treads, wheels) in a single pass
    this.entityRenderer.updateLocomotion(delta);

    // Update minigun barrel spin (acceleration/deceleration)
    this.entityRenderer.updateMinigunSpins(delta);

    // Update input
    if (this.inputManager) {
      this.inputManager.update(delta);
    }

    // Process local commands (selection local, others sent to server)
    this.processLocalCommands();

    // Rebuild per-frame cached query results AFTER processing commands
    // (selection commands modify entity.selectable.selected, so cache must reflect that)
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
    // Invalidate per-player caches (rebuilt lazily on first access)
    this._cachedPlayerIdForUnits = -1 as PlayerId;
    this._cachedPlayerIdForBuildings = -1 as PlayerId;

    // Run snapshot interpolation
    this.clientViewState.applyPrediction(delta);

    // Set spray targets from ClientViewState
    this.entityRenderer.setSprayTargets(this.clientViewState.getSprayTargets());

    // --- Render phase (timed separately from logic) ---
    const renderStart = performance.now();

    // Render territory capture overlay (client-side toggle)
    if (getGridOverlay() !== 'off') {
      this.renderCaptureOverlay();
    } else {
      this.spatialGridGraphics.clear();
    }

    // Refresh the shared visibility footprint once per frame from
    // the same 4-corner quad the minimap uses. Driving scope culling
    // off the quad means camera rotation doesn't leak entities
    // through a stale axis-aligned worldView.
    this._cameraQuad = this.computeCameraQuad();
    this.entityRenderer.setCameraQuad(this._cameraQuad);
    // Emit to the minimap box every frame (cheap) — entity list
    // rebuilding is still throttled by minimapUpdateTimer below.
    this.onCameraQuadUpdate?.(this._cameraQuad);

    // Render entities
    this.entityRenderer.render();

    // Shared HP bar overlay (SVG layer above the canvas)
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

    // Update UI with throttling
    {
      // Check if a producing factory is selected
      if (!this.selectionDirty) {
        const entitySource = this.getCurrentEntitySource();
        const selectedBuildings = entitySource.getSelectedBuildings();
        const hasProducingFactory = selectedBuildings.some(
          (b) => b.factory?.isProducing,
        );
        if (hasProducingFactory) {
          this.selectionDirty = true;
        }
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

      const camera = this.cameras.main;
      const cameraMoved =
        camera.scrollX !== this.lastCameraX ||
        camera.scrollY !== this.lastCameraY ||
        camera.zoom !== this.lastCameraZoom;

      this.minimapUpdateTimer += delta;
      if (
        this.minimapUpdateTimer >= this.MINIMAP_UPDATE_INTERVAL ||
        cameraMoved
      ) {
        this.minimapUpdateTimer = 0;
        this.lastCameraX = camera.scrollX;
        this.lastCameraY = camera.scrollY;
        this.lastCameraZoom = camera.zoom;
        this.updateMinimapData();
      }
    }

    // Combat stats update (runs in all modes including background for demo)
    this.combatStatsUpdateTimer += delta;
    if (this.combatStatsUpdateTimer >= this.COMBAT_STATS_UPDATE_INTERVAL) {
      this.combatStatsUpdateTimer = 0;
      const stats = this.clientViewState.getCombatStats();
      if (stats && this.onCombatStatsUpdate) {
        this.onCombatStatsUpdate(stats);
      }
    }

    // Track frame timing (ms)
    const frameEnd = performance.now();
    const frameMs = frameEnd - frameStart;
    const renderMs = renderEnd - renderStart;
    const logicMs = frameMs - renderMs;
    this.frameMsTracker.update(frameMs);
    this.renderMsTracker.update(renderMs);
    this.logicMsTracker.update(logicMs);
    this.longtaskTracker.tick();
  }

  // Process commands from local command queue
  // Selection is handled locally on ClientViewState, other commands are sent to server
  private processLocalCommands(): void {
    const commands = this.localCommandQueue.getAll();
    this.localCommandQueue.clear();

    for (const command of commands) {
      if (command.type === 'select') {
        this.executeLocalSelectCommand(command as SelectCommand);
      } else if (command.type === 'clearSelection') {
        this.clientViewState.clearSelection();
        this.markSelectionDirty();
      } else {
        // Send other commands to server via GameConnection
        this.gameConnection.sendCommand(command);
      }
    }
  }

  // Execute select command locally on ClientViewState
  private executeLocalSelectCommand(command: SelectCommand): void {
    if (!command.additive) {
      this.clientViewState.clearSelection();
    }
    for (const id of command.entityIds) {
      this.clientViewState.selectEntity(id);
    }
    this.markSelectionDirty();
  }

  /**
   * Get frame timing statistics (EMA-based avg and hi, in ms)
   */
  public getFrameTiming(): {
    frameMsAvg: number; frameMsHi: number;
    renderMsAvg: number; renderMsHi: number;
    logicMsAvg: number; logicMsHi: number;
    gpuTimerMs: number;
    gpuTimerSupported: boolean;
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
      gpuTimerMs: this.pixiApp.gpuTimer.getGpuMs(),
      gpuTimerSupported: this.pixiApp.gpuTimer.isSupported(),
      longtaskMsPerSec: this.longtaskTracker.getBlockedMsPerSec(),
      longtaskCountPerSec: this.longtaskTracker.getCountPerSec(),
      longtaskSupported: this.longtaskTracker.isSupported(),
    };
  }

  /**
   * Get FPS statistics (EMA-based avg and low)
   */
  public getFrameStats(): { avgFps: number; worstFps: number } {
    return {
      avgFps: this.fpsTracker.getAvg(),
      worstFps: this.fpsTracker.getLow(),
    };
  }

  /**
   * Get snapshot rate statistics (EMA-based avg and low, in Hz)
   */
  public getSnapshotStats(): { avgRate: number; worstRate: number } {
    return {
      avgRate: this.snapTracker.getAvg(),
      worstRate: this.snapTracker.getLow(),
    };
  }

  // Clean shutdown
  /**
   * Tear down the scene. By default disconnects the GameConnection;
   * passing `{ keepConnection: true }` skips the disconnect so a live
   * renderer swap can reuse the same connection across the new scene.
   * The caller is then responsible for disconnecting when the game
   * actually ends.
   */
  shutdown(opts: { keepConnection?: boolean } = {}): void {
    musicPlayer.stop();
    audioManager.stopAllLaserSounds();
    audioManager.stopAllForceFieldSounds();
    this.entityRenderer?.destroy();
    this.inputManager?.destroy();
    this.inputManager = null;
    this.gridGraphics?.destroy();
    this.spatialGridGraphics?.destroy();
    this.panArrowOverlay?.destroy();
    this.panArrowOverlay = null;
    this.healthBarOverlay?.destroy();
    this.healthBarOverlay = null;
    this.waypointOverlay?.destroy();
    this.waypointOverlay = null;
    this.selectionLabelOverlay?.destroy();
    this.selectionLabelOverlay = null;
    this.longtaskTracker.destroy();
    if (!opts.keepConnection) {
      this.gameConnection?.disconnect();
    }

    // Clear snapshot buffer and audio scheduler
    this.snapshotBuffer.clear();
    this.audioScheduler.clear();

    // Clear cached entity arrays
    this._cachedSelectedUnits.length = 0;
    this._cachedSelectedBuildings.length = 0;
    this._cachedPlayerUnits.length = 0;
    this._cachedPlayerBuildings.length = 0;

    // Release callback closures (prevent Vue reactive state from being retained)
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
