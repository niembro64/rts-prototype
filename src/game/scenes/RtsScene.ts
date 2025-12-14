import Phaser from 'phaser';
import { WorldState } from '../sim/WorldState';
import { Simulation } from '../sim/Simulation';
import { CommandQueue } from '../sim/commands';
import { spawnInitialEntities } from '../sim/spawn';
import { EntityRenderer } from '../render/renderEntities';
import { InputManager } from '../input/inputBindings';
import type { Entity, PlayerId, EntityId, WaypointType } from '../sim/types';
import { PLAYER_COLORS } from '../sim/types';

// Waypoint mode display config
const WAYPOINT_MODE_COLORS: Record<WaypointType, string> = {
  move: '#00ff00',
  patrol: '#0088ff',
  fight: '#ff4444',
};

const WAYPOINT_MODE_NAMES: Record<WaypointType, string> = {
  move: 'MOVE',
  patrol: 'PATROL',
  fight: 'FIGHT',
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
  private playerText!: Phaser.GameObjects.Text;
  private waypointModeText!: Phaser.GameObjects.Text;
  private frameCount: number = 0;
  private fps: number = 0;
  private fpsUpdateTime: number = 0;
  private audioInitialized: boolean = false;

  // Callback for UI to know when player changes
  public onPlayerChange?: (playerId: PlayerId) => void;

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

    // Setup debug overlay
    this.createDebugOverlay();

    // Setup player indicator
    this.createPlayerIndicator();

    // Setup waypoint mode indicator
    this.createWaypointModeIndicator();

    // Listen for waypoint mode changes
    this.inputManager.onWaypointModeChange = (mode: WaypointType) => {
      this.updateWaypointModeIndicator(mode);
    };

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

  // Switch active player
  public switchPlayer(playerId: PlayerId): void {
    this.world.setActivePlayer(playerId);
    this.updatePlayerIndicator();
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

  // Create debug overlay
  private createDebugOverlay(): void {
    this.debugText = this.add.text(10, 10, '', {
      fontFamily: 'monospace',
      fontSize: '14px',
      color: '#00ff88',
      backgroundColor: '#000000aa',
      padding: { x: 10, y: 8 },
    });
    this.debugText.setScrollFactor(0);
    this.debugText.setDepth(1001);
  }

  // Create player indicator
  private createPlayerIndicator(): void {
    this.playerText = this.add.text(10, 130, '', {
      fontFamily: 'monospace',
      fontSize: '16px',
      color: '#ffffff',
      backgroundColor: '#000000aa',
      padding: { x: 10, y: 8 },
    });
    this.playerText.setScrollFactor(0);
    this.playerText.setDepth(1001);
    this.updatePlayerIndicator();
  }

  // Update player indicator text
  private updatePlayerIndicator(): void {
    const playerId = this.world.activePlayerId;
    const playerInfo = PLAYER_COLORS[playerId];
    const colorHex = playerInfo.primary.toString(16).padStart(6, '0');
    this.playerText.setText(`Player: ${playerInfo.name}`);
    this.playerText.setColor(`#${colorHex}`);
  }

  // Create waypoint mode indicator
  private createWaypointModeIndicator(): void {
    this.waypointModeText = this.add.text(10, 170, '', {
      fontFamily: 'monospace',
      fontSize: '16px',
      color: '#00ff00',
      backgroundColor: '#000000aa',
      padding: { x: 10, y: 8 },
    });
    this.waypointModeText.setScrollFactor(0);
    this.waypointModeText.setDepth(1001);
    this.updateWaypointModeIndicator('move');
  }

  // Update waypoint mode indicator
  private updateWaypointModeIndicator(mode: WaypointType): void {
    const color = WAYPOINT_MODE_COLORS[mode];
    const name = WAYPOINT_MODE_NAMES[mode];
    this.waypointModeText.setText(`Mode: ${name} [M/F/H]`);
    this.waypointModeText.setColor(color);
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

    // Render entities
    this.entityRenderer.render();

    // Update debug text
    this.updateDebugText();
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
    const entityCount = this.world.getEntityCount();
    const unitCount = this.world.getUnits().length;
    const projectileCount = this.world.getProjectiles().length;
    const zoom = this.inputManager.getZoom().toFixed(2);
    const tick = this.world.getTick();

    const p1Units = this.world.getUnitsByPlayer(1).length;
    const p2Units = this.world.getUnitsByPlayer(2).length;

    this.debugText.setText(
      [
        `FPS: ${this.fps}`,
        `Entities: ${entityCount}`,
        `Units: ${unitCount} (P1: ${p1Units}, P2: ${p2Units})`,
        `Projectiles: ${projectileCount}`,
        `Selected: ${selectedCount}`,
        `Zoom: ${zoom}x`,
        `Tick: ${tick}`,
        `Audio: ${this.audioInitialized ? 'ON' : 'Click to enable'}`,
      ].join('\n')
    );
  }

  // Clean shutdown
  shutdown(): void {
    audioManager.stopAllLaserSounds();
    this.entityRenderer?.destroy();
    this.inputManager?.destroy();
    this.gridGraphics?.destroy();
    this.debugText?.destroy();
    this.playerText?.destroy();
    this.waypointModeText?.destroy();
  }
}
