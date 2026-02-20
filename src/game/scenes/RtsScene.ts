import Phaser from 'phaser';
import { CommandQueue, type SelectCommand } from '../sim/commands';
import { EntityRenderer } from '../render/renderEntities';
import { InputManager, type InputContext } from '../input/inputBindings';
import { PLAYER_COLORS, type Entity, type PlayerId, type EntityId, type WaypointType } from '../sim/types';
import { getPendingGameConfig, clearPendingGameConfig } from '../createGame';
import { ClientViewState } from '../network/ClientViewState';
import type { GameConnection } from '../server/GameConnection';
import type { NetworkGameState, NetworkProjectileSpawn, NetworkProjectileDespawn, NetworkAudioEvent, NetworkProjectileVelocityUpdate, NetworkCombatStats, NetworkServerMeta } from '../network/NetworkTypes';

import { audioManager } from '../audio/AudioManager';
import type { AudioEvent } from '../sim/combat';
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
} from '../../config';

import { getAudioSmoothing } from '../render/graphicsSettings';

// Import helpers
import {
  handleAudioEvent,
  buildSelectionInfo,
  buildEconomyInfo,
  buildMinimapData,
} from './helpers';

// Grid settings
const GRID_SIZE = 50;

export class RtsScene extends Phaser.Scene {
  private clientViewState!: ClientViewState;
  private entityRenderer!: EntityRenderer;
  private inputManager: InputManager | null = null;
  private gameConnection!: GameConnection;
  private localCommandQueue!: CommandQueue;
  private gridGraphics!: Phaser.GameObjects.Graphics;
  private spatialGridGraphics!: Phaser.GameObjects.Graphics;
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

  // FPS tracking (EMA-based)
  private fpsAvg: number = 0;
  private fpsLow: number = 0;
  private fpsInitialized: boolean = false;

  // Snapshot rate tracking (EMA-based)
  private snapAvg: number = 0;
  private snapLow: number = 0;
  private snapInitialized: boolean = false;

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

  // Snapshot buffering: decouple PeerJS delivery from frame processing.
  // PeerJS callback stores the latest snapshot instantly; update() processes once per frame.
  // One-shot events are accumulated so dropped intermediate snapshots don't lose them.
  private pendingSnapshot: NetworkGameState | null = null;
  // Double-buffered event arrays (swap instead of allocating new arrays each frame)
  private _spawnsA: NetworkProjectileSpawn[] = [];
  private _spawnsB: NetworkProjectileSpawn[] = [];
  private bufferedSpawns: NetworkProjectileSpawn[] = this._spawnsA;
  private _despawnsA: NetworkProjectileDespawn[] = [];
  private _despawnsB: NetworkProjectileDespawn[] = [];
  private bufferedDespawns: NetworkProjectileDespawn[] = this._despawnsA;
  private _audioA: NetworkAudioEvent[] = [];
  private _audioB: NetworkAudioEvent[] = [];
  private bufferedAudio: NetworkAudioEvent[] = this._audioA;
  private bufferedVelocityUpdates = new Map<number, NetworkProjectileVelocityUpdate>();
  private _velBufA: NetworkProjectileVelocityUpdate[] = [];
  private _velBufB: NetworkProjectileVelocityUpdate[] = [];
  private _velBufToggle = false;

  // Audio smoothing queue: events scheduled to play at future times
  private audioQueue: { event: NetworkAudioEvent; playAt: number }[] = [];
  private lastSnapshotTime: number = 0;
  private snapshotInterval: number = 100; // EMA of snapshot interval (ms)

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
    factoryQueue?: { weaponId: string; label: string }[];
    factoryProgress?: number;
    factoryIsProducing?: boolean;
  }) => void;

  // Callback for UI to know when economy changes
  public onEconomyChange?: (info: {
    stockpile: number;
    maxStockpile: number;
    income: number;
    baseIncome: number;
    production: number;
    expenditure: number;
    netFlow: number;
    solarCount: number;
    factoryCount: number;
    unitCount: number;
    unitCap: number;
  }) => void;

  // Callback for minimap updates
  public onMinimapUpdate?: (data: {
    mapWidth: number;
    mapHeight: number;
    entities: { x: number; y: number; type: 'unit' | 'building'; color: string; isSelected?: boolean }[];
    cameraX: number;
    cameraY: number;
    cameraWidth: number;
    cameraHeight: number;
  }) => void;

  // Callback for game over (passes winner ID)
  public onGameOverUI?: (winnerId: PlayerId) => void;

  // Callback for game restart
  public onGameRestart?: () => void;

  // Callback for combat stats updates
  public onCombatStatsUpdate?: (stats: NetworkCombatStats) => void;

  // Callback for server metadata updates (TPS, snapshot rate, IP, time)
  public onServerMetaUpdate?: (meta: NetworkServerMeta) => void;

  constructor() {
    super({ key: 'RtsScene' });
  }

  create(): void {
    // Get configuration from pending config
    const config = getPendingGameConfig();
    if (config) {
      this.localPlayerId = config.localPlayerId;
      this.playerIds = config.playerIds;
      this.backgroundMode = config.backgroundMode;
      this.gameConnection = config.gameConnection;
      this.mapWidth = config.mapWidth;
      this.mapHeight = config.mapHeight;
      clearPendingGameConfig();
    }

    // Create ClientViewState (always the entity source)
    this.clientViewState = new ClientViewState();

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
            if (b.ownership?.playerId === pid) this._cachedPlayerBuildings.push(b);
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

    // Wire gameConnection snapshot to buffer (processed once per frame in update).
    // This prevents PeerJS message queue buildup from freezing remote clients —
    // snapshots are accepted instantly, and only the latest is processed each frame.
    this.gameConnection.onSnapshot((state: NetworkGameState) => {
      // Accumulate one-shot events from all intermediate snapshots
      if (state.projectileSpawns) {
        for (let i = 0; i < state.projectileSpawns.length; i++) {
          this.bufferedSpawns.push(state.projectileSpawns[i]);
        }
      }
      if (state.projectileDespawns) {
        for (let i = 0; i < state.projectileDespawns.length; i++) {
          this.bufferedDespawns.push(state.projectileDespawns[i]);
        }
      }
      if (state.audioEvents) {
        for (let i = 0; i < state.audioEvents.length; i++) {
          this.bufferedAudio.push(state.audioEvents[i]);
        }
      }
      if (state.projectileVelocityUpdates) {
        for (let i = 0; i < state.projectileVelocityUpdates.length; i++) {
          const vu = state.projectileVelocityUpdates[i];
          this.bufferedVelocityUpdates.set(vu.id, vu);
        }
      }
      // Keep only the latest snapshot (entity positions, economy, game over)
      this.pendingSnapshot = state;
    });

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
    this.spatialGridGraphics.setBlendMode(Phaser.BlendModes.ADD);

    // Setup renderer with ClientViewState as source
    this.entityRenderer = new EntityRenderer(this, this.clientViewState);
    this.entityRenderer.setEntitySource(this.clientViewState);

    // Setup input context
    const inputContext: InputContext = {
      getTick: () => this.clientViewState.getTick(),
      activePlayerId: this.backgroundMode ? 0 as PlayerId : this.localPlayerId,
    };

    this.inputManager = new InputManager(this, inputContext, this.clientViewState, this.localCommandQueue);

    // Initialize audio on first user interaction
    this.input.once('pointerdown', () => {
      if (!this.audioInitialized) {
        audioManager.init();
        this.audioInitialized = true;
      }
    });

    // Register shutdown handler so scene.restart() triggers cleanup
    this.events.once('shutdown', this.shutdown, this);
  }

  // Center camera on local player's commander from ClientViewState
  private centerCameraOnCommander(): void {
    const units = this.clientViewState.getUnits();
    const commander = units.find(
      e => e.commander !== undefined && e.ownership?.playerId === this.localPlayerId
    );
    if (commander) {
      this.cameras.main.centerOn(commander.transform.x, commander.transform.y);
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
    // Update input context by creating new InputManager with new context
    // (InputContext activePlayerId is read directly, but we stored it as a value)
    // Rebuild inputManager with new context
    if (this.inputManager) {
      this.inputManager.destroy();
    }
    const inputContext: InputContext = {
      getTick: () => this.clientViewState.getTick(),
      activePlayerId: playerId,
    };
    this.inputManager = new InputManager(this, inputContext, this.clientViewState, this.localCommandQueue);
    this.markSelectionDirty();
    this.onPlayerChange?.(playerId);
  }

  // Toggle between players
  public togglePlayer(): void {
    const newPlayer = this.localPlayerId === 1 ? 2 : 1;
    this.switchPlayer(newPlayer);
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
  public queueFactoryUnit(factoryId: number, weaponId: string): void {
    this.inputManager?.queueUnitAtFactory(factoryId, weaponId);
  }

  // Cancel a queue item at a factory
  public cancelFactoryQueueItem(factoryId: number, index: number): void {
    this.inputManager?.cancelQueueItemAtFactory(factoryId, index);
  }

  // Center camera on a world position (used by minimap click)
  public centerCameraOn(x: number, y: number): void {
    this.cameras.main.centerOn(x, y);
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
    const economyInfo = buildEconomyInfo(
      entitySource,
      this.localPlayerId,
      Math.floor(120 / this.playerIds.length) // unit cap per player
    );

    if (economyInfo) {
      this.onEconomyChange(economyInfo);
    }
  }

  // Update minimap data and notify UI
  public updateMinimapData(): void {
    if (!this.onMinimapUpdate) return;

    const camera = this.cameras.main;
    const entitySource = this.getCurrentEntitySource();

    this.onMinimapUpdate(buildMinimapData(
      entitySource,
      this.mapWidth,
      this.mapHeight,
      camera.scrollX,
      camera.scrollY,
      camera.width / camera.zoom,
      camera.height / camera.zoom
    ));
  }

  // Render spatial grid debug overlay (search cells + occupancy cells)
  private renderSpatialGridOverlay(): void {
    this.spatialGridGraphics.clear();

    const cellSize = this.clientViewState.getGridCellSize();
    if (cellSize <= 0) return;

    // Draw search cells first (bottom layer): subtle fill, no borders
    const searchCells = this.clientViewState.getGridSearchCells();
    for (const cell of searchCells) {
      const worldX = cell.cx * cellSize;
      const worldY = cell.cy * cellSize;

      for (const playerId of cell.players) {
        const playerConfig = PLAYER_COLORS[playerId as PlayerId];
        const color = playerConfig?.primary ?? 0x888888;
        this.spatialGridGraphics.fillStyle(color, 0.04);
        this.spatialGridGraphics.fillRect(worldX, worldY, cellSize, cellSize);
      }
    }

    // Draw occupancy cells second (top layer): more pronounced fill + borders
    const gridCells = this.clientViewState.getGridCells();
    for (const cell of gridCells) {
      const worldX = cell.cx * cellSize;
      const worldY = cell.cy * cellSize;

      for (const playerId of cell.players) {
        const playerConfig = PLAYER_COLORS[playerId as PlayerId];
        const color = playerConfig?.primary ?? 0x888888;
        this.spatialGridGraphics.fillStyle(color, 0.25);
        this.spatialGridGraphics.fillRect(worldX, worldY, cellSize, cellSize);
      }

      // Draw cell border
      this.spatialGridGraphics.lineStyle(1, 0x666688, 0.3);
      this.spatialGridGraphics.strokeRect(worldX, worldY, cellSize, cellSize);
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
      this.mapHeight + paddingY * 2
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
    // Track FPS via EMA
    if (delta > 0) {
      const fps = 1000 / delta;
      if (!this.fpsInitialized) {
        this.fpsAvg = fps;
        this.fpsLow = fps;
        this.fpsInitialized = true;
      } else {
        this.fpsAvg = (1 - EMA_CONFIG.fps.avg) * this.fpsAvg + EMA_CONFIG.fps.avg * fps;
        this.fpsLow = fps < this.fpsLow
          ? (1 - EMA_CONFIG.fps.low.drop) * this.fpsLow + EMA_CONFIG.fps.low.drop * fps
          : (1 - EMA_CONFIG.fps.low.recovery) * this.fpsLow + EMA_CONFIG.fps.low.recovery * fps;
      }
    }

    // Drain audio smoothing queue: play any events whose scheduled time has arrived
    const now = performance.now();
    const queue = this.audioQueue;
    for (let i = queue.length - 1; i >= 0; i--) {
      if (now >= queue[i].playAt) {
        const cam = this.cameras.main;
        handleAudioEvent(queue[i].event as AudioEvent, this.entityRenderer, this.audioInitialized, cam.worldView, cam.zoom);
        // Swap-remove for efficiency
        queue[i] = queue[queue.length - 1];
        queue.length--;
      }
    }

    // Process buffered snapshot (at most one per frame)
    if (this.pendingSnapshot) {
      const state = this.pendingSnapshot;
      this.pendingSnapshot = null;

      // Swap double-buffered event arrays (zero allocation per frame)
      const spawns = this.bufferedSpawns;
      this.bufferedSpawns = (spawns === this._spawnsA) ? this._spawnsB : this._spawnsA;
      this.bufferedSpawns.length = 0;
      state.projectileSpawns = spawns.length > 0 ? spawns : undefined;

      const despawns = this.bufferedDespawns;
      this.bufferedDespawns = (despawns === this._despawnsA) ? this._despawnsB : this._despawnsA;
      this.bufferedDespawns.length = 0;
      state.projectileDespawns = despawns.length > 0 ? despawns : undefined;

      const audio = this.bufferedAudio;
      this.bufferedAudio = (audio === this._audioA) ? this._audioB : this._audioA;
      this.bufferedAudio.length = 0;
      state.audioEvents = audio.length > 0 ? audio : undefined;

      if (this.bufferedVelocityUpdates.size > 0) {
        const buf = this._velBufToggle ? this._velBufB : this._velBufA;
        this._velBufToggle = !this._velBufToggle;
        buf.length = 0;
        for (const v of this.bufferedVelocityUpdates.values()) buf.push(v);
        this.bufferedVelocityUpdates.clear();
        state.projectileVelocityUpdates = buf;
      } else {
        state.projectileVelocityUpdates = undefined;
      }

      this.clientViewState.applyNetworkState(state);

      // Track snapshot interval for audio smoothing and stats (EMA)
      if (this.lastSnapshotTime > 0) {
        const snapDelta = now - this.lastSnapshotTime;
        this.snapshotInterval = 0.8 * this.snapshotInterval + 0.2 * snapDelta;
        const snapRate = 1000 / snapDelta;
        if (!this.snapInitialized) {
          this.snapAvg = snapRate;
          this.snapLow = snapRate;
          this.snapInitialized = true;
        } else {
          this.snapAvg = (1 - EMA_CONFIG.snaps.avg) * this.snapAvg + EMA_CONFIG.snaps.avg * snapRate;
          this.snapLow = snapRate < this.snapLow
            ? (1 - EMA_CONFIG.snaps.low.drop) * this.snapLow + EMA_CONFIG.snaps.low.drop * snapRate
            : (1 - EMA_CONFIG.snaps.low.recovery) * this.snapLow + EMA_CONFIG.snaps.low.recovery * snapRate;
        }
      }
      this.lastSnapshotTime = now;

      // Forward server metadata to UI
      const serverMeta = this.clientViewState.getServerMeta();
      if (serverMeta && this.onServerMetaUpdate) {
        this.onServerMetaUpdate(serverMeta);
      }

      // Process audio events
      const audioEvents = this.clientViewState.getPendingAudioEvents();
      if (audioEvents) {
        const cam = this.cameras.main;
        const smoothing = getAudioSmoothing();
        for (const event of audioEvents) {
          if (!smoothing || event.type === 'laserStart' || event.type === 'laserStop') {
            // Play immediately: smoothing off, or state-dependent laser events
            handleAudioEvent(event as AudioEvent, this.entityRenderer, this.audioInitialized, cam.worldView, cam.zoom);
          } else {
            // Schedule for playback spread across the snapshot interval
            this.audioQueue.push({
              event,
              playAt: now + Math.random() * this.snapshotInterval,
            });
          }
        }
      }

      // Check for game over
      const winnerId = this.clientViewState.getGameOverWinnerId();
      if (winnerId !== null && !this.isGameOver) {
        this.handleGameOver(winnerId);
      }

      // Center camera on first snapshot
      if (!this.hasCenteredCamera && !this.backgroundMode) {
        this.centerCameraOnCommander();
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

    // Render spatial grid debug overlay (below entities)
    this.renderSpatialGridOverlay();

    // Render entities
    this.entityRenderer.render();

    // Update UI with throttling (skip in background mode)
    if (!this.backgroundMode) {
      // Check if a producing factory is selected
      if (!this.selectionDirty) {
        const entitySource = this.getCurrentEntitySource();
        const selectedBuildings = entitySource.getSelectedBuildings();
        const hasProducingFactory = selectedBuildings.some(
          b => b.factory?.isProducing
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
      const cameraMoved = camera.scrollX !== this.lastCameraX ||
                          camera.scrollY !== this.lastCameraY ||
                          camera.zoom !== this.lastCameraZoom;

      this.minimapUpdateTimer += delta;
      if (this.minimapUpdateTimer >= this.MINIMAP_UPDATE_INTERVAL || cameraMoved) {
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
   * Get FPS statistics (EMA-based avg and low)
   */
  public getFrameStats(): { avgFps: number; worstFps: number } {
    return { avgFps: this.fpsAvg, worstFps: this.fpsLow };
  }

  /**
   * Get snapshot rate statistics (EMA-based avg and low, in Hz)
   */
  public getSnapshotStats(): { avgRate: number; worstRate: number } {
    return { avgRate: this.snapAvg, worstRate: this.snapLow };
  }

  // Clean shutdown
  shutdown(): void {
    audioManager.stopAllLaserSounds();
    this.entityRenderer?.destroy();
    this.inputManager?.destroy();
    this.inputManager = null;
    this.gridGraphics?.destroy();
    this.spatialGridGraphics?.destroy();
    this.gameConnection?.disconnect();

    // Clear snapshot buffers (hold entity references from network state)
    this.pendingSnapshot = null;
    this._spawnsA.length = 0;
    this._spawnsB.length = 0;
    this._despawnsA.length = 0;
    this._despawnsB.length = 0;
    this._audioA.length = 0;
    this._audioB.length = 0;
    this.bufferedVelocityUpdates.clear();
    this._velBufA.length = 0;
    this._velBufB.length = 0;
    this.audioQueue.length = 0;

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
    this.onGameOverUI = undefined;
    this.onGameRestart = undefined;
    this.onCombatStatsUpdate = undefined;
    this.onServerMetaUpdate = undefined;
  }
}
