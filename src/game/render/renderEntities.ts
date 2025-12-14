import Phaser from 'phaser';
import type { WorldState } from '../sim/WorldState';
import type { Entity } from '../sim/types';

// Colors
const UNIT_COLOR = 0x4a9eff;
const UNIT_SELECTED_COLOR = 0x00ff88;
const UNIT_OUTLINE_COLOR = 0xffffff;
const BUILDING_COLOR = 0x886644;
const BUILDING_OUTLINE_COLOR = 0xaa8866;
const HEALTH_BAR_BG = 0x333333;
const HEALTH_BAR_FG = 0x44dd44;

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

    // Render units
    for (const entity of this.world.getUnits()) {
      this.renderUnit(entity);
    }
  }

  // Render a unit (circle)
  private renderUnit(entity: Entity): void {
    if (!entity.unit) return;

    const { transform, unit, selectable } = entity;
    const { x, y, rotation } = transform;
    const { radius } = unit;
    const isSelected = selectable?.selected ?? false;

    // Selection ring
    if (isSelected) {
      this.graphics.lineStyle(3, UNIT_SELECTED_COLOR, 1);
      this.graphics.strokeCircle(x, y, radius + 4);
    }

    // Unit body
    const fillColor = isSelected ? UNIT_SELECTED_COLOR : UNIT_COLOR;
    this.graphics.fillStyle(fillColor, 0.9);
    this.graphics.fillCircle(x, y, radius);

    // Outline
    this.graphics.lineStyle(2, UNIT_OUTLINE_COLOR, 0.8);
    this.graphics.strokeCircle(x, y, radius);

    // Direction indicator (small line showing facing)
    const dirLength = radius * 1.2;
    const dirX = x + Math.cos(rotation) * dirLength;
    const dirY = y + Math.sin(rotation) * dirLength;
    this.graphics.lineStyle(2, 0xffffff, 1);
    this.graphics.lineBetween(x, y, dirX, dirY);

    // Health bar (only show if damaged)
    if (unit.hp < unit.maxHp) {
      this.renderHealthBar(x, y - radius - 10, radius * 2, 4, unit.hp / unit.maxHp);
    }

    // Target indicator (line to target)
    if (unit.targetX !== null && unit.targetY !== null) {
      this.graphics.lineStyle(1, UNIT_SELECTED_COLOR, 0.3);
      this.graphics.lineBetween(x, y, unit.targetX, unit.targetY);
    }
  }

  // Render a building (rectangle)
  private renderBuilding(entity: Entity): void {
    if (!entity.building) return;

    const { transform, building } = entity;
    const { x, y } = transform;
    const { width, height, hp, maxHp } = building;

    // Building body (centered at x, y)
    const left = x - width / 2;
    const top = y - height / 2;

    this.graphics.fillStyle(BUILDING_COLOR, 0.9);
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
  private renderHealthBar(x: number, y: number, width: number, height: number, percent: number): void {
    const left = x - width / 2;

    // Background
    this.graphics.fillStyle(HEALTH_BAR_BG, 0.8);
    this.graphics.fillRect(left, y, width, height);

    // Health fill
    this.graphics.fillStyle(HEALTH_BAR_FG, 0.9);
    this.graphics.fillRect(left, y, width * percent, height);
  }

  // Clean up
  destroy(): void {
    this.graphics.destroy();
  }
}
