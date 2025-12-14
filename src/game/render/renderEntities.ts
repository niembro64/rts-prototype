import Phaser from 'phaser';
import type { WorldState } from '../sim/WorldState';
import type { Entity } from '../sim/types';
import { PLAYER_COLORS } from '../sim/types';

// Colors
const UNIT_SELECTED_COLOR = 0x00ff88;
const UNIT_OUTLINE_COLOR = 0xffffff;
const BUILDING_COLOR = 0x886644;
const BUILDING_OUTLINE_COLOR = 0xaa8866;
const HEALTH_BAR_BG = 0x333333;
const HEALTH_BAR_FG = 0x44dd44;
const HEALTH_BAR_LOW = 0xff4444;

export class EntityRenderer {
  private graphics: Phaser.GameObjects.Graphics;
  private world: WorldState;

  constructor(scene: Phaser.Scene, world: WorldState) {
    this.graphics = scene.add.graphics();
    this.world = world;
  }

  // Render all entities
  render(): void {
    this.graphics.clear();

    // Render buildings first (below units)
    for (const entity of this.world.getBuildings()) {
      this.renderBuilding(entity);
    }

    // Render projectiles (below units)
    for (const entity of this.world.getProjectiles()) {
      this.renderProjectile(entity);
    }

    // Render units
    for (const entity of this.world.getUnits()) {
      this.renderUnit(entity);
    }
  }

  // Get player color
  private getPlayerColor(playerId: number | undefined): number {
    if (playerId === undefined) return 0x888888;
    return PLAYER_COLORS[playerId]?.primary ?? 0x888888;
  }

  // Render a unit (circle)
  private renderUnit(entity: Entity): void {
    if (!entity.unit) return;

    const { transform, unit, selectable, ownership } = entity;
    const { x, y, rotation } = transform;
    const { radius, hp, maxHp } = unit;
    const isSelected = selectable?.selected ?? false;
    const playerId = ownership?.playerId;

    // Get player color
    const playerColor = this.getPlayerColor(playerId);

    // Selection ring
    if (isSelected) {
      this.graphics.lineStyle(3, UNIT_SELECTED_COLOR, 1);
      this.graphics.strokeCircle(x, y, radius + 4);
    }

    // Unit body
    const fillColor = isSelected ? UNIT_SELECTED_COLOR : playerColor;
    this.graphics.fillStyle(fillColor, 0.9);
    this.graphics.fillCircle(x, y, radius);

    // Outline
    this.graphics.lineStyle(2, UNIT_OUTLINE_COLOR, 0.8);
    this.graphics.strokeCircle(x, y, radius);

    // Inner circle showing player color when selected
    if (isSelected) {
      this.graphics.fillStyle(playerColor, 1);
      this.graphics.fillCircle(x, y, radius * 0.5);
    }

    // Direction indicator (small line showing facing)
    const dirLength = radius * 1.2;
    const dirX = x + Math.cos(rotation) * dirLength;
    const dirY = y + Math.sin(rotation) * dirLength;
    this.graphics.lineStyle(2, 0xffffff, 1);
    this.graphics.lineBetween(x, y, dirX, dirY);

    // Weapon type indicator (small colored dot)
    if (entity.weapon) {
      const weaponColor = (entity.weapon.config.color as number) ?? 0xffffff;
      this.graphics.fillStyle(weaponColor, 0.9);
      this.graphics.fillCircle(x, y, 4);
    }

    // Health bar (always show)
    const healthPercent = hp / maxHp;
    this.renderHealthBar(x, y - radius - 10, radius * 2, 4, healthPercent);

    // Target line (show line to current attack target)
    if (entity.weapon?.targetEntityId !== null && isSelected) {
      const target = this.world.getEntity(entity.weapon!.targetEntityId!);
      if (target) {
        this.graphics.lineStyle(1, 0xff0000, 0.3);
        this.graphics.lineBetween(x, y, target.transform.x, target.transform.y);
      }
    }
  }

  // Render a projectile
  private renderProjectile(entity: Entity): void {
    if (!entity.projectile) return;

    const { transform, projectile } = entity;
    const { x, y } = transform;
    const config = projectile.config;
    const color = (config.color as number) ?? 0xffffff;

    if (projectile.projectileType === 'beam') {
      // Render beam as a line
      const startX = projectile.startX ?? x;
      const startY = projectile.startY ?? y;
      const endX = projectile.endX ?? x;
      const endY = projectile.endY ?? y;
      const beamWidth = config.beamWidth ?? 2;

      // Outer glow
      this.graphics.lineStyle(beamWidth + 4, color, 0.3);
      this.graphics.lineBetween(startX, startY, endX, endY);

      // Inner beam
      this.graphics.lineStyle(beamWidth, color, 0.9);
      this.graphics.lineBetween(startX, startY, endX, endY);

      // Core
      this.graphics.lineStyle(beamWidth / 2, 0xffffff, 1);
      this.graphics.lineBetween(startX, startY, endX, endY);
    } else {
      // Render traveling projectile as a circle
      const radius = config.projectileRadius ?? 5;

      // Trail effect (draw previous positions)
      const trailLength = config.trailLength ?? 3;
      const velMag = Math.sqrt(
        projectile.velocityX * projectile.velocityX + projectile.velocityY * projectile.velocityY
      );
      if (velMag > 0) {
        const dirX = projectile.velocityX / velMag;
        const dirY = projectile.velocityY / velMag;

        for (let i = 1; i <= trailLength; i++) {
          const trailX = x - dirX * i * radius * 1.5;
          const trailY = y - dirY * i * radius * 1.5;
          const alpha = 0.5 - i * 0.15;
          const trailRadius = radius * (1 - i * 0.2);

          if (alpha > 0 && trailRadius > 0) {
            this.graphics.fillStyle(color, alpha);
            this.graphics.fillCircle(trailX, trailY, trailRadius);
          }
        }
      }

      // Main projectile
      this.graphics.fillStyle(color, 0.9);
      this.graphics.fillCircle(x, y, radius);

      // Bright center
      this.graphics.fillStyle(0xffffff, 0.8);
      this.graphics.fillCircle(x, y, radius * 0.4);

      // Splash radius indicator for grenades
      if (config.splashRadius && !projectile.hasExploded) {
        this.graphics.lineStyle(1, color, 0.2);
        this.graphics.strokeCircle(x, y, config.splashRadius);
      }
    }
  }

  // Render a building (rectangle)
  private renderBuilding(entity: Entity): void {
    if (!entity.building) return;

    const { transform, building, ownership } = entity;
    const { x, y } = transform;
    const { width, height, hp, maxHp } = building;

    // Building body (centered at x, y)
    const left = x - width / 2;
    const top = y - height / 2;

    // Get color based on ownership
    const fillColor = ownership?.playerId
      ? this.getPlayerColor(ownership.playerId)
      : BUILDING_COLOR;

    this.graphics.fillStyle(fillColor, 0.9);
    this.graphics.fillRect(left, top, width, height);

    // Outline
    this.graphics.lineStyle(3, BUILDING_OUTLINE_COLOR, 1);
    this.graphics.strokeRect(left, top, width, height);

    // Inner detail
    this.graphics.lineStyle(1, 0x665533, 0.5);
    this.graphics.strokeRect(left + 4, top + 4, width - 8, height - 8);

    // Health bar (only show if damaged)
    if (hp < maxHp) {
      this.renderHealthBar(x, top - 10, width, 5, hp / maxHp);
    }
  }

  // Render a health bar
  private renderHealthBar(
    x: number,
    y: number,
    width: number,
    height: number,
    percent: number
  ): void {
    const left = x - width / 2;

    // Background
    this.graphics.fillStyle(HEALTH_BAR_BG, 0.8);
    this.graphics.fillRect(left, y, width, height);

    // Health fill (green when high, red when low)
    const healthColor = percent > 0.3 ? HEALTH_BAR_FG : HEALTH_BAR_LOW;
    this.graphics.fillStyle(healthColor, 0.9);
    this.graphics.fillRect(left, y, width * percent, height);
  }

  // Clean up
  destroy(): void {
    this.graphics.destroy();
  }
}
