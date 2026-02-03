import Phaser from 'phaser';
import { WorldState } from '../sim/WorldState';
import { Simulation } from '../sim/Simulation';
import { CommandQueue, type Command } from '../sim/commands';
import { spawnInitialEntities } from '../sim/spawn';
import { EntityRenderer } from '../render/renderEntities';
import { InputManager } from '../input/inputBindings';
import type { Entity, PlayerId, EntityId, WaypointType } from '../sim/types';
import { economyManager } from '../sim/economy';
import { getPendingGameConfig, clearPendingGameConfig } from '../createGame';
import { networkManager, type NetworkRole } from '../network/NetworkManager';
import { serializeGameState } from '../network/stateSerializer';
import type { NetworkGameState } from '../network/NetworkManager';
import type { SelectCommand } from '../sim/commands';
import { ClientViewState } from '../network/ClientViewState';

// Host view modes
export type HostViewMode = 'simulation' | 'client';
import { audioManager } from '../audio/AudioManager';
import type { AudioEvent, DeathContext } from '../sim/combat';
import {
  ZOOM_INITIAL,
  WORLD_PADDING_PERCENT,
  MAP_WIDTH,
  MAP_HEIGHT,
  BACKGROUND_MAP_WIDTH,
  BACKGROUND_MAP_HEIGHT,
} from '../../config';

// Import helpers
import {
  createUnitBody,
  createMatterBodies,
  applyUnitVelocities,
  handleAudioEvent,
  handleUnitDeaths,
  handleBuildingDeaths,
  spawnBackgroundUnits,
  buildSelectionInfo,
  buildEconomyInfo,
  buildMinimapData,
} from './helpers';

// Grid settings
const GRID_SIZE = 50;
const GRID_COLOR = 0x333355;

export class RtsScene extends Phaser.Scene {
  private world!: WorldState;
  private simulation!: Simulation;
  private commandQueue!: CommandQueue;
  private entityRenderer!: EntityRenderer;
  private inputManager: InputManager | null = null;
  private gridGraphics!: Phaser.GameObjects.Graphics;
  private audioInitialized: boolean = false;
  private isGameOver: boolean = false;

  // Network configuration
  private networkRole: NetworkRole = 'offline';
  private localPlayerId: PlayerId = 1;
  private playerIds: PlayerId[] = [1, 2];

  // Background mode (no input, no UI, endless battle)
  private backgroundMode: boolean = false;
  private backgroundSpawnTimer: number = 0;
  private readonly BACKGROUND_SPAWN_INTERVAL: number = 500; // ms between spawn attempts

  // Host view mode - allows host to see what clients see
  private hostViewMode: HostViewMode = 'simulation';
  private clientViewState: ClientViewState | null = null;

  // Frame delta tracking for accurate FPS measurement
  private frameDeltaHistory: number[] = [];
  private readonly FRAME_HISTORY_SIZE = 1000;

  // Fixed timestep physics - ensures consistent physics regardless of framerate
  private physicsAccumulator: number = 0;
  private readonly PHYSICS_TIMESTEP = 1000 / 60; // 60Hz fixed physics (16.67ms)
  private readonly MAX_PHYSICS_STEPS = 4; // Cap steps per frame to prevent spiral of death

  // UI update throttling - avoid updating every frame
  private selectionDirty: boolean = true;
  private economyUpdateTimer: number = 0;
  private minimapUpdateTimer: number = 0;
  private readonly ECONOMY_UPDATE_INTERVAL = 100; // ms between economy updates
  private readonly MINIMAP_UPDATE_INTERVAL = 50; // ms between minimap updates
  private lastCameraX: number = 0;
  private lastCameraY: number = 0;
  private lastCameraZoom: number = 0;

  // Callback for UI to know when player changes
  public onPlayerChange?: (playerId: PlayerId) => void;

  // Callback for UI to know when selection changes
  public onSelectionChange?: (info: {
    unitCount: number;
    hasCommander: boolean;
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

  // Callback for view mode change (host only)
  public onViewModeChange?: (mode: HostViewMode) => void;

  constructor() {
    super({ key: 'RtsScene' });
  }

  create(): void {
    // Get network configuration from pending config
    const config = getPendingGameConfig();
    if (config) {
      this.networkRole = config.networkRole;
      this.localPlayerId = config.localPlayerId;
      this.playerIds = config.playerIds;
      this.backgroundMode = config.backgroundMode;
      clearPendingGameConfig();
    }

    // Initialize world state with appropriate map size
    const mapWidth = this.backgroundMode ? BACKGROUND_MAP_WIDTH : MAP_WIDTH;
    const mapHeight = this.backgroundMode ? BACKGROUND_MAP_HEIGHT : MAP_HEIGHT;
    this.world = new WorldState(42, mapWidth, mapHeight);
    // In background mode, set active player to 0 (spectator - no unit selection)
    this.world.setActivePlayer(this.backgroundMode ? 0 as PlayerId : this.localPlayerId);

    this.commandQueue = new CommandQueue();
    this.simulation = new Simulation(this.world, this.commandQueue);
    this.simulation.setPlayerIds(this.playerIds);

    // Setup callbacks (only needed for host/offline mode)
    if (this.networkRole !== 'client') {
      // Setup death callback (with deathContexts for directional explosions)
      this.simulation.onUnitDeath = (deadUnitIds: EntityId[], deathContexts?: Map<EntityId, DeathContext>) => {
        handleUnitDeaths(this.world, this.matter, this.entityRenderer, deadUnitIds, deathContexts);
      };

      // Setup building death callback
      this.simulation.onBuildingDeath = (deadBuildingIds: EntityId[]) => {
        handleBuildingDeaths(this.world, this.simulation, deadBuildingIds);
      };

      // Setup spawn callback (for factory-produced units)
      this.simulation.onUnitSpawn = (newUnits: Entity[]) => {
        this.handleUnitSpawns(newUnits);
      };

      // Setup audio callback
      this.simulation.onAudioEvent = (event: AudioEvent) => {
        handleAudioEvent(event, this.entityRenderer, this.audioInitialized);
      };

      // Setup game over callback (skip in background mode - never ends)
      if (!this.backgroundMode) {
        this.simulation.onGameOver = (winnerId: PlayerId) => {
          this.handleGameOver(winnerId);
        };
      }
    }

    // Setup camera with bounds on the extended world (map + padding)
    const camera = this.cameras.main;
    camera.setBackgroundColor(0x0a0a14); // Dark background

    // Calculate padding from percentage of map dimensions
    const paddingX = this.world.mapWidth * WORLD_PADDING_PERCENT;
    const paddingY = this.world.mapHeight * WORLD_PADDING_PERCENT;

    // Set camera bounds to the extended world area
    // This allows natural panning/zooming within the padded area
    const worldX = -paddingX;
    const worldY = -paddingY;
    const worldWidth = this.world.mapWidth + paddingX * 2;
    const worldHeight = this.world.mapHeight + paddingY * 2;
    camera.setBounds(worldX, worldY, worldWidth, worldHeight);

    // Set initial zoom level
    // Main game uses 0.5, background mode uses ZOOM_INITIAL
    camera.setZoom(this.backgroundMode ? ZOOM_INITIAL : 0.5);

    // Center camera on the map initially (will be updated for main game after commander spawn)
    camera.centerOn(this.world.mapWidth / 2, this.world.mapHeight / 2);

    // Draw grid background
    this.drawGrid();

    // Spawn initial entities (only for host/offline mode)
    if (this.networkRole !== 'client') {
      if (this.backgroundMode) {
        // Background mode: initialize economy for 4 players and spawn random units
        this.world.playerCount = 4;
        economyManager.initPlayer(1); // Red
        economyManager.initPlayer(2); // Blue
        economyManager.initPlayer(3); // Yellow
        economyManager.initPlayer(4); // Green
        spawnBackgroundUnits(this.world, this.matter, true); // Initial spawn
      } else {
        // Normal mode: spawn commanders
        const entities = spawnInitialEntities(this.world, this.playerIds);
        // Create Matter bodies for entities
        createMatterBodies(this.matter, entities);

        // Center camera on local player's commander
        const commander = this.world.getCommander(this.world.activePlayerId);
        if (commander) {
          camera.centerOn(commander.transform.x, commander.transform.y);
        }
      }
    }

    // Setup renderer
    this.entityRenderer = new EntityRenderer(this, this.world);

    // Setup input - in background mode, camera controls work but no unit selection (activePlayer=0)
    this.inputManager = new InputManager(this, this.world, this.commandQueue);

    // Initialize ClientViewState for all non-background modes
    // - Host/offline: Used for "client view" toggle to see what clients see
    // - Client: Used for snapshot interpolation (the actual view)
    if (!this.backgroundMode) {
      this.clientViewState = new ClientViewState();

      // For actual clients, use ClientViewState as the primary entity source
      if (this.networkRole === 'client') {
        this.entityRenderer.setEntitySource(this.clientViewState, 'clientView');
        this.inputManager?.setEntitySource(this.clientViewState);
      }
    }

    // Initialize audio on first user interaction
    this.input.once('pointerdown', () => {
      if (!this.audioInitialized) {
        audioManager.init();
        this.audioInitialized = true;
      }
    });
  }

  // Handle game over (last commander standing)
  private handleGameOver(winnerId: PlayerId): void {
    if (this.isGameOver) return; // Already handled
    this.isGameOver = true;

    // Notify Vue UI to show game over modal
    this.onGameOverUI?.(winnerId);

    // Listen for R key to restart
    this.input.keyboard?.once('keydown-R', () => {
      this.restartGame();
    });
  }

  // Restart the game (public so UI can call it)
  public restartGame(): void {
    this.isGameOver = false;
    // Notify UI to reset
    this.onGameRestart?.();
    // Restart the scene
    this.scene.restart();
  }

  // Handle unit spawns (create Matter bodies for factory-produced units)
  private handleUnitSpawns(newUnits: Entity[]): void {
    for (const entity of newUnits) {
      if (entity.type === 'unit' && entity.unit) {
        // Create circle body for unit with proper mass
        const body = createUnitBody(
          this.matter,
          entity.transform.x,
          entity.transform.y,
          entity.unit.collisionRadius,
          entity.unit.mass,
          `unit_${entity.id}`
        );
        entity.body = { matterBody: body };
      }
    }
  }

  // Switch active player
  public switchPlayer(playerId: PlayerId): void {
    this.world.setActivePlayer(playerId);
    this.markSelectionDirty();
    if (this.onPlayerChange) {
      this.onPlayerChange(playerId);
    }
  }

  // Toggle between players
  public togglePlayer(): void {
    const newPlayer = this.world.activePlayerId === 1 ? 2 : 1;
    this.switchPlayer(newPlayer);
  }

  // Get current active player
  public getActivePlayer(): PlayerId {
    return this.world.activePlayerId;
  }

  // Mark selection info as needing update (called when selection changes)
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
    const camera = this.cameras.main;
    camera.centerOn(x, y);
  }

  // Get the current entity source based on view mode
  // When in client view or actual client mode, ALL entity queries should go through ClientViewState
  private getCurrentEntitySource(): {
    getUnits: () => Entity[],
    getBuildings: () => Entity[],
    getProjectiles: () => Entity[],
    getAllEntities: () => Entity[],
    getEntity: (id: EntityId) => Entity | undefined,
    getSelectedUnits: () => Entity[],
    getSelectedBuildings: () => Entity[],
    getBuildingsByPlayer: (playerId: PlayerId) => Entity[],
    getUnitsByPlayer: (playerId: PlayerId) => Entity[],
  } {
    const playerId = this.world.activePlayerId; // Player ID is always from world (it's "who am I")

    // Use ClientViewState for: actual clients OR host's client view mode
    const useClientViewState = this.networkRole === 'client' ||
                                (this.hostViewMode === 'client' && this.clientViewState);

    if (useClientViewState && this.clientViewState) {
      const cvs = this.clientViewState;
      return {
        getUnits: () => cvs.getUnits(),
        getBuildings: () => cvs.getBuildings(),
        getProjectiles: () => cvs.getProjectiles(),
        getAllEntities: () => cvs.getAllEntities(),
        getEntity: (id: EntityId) => cvs.getEntity(id),
        getSelectedUnits: () => cvs.getUnits().filter(
          e => e.selectable?.selected && e.ownership?.playerId === playerId
        ),
        getSelectedBuildings: () => cvs.getBuildings().filter(
          b => b.selectable?.selected && b.ownership?.playerId === playerId
        ),
        getBuildingsByPlayer: (pid: PlayerId) => cvs.getBuildings().filter(
          b => b.ownership?.playerId === pid
        ),
        getUnitsByPlayer: (pid: PlayerId) => cvs.getUnits().filter(
          u => u.ownership?.playerId === pid
        ),
      };
    }

    // Simulation view - use WorldState
    return {
      getUnits: () => this.world.getUnits(),
      getBuildings: () => this.world.getBuildings(),
      getProjectiles: () => this.world.getProjectiles(),
      getAllEntities: () => this.world.getAllEntities(),
      getEntity: (id: EntityId) => this.world.getEntity(id),
      getSelectedUnits: () => this.world.getSelectedUnits(),
      getSelectedBuildings: () => this.world.getBuildings().filter(
        b => b.selectable?.selected && b.ownership?.playerId === playerId
      ),
      getBuildingsByPlayer: (pid: PlayerId) => this.world.getBuildingsByPlayer(pid),
      getUnitsByPlayer: (pid: PlayerId) => this.world.getUnitsByPlayer(pid),
    };
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
      this.world.activePlayerId,
      this.world.getUnitCapPerPlayer()
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
      this.world.mapWidth,
      this.world.mapHeight,
      camera.scrollX,
      camera.scrollY,
      camera.width / camera.zoom,
      camera.height / camera.zoom
    ));
  }

  // Draw the grid background
  private drawGrid(): void {
    this.gridGraphics = this.add.graphics();

    // Calculate padding from percentage of map dimensions
    const paddingX = this.world.mapWidth * WORLD_PADDING_PERCENT;
    const paddingY = this.world.mapHeight * WORLD_PADDING_PERCENT;

    // Fill the extended world area with dark background
    // This provides a visual buffer around the playable map
    this.gridGraphics.fillStyle(0x08080f, 1);
    this.gridGraphics.fillRect(
      -paddingX,
      -paddingY,
      this.world.mapWidth + paddingX * 2,
      this.world.mapHeight + paddingY * 2
    );

    // Fill the playable map area with a slightly lighter background
    this.gridGraphics.fillStyle(0x1a1a2e, 1);
    this.gridGraphics.fillRect(0, 0, this.world.mapWidth, this.world.mapHeight);

    // Draw grid lines
    this.gridGraphics.lineStyle(1, GRID_COLOR, 0.3);

    // Vertical lines
    for (let x = 0; x <= this.world.mapWidth; x += GRID_SIZE) {
      this.gridGraphics.lineBetween(x, 0, x, this.world.mapHeight);
    }

    // Horizontal lines
    for (let y = 0; y <= this.world.mapHeight; y += GRID_SIZE) {
      this.gridGraphics.lineBetween(0, y, this.world.mapWidth, y);
    }

    // Map border (more prominent)
    this.gridGraphics.lineStyle(4, 0x4444aa, 1);
    this.gridGraphics.strokeRect(0, 0, this.world.mapWidth, this.world.mapHeight);
  }

  update(_time: number, delta: number): void {
    // Track frame delta for accurate FPS measurement
    this.frameDeltaHistory.push(delta);
    if (this.frameDeltaHistory.length > this.FRAME_HISTORY_SIZE) {
      this.frameDeltaHistory.shift();
    }

    // Update explosion effects (always, even when game is over for nice visuals)
    this.entityRenderer.updateExplosions(delta);

    // Update Arachnid leg animations (client-side only, visual effect)
    this.entityRenderer.updateArachnidLegs(delta);

    // Update tread/wheel animations (client-side only, visual effect)
    this.entityRenderer.updateTreads(delta);

    // Skip game updates if game is over (not applicable in background mode)
    if (this.isGameOver && !this.backgroundMode) {
      // Still render but don't update simulation
      this.entityRenderer.render();
      return;
    }

    // Update input (keyboard camera pan, zoom bounds)
    if (this.inputManager) {
      this.inputManager.update(delta);
    }

    // Only run simulation for host/offline mode
    if (this.networkRole !== 'client') {
      // IMPORTANT: In client view mode, intercept selection commands BEFORE simulation
      // This ensures selection is applied to ClientViewState, not WorldState
      if (this.hostViewMode === 'client' && this.clientViewState) {
        // Process selection commands locally on ClientViewState (before simulation consumes them)
        this.processClientViewCommands();
      } else {
        // In simulation view, check if there are selection commands that will be processed
        // Mark selection dirty so UI updates after simulation processes them
        const commands = this.commandQueue.getAll();
        for (const cmd of commands) {
          if (cmd.type === 'select' || cmd.type === 'clearSelection') {
            this.markSelectionDirty();
            break;
          }
        }
      }

      // === FIXED TIMESTEP PHYSICS ===
      // Accumulate frame time and run physics in fixed steps
      // This ensures physics behaves identically regardless of framerate
      this.physicsAccumulator += delta;

      // Cap accumulated time to prevent "spiral of death" when running slow
      const maxAccumulator = this.PHYSICS_TIMESTEP * this.MAX_PHYSICS_STEPS;
      if (this.physicsAccumulator > maxAccumulator) {
        this.physicsAccumulator = maxAccumulator;
      }

      // Run physics in fixed timestep chunks
      let physicsSteps = 0;
      while (this.physicsAccumulator >= this.PHYSICS_TIMESTEP && physicsSteps < this.MAX_PHYSICS_STEPS) {
        // Update simulation (calculates velocities) with fixed timestep
        this.simulation.update(this.PHYSICS_TIMESTEP);

        // Apply forces to Matter bodies
        applyUnitVelocities(this.matter, this.world, this.simulation.getForceAccumulator());

        // Step Matter.js physics with fixed timestep
        this.matter.world.step(this.PHYSICS_TIMESTEP);

        this.physicsAccumulator -= this.PHYSICS_TIMESTEP;
        physicsSteps++;
      }

      // Background mode: continuously spawn units (uses real delta for timing)
      if (this.backgroundMode) {
        this.backgroundSpawnTimer += delta;
        if (this.backgroundSpawnTimer >= this.BACKGROUND_SPAWN_INTERVAL) {
          this.backgroundSpawnTimer = 0;
          spawnBackgroundUnits(this.world, this.matter, false);
        }
      }

      // Handle rendering based on view mode
      if (this.hostViewMode === 'client' && this.clientViewState) {
        // Run prediction on ClientViewState
        this.clientViewState.applyPrediction(delta);
        // Use spray targets from ClientViewState
        this.entityRenderer.setSprayTargets(this.clientViewState.getSprayTargets());
      } else {
        // Normal simulation view - use spray targets from simulation
        this.entityRenderer.setSprayTargets(this.simulation.getSprayTargets());
      }
    } else {
      // Client mode: process local-only commands (selection)
      this.processClientCommands();

      // Run snapshot interpolation on ClientViewState
      if (this.clientViewState) {
        this.clientViewState.applyPrediction(delta);
        // Spray targets are already set in applyNetworkState
      }
    }

    // Render entities
    this.entityRenderer.render();

    // Update UI with throttling (skip in background mode - no UI)
    if (!this.backgroundMode) {
      // Check if a producing factory is selected - need to update progress bar
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

      // Update selection info only when dirty (selection changed, mode changed, etc.)
      if (this.selectionDirty) {
        this.updateSelectionInfo();
        this.selectionDirty = false;
      }

      // Throttle economy updates
      this.economyUpdateTimer += delta;
      if (this.economyUpdateTimer >= this.ECONOMY_UPDATE_INTERVAL) {
        this.economyUpdateTimer = 0;
        this.updateEconomyInfo();
      }

      // Throttle minimap updates, but update immediately if camera moved
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
  }

  // === Network methods ===

  // Get serialized game state for network broadcast (host and offline)
  // Also feeds the state to ClientViewState for host's "client view"
  public getSerializedState(): NetworkGameState | null {
    if (this.networkRole !== 'host' && this.networkRole !== 'offline') return null;
    const winnerId = this.simulation.getWinnerId() ?? undefined;
    const sprayTargets = this.simulation.getSprayTargets();
    const audioEvents = this.simulation.getAndClearAudioEvents();
    const state = serializeGameState(this.world, winnerId, sprayTargets, audioEvents);

    // Feed the same state to ClientViewState (for host's "client view")
    if (this.clientViewState && state) {
      this.clientViewState.applyNetworkState(state);
    }

    return state;
  }

  // === Host View Mode Methods ===

  /**
   * Set the host's view mode
   * - 'simulation': See authoritative simulation state (default)
   * - 'client': See exactly what clients see (predicted from network state)
   */
  public setHostViewMode(mode: HostViewMode): void {
    if (this.networkRole !== 'host' && this.networkRole !== 'offline') return;
    if (this.hostViewMode === mode) return;

    // Sync selection state when switching views
    this.syncSelectionBetweenViews(this.hostViewMode, mode);

    this.hostViewMode = mode;

    // Switch renderer's entity source
    if (mode === 'simulation') {
      this.entityRenderer.setEntitySource(this.world, 'world');
      this.inputManager?.setEntitySource(this.world);
    } else if (this.clientViewState) {
      this.entityRenderer.setEntitySource(this.clientViewState, 'clientView');
      this.inputManager?.setEntitySource(this.clientViewState);
    }

    this.onViewModeChange?.(mode);
  }

  /**
   * Get current host view mode
   */
  public getHostViewMode(): HostViewMode {
    return this.hostViewMode;
  }

  /**
   * Get frame delta statistics for accurate FPS measurement
   * Returns avg and worst (lowest) FPS from actual frame deltas
   */
  public getFrameStats(): { avgFps: number; worstFps: number } {
    if (this.frameDeltaHistory.length === 0) {
      return { avgFps: 0, worstFps: 0 };
    }

    // Calculate average FPS from average delta
    const avgDelta = this.frameDeltaHistory.reduce((a, b) => a + b, 0) / this.frameDeltaHistory.length;
    const avgFps = 1000 / avgDelta;

    // Find worst frame (highest delta = lowest FPS)
    const worstDelta = Math.max(...this.frameDeltaHistory);
    const worstFps = 1000 / worstDelta;

    return { avgFps, worstFps };
  }

  /**
   * Sync selection between views when toggling
   */
  private syncSelectionBetweenViews(fromMode: HostViewMode, toMode: HostViewMode): void {
    if (!this.clientViewState) return;

    if (fromMode === 'simulation' && toMode === 'client') {
      // Copy selection from WorldState to ClientViewState
      const selectedIds = new Set<EntityId>();
      for (const entity of this.world.getAllEntities()) {
        if (entity.selectable?.selected) {
          selectedIds.add(entity.id);
        }
      }
      this.clientViewState.setSelectedIds(selectedIds);
    } else if (fromMode === 'client' && toMode === 'simulation') {
      // Copy selection from ClientViewState to WorldState
      const selectedIds = this.clientViewState.getSelectedIds();
      for (const entity of this.world.getAllEntities()) {
        if (entity.selectable) {
          entity.selectable.selected = selectedIds.has(entity.id);
        }
      }
    }
  }

  /**
   * Check if host is in client view mode
   */
  public isInClientViewMode(): boolean {
    return this.networkRole === 'host' && this.hostViewMode === 'client';
  }

  // Apply received network state (client only)
  public applyNetworkState(state: NetworkGameState): void {
    if (this.networkRole !== 'client') return;

    // Feed state to ClientViewState for snapshot interpolation
    // ClientViewState handles entity management, economy, spray targets internally
    if (this.clientViewState) {
      this.clientViewState.applyNetworkState(state);

      // Get spray targets from ClientViewState for rendering
      this.entityRenderer.setSprayTargets(this.clientViewState.getSprayTargets());

      // Process audio events from ClientViewState
      const audioEvents = this.clientViewState.getPendingAudioEvents();
      if (audioEvents) {
        for (const event of audioEvents) {
          handleAudioEvent(event, this.entityRenderer, this.audioInitialized);
        }
      }

      // Check for game over
      const winnerId = this.clientViewState.getGameOverWinnerId();
      if (winnerId !== null && !this.isGameOver) {
        this.isGameOver = true;
        this.onGameOverUI?.(winnerId);
      }
    }
  }

  // Enqueue command from network (host only)
  public enqueueNetworkCommand(command: Command, _fromPlayerId: PlayerId): void {
    if (this.networkRole !== 'host') return;
    // Add command to queue - it will be processed in the next simulation tick
    this.commandQueue.enqueue(command);
  }

  // Process commands for client mode
  // Selection is handled locally on ClientViewState, other commands are sent to host
  private processClientCommands(): void {
    if (!this.clientViewState) return;

    const commands = this.commandQueue.getAll();
    this.commandQueue.clear();

    for (const command of commands) {
      if (command.type === 'select') {
        // Selection is local-only, process it on ClientViewState
        this.executeClientSelectCommand(command as SelectCommand);
      } else if (command.type === 'clearSelection') {
        // Clear selection on ClientViewState
        this.clientViewState.clearSelection();
        this.markSelectionDirty();
      } else {
        // Send other commands to host
        networkManager.sendCommand(command);
      }
    }
  }

  // Execute select command on ClientViewState (for client-side selection)
  private executeClientSelectCommand(command: SelectCommand): void {
    if (!this.clientViewState) return;

    if (!command.additive) {
      this.clientViewState.clearSelection();
    }
    for (const id of command.entityIds) {
      this.clientViewState.selectEntity(id);
    }
    this.markSelectionDirty();
  }

  // Process commands for host's client view mode
  // Selection is handled locally on ClientViewState, other commands go to simulation
  private processClientViewCommands(): void {
    if (!this.clientViewState) return;

    const commands = this.commandQueue.getAll();
    this.commandQueue.clear();

    // Debug: log commands being processed
    if (commands.length > 0) {
      console.log(`[ClientViewCommands] Processing ${commands.length} commands:`, commands.map(c => c.type));
    }

    for (const command of commands) {
      if (command.type === 'select') {
        // Selection is local to current view, process it on ClientViewState
        console.log(`[ClientViewCommands] Select command:`, (command as SelectCommand).entityIds);
        this.executeClientViewSelectCommand(command as SelectCommand);
      } else if (command.type === 'clearSelection') {
        // Clear selection on ClientViewState
        console.log(`[ClientViewCommands] Clear selection`);
        this.clientViewState.clearSelection();
        this.markSelectionDirty();
      } else {
        // Other commands go to the simulation (re-enqueue them)
        this.commandQueue.enqueue(command);
      }
    }
  }

  // Execute select command on ClientViewState
  private executeClientViewSelectCommand(command: SelectCommand): void {
    if (!this.clientViewState) return;

    if (!command.additive) {
      this.clientViewState.clearSelection();
    }
    for (const id of command.entityIds) {
      this.clientViewState.selectEntity(id);
    }
    this.markSelectionDirty();
  }

  // Clean shutdown
  shutdown(): void {
    audioManager.stopAllLaserSounds();
    this.entityRenderer?.destroy();
    this.inputManager?.destroy();
    this.gridGraphics?.destroy();
  }
}
