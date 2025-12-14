import Phaser from 'phaser';
import { WorldState } from '../sim/WorldState';
import { Simulation } from '../sim/Simulation';
import { CommandQueue } from '../sim/commands';
import { spawnInitialEntities } from '../sim/spawn';
import { EntityRenderer } from '../render/renderEntities';
import { InputManager } from '../input/inputBindings';
import type { Entity } from '../sim/types';

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

  constructor() {
    super({ key: 'RtsScene' });
  }

  create(): void {
    // Initialize world state
    this.world = new WorldState(42);
    this.commandQueue = new CommandQueue();
    this.simulation = new Simulation(this.world, this.commandQueue);

    // Setup camera
    const camera = this.cameras.main;
    camera.setBackgroundColor(0x1a1a2e);
    camera.setBounds(0, 0, this.world.mapWidth, this.world.mapHeight);
    camera.setScroll(0, 0);

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

    // Apply velocities to Matter bodies before simulation
    this.applyUnitVelocities();

    // Update simulation
    this.simulation.update(delta);

    // Render entities
    this.entityRenderer.render();

    // Update debug text
    this.updateDebugText();
  }

  // Apply calculated velocities to Matter bodies
  private applyUnitVelocities(): void {
    for (const entity of this.world.getUnits()) {
      if (!entity.body?.matterBody) continue;

      const velX = (entity as unknown as { velocityX?: number }).velocityX ?? 0;
      const velY = (entity as unknown as { velocityY?: number }).velocityY ?? 0;

      this.matter.body.setVelocity(entity.body.matterBody, { x: velX / 60, y: velY / 60 });

      // Clear stored velocity
      (entity as unknown as { velocityX?: number }).velocityX = undefined;
      (entity as unknown as { velocityY?: number }).velocityY = undefined;
    }
  }

  // Update debug overlay text
  private updateDebugText(): void {
    const selectedCount = this.world.getSelectedEntities().length;
    const entityCount = this.world.getEntityCount();
    const zoom = this.inputManager.getZoom().toFixed(2);
    const tick = this.world.getTick();

    this.debugText.setText(
      [
        `FPS: ${this.fps}`,
        `Entities: ${entityCount}`,
        `Selected: ${selectedCount}`,
        `Zoom: ${zoom}x`,
        `Tick: ${tick}`,
      ].join('\n')
    );
  }

  // Clean shutdown
  shutdown(): void {
    this.entityRenderer?.destroy();
    this.inputManager?.destroy();
    this.gridGraphics?.destroy();
    this.debugText?.destroy();
  }
}
