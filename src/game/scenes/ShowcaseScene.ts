import Phaser from 'phaser';
import { WorldState } from '../sim/WorldState';
import { EntityRenderer } from '../render/renderEntities';
import type { PlayerId, Entity, UnitAction } from '../sim/types';
import { UNIT_BUILD_CONFIGS } from '../sim/buildConfigs';
import {
  updateWeaponCooldowns,
  updateAutoTargeting,
  updateTurretRotation,
  fireWeapons,
  updateProjectiles,
  checkProjectileCollisions,
} from '../sim/combat';

// Grid settings
const GRID_SIZE = 50;
const GRID_COLOR = 0x333355;

// Spawn settings
const SPAWN_INTERVAL = 800; // ms between spawns
const MAX_UNITS_PER_TEAM = 25;

export class ShowcaseScene extends Phaser.Scene {
  private world!: WorldState;
  private entityRenderer!: EntityRenderer;
  private gridGraphics!: Phaser.GameObjects.Graphics;
  private timeSinceLastSpawn = 0;
  private weaponTypes: string[] = [];
  constructor() {
    super({ key: 'ShowcaseScene' });
  }

  create(): void {

    // Initialize world state
    this.world = new WorldState(42);
    this.world.setActivePlayer(1);
    this.world.playerCount = 2;

    // Get all weapon types
    this.weaponTypes = Object.keys(UNIT_BUILD_CONFIGS);

    // Setup camera - more zoomed in than real game (which starts at 0.4)
    const camera = this.cameras.main;
    camera.setBackgroundColor(0x0a0a14);
    camera.setZoom(1.0);
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

    // Spawn position - teams on opposite sides
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

      // Set initial rotation toward target
      const angle = Math.atan2(targetY - y, targetX - x);
      unit.transform.rotation = angle;
      unit.unit.turretRotation = angle;

      // Add patrol actions - fight toward enemy side, then loop back
      // This creates continuous back-and-forth fighting behavior
      const returnX = margin + Math.random() * (mapWidth - margin * 2);
      const returnY = y; // Return to spawn side

      const fightAction1: UnitAction = {
        type: 'patrol',
        x: targetX,
        y: targetY,
      };

      const fightAction2: UnitAction = {
        type: 'patrol',
        x: returnX,
        y: returnY,
      };

      unit.unit.actions = [fightAction1, fightAction2];
      unit.unit.patrolStartIndex = 0; // Start patrol loop immediately
    }

    this.world.addEntity(unit);
  }

  private frameCount = 0;

  update(_time: number, delta: number): void {
    this.frameCount++;
    const dtSec = delta / 1000;
    const dtMs = delta;
    const units = this.world.getUnits();

    // Update unit movement using real game mechanics (fight mode behavior)
    this.updateUnitMovement(dtSec);

    // Run combat systems
    updateWeaponCooldowns(this.world, dtMs);
    updateAutoTargeting(this.world);
    updateTurretRotation(this.world, dtMs);

    // Fire weapons and add projectiles to world
    const fireResult = fireWeapons(this.world);
    for (const proj of fireResult.projectiles) {
      this.world.addEntity(proj);
    }

    // Update projectile positions
    updateProjectiles(this.world, dtMs);

    // Check collisions and handle damage/deaths
    const collisionResult = checkProjectileCollisions(this.world, dtMs);

    // Remove dead units from world
    if (collisionResult.deadUnitIds.length > 0) {
      for (const deadId of collisionResult.deadUnitIds) {
        this.world.removeEntity(deadId);
      }
    }

    // Spawn new units periodically to keep the battle going
    this.timeSinceLastSpawn += delta;
    if (this.timeSinceLastSpawn >= SPAWN_INTERVAL) {
      this.timeSinceLastSpawn = 0;

      const player1Count = units.filter(u => u.ownership?.playerId === 1).length;
      const player2Count = units.filter(u => u.ownership?.playerId === 2).length;

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
  }

  // Movement update using real game mechanics - same as Simulation.updateUnits()
  private updateUnitMovement(dtSec: number): void {
    for (const entity of this.world.getUnits()) {
      if (!entity.unit) continue;

      const { unit, transform } = entity;

      // Skip dead units
      if (unit.hp <= 0) continue;

      // No actions - stop moving
      if (unit.actions.length === 0) {
        unit.velocityX = 0;
        unit.velocityY = 0;
        continue;
      }

      // Get current action
      const currentAction = unit.actions[0];

      // Check if unit should stop moving due to combat (fight or patrol mode)
      // Only stop when target is within WEAPON range (not just vision range)
      let canFireAtTarget = false;
      if (entity.weapon && entity.weapon.targetEntityId !== null) {
        const target = this.world.getEntity(entity.weapon.targetEntityId);
        if (target?.unit || target?.building) {
          const targetX = target.transform.x;
          const targetY = target.transform.y;
          const dx = targetX - entity.transform.x;
          const dy = targetY - entity.transform.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const targetRadius = target.unit?.radius ?? 0;
          const effectiveRange = entity.weapon.config.range + targetRadius;
          canFireAtTarget = dist <= effectiveRange;
        }
      }

      const shouldStopForCombat =
        (currentAction.type === 'fight' || currentAction.type === 'patrol') && canFireAtTarget;

      if (shouldStopForCombat) {
        // Stop moving - target is within weapon range
        unit.velocityX = 0;
        unit.velocityY = 0;
        continue;
      }

      // Calculate direction to action target
      const dx = currentAction.x - transform.x;
      const dy = currentAction.y - transform.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      // If close enough to target, advance to next action
      const stopThreshold = 20;
      if (distance < stopThreshold) {
        this.advanceAction(entity);

        // Zero out velocity for this frame
        unit.velocityX = 0;
        unit.velocityY = 0;
        continue;
      }

      // Calculate velocity
      const speed = unit.moveSpeed;
      const vx = (dx / distance) * speed;
      const vy = (dy / distance) * speed;

      // Store velocity on unit for rendering and combat system
      unit.velocityX = vx;
      unit.velocityY = vy;

      // Update position directly (no physics bodies in showcase)
      transform.x += vx * dtSec;
      transform.y += vy * dtSec;

      // Update body rotation to face movement direction
      transform.rotation = Math.atan2(dy, dx);
    }
  }

  // Advance to next action (with patrol loop support) - same as Simulation.advanceAction()
  private advanceAction(entity: Entity): void {
    if (!entity.unit) return;
    const unit = entity.unit;

    if (unit.actions.length === 0) return;

    const completedAction = unit.actions[0];

    // Check if we're in patrol mode and should loop
    if (completedAction.type === 'patrol' && unit.patrolStartIndex !== null) {
      // Move completed patrol action to end of queue (after all patrol actions)
      unit.actions.shift();
      unit.actions.push(completedAction);
    } else {
      // Remove completed action
      unit.actions.shift();

      // If we just finished the last non-patrol action and hit patrol section
      if (unit.actions.length > 0 && unit.actions[0].type === 'patrol') {
        unit.patrolStartIndex = 0;
      }
    }

    // Clear patrol start index if no more actions
    if (unit.actions.length === 0) {
      unit.patrolStartIndex = null;
    }
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
