import Phaser from 'phaser';
import { WorldState } from '../sim/WorldState';
import { EntityRenderer } from '../render/renderEntities';
import type { PlayerId, Entity } from '../sim/types';
import { UNIT_BUILD_CONFIGS } from '../sim/buildConfigs';

// Grid settings
const GRID_SIZE = 50;
const GRID_COLOR = 0x333355;

// Spawn settings
const SPAWN_INTERVAL = 800; // ms between spawns
const MAX_UNITS_PER_TEAM = 25;

// Simple unit data for manual movement
interface ShowcaseUnit {
  entity: Entity;
  targetX: number;
  targetY: number;
  speed: number;
}

export class ShowcaseScene extends Phaser.Scene {
  private world!: WorldState;
  private entityRenderer!: EntityRenderer;
  private gridGraphics!: Phaser.GameObjects.Graphics;
  private timeSinceLastSpawn = 0;
  private weaponTypes: string[] = [];
  private showcaseUnits: ShowcaseUnit[] = [];
  private debugText!: Phaser.GameObjects.Text;

  constructor() {
    super({ key: 'ShowcaseScene' });
  }

  create(): void {
    console.log('[ShowcaseScene] create() called');

    // Initialize world state
    this.world = new WorldState(42);
    this.world.setActivePlayer(1);
    this.world.playerCount = 2;

    // Get all weapon types
    this.weaponTypes = Object.keys(UNIT_BUILD_CONFIGS);

    // Setup camera
    const camera = this.cameras.main;
    camera.setBackgroundColor(0x0a0a14);
    camera.setZoom(0.5);
    camera.centerOn(this.world.mapWidth / 2, this.world.mapHeight / 2);

    // Draw grid background
    this.drawGrid();

    // Setup renderer
    this.entityRenderer = new EntityRenderer(this, this.world);

    // Spawn initial wave of units
    for (let i = 0; i < 12; i++) {
      this.spawnUnit(1);
      this.spawnUnit(2);
    }

    // Debug text (fixed to screen, not world)
    this.debugText = this.add.text(10, 10, 'DEBUG', {
      fontSize: '16px',
      color: '#00ff00',
      backgroundColor: '#000000aa',
      padding: { x: 8, y: 4 },
    });
    this.debugText.setScrollFactor(0);
    this.debugText.setDepth(1000);
  }

  private drawGrid(): void {
    this.gridGraphics = this.add.graphics();
    this.gridGraphics.lineStyle(1, GRID_COLOR, 0.3);

    for (let x = 0; x <= this.world.mapWidth; x += GRID_SIZE) {
      this.gridGraphics.lineBetween(x, 0, x, this.world.mapHeight);
    }

    for (let y = 0; y <= this.world.mapHeight; y += GRID_SIZE) {
      this.gridGraphics.lineBetween(0, y, this.world.mapWidth, y);
    }

    this.gridGraphics.lineStyle(3, 0x4444aa, 0.5);
    this.gridGraphics.strokeRect(0, 0, this.world.mapWidth, this.world.mapHeight);
  }

  private spawnUnit(playerId: PlayerId): void {
    const mapWidth = this.world.mapWidth;
    const mapHeight = this.world.mapHeight;
    const margin = 100;

    // Random weapon type
    const weaponId = this.weaponTypes[Math.floor(Math.random() * this.weaponTypes.length)];
    const unitConfig = UNIT_BUILD_CONFIGS[weaponId];

    // Spawn position
    const x = margin + Math.random() * (mapWidth - margin * 2);
    let y: number;
    let targetY: number;

    if (playerId === 1) {
      y = margin;
      targetY = mapHeight - margin;
    } else {
      y = mapHeight - margin;
      targetY = margin;
    }

    const targetX = margin + Math.random() * (mapWidth - margin * 2);

    // Create the unit
    const unit = this.world.createUnit(
      x, y, playerId, weaponId,
      unitConfig.radius,
      unitConfig.moveSpeed
    );

    if (unit.unit) {
      unit.unit.hp = unitConfig.hp;
      unit.unit.maxHp = unitConfig.hp;

      const angle = Math.atan2(targetY - y, targetX - x);
      unit.transform.rotation = angle;
      unit.unit.turretRotation = angle;
    }

    this.world.addEntity(unit);

    console.log(`[ShowcaseScene] spawned unit id=${unit.id} at (${x.toFixed(0)}, ${y.toFixed(0)}) -> (${targetX.toFixed(0)}, ${targetY.toFixed(0)})`);

    // Track for manual movement
    this.showcaseUnits.push({
      entity: unit,
      targetX,
      targetY,
      speed: unitConfig.moveSpeed,
    });
  }

  private removeUnit(showcaseUnit: ShowcaseUnit): void {
    const index = this.showcaseUnits.indexOf(showcaseUnit);
    if (index > -1) {
      this.showcaseUnits.splice(index, 1);
    }
    this.world.removeEntity(showcaseUnit.entity.id);
  }

  private frameCount = 0;

  update(_time: number, delta: number): void {
    this.frameCount++;
    const dtSec = delta / 1000;

    // Debug log every 60 frames
    if (this.frameCount % 60 === 0) {
      console.log(`[ShowcaseScene] update frame=${this.frameCount}, units=${this.showcaseUnits.length}, worldUnits=${this.world.getUnits().length}`);
    }

    // Manually move all units toward their targets
    for (let i = this.showcaseUnits.length - 1; i >= 0; i--) {
      const su = this.showcaseUnits[i];
      const entity = su.entity;

      if (!entity.unit) continue;

      // Calculate direction to target
      const dx = su.targetX - entity.transform.x;
      const dy = su.targetY - entity.transform.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // If reached target, remove unit
      if (dist < 20) {
        this.removeUnit(su);
        continue;
      }

      // Move toward target
      const moveX = (dx / dist) * su.speed * dtSec;
      const moveY = (dy / dist) * su.speed * dtSec;

      // Debug: log first unit's movement
      if (i === 0 && this.frameCount % 60 === 0) {
        console.log(`[ShowcaseScene] unit0 pos=(${entity.transform.x.toFixed(1)}, ${entity.transform.y.toFixed(1)}) move=(${moveX.toFixed(2)}, ${moveY.toFixed(2)}) speed=${su.speed}`);
      }

      entity.transform.x += moveX;
      entity.transform.y += moveY;
      entity.transform.rotation = Math.atan2(dy, dx);

      if (entity.unit.turretRotation !== undefined) {
        entity.unit.turretRotation = entity.transform.rotation;
      }

      // Store velocity for rendering
      entity.unit.velocityX = (dx / dist) * su.speed;
      entity.unit.velocityY = (dy / dist) * su.speed;
    }

    // Spawn new units periodically
    this.timeSinceLastSpawn += delta;
    if (this.timeSinceLastSpawn >= SPAWN_INTERVAL) {
      this.timeSinceLastSpawn = 0;

      const player1Count = this.showcaseUnits.filter(su => su.entity.ownership?.playerId === 1).length;
      const player2Count = this.showcaseUnits.filter(su => su.entity.ownership?.playerId === 2).length;

      if (player1Count < MAX_UNITS_PER_TEAM) {
        this.spawnUnit(1);
      }
      if (player2Count < MAX_UNITS_PER_TEAM) {
        this.spawnUnit(2);
      }
    }

    // Gentle camera pan
    const camera = this.cameras.main;
    const centerX = this.world.mapWidth / 2;
    const centerY = this.world.mapHeight / 2;
    const panRadius = 150;
    const panX = centerX + Math.sin(_time / 8000) * panRadius;
    const panY = centerY + Math.cos(_time / 10000) * panRadius;
    camera.centerOn(panX, panY);

    // Render entities
    this.entityRenderer.render();

    // Update debug text
    const firstUnit = this.showcaseUnits[0]?.entity;
    const posInfo = firstUnit
      ? `pos=(${firstUnit.transform.x.toFixed(0)}, ${firstUnit.transform.y.toFixed(0)})`
      : 'no units';
    this.debugText.setText(`Frame: ${this.frameCount} | Units: ${this.showcaseUnits.length} | ${posInfo}`);
  }

  shutdown(): void {
    if (this.gridGraphics) {
      this.gridGraphics.destroy();
    }
    if (this.entityRenderer) {
      this.entityRenderer.destroy();
    }
  }
}
