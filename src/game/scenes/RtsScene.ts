import Phaser from 'phaser';
import { WorldState } from '../sim/WorldState';
import { Simulation } from '../sim/Simulation';
import { CommandQueue } from '../sim/commands';
import { spawnInitialEntities } from '../sim/spawn';
import { EntityRenderer } from '../render/renderEntities';
import { InputManager } from '../input/inputBindings';
import type { Entity, PlayerId, EntityId, WaypointType } from '../sim/types';
import { PLAYER_COLORS } from '../sim/types';
import { economyManager } from '../sim/economy';

// Weapon ID to display label
const WEAPON_LABELS: Record<string, string> = {
  minigun: 'Minigun',
  laser: 'Laser',
  cannon: 'Cannon',
  shotgun: 'Shotgun',
};
import { audioManager } from '../audio/AudioManager';
import type { AudioEvent } from '../sim/combat';

// Grid settings
const GRID_SIZE = 50;
const GRID_COLOR = 0x333355;

export class RtsScene extends Phaser.Scene {
  private world!: WorldState;
  private simulation!: Simulation;
  private commandQueue!: CommandQueue;
  private entityRenderer!: EntityRenderer;
  private inputManager!: InputManager;
  private gridGraphics!: Phaser.GameObjects.Graphics;
  private debugText!: Phaser.GameObjects.Text;
  private frameCount: number = 0;
  private fps: number = 0;
  private fpsUpdateTime: number = 0;
  private audioInitialized: boolean = false;

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

  constructor() {
    super({ key: 'RtsScene' });
  }

  create(): void {
    // Initialize world state
    this.world = new WorldState(42);
    this.commandQueue = new CommandQueue();
    this.simulation = new Simulation(this.world, this.commandQueue);

    // Setup death callback
    this.simulation.onUnitDeath = (deadUnitIds: EntityId[]) => {
      this.handleUnitDeaths(deadUnitIds);
    };

    // Setup building death callback
    this.simulation.onBuildingDeath = (deadBuildingIds: EntityId[]) => {
      this.handleBuildingDeaths(deadBuildingIds);
    };

    // Setup spawn callback (for factory-produced units)
    this.simulation.onUnitSpawn = (newUnits: Entity[]) => {
      this.handleUnitSpawns(newUnits);
    };

    // Setup audio callback
    this.simulation.onAudioEvent = (event: AudioEvent) => {
      this.handleAudioEvent(event);
    };

    // Setup camera
    const camera = this.cameras.main;
    camera.setBackgroundColor(0x1a1a2e);
    camera.setBounds(0, 0, this.world.mapWidth, this.world.mapHeight);
    // Center camera on the map
    camera.centerOn(this.world.mapWidth / 2, this.world.mapHeight / 2);

    // Draw grid background
    this.drawGrid();

    // Spawn initial entities
    const entities = spawnInitialEntities(this.world);

    // Create Matter bodies for entities
    this.createMatterBodies(entities);

    // Setup renderer
    this.entityRenderer = new EntityRenderer(this, this.world);

    // Setup input
    this.inputManager = new InputManager(this, this.world, this.commandQueue);

    // Setup debug overlay (bottom-right corner)
    this.createDebugOverlay();

    // Initialize audio on first user interaction
    this.input.once('pointerdown', () => {
      if (!this.audioInitialized) {
        audioManager.init();
        this.audioInitialized = true;
      }
    });
  }

  // Handle audio events from simulation
  private handleAudioEvent(event: AudioEvent): void {
    if (!this.audioInitialized) return;

    switch (event.type) {
      case 'fire':
        audioManager.playWeaponFire(event.weaponId);
        break;
      case 'hit':
        audioManager.playWeaponHit(event.weaponId);
        break;
      case 'death':
        audioManager.playUnitDeath(event.weaponId);
        break;
      case 'laserStart':
        if (event.entityId !== undefined) {
          audioManager.startLaserSound(event.entityId);
        }
        break;
      case 'laserStop':
        if (event.entityId !== undefined) {
          audioManager.stopLaserSound(event.entityId);
        }
        break;
    }
  }

  // Handle unit deaths (cleanup Matter bodies and audio)
  private handleUnitDeaths(deadUnitIds: EntityId[]): void {
    for (const id of deadUnitIds) {
      const entity = this.world.getEntity(id);
      if (entity?.body?.matterBody) {
        this.matter.world.remove(entity.body.matterBody);
      }
      // Stop any laser sound this unit was making
      audioManager.stopLaserSound(id);
      this.world.removeEntity(id);
    }
  }

  // Handle building deaths (remove from world and clean up construction grid)
  private handleBuildingDeaths(deadBuildingIds: EntityId[]): void {
    const constructionSystem = this.simulation.getConstructionSystem();
    for (const id of deadBuildingIds) {
      const entity = this.world.getEntity(id);
      if (entity) {
        // Clean up construction grid occupancy and energy production
        constructionSystem.onBuildingDestroyed(entity);
      }
      this.world.removeEntity(id);
    }
  }

  // Handle unit spawns (create Matter bodies for factory-produced units)
  private handleUnitSpawns(newUnits: Entity[]): void {
    for (const entity of newUnits) {
      if (entity.type === 'unit' && entity.unit) {
        // Create circle body for unit
        const body = this.matter.add.circle(
          entity.transform.x,
          entity.transform.y,
          entity.unit.radius,
          {
            friction: 0.05,
            frictionAir: 0.15,
            restitution: 0.2,
            mass: 1,
            label: `unit_${entity.id}`,
          }
        );
        entity.body = { matterBody: body as unknown as MatterJS.BodyType };
      }
    }
  }

  // Switch active player
  public switchPlayer(playerId: PlayerId): void {
    this.world.setActivePlayer(playerId);
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

  // Set waypoint mode via UI
  public setWaypointMode(mode: WaypointType): void {
    this.inputManager.setWaypointMode(mode);
    this.updateSelectionInfo();
  }

  // Start build mode via UI
  public startBuildMode(buildingType: 'solar' | 'factory'): void {
    this.inputManager.startBuildMode(buildingType);
    this.updateSelectionInfo();
  }

  // Cancel build mode via UI
  public cancelBuildMode(): void {
    this.inputManager.cancelBuildMode();
    this.updateSelectionInfo();
  }

  // Toggle D-Gun mode via UI
  public toggleDGunMode(): void {
    this.inputManager.toggleDGunMode();
    this.updateSelectionInfo();
  }

  // Queue unit production via UI
  public queueFactoryUnit(factoryId: number, weaponId: string): void {
    this.inputManager.queueUnitAtFactory(factoryId, weaponId);
  }

  // Cancel a queue item at a factory
  public cancelFactoryQueueItem(factoryId: number, index: number): void {
    const factory = this.world.getEntity(factoryId);
    if (!factory?.factory) return;

    // Remove the item at the given index
    if (index >= 0 && index < factory.factory.buildQueue.length) {
      factory.factory.buildQueue.splice(index, 1);

      // If we removed the first item and it was being built, reset production
      if (index === 0) {
        factory.factory.currentBuildProgress = 0;
        factory.factory.isProducing = factory.factory.buildQueue.length > 0;
      }
    }
  }

  // Center camera on a world position (used by minimap click)
  public centerCameraOn(x: number, y: number): void {
    const camera = this.cameras.main;
    camera.centerOn(x, y);
  }

  // Update selection info and notify UI
  public updateSelectionInfo(): void {
    if (!this.onSelectionChange) return;

    const selectedUnits = this.world.getSelectedUnits();
    const selectedBuildings = this.world.getBuildings().filter(
      b => b.selectable?.selected && b.ownership?.playerId === this.world.activePlayerId
    );

    // Check for commander
    const commander = selectedUnits.find(u => u.commander !== undefined);

    // Check for factory
    const factory = selectedBuildings.find(b => b.factory !== undefined);

    const inputState = this.inputManager.getState();

    // Get factory queue info if factory is selected
    let factoryQueue: { weaponId: string; label: string }[] | undefined;
    let factoryProgress: number | undefined;
    let factoryIsProducing: boolean | undefined;

    if (factory?.factory) {
      const f = factory.factory;
      factoryQueue = f.buildQueue.map(weaponId => ({
        weaponId,
        label: WEAPON_LABELS[weaponId] ?? weaponId,
      }));
      factoryProgress = f.currentBuildProgress;
      factoryIsProducing = f.isProducing;
    }

    this.onSelectionChange({
      unitCount: selectedUnits.length,
      hasCommander: commander !== undefined,
      hasFactory: factory !== undefined,
      factoryId: factory?.id,
      commanderId: commander?.id,
      waypointMode: inputState.waypointMode,
      isBuildMode: inputState.isBuildMode,
      selectedBuildingType: inputState.selectedBuildingType,
      isDGunMode: inputState.isDGunMode,
      factoryQueue,
      factoryProgress,
      factoryIsProducing,
    });
  }

  // Update economy info and notify UI
  public updateEconomyInfo(): void {
    if (!this.onEconomyChange) return;

    const playerId = this.world.activePlayerId;
    const economy = economyManager.getEconomy(playerId);
    if (!economy) return;

    // Count buildings for this player
    const playerBuildings = this.world.getBuildingsByPlayer(playerId);
    const solarCount = playerBuildings.filter(b => b.buildingType === 'solar').length;
    const factoryCount = playerBuildings.filter(b => b.buildingType === 'factory').length;

    const income = economy.baseIncome + economy.production;
    const netFlow = income - economy.expenditure;

    this.onEconomyChange({
      stockpile: economy.stockpile,
      maxStockpile: economy.maxStockpile,
      income,
      baseIncome: economy.baseIncome,
      production: economy.production,
      expenditure: economy.expenditure,
      netFlow,
      solarCount,
      factoryCount,
    });
  }

  // Update minimap data and notify UI
  public updateMinimapData(): void {
    if (!this.onMinimapUpdate) return;

    const camera = this.cameras.main;
    const entities: { x: number; y: number; type: 'unit' | 'building'; color: string; isSelected?: boolean }[] = [];

    // Add units to minimap
    for (const unit of this.world.getUnits()) {
      const playerId = unit.ownership?.playerId;
      const color = playerId ? PLAYER_COLORS[playerId]?.primary : 0x888888;
      const colorHex = '#' + (color ?? 0x888888).toString(16).padStart(6, '0');

      entities.push({
        x: unit.transform.x,
        y: unit.transform.y,
        type: 'unit',
        color: colorHex,
        isSelected: unit.selectable?.selected,
      });
    }

    // Add buildings to minimap
    for (const building of this.world.getBuildings()) {
      const playerId = building.ownership?.playerId;
      const color = playerId ? PLAYER_COLORS[playerId]?.primary : 0x888888;
      const colorHex = '#' + (color ?? 0x888888).toString(16).padStart(6, '0');

      entities.push({
        x: building.transform.x,
        y: building.transform.y,
        type: 'building',
        color: colorHex,
        isSelected: building.selectable?.selected,
      });
    }

    // Calculate camera viewport in world coordinates
    const cameraX = camera.scrollX;
    const cameraY = camera.scrollY;
    const cameraWidth = camera.width / camera.zoom;
    const cameraHeight = camera.height / camera.zoom;

    this.onMinimapUpdate({
      mapWidth: this.world.mapWidth,
      mapHeight: this.world.mapHeight,
      entities,
      cameraX,
      cameraY,
      cameraWidth,
      cameraHeight,
    });
  }

  // Create Matter.js physics bodies for entities
  private createMatterBodies(entities: Entity[]): void {
    for (const entity of entities) {
      if (entity.type === 'unit' && entity.unit) {
        // Circle body for units
        const body = this.matter.add.circle(entity.transform.x, entity.transform.y, entity.unit.radius, {
          friction: 0.05,
          frictionAir: 0.15,
          restitution: 0.2,
          mass: 1,
          label: `unit_${entity.id}`,
        });

        entity.body = { matterBody: body as unknown as MatterJS.BodyType };
      } else if (entity.type === 'building' && entity.building) {
        // Rectangle body for buildings (static)
        const body = this.matter.add.rectangle(
          entity.transform.x,
          entity.transform.y,
          entity.building.width,
          entity.building.height,
          {
            isStatic: true,
            friction: 0.8,
            restitution: 0.1,
            label: `building_${entity.id}`,
          }
        );

        entity.body = { matterBody: body as unknown as MatterJS.BodyType };
      }
    }
  }

  // Draw the grid background
  private drawGrid(): void {
    this.gridGraphics = this.add.graphics();
    this.gridGraphics.lineStyle(1, GRID_COLOR, 0.3);

    // Vertical lines
    for (let x = 0; x <= this.world.mapWidth; x += GRID_SIZE) {
      this.gridGraphics.lineBetween(x, 0, x, this.world.mapHeight);
    }

    // Horizontal lines
    for (let y = 0; y <= this.world.mapHeight; y += GRID_SIZE) {
      this.gridGraphics.lineBetween(0, y, this.world.mapWidth, y);
    }

    // Map border
    this.gridGraphics.lineStyle(3, 0x4444aa, 0.8);
    this.gridGraphics.strokeRect(0, 0, this.world.mapWidth, this.world.mapHeight);
  }

  // Create debug overlay (bottom-right corner)
  private createDebugOverlay(): void {
    this.debugText = this.add.text(0, 0, '', {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: '#00ff88',
      backgroundColor: '#000000aa',
      padding: { x: 8, y: 6 },
    });
    this.debugText.setScrollFactor(0);
    this.debugText.setDepth(1001);
    // Position will be set in updateDebugText based on text size
  }

  update(time: number, delta: number): void {
    // Update FPS counter
    this.frameCount++;
    if (time - this.fpsUpdateTime >= 1000) {
      this.fps = this.frameCount;
      this.frameCount = 0;
      this.fpsUpdateTime = time;
    }

    // Update input (keyboard camera pan)
    this.inputManager.update(delta);

    // Update simulation (calculates velocities)
    this.simulation.update(delta);

    // Apply calculated velocities to Matter bodies
    this.applyUnitVelocities();

    // Pass spray targets to renderer
    this.entityRenderer.setSprayTargets(this.simulation.getSprayTargets());

    // Render entities
    this.entityRenderer.render();

    // Update debug text
    this.updateDebugText();

    // Update selection info for UI
    this.updateSelectionInfo();

    // Update economy info for UI
    this.updateEconomyInfo();

    // Update minimap for UI
    this.updateMinimapData();
  }

  // Apply calculated velocities to Matter bodies
  private applyUnitVelocities(): void {
    for (const entity of this.world.getUnits()) {
      if (!entity.body?.matterBody || !entity.unit) continue;

      const velX = entity.unit.velocityX ?? 0;
      const velY = entity.unit.velocityY ?? 0;

      this.matter.body.setVelocity(entity.body.matterBody, { x: velX / 60, y: velY / 60 });

      // Clear stored velocity after applying
      entity.unit.velocityX = 0;
      entity.unit.velocityY = 0;
    }
  }

  // Update debug overlay text
  private updateDebugText(): void {
    const selectedCount = this.world.getSelectedEntities().length;
    const unitCount = this.world.getUnits().length;
    const projectileCount = this.world.getProjectiles().length;
    const zoom = this.inputManager.getZoom().toFixed(2);
    const tick = this.world.getTick();

    const p1Units = this.world.getUnitsByPlayer(1).length;
    const p2Units = this.world.getUnitsByPlayer(2).length;

    this.debugText.setText(
      [
        `FPS: ${this.fps} | Tick: ${tick}`,
        `Units: ${unitCount} (P1:${p1Units} P2:${p2Units})`,
        `Projectiles: ${projectileCount} | Selected: ${selectedCount}`,
        `Zoom: ${zoom}x | Audio: ${this.audioInitialized ? 'ON' : 'Click'}`,
      ].join('\n')
    );

    // Position at bottom-right corner
    const camera = this.cameras.main;
    const padding = 10;
    this.debugText.setPosition(
      camera.width - this.debugText.width - padding,
      camera.height - this.debugText.height - padding
    );
  }

  // Clean shutdown
  shutdown(): void {
    audioManager.stopAllLaserSounds();
    this.entityRenderer?.destroy();
    this.inputManager?.destroy();
    this.gridGraphics?.destroy();
    this.debugText?.destroy();
  }
}
