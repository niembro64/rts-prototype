import Phaser from 'phaser';
import { CommandQueue, type SelectCommand } from '../sim/commands';
import { EntityRenderer } from '../render/renderEntities';
import { InputManager, type InputContext } from '../input/inputBindings';
import type { Entity, PlayerId, EntityId, WaypointType } from '../sim/types';
import { getPendingGameConfig, clearPendingGameConfig } from '../createGame';
import { ClientViewState } from '../network/ClientViewState';
import type { GameConnection } from '../server/GameConnection';
import type { NetworkGameState, NetworkProjectileSpawn, NetworkProjectileDespawn, NetworkAudioEvent } from '../network/NetworkTypes';

import { audioManager } from '../audio/AudioManager';
import type { AudioEvent } from '../sim/combat';
import {
  ZOOM_INITIAL_DEMO,
  ZOOM_INITIAL_GAME,
  WORLD_PADDING_PERCENT,
} from '../../config';

// Import helpers
import {
  handleAudioEvent,
  buildSelectionInfo,
  buildEconomyInfo,
  buildMinimapData,
} from './helpers';

// Grid settings
const GRID_SIZE = 50;
const GRID_COLOR = 0x333355;

export class RtsScene extends Phaser.Scene {
  private clientViewState!: ClientViewState;
  private entityRenderer!: EntityRenderer;
  private inputManager: InputManager | null = null;
  private gameConnection!: GameConnection;
  private localCommandQueue!: CommandQueue;
  private gridGraphics!: Phaser.GameObjects.Graphics;
  private audioInitialized: boolean = false;
  private isGameOver: boolean = false;

  // Config values
  private localPlayerId: PlayerId = 1;
  private playerIds: PlayerId[] = [1, 2];
  private mapWidth: number = 6000;
  private mapHeight: number = 6000;

  // Background mode (no input, no UI, endless battle)
  private backgroundMode: boolean = false;

  // Frame delta tracking for accurate FPS measurement (ring buffer)
  private readonly FRAME_HISTORY_SIZE = 1000;
  private frameDeltaHistory = new Float64Array(this.FRAME_HISTORY_SIZE);
  private frameDeltaWriteIndex = 0;
  private frameDeltaCount = 0;

  // UI update throttling
  private selectionDirty: boolean = true;
  private economyUpdateTimer: number = 0;
  private minimapUpdateTimer: number = 0;
  private readonly ECONOMY_UPDATE_INTERVAL = 100;
  private readonly MINIMAP_UPDATE_INTERVAL = 50;
  private lastCameraX: number = 0;
  private lastCameraY: number = 0;
  private lastCameraZoom: number = 0;

  // Camera centering flag (center on first snapshot)
  private hasCenteredCamera: boolean = false;

  // Snapshot buffering: decouple PeerJS delivery from frame processing.
  // PeerJS callback stores the latest snapshot instantly; update() processes once per frame.
  // One-shot events are accumulated so dropped intermediate snapshots don't lose them.
  private pendingSnapshot: NetworkGameState | null = null;
  private bufferedSpawns: NetworkProjectileSpawn[] = [];
  private bufferedDespawns: NetworkProjectileDespawn[] = [];
  private bufferedAudio: NetworkAudioEvent[] = [];

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
    camera.setBackgroundColor(0x0a0a14);

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

    // Setup renderer with ClientViewState as source
    this.entityRenderer = new EntityRenderer(this, this.clientViewState);
    this.entityRenderer.setEntitySource(this.clientViewState, 'clientView');

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

  // Get current entity source - always ClientViewState
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
    const playerId = this.localPlayerId;
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

  // Draw the grid background
  private drawGrid(): void {
    this.gridGraphics = this.add.graphics();

    const paddingX = this.mapWidth * WORLD_PADDING_PERCENT;
    const paddingY = this.mapHeight * WORLD_PADDING_PERCENT;

    this.gridGraphics.fillStyle(0x08080f, 1);
    this.gridGraphics.fillRect(
      -paddingX,
      -paddingY,
      this.mapWidth + paddingX * 2,
      this.mapHeight + paddingY * 2
    );

    this.gridGraphics.fillStyle(0x1a1a2e, 1);
    this.gridGraphics.fillRect(0, 0, this.mapWidth, this.mapHeight);

    this.gridGraphics.lineStyle(1, GRID_COLOR, 0.3);

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
    // Track frame delta for accurate FPS measurement (ring buffer)
    this.frameDeltaHistory[this.frameDeltaWriteIndex] = delta;
    this.frameDeltaWriteIndex = (this.frameDeltaWriteIndex + 1) % this.FRAME_HISTORY_SIZE;
    if (this.frameDeltaCount < this.FRAME_HISTORY_SIZE) {
      this.frameDeltaCount++;
    }

    // Process buffered snapshot (at most one per frame)
    if (this.pendingSnapshot) {
      const state = this.pendingSnapshot;
      this.pendingSnapshot = null;

      // Replace one-shot event arrays with accumulated versions
      // (includes events from any intermediate snapshots that were superseded)
      state.projectileSpawns = this.bufferedSpawns.length > 0 ? this.bufferedSpawns : undefined;
      state.projectileDespawns = this.bufferedDespawns.length > 0 ? this.bufferedDespawns : undefined;
      state.audioEvents = this.bufferedAudio.length > 0 ? this.bufferedAudio : undefined;
      this.bufferedSpawns = [];
      this.bufferedDespawns = [];
      this.bufferedAudio = [];

      this.clientViewState.applyNetworkState(state);

      // Process audio events
      const audioEvents = this.clientViewState.getPendingAudioEvents();
      if (audioEvents) {
        for (const event of audioEvents) {
          handleAudioEvent(event as AudioEvent, this.entityRenderer, this.audioInitialized);
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

    // Update input
    if (this.inputManager) {
      this.inputManager.update(delta);
    }

    // Process local commands (selection local, others sent to server)
    this.processLocalCommands();

    // Run snapshot interpolation
    this.clientViewState.applyPrediction(delta);

    // Set spray targets from ClientViewState
    this.entityRenderer.setSprayTargets(this.clientViewState.getSprayTargets());

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
   * Get frame delta statistics for accurate FPS measurement
   */
  public getFrameStats(): { avgFps: number; worstFps: number } {
    const count = this.frameDeltaCount;
    if (count === 0) {
      return { avgFps: 0, worstFps: 0 };
    }

    let sum = 0;
    let worst = 0;
    for (let i = 0; i < count; i++) {
      const d = this.frameDeltaHistory[i];
      sum += d;
      if (d > worst) worst = d;
    }

    const avgFps = 1000 / (sum / count);
    const worstFps = 1000 / worst;

    return { avgFps, worstFps };
  }

  // Clean shutdown
  shutdown(): void {
    audioManager.stopAllLaserSounds();
    this.entityRenderer?.destroy();
    this.inputManager?.destroy();
    this.gridGraphics?.destroy();
    this.gameConnection?.disconnect();
  }
}
