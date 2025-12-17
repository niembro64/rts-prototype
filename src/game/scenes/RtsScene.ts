import Phaser from 'phaser';
import { WorldState } from '../sim/WorldState';
import { Simulation } from '../sim/Simulation';
import { CommandQueue, type Command } from '../sim/commands';
import { spawnInitialEntities } from '../sim/spawn';
import { EntityRenderer } from '../render/renderEntities';
import { InputManager } from '../input/inputBindings';
import type { Entity, PlayerId, EntityId, WaypointType } from '../sim/types';
import { PLAYER_COLORS } from '../sim/types';
import { economyManager } from '../sim/economy';
import { getPendingGameConfig, clearPendingGameConfig } from '../createGame';
import { networkManager, type NetworkRole } from '../network/NetworkManager';
import { serializeGameState } from '../network/stateSerializer';
import type { NetworkGameState } from '../network/NetworkManager';
import type { SelectCommand } from '../sim/commands';
import { ClientViewState } from '../network/ClientViewState';

// Host view modes
export type HostViewMode = 'simulation' | 'client';

// Weapon ID to display label
const WEAPON_LABELS: Record<string, string> = {
  scout: 'Scout',
  burst: 'Burst',
  beam: 'Beam',
  brawl: 'Brawl',
  mortar: 'Mortar',
  snipe: 'Snipe',
  tank: 'Tank',
  arachnid: 'Arachnid',
};
import { audioManager } from '../audio/AudioManager';
import type { AudioEvent, DeathContext } from '../sim/combat';
import {
  LASER_SOUND_ENABLED,
  UNIT_STATS,
  MAX_TOTAL_UNITS,
  BACKGROUND_SPAWN_INVERSE_COST_WEIGHTING,
  EXPLOSION_VELOCITY_MULTIPLIER,
  EXPLOSION_IMPACT_FORCE_MULTIPLIER,
  EXPLOSION_ATTACKER_DIRECTION_MULTIPLIER,
  EXPLOSION_BASE_MOMENTUM,
  UNIT_MASS_MULTIPLIER,
} from '../../config';
import { createWeaponsFromDefinition } from '../sim/unitDefinitions';

// Grid settings
const GRID_SIZE = 50;
const GRID_COLOR = 0x333355;

// Create a physics body with explicit mass from config
function createUnitBody(
  matter: Phaser.Physics.Matter.MatterPhysics,
  x: number,
  y: number,
  collisionRadius: number,
  mass: number,
  label: string
): MatterJS.BodyType {
  // Apply global mass multiplier for physics feel tuning
  const physicsMass = mass * UNIT_MASS_MULTIPLIER;

  const body = matter.add.circle(x, y, collisionRadius, {
    friction: 0.01,        // Low ground friction
    frictionAir: 0.15,     // Higher air friction - units slow down quickly when not thrusting
    frictionStatic: 0.1,
    restitution: 0.2,      // Less bounce
    label,
  });

  // Explicitly set mass after creation (Matter.js option doesn't always work)
  matter.body.setMass(body, physicsMass);

  // Set inertia based on mass - heavier units resist rotation more
  matter.body.setInertia(body, physicsMass * collisionRadius * collisionRadius * 0.5);

  return body as unknown as MatterJS.BodyType;
}

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

    // Initialize world state
    this.world = new WorldState(42);
    // In background mode, set active player to 0 (spectator - no unit selection)
    this.world.setActivePlayer(this.backgroundMode ? 0 as PlayerId : this.localPlayerId);

    this.commandQueue = new CommandQueue();
    this.simulation = new Simulation(this.world, this.commandQueue);
    this.simulation.setPlayerIds(this.playerIds);

    // Setup callbacks (only needed for host/offline mode)
    if (this.networkRole !== 'client') {
      // Setup death callback (with deathContexts for directional explosions)
      this.simulation.onUnitDeath = (deadUnitIds: EntityId[], deathContexts?: Map<EntityId, DeathContext>) => {
        this.handleUnitDeaths(deadUnitIds, deathContexts);
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

      // Setup game over callback (skip in background mode - never ends)
      if (!this.backgroundMode) {
        this.simulation.onGameOver = (winnerId: PlayerId) => {
          this.handleGameOver(winnerId);
        };
      }
    }

    // Setup camera - no bounds so player can see outside the map
    const camera = this.cameras.main;
    camera.setBackgroundColor(0x0a0a14); // Darker background outside the map

    // Set zoom level - same for both normal and background mode
    const INITIAL_ZOOM = 0.4;
    camera.setZoom(INITIAL_ZOOM);

    // Center camera on the map
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
        this.spawnBackgroundUnits(true); // Initial spawn
      } else {
        // Normal mode: spawn commanders
        const entities = spawnInitialEntities(this.world, this.playerIds);
        // Create Matter bodies for entities
        this.createMatterBodies(entities);
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

  // Handle audio events from simulation (or network)
  private handleAudioEvent(event: AudioEvent): void {
    // Always handle visual effects even if audio not initialized
    if (event.type === 'hit' || event.type === 'projectileExpire') {
      // Add impact explosion at hit/termination location
      // Size based on weapon type (larger for heavy weapons)
      const explosionRadius = this.getExplosionRadius(event.weaponId);
      const explosionColor = 0xff8844; // Orange-ish for impacts
      this.entityRenderer.addExplosion(event.x, event.y, explosionRadius, explosionColor, 'impact');
    }

    // Handle death explosions (visual) - uses death context from event
    if (event.type === 'death' && event.deathContext) {
      const ctx = event.deathContext;
      const radius = ctx.radius * 2.5; // Death explosions are 2.5x collision radius

      // Apply same multipliers as host-side death handling
      const velocityX = ctx.unitVelX * EXPLOSION_VELOCITY_MULTIPLIER;
      const velocityY = ctx.unitVelY * EXPLOSION_VELOCITY_MULTIPLIER;

      const penetrationX = ctx.hitDirX * EXPLOSION_IMPACT_FORCE_MULTIPLIER;
      const penetrationY = ctx.hitDirY * EXPLOSION_IMPACT_FORCE_MULTIPLIER;

      const attackScale = Math.min(ctx.attackMagnitude / 50, 2);
      const attackerX = ctx.projectileVelX * EXPLOSION_ATTACKER_DIRECTION_MULTIPLIER * attackScale;
      const attackerY = ctx.projectileVelY * EXPLOSION_ATTACKER_DIRECTION_MULTIPLIER * attackScale;

      // Add base momentum
      let baseVelX = velocityX;
      let baseVelY = velocityY;
      const combinedX = velocityX + penetrationX + attackerX;
      const combinedY = velocityY + penetrationY + attackerY;
      const combinedMag = Math.sqrt(combinedX * combinedX + combinedY * combinedY);
      if (combinedMag > 0 && EXPLOSION_BASE_MOMENTUM > 0) {
        baseVelX += (combinedX / combinedMag) * EXPLOSION_BASE_MOMENTUM;
        baseVelY += (combinedY / combinedMag) * EXPLOSION_BASE_MOMENTUM;
      }

      this.entityRenderer.addExplosion(
        event.x,
        event.y,
        radius,
        ctx.color,
        'death',
        baseVelX,
        baseVelY,
        penetrationX,
        penetrationY,
        attackerX,
        attackerY
      );
    }

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
        // Only play laser sound if enabled in config
        if (LASER_SOUND_ENABLED && event.entityId !== undefined) {
          audioManager.startLaserSound(event.entityId);
        }
        break;
      case 'laserStop':
        // Always try to stop (in case config changed mid-game)
        if (event.entityId !== undefined) {
          audioManager.stopLaserSound(event.entityId);
        }
        break;
      case 'projectileExpire':
        // No sound for projectile expiration (visual only)
        break;
    }
  }

  // Get explosion radius based on weapon type
  private getExplosionRadius(weaponId: string): number {
    const weaponSizes: Record<string, number> = {
      scout: 6,
      burst: 7,
      beam: 5,
      brawl: 10,
      mortar: 18,
      snipe: 8,
      tank: 15,
      dgun: 30,
    };
    return weaponSizes[weaponId] ?? 8;
  }

  // Handle unit deaths (cleanup Matter bodies and audio)
  // deathContexts contains info about the killing blow for directional explosions
  private handleUnitDeaths(
    deadUnitIds: EntityId[],
    deathContexts?: Map<EntityId, DeathContext>
  ): void {
    for (const id of deadUnitIds) {
      const entity = this.world.getEntity(id);
      if (entity) {
        // Add death explosion at 2.5x collision radius
        // Pass three separate momentum vectors for different explosion layers:
        // 1. Unit's own velocity - affects smoke, embers (trailing effect)
        // 2. Impact force from killing blow - affects debris, shockwaves (blown away)
        // 3. Attacker's projectile/beam direction - affects sparks (penetration effect)
        if (entity.unit) {
          const radius = entity.unit.collisionRadius * 2.5;
          const playerColor = entity.ownership?.playerId
            ? PLAYER_COLORS[entity.ownership.playerId]?.primary ?? 0xff6600
            : 0xff6600;

          // 1. Unit's velocity from physics body (scaled by multiplier)
          const bodyVel = (entity.body?.matterBody as { velocity?: { x: number; y: number } })?.velocity;
          const velocityX = (bodyVel?.x ?? 0) * EXPLOSION_VELOCITY_MULTIPLIER;
          const velocityY = (bodyVel?.y ?? 0) * EXPLOSION_VELOCITY_MULTIPLIER;

          // 2 & 3: Hit direction and attacker velocity from death context
          let penetrationX = 0;
          let penetrationY = 0;
          let attackerX = 0;
          let attackerY = 0;

          const ctx = deathContexts?.get(id);
          if (ctx) {
            // Hit direction (from hit point through unit center)
            penetrationX = ctx.penetrationDirX * EXPLOSION_IMPACT_FORCE_MULTIPLIER;
            penetrationY = ctx.penetrationDirY * EXPLOSION_IMPACT_FORCE_MULTIPLIER;

            // Attacker velocity (actual projectile velocity or beam direction * magnitude)
            // Scale by attack magnitude for bigger hits = bigger directional effect
            const attackScale = Math.min(ctx.attackMagnitude / 50, 2); // Normalize to ~1 for 50 damage
            attackerX = ctx.attackerVelX * EXPLOSION_ATTACKER_DIRECTION_MULTIPLIER * attackScale;
            attackerY = ctx.attackerVelY * EXPLOSION_ATTACKER_DIRECTION_MULTIPLIER * attackScale;
          }

          // Add base momentum to combined direction (gives minimum "oomph")
          // We add it to velocity since that's always present
          let baseVelX = velocityX;
          let baseVelY = velocityY;
          const combinedX = velocityX + penetrationX + attackerX;
          const combinedY = velocityY + penetrationY + attackerY;
          const combinedMag = Math.sqrt(combinedX * combinedX + combinedY * combinedY);
          if (combinedMag > 0 && EXPLOSION_BASE_MOMENTUM > 0) {
            baseVelX += (combinedX / combinedMag) * EXPLOSION_BASE_MOMENTUM;
            baseVelY += (combinedY / combinedMag) * EXPLOSION_BASE_MOMENTUM;
          }

          this.entityRenderer.addExplosion(
            entity.transform.x,
            entity.transform.y,
            radius,
            playerColor,
            'death',
            baseVelX,
            baseVelY,
            penetrationX,
            penetrationY,
            attackerX,
            attackerY
          );
        }
        if (entity.body?.matterBody) {
          this.matter.world.remove(entity.body.matterBody);
        }
        // Stop any laser sound this unit was making
        audioManager.stopLaserSound(id);
      }
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
    this.inputManager?.setWaypointMode(mode);
    this.updateSelectionInfo();
  }

  // Start build mode via UI
  public startBuildMode(buildingType: 'solar' | 'factory'): void {
    this.inputManager?.startBuildMode(buildingType);
    this.updateSelectionInfo();
  }

  // Cancel build mode via UI
  public cancelBuildMode(): void {
    this.inputManager?.cancelBuildMode();
    this.updateSelectionInfo();
  }

  // Toggle D-Gun mode via UI
  public toggleDGunMode(): void {
    this.inputManager?.toggleDGunMode();
    this.updateSelectionInfo();
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
    const selectedUnits = entitySource.getSelectedUnits();
    const selectedBuildings = entitySource.getSelectedBuildings();

    // Check for commander
    const commander = selectedUnits.find(u => u.commander !== undefined);

    // Check for factory
    const factory = selectedBuildings.find(b => b.factory !== undefined);

    const inputState = this.inputManager?.getState();

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
      waypointMode: inputState?.waypointMode ?? 'move',
      isBuildMode: inputState?.isBuildMode ?? false,
      selectedBuildingType: inputState?.selectedBuildingType ?? null,
      isDGunMode: inputState?.isDGunMode ?? false,
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

    // Count buildings for this player - use current entity source for view mode awareness
    const entitySource = this.getCurrentEntitySource();
    const playerBuildings = entitySource.getBuildingsByPlayer(playerId);
    const solarCount = playerBuildings.filter(b => b.buildingType === 'solar').length;
    const factoryCount = playerBuildings.filter(b => b.buildingType === 'factory').length;

    // Count units for this player
    const unitCount = entitySource.getUnitsByPlayer(playerId).length;
    const unitCap = this.world.getUnitCapPerPlayer();

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
      unitCount,
      unitCap,
    });
  }

  // Update minimap data and notify UI
  public updateMinimapData(): void {
    if (!this.onMinimapUpdate) return;

    const camera = this.cameras.main;
    const entitySource = this.getCurrentEntitySource();
    const entities: { x: number; y: number; type: 'unit' | 'building'; color: string; isSelected?: boolean }[] = [];

    // Add units to minimap
    for (const unit of entitySource.getUnits()) {
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
    for (const building of entitySource.getBuildings()) {
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
        // Circle body for units with proper mass
        const body = createUnitBody(
          this.matter,
          entity.transform.x,
          entity.transform.y,
          entity.unit.collisionRadius,
          entity.unit.mass,
          `unit_${entity.id}`
        );
        entity.body = { matterBody: body };
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
      }

      // Update simulation (calculates velocities) - ALWAYS runs for host
      // Note: In client view mode, selection commands have been removed from queue above
      this.simulation.update(delta);

      // Apply calculated velocities to Matter bodies
      this.applyUnitVelocities();

      // Background mode: continuously spawn units
      if (this.backgroundMode) {
        this.backgroundSpawnTimer += delta;
        if (this.backgroundSpawnTimer >= this.BACKGROUND_SPAWN_INTERVAL) {
          this.backgroundSpawnTimer = 0;
          this.spawnBackgroundUnits(false);
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

    // Update UI (skip in background mode - no UI)
    if (!this.backgroundMode) {
      // Update selection info for UI
      this.updateSelectionInfo();

      // Update economy info for UI
      this.updateEconomyInfo();

      // Update minimap for UI
      this.updateMinimapData();
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
          this.handleAudioEvent(event);
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
  }

  // Apply forces to Matter bodies - simple force toward waypoint, friction handles the rest
  private applyUnitVelocities(): void {
    const forceAccumulator = this.simulation.getForceAccumulator();

    for (const entity of this.world.getUnits()) {
      if (!entity.body?.matterBody || !entity.unit) continue;

      const matterBody = entity.body.matterBody as MatterJS.BodyType;

      // Sync position from physics body
      entity.transform.x = matterBody.position.x;
      entity.transform.y = matterBody.position.y;

      // Get the direction unit wants to move (stored as velocityX/Y, but we treat as direction)
      const dirX = entity.unit.velocityX ?? 0;
      const dirY = entity.unit.velocityY ?? 0;
      const dirMag = Math.sqrt(dirX * dirX + dirY * dirY);

      // Update rotation to face thrust direction (where unit is trying to go)
      if (dirMag > 0.01) {
        entity.transform.rotation = Math.atan2(dirY, dirX);
      }

      // Calculate thrust force toward waypoint
      // Force is proportional to moveSpeed - faster units have more thrust
      let thrustX = 0;
      let thrustY = 0;
      if (dirMag > 0) {
        // Normalize direction and apply thrust based on unit's moveSpeed
        const thrustStrength = entity.unit.moveSpeed * 0.0003; // Tunable thrust factor
        thrustX = (dirX / dirMag) * thrustStrength;
        thrustY = (dirY / dirMag) * thrustStrength;
      }

      // Get external forces (like wave pull) from the accumulator
      const externalForce = forceAccumulator.getFinalForce(entity.id);
      const externalFx = (externalForce?.fx ?? 0) / 3600; // Scale down significantly
      const externalFy = (externalForce?.fy ?? 0) / 3600;

      // Combine thrust and external forces
      let totalForceX = thrustX + externalFx;
      let totalForceY = thrustY + externalFy;

      // Safety: skip NaN/Infinity values
      if (!Number.isFinite(totalForceX) || !Number.isFinite(totalForceY)) {
        continue;
      }

      // Apply force at center of mass
      this.matter.body.applyForce(matterBody, matterBody.position, {
        x: totalForceX,
        y: totalForceY,
      });
    }
  }

  // === Background Mode Methods ===

  // Available unit types for background spawning
  private readonly BACKGROUND_UNIT_TYPES = Object.keys(UNIT_STATS) as (keyof typeof UNIT_STATS)[];

  // Precomputed inverse cost weights for weighted random selection
  private backgroundUnitWeights: { type: keyof typeof UNIT_STATS; weight: number }[] = [];
  private backgroundTotalWeight: number = 0;

  // Initialize background unit weights (call once)
  private initBackgroundUnitWeights(): void {
    if (this.backgroundUnitWeights.length > 0) return; // Already initialized

    // Calculate inverse cost weights: weight = 1 / cost
    // This makes cheaper units spawn more frequently
    for (const unitType of this.BACKGROUND_UNIT_TYPES) {
      const cost = UNIT_STATS[unitType].baseCost;
      const weight = 1 / cost;
      this.backgroundUnitWeights.push({ type: unitType, weight });
      this.backgroundTotalWeight += weight;
    }
  }

  // Select a random unit type based on inverse cost weighting
  private selectWeightedUnitType(): keyof typeof UNIT_STATS {
    this.initBackgroundUnitWeights();

    const random = Math.random() * this.backgroundTotalWeight;
    let cumulative = 0;

    for (const entry of this.backgroundUnitWeights) {
      cumulative += entry.weight;
      if (random <= cumulative) {
        return entry.type;
      }
    }

    // Fallback (shouldn't reach here)
    return this.backgroundUnitWeights[this.backgroundUnitWeights.length - 1].type;
  }

  // Spawn units for the background battle (4 players: Red, Blue, Yellow, Green)
  private spawnBackgroundUnits(initialSpawn: boolean): void {
    const numPlayers = 4;
    const unitCapPerPlayer = Math.floor(MAX_TOTAL_UNITS / numPlayers);
    const spawnMargin = 100; // Distance from map edge for spawning
    const mapWidth = this.world.mapWidth;
    const mapHeight = this.world.mapHeight;

    // How many to spawn this cycle per player
    const unitsToSpawnPerPlayer = initialSpawn ? Math.min(15, unitCapPerPlayer) : 1;

    // Player 1 (Red) - top of map, moving down
    const player1Units = this.world.getUnitsByPlayer(1).length;
    for (let i = 0; i < unitsToSpawnPerPlayer && player1Units + i < unitCapPerPlayer; i++) {
      this.spawnBackgroundUnit(1,
        spawnMargin, mapWidth - spawnMargin, spawnMargin, spawnMargin, // spawn at top
        spawnMargin, mapWidth - spawnMargin, mapHeight - spawnMargin, mapHeight, // target bottom
        Math.PI / 2 // facing down
      );
    }

    // Player 2 (Blue) - bottom of map, moving up
    const player2Units = this.world.getUnitsByPlayer(2).length;
    for (let i = 0; i < unitsToSpawnPerPlayer && player2Units + i < unitCapPerPlayer; i++) {
      this.spawnBackgroundUnit(2,
        spawnMargin, mapWidth - spawnMargin, mapHeight - spawnMargin, mapHeight, // spawn at bottom
        spawnMargin, mapWidth - spawnMargin, spawnMargin, spawnMargin, // target top
        -Math.PI / 2 // facing up
      );
    }

    // Player 3 (Yellow) - left of map, moving right
    const player3Units = this.world.getUnitsByPlayer(3).length;
    for (let i = 0; i < unitsToSpawnPerPlayer && player3Units + i < unitCapPerPlayer; i++) {
      this.spawnBackgroundUnit(3,
        spawnMargin, spawnMargin, spawnMargin, mapHeight - spawnMargin, // spawn at left
        mapWidth - spawnMargin, mapWidth, spawnMargin, mapHeight - spawnMargin, // target right
        0 // facing right
      );
    }

    // Player 4 (Green) - right of map, moving left
    const player4Units = this.world.getUnitsByPlayer(4).length;
    for (let i = 0; i < unitsToSpawnPerPlayer && player4Units + i < unitCapPerPlayer; i++) {
      this.spawnBackgroundUnit(4,
        mapWidth - spawnMargin, mapWidth, spawnMargin, mapHeight - spawnMargin, // spawn at right
        spawnMargin, spawnMargin, spawnMargin, mapHeight - spawnMargin, // target left
        Math.PI // facing left
      );
    }
  }

  // Spawn a single background unit with a fight waypoint to opposite side
  private spawnBackgroundUnit(
    playerId: PlayerId,
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
    targetMinX: number,
    targetMaxX: number,
    targetMinY: number,
    targetMaxY: number,
    initialRotation: number
  ): void {
    // Random position within spawn area
    const x = minX + Math.random() * (maxX - minX);
    const y = minY + Math.random() * (maxY - minY);

    // Select unit type based on config (weighted by inverse cost or flat distribution)
    const unitType = BACKGROUND_SPAWN_INVERSE_COST_WEIGHTING
      ? this.selectWeightedUnitType()
      : this.BACKGROUND_UNIT_TYPES[Math.floor(Math.random() * this.BACKGROUND_UNIT_TYPES.length)];
    const stats = UNIT_STATS[unitType];

    // Create the unit using base method and set weapons for this unit type
    const unit = this.world.createUnitBase(
      x,
      y,
      playerId,
      stats.collisionRadius,
      stats.moveSpeed,
      stats.mass,  // Mass was missing - stats.hp was being passed as mass!
      stats.hp
    );
    unit.weapons = createWeaponsFromDefinition(unitType, stats.collisionRadius);

    // Set initial rotation
    unit.transform.rotation = initialRotation;

    // Add fight waypoint to opposite side of map
    const targetX = targetMinX + Math.random() * (targetMaxX - targetMinX);
    const targetY = targetMinY + Math.random() * (targetMaxY - targetMinY);

    if (unit.unit) {
      unit.unit.actions = [{
        type: 'fight',
        x: targetX,
        y: targetY,
      }];
    }

    this.world.addEntity(unit);

    // Create physics body with proper mass
    if (unit.unit) {
      const body = createUnitBody(
        this.matter,
        x,
        y,
        unit.unit.collisionRadius,
        unit.unit.mass,
        `unit_${unit.id}`
      );
      unit.body = { matterBody: body };
    }
  }

  // Clean shutdown
  shutdown(): void {
    audioManager.stopAllLaserSounds();
    this.entityRenderer?.destroy();
    this.inputManager?.destroy();
    this.gridGraphics?.destroy();
  }
}
